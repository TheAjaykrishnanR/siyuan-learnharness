/**
 * Safe Markdown + LaTeX + Callout renderer using SiYuan's built-in Lute engine
 * with a clean fallback formatter.
 */

let sharedLute: any = null;

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

/** Render markdown text to HTML suitable for `.b3-typography` inside SiYuan. */
export function renderMarkdown(md: string): string {
    if (!md || !md.trim()) return "";

    // Transform GitHub-style > [!IMPORTANT] / > [!NOTE] callouts into styled callout blocks before rendering
    const processed = md.replace(
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

    const lute = getLute();
    if (lute && typeof lute.Md2HTML === "function") {
        try {
            return lute.Md2HTML(withBlockRefs);
        } catch {
            // Fall through to lightweight fallback
        }
    }

    // Fallback formatter if Lute is unavailable
    const paragraphs = withBlockRefs.split(/\n{2,}/);
    return paragraphs
        .map((p) => {
            if (p.trim().startsWith("<div class=\"lh-callout")) return p;
            const escaped = escapeHtml(p)
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/`([^`]+)`/g, "<code>$1</code>")
                .replace(/\n/g, "<br>");
            return `<p>${escaped}</p>`;
        })
        .join("\n");
}
