/**
 * Safe Markdown + LaTeX (KaTeX) + Callout renderer using SiYuan's built-in Lute engine
 * with guaranteed KaTeX math rendering and a clean fallback formatter.
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

function renderTex(tex: string, displayMode: boolean): string {
    ensureKatexCss();
    const cleaned = tex.trim();
    if (!cleaned) return "";
    try {
        const html = katex.renderToString(cleaned, {
            displayMode,
            throwOnError: false,
            strict: false,
            trust: false,
            output: "htmlAndMathml",
        });
        return displayMode ? `<div class="lh-math-block">${html}</div>` : `<span class="lh-math-inline">${html}</span>`;
    } catch {
        return displayMode
            ? `<div class="lh-math-block"><code>${escapeHtml(cleaned)}</code></div>`
            : `<span class="lh-math-inline"><code>${escapeHtml(cleaned)}</code></span>`;
    }
}

/**
 * Extract fenced/inline code spans first so `$` inside code is untouched,
 * then replace `$$...$$`, `\[...\]`, `$...$`, and `\(...\)` with placeholders
 * holding pre-rendered KaTeX HTML so Lute cannot mangle LaTeX backslashes/underscores.
 */
function extractMathPlaceholders(input: string): { text: string; restore: (html: string) => string } {
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

    // 2. Display math: $$...$$ and \[...\]
    work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => stashMath(tex, true));
    work = work.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => stashMath(tex, true));

    // 3. Inline math: \(...\)
    work = work.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => stashMath(tex, false));

    // 4. Inline math: $...$ (single line, no leading/trailing space right inside $, avoids "$5 and $10")
    work = work.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (match, prefix, tex) => {
        // Avoid accidental currency matches like "$50" followed by another "$20" in prose
        if (/^\d[\d,.\s]*$/.test(tex.trim())) return match;
        return `${prefix}${stashMath(tex, false)}`;
    });

    // 5. Restore stashed code spans before passing to Lute
    work = work.replace(/@@LHCODE(\d+)@@/g, (_m, idx) => codeStash[Number(idx)] ?? "");

    const restore = (html: string): string =>
        html.replace(/@@LHMATH(\d+)@@/g, (_m, idx) => mathStash[Number(idx)] ?? "");

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

    // Transform SiYuan block references ((id "anchor")) / ((id 'anchor')) / ((id)) into interactive pills
    const withBlockRefs = processed.replace(
        /\(\((\d{14}-[a-z0-9]{7})(?:\s+(?:"([^"]+)"|'([^']+)'))?\)\)/gi,
        (_m, blockId, dqAnchor, sqAnchor) => {
            const label = dqAnchor || sqAnchor || blockId;
            return `<span class="lh-block-ref" data-action="open-siyuan-doc" data-doc-id="${escapeHtml(
                blockId,
            )}" data-block-ref-id="${escapeHtml(blockId)}" title="SiYuan Block (${escapeHtml(
                blockId,
            )}) — Click to open, hover to preview">📄 ${escapeHtml(label)}</span>`;
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
