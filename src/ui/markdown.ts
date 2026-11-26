/**
 * Safe Markdown + Universal LaTeX (KaTeX) + Callout renderer using SiYuan's built-in Lute engine.
 *
 * Includes a model-agnostic presentation-time math healer (inspired by LearnHarness's
 * `math-delims.ts`) that repairs:
 *   1. JSON-swallowed backslashes (\f -> form feed in \frac, \t -> tab in \theta, \b -> \beta, \r -> \rho, \n -> \nabla)
 *   2. Over-escaped commands (\\frac, \\\\frac, \\sin, \\alpha) without breaking matrix row breaks
 *   3. Varied delimiters ($$...$$, \[...\], \(...\), $...$, and spaced $ \frac{1}{2} $)
 */

import katex from "katex";

let sharedLute: any = null;
let katexCssInjected = false;

function ensureKatexCss(): void {
    if (katexCssInjected || typeof document === "undefined") return;
    katexCssInjected = true;
    const existing = document.querySelector(
        'link[href*="katex.min.css"], link[href*="katex.css"], #lh-katex-css',
    );
    if (existing) return;
    const link = document.createElement("link");
    link.id = "lh-katex-css";
    link.rel = "stylesheet";
    link.href = "/stage/protyle/js/katex/katex.min.css";
    document.head?.appendChild(link);
}

function getLute(): any {
    if (sharedLute) return sharedLute;
    const win = window as any;
    if (win.Lute && typeof win.Lute.New === "function") {
        try {
            sharedLute = win.Lute.New();
            if (typeof sharedLute.SetInlineMathAllowDigitAfterOpenMarker === "function") {
                sharedLute.SetInlineMathAllowDigitAfterOpenMarker(true);
            }
            return sharedLute;
        } catch {
            sharedLute = null;
        }
    }
    return null;
}

export function escapeHtml(str: string): string {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ─── Universal Model-Agnostic TeX Healer ────────────────────────────────────

const knownCommandCache = new Map<string, boolean>();

function knownTexCommand(name: string): boolean {
    if (!/^[A-Za-z]+$/.test(name)) return false;
    const cached = knownCommandCache.get(name);
    if (cached !== undefined) return cached;
    let known = true;
    try {
        katex.renderToString("\\" + name, { throwOnError: true, trust: false, strict: false });
    } catch (err) {
        known = !String(err).includes("Undefined control sequence: \\" + name);
    }
    knownCommandCache.set(name, known);
    return known;
}

function canParseTex(body: string, displayMode: boolean): boolean {
    try {
        katex.renderToString(body, { throwOnError: true, trust: false, strict: false, displayMode });
        return true;
    } catch {
        return false;
    }
}

const CONTROL_DEBRIS: Record<string, string> = {
    "\b": "\\b",
    "\t": "\\t",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
};

/** Stage 1: Restore JSON-swallowed backslashes (\f->\frac, \t->\theta, \b->\beta, \r->\rho, inline \n->\nabla). */
function restoreMathEscapes(body: string, displayMode: boolean): string {
    if (!/[\b\t\n\v\f\r]/.test(body)) return body;
    let out = body.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
        if (char === "\r" && body[offset + 1] === "\n") return char;
        const suffix = /^[A-Za-z]+/.exec(body.slice(offset + 1))?.[0];
        if (suffix && knownTexCommand(CONTROL_DEBRIS[char]!.slice(1) + suffix)) {
            return CONTROL_DEBRIS[char]!;
        }
        return char;
    });
    if (!displayMode) {
        out = out.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
            knownTexCommand("n" + suffix) ? "\\n" + suffix : whole,
        );
    }
    return out;
}

/** Stage 2: Collapse over-escaped commands (\\frac -> \frac, \\\\frac -> \frac) while preserving valid matrix row breaks. */
function healOverescapedCommands(body: string, displayMode: boolean): string {
    if (!body.includes("\\\\")) return body;
    const recovered = body.replace(/(\\+)([A-Za-z]+|[,;:!|{}%])/g, (whole, run: string, next: string) => {
        if (run.length % 2 !== 0) return whole;
        if (/^[A-Za-z]+$/.test(next)) {
            if (next.length > 1 && knownTexCommand(next)) {
                return "\\" + next;
            }
            return whole;
        }
        // Over-escaped command symbol like \\{ or \\} or \\%
        return "\\" + next;
    });
    if (recovered !== body && !canParseTex(recovered, displayMode) && canParseTex(body, displayMode)) {
        return body;
    }
    return recovered;
}

export function healTexBody(tex: string, displayMode: boolean): string {
    const step1 = restoreMathEscapes(tex, displayMode);
    return healOverescapedCommands(step1, displayMode);
}

function renderTex(tex: string, displayMode: boolean): string {
    ensureKatexCss();
    const cleaned = healTexBody(tex, displayMode).trim();
    if (!cleaned) return "";
    try {
        const html = katex.renderToString(cleaned, {
            displayMode,
            throwOnError: false,
            strict: false,
            trust: false,
            output: "htmlAndMathml",
        });
        return displayMode
            ? `<div class="lh-math-block">${html}</div>`
            : `<span class="lh-math-inline">${html}</span>`;
    } catch {
        return displayMode
            ? `<div class="lh-math-block"><code>${escapeHtml(cleaned)}</code></div>`
            : `<span class="lh-math-inline"><code>${escapeHtml(cleaned)}</code></span>`;
    }
}

/**
 * Extract fenced/inline code spans first so `$` inside code is untouched,
 * then replace `$$...$$`, `\[...\]`, `\(...\)`, and `$...$` (including spaced `$ \frac{1}{2} $`)
 * with placeholders holding pre-rendered KaTeX HTML so Lute cannot mangle LaTeX.
 */
function extractMathPlaceholders(
    input: string,
    forceInline = false,
): { text: string; restore: (html: string) => string } {
    const codeStash: string[] = [];
    const mathStash: string[] = [];

    // 1. Stash fenced code blocks and inline code spans
    let work = input.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
        const idx = codeStash.length;
        codeStash.push(m);
        return `@@LHCODE${idx}@@`;
    });

    const stashMath = (tex: string, displayMode: boolean): string => {
        const idx = mathStash.length;
        mathStash.push(renderTex(tex, displayMode));
        return `@@LHMATH${idx}@@`;
    };

    // 2. Display vs inline $$...$$: only use displayMode when $$...$$ is standalone on its own line(s);
    //    if embedded mid-sentence (e.g. "where $$x$$ is..."), render inline so no unwanted newlines appear.
    work = work.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string, offset: number, full: string) => {
        const before = full.slice(0, offset);
        const after = full.slice(offset + match.length);
        const lineStart = /(?:^|\n)[ \t]*$/.test(before);
        const lineEnd = /^[ \t]*(?:\r?\n|$)/.test(after);
        const isStandalone = !forceInline && ((lineStart && lineEnd) || tex.includes("\n"));
        return stashMath(tex, isStandalone);
    });
    work = work.replace(/\\{1,2}\[([\s\S]+?)\\{1,2}\]/g, (match, tex: string, offset: number, full: string) => {
        const before = full.slice(0, offset);
        const after = full.slice(offset + match.length);
        const lineStart = /(?:^|\n)[ \t]*$/.test(before);
        const lineEnd = /^[ \t]*(?:\r?\n|$)/.test(after);
        const isStandalone = !forceInline && ((lineStart && lineEnd) || tex.includes("\n"));
        return stashMath(tex, isStandalone);
    });

    // 3. Inline math: \(...\) and over-escaped \\(...\\)
    work = work.replace(/\\{1,2}\(([\s\S]+?)\\{1,2}\)/g, (_m, tex) => stashMath(tex, false));

    // 4. Inline math: $...$ (single line; allows inner spaces like "$ \frac{1}{2} $" if it contains math/TeX)
    work = work.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (match, prefix, tex: string) => {
        const trimmed = tex.trim();
        if (!trimmed) return match;
        // Skip pure currency numbers like "$50" ... "$20"
        if (/^\d[\d,.\s]*$/.test(trimmed)) return match;
        const hasOuterSpace = /^\s|\s$/.test(tex);
        if (hasOuterSpace) {
            // Only treat spaced "$ ... $" as math if it clearly contains TeX commands, math operators, or swallowed escapes
            const looksLikeMath = /[\\^_{}=<>+\-*/\b\t\v\f\r]/.test(tex);
            if (!looksLikeMath) return match;
        }
        return `${prefix}${stashMath(tex, false)}`;
    });

    // 5. Restore stashed code spans before passing to Lute
    work = work.replace(/@@LHCODE(\d+)@@/g, (_m, idx) => codeStash[Number(idx)] ?? "");

    const restore = (html: string): string =>
        html
            .replace(/@@LHMATH(\d+)@@/g, (_m, idx) => mathStash[Number(idx)] ?? "")
            .replace(/<p>\s*(<div class="lh-math-block">[\s\S]*?<\/div>)\s*<\/p>/g, "$1");

    return { text: work, restore };
}

/** Render markdown + LaTeX text to HTML suitable for `.b3-typography` inside SiYuan. */
export function renderMarkdown(md: string): string {
    if (!md || !md.trim()) return "";

    const { text: mathProtected, restore: restoreMath } = extractMathPlaceholders(md);

    // Transform GitHub-style > [!IMPORTANT] / > [!NOTE] callouts into styled callout blocks before rendering
    const processed = mathProtected.replace(
        /^>\s*\[!(IMPORTANT|NOTE|TIP|WARNING|CAUTION)\]\s*\n((?:>.*(?:\n|$))*)/gm,
        (_match, kind, body) => {
            const cleanBody = String(body)
                .replace(/^>\s?/gm, "")
                .trim();
            return `\n<div class="lh-callout lh-callout--${String(kind).toLowerCase()}"><div class="lh-callout__title">${escapeHtml(
                kind,
            )}</div><div class="lh-callout__body">${escapeHtml(cleanBody)}</div></div>\n`;
        },
    );

    // Transform SiYuan block references ((id "anchor")) / ((id 'anchor')) / ((id)) into interactive glass pills
    const docIconSvg = `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="12" height="12"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    const withBlockRefs = processed.replace(
        /\(\((\d{14}-[a-z0-9]{7})(?:\s+(?:"([^"]+)"|'([^']+)'))?\)\)/gi,
        (_m, blockId, dqAnchor, sqAnchor) => {
            const label = dqAnchor || sqAnchor || blockId;
            return `<span class="lh-block-ref" data-action="open-siyuan-doc" data-doc-id="${escapeHtml(
                blockId,
            )}" data-block-ref-id="${escapeHtml(blockId)}" title="SiYuan Block (${escapeHtml(
                blockId,
            )}) — Click to open, hover to preview">${docIconSvg}<span>${escapeHtml(label)}</span></span>`;
        },
    );

    const fixAssetImgSrc = (html: string): string =>
        html.replace(/(<img\b[^>]*\bsrc=["'])(?:\.\/)?(assets\/[^"']+["'])/gi, "$1/$2");

    const lute = getLute();
    if (lute && typeof lute.Md2HTML === "function") {
        try {
            return fixAssetImgSrc(restoreMath(lute.Md2HTML(withBlockRefs)));
        } catch {
            // Fall through to lightweight fallback
        }
    }

    // Fallback formatter if Lute is unavailable
    const paragraphs = withBlockRefs.split(/\n{2,}/);
    const fallbackHtml = paragraphs
        .map((p) => {
            if (p.trim().startsWith('<div class="lh-callout')) return p;
            const escaped = escapeHtml(p)
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/`([^`]+)`/g, "<code>$1</code>")
                .replace(/\n/g, "<br>");
            return `<p>${escaped}</p>`;
        })
        .join("\n");
    return fixAssetImgSrc(restoreMath(fallbackHtml));
}

/**
 * Render single-line / badge / quote text with full universal KaTeX math healing,
 * forcing all math inline (no block <div>/<p> wrappers) so it fits cleanly inside badges & headers.
 */
export function renderInlineMarkdown(text: string): string {
    if (!text || !text.trim()) return "";
    // Collapse newlines so standalone $$...$$ is rendered inline inside compact badges/quotes
    const singleLine = text.replace(/\s+/g, " ").trim();
    const { text: mathProtected, restore: restoreMath } = extractMathPlaceholders(singleLine, true);
    const formatted = escapeHtml(mathProtected)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    return restoreMath(formatted);
}
