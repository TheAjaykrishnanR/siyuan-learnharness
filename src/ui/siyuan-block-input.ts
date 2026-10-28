/**
 * Mini SiYuan Note Chat Input (`SiYuanBlockInput`).
 *
 * Mounts a real standalone SiYuan `Protyle` editor (`lite: true`) inside a modern
 * chat composer card so the input box behaves like an authentic mini SiYuan note:
 *   - Native `/` slash commands (headings, code blocks, math blocks, callouts, lists, tables)
 *   - Native `((` block reference search & inline block chips
 *   - Native text selection formatting toolbar & block gutter handles
 *   - `Enter` to send (when `/` or `((` hint menu is closed and not inside a code/math block)
 *   - `Shift+Enter` to create a new SiYuan block inside the mini note
 */

import { Protyle, type App } from "siyuan";
import { escapeHtml } from "./markdown";

export interface SiYuanBlockInputOptions {
    app: App;
    placeholder?: string;
    onSubmit: (payload: {
        displayMarkdown: string;
        referencedBlockIds: string[];
    }) => void;
    onStop: () => void;
}

const SEND_ARROW_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
const STOP_SQUARE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;

export class SiYuanBlockInput {
    private container: HTMLElement;
    private opts: SiYuanBlockInputOptions;
    private protyleInstance: Protyle | null = null;
    private busy = false;

    private cardEl!: HTMLElement;
    private protyleHostEl!: HTMLElement;
    private actionBtnEl!: HTMLButtonElement;

    constructor(container: HTMLElement, opts: SiYuanBlockInputOptions) {
        this.container = container;
        this.opts = opts;
        this.mount();
    }

    public destroy(): void {
        try {
            this.protyleInstance?.destroy();
        } catch {
            // ignore
        }
        this.protyleInstance = null;
    }

    private newNodeId(): string {
        const win = window as any;
        if (win.Lute && typeof win.Lute.NewNodeID === "function") {
            return win.Lute.NewNodeID();
        }
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(
            now.getMinutes(),
        )}${pad(now.getSeconds())}`;
        const rand = Math.random().toString(36).slice(2, 9).padEnd(7, "a");
        return `${ts}-${rand}`;
    }

    private createEmptyParagraphHtml(): string {
        const id = this.newNodeId();
        return `<div data-node-id="${id}" data-type="NodeParagraph" class="p"><div contenteditable="true" spellcheck="false"></div><div class="protyle-attr" contenteditable="false">\u200B</div></div>`;
    }

    private mount(): void {
        this.cardEl = document.createElement("div");
        this.cardEl.className = "lh-composer-card";
        this.cardEl.innerHTML = `
            <div class="lh-composer-card__editor" data-placeholder="${escapeHtml(
                this.opts.placeholder ?? "Write a message, press / for blocks, (( to reference notes...",
            )}"></div>
            <div class="lh-composer-card__footer">
                <span class="lh-composer-card__hint"><code>/</code> blocks · <code>((</code> ref · <code>⇧↵</code> new block</span>
                <button class="lh-send-icon-btn lh-send-icon-btn--empty" type="button" title="Send (Enter)">
                    ${SEND_ARROW_SVG}
                </button>
            </div>
        `;
        this.container.innerHTML = "";
        this.container.appendChild(this.cardEl);

        this.protyleHostEl = this.cardEl.querySelector(".lh-composer-card__editor") as HTMLElement;
        this.actionBtnEl = this.cardEl.querySelector(".lh-send-icon-btn") as HTMLButtonElement;

        this.initProtyle();
        this.bindEvents();
    }

    private initProtyle(): void {
        try {
            const rootId = this.newNodeId();
            this.protyleInstance = new Protyle(this.opts.app, this.protyleHostEl, {
                blockId: "",
                lite: true,
                mode: "wysiwyg",
                action: [],
                render: {
                    background: false,
                    title: false,
                    titleShowTop: false,
                    gutter: true,
                    scroll: false,
                    breadcrumb: false,
                    breadcrumbDocName: false,
                },
                after: (p) => {
                    this.ensureEditableProtyle(p, rootId);
                },
            });
            this.ensureEditableProtyle(this.protyleInstance, rootId);
        } catch {
            // Fallback if Protyle constructor throws in an unusual environment
            this.protyleHostEl.innerHTML = `<div class="protyle-wysiwyg">${this.createEmptyParagraphHtml()}</div>`;
        }
        this.syncEmptyState();
    }

    private ensureEditableProtyle(p: Protyle, rootId: string): void {
        try {
            p.enable();
        } catch {
            // ignore
        }
        const raw = p.protyle;
        if (!raw) return;
        raw.disabled = false;
        if (!raw.block) {
            raw.block = {
                id: rootId,
                rootID: rootId,
                showAll: true,
                mode: 0,
                blockCount: 1,
                action: [],
            };
        } else if (!raw.block.rootID) {
            raw.block.id = rootId;
            raw.block.rootID = rootId;
            raw.block.showAll = true;
        }

        const wysiwygEl = raw.wysiwyg?.element;
        if (wysiwygEl) {
            wysiwygEl.setAttribute("contenteditable", "true");
            if (!wysiwygEl.querySelector("[data-node-id]")) {
                wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
            }
        }
    }

    private getWysiwygElement(): HTMLElement | null {
        return (
            this.protyleInstance?.protyle?.wysiwyg?.element ??
            (this.protyleHostEl.querySelector(".protyle-wysiwyg") as HTMLElement | null)
        );
    }

    private isHintPopupVisible(): boolean {
        const hintEl = this.protyleInstance?.protyle?.hint?.element;
        if (!hintEl) return false;
        return !hintEl.classList.contains("fn__none") && hintEl.innerHTML.trim().length > 0;
    }

    private isSelectionInsideMultilineBlock(): boolean {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const node = sel.anchorNode;
        const el = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement;
        if (!el) return false;
        return Boolean(
            el.closest(
                '[data-type="NodeCodeBlock"], [data-type="NodeMathBlock"], [data-type="NodeHTMLBlock"], .code-block, .table',
            ),
        );
    }

    public getPlainText(): string {
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return "";
        return (wysiwygEl.innerText ?? wysiwygEl.textContent ?? "").replace(/\u200B/g, "").trim();
    }

    /** Extract clean Markdown + all referenced SiYuan block IDs from the Protyle WYSIWYG DOM. */
    public extractContent(): { markdown: string; referencedBlockIds: string[] } {
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return { markdown: "", referencedBlockIds: [] };

        const refIds = new Set<string>();
        const clone = wysiwygEl.cloneNode(true) as HTMLElement;

        // 1. Collect and preserve inline SiYuan block-ref spans (`<span data-type="block-ref" data-id="...">`)
        clone.querySelectorAll('[data-type="block-ref"]').forEach((el) => {
            const id = el.getAttribute("data-id") || "";
            const label = (el.textContent || id).replace(/\u200B/g, "").trim().replace(/"/g, "'");
            if (/^\d{14}-[a-z0-9]{7}$/i.test(id)) {
                refIds.add(id);
                el.replaceWith(document.createTextNode(`((${id} "${label}"))`));
            }
        });

        // 2. Remove non-content Protyle attribute nodes before converting to Markdown
        clone.querySelectorAll(".protyle-attr, .protyle-action__drag").forEach((el) => el.remove());

        let md = "";
        const lute = this.protyleInstance?.protyle?.lute ?? (window as any)?.Lute?.New?.();
        if (lute && typeof lute.BlockDOM2StdMd === "function") {
            try {
                md = String(lute.BlockDOM2StdMd(clone.innerHTML) ?? "").trim();
            } catch {
                md = "";
            }
        }
        if (!md) {
            md = (clone.innerText ?? clone.textContent ?? "").replace(/\u200B/g, "").trim();
        }

        // 3. Also detect any `((2024...))` or `siyuan://blocks/2024...` typed/pasted in the markdown
        for (const m of md.matchAll(/\(\((\d{14}-[a-z0-9]{7})(?:\s+(?:"[^"]*"|'[^']*'))?\)\)/gi)) {
            if (m[1]) refIds.add(m[1]);
        }
        for (const m of md.matchAll(/siyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})/gi)) {
            if (m[1]) refIds.add(m[1]);
        }

        return {
            markdown: md,
            referencedBlockIds: Array.from(refIds),
        };
    }

    public clear(): void {
        const wysiwygEl = this.getWysiwygElement();
        if (wysiwygEl) {
            wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
        }
        try {
            this.protyleInstance?.clearStack();
        } catch {
            // ignore
        }
        this.syncEmptyState();
    }

    public focus(): void {
        const wysiwygEl = this.getWysiwygElement();
        const editable =
            (wysiwygEl?.querySelector('[contenteditable="true"]') as HTMLElement | null) ?? wysiwygEl;
        editable?.focus();
    }

    public setBusy(busy: boolean): void {
        this.busy = busy;
        if (busy) {
            this.actionBtnEl.innerHTML = STOP_SQUARE_SVG;
            this.actionBtnEl.classList.add("lh-send-icon-btn--stop");
            this.actionBtnEl.classList.remove("lh-send-icon-btn--empty");
            this.actionBtnEl.title = "Stop generating";
        } else {
            this.actionBtnEl.innerHTML = SEND_ARROW_SVG;
            this.actionBtnEl.classList.remove("lh-send-icon-btn--stop");
            this.actionBtnEl.title = "Send (Enter)";
            this.syncEmptyState();
        }
    }

    public submit(): void {
        if (this.busy) return;
        const { markdown, referencedBlockIds } = this.extractContent();
        if (!markdown && referencedBlockIds.length === 0) return;

        this.clear();
        this.opts.onSubmit({
            displayMarkdown: markdown,
            referencedBlockIds,
        });
    }

    /** Insert a SiYuan block reference `((id "title"))` directly into the Protyle editor. */
    public insertBlockReference(blockId: string, label?: string): void {
        const cleanId = blockId.trim();
        if (!cleanId) return;
        const text = (label || cleanId).replace(/\s+/g, " ").slice(0, 60);
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return;

        let targetEditable = wysiwygEl.querySelector('[contenteditable="true"]') as HTMLElement | null;
        if (!targetEditable) {
            wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
            targetEditable = wysiwygEl.querySelector('[contenteditable="true"]') as HTMLElement | null;
        }
        if (targetEditable) {
            const span = document.createElement("span");
            span.setAttribute("data-type", "block-ref");
            span.setAttribute("data-id", cleanId);
            span.setAttribute("data-subtype", "s");
            span.textContent = text;
            targetEditable.appendChild(span);
            targetEditable.appendChild(document.createTextNode(" "));
        }
        this.syncEmptyState();
        this.focus();
    }

    private syncEmptyState(): void {
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return;
        const hasBlockRef = Boolean(wysiwygEl.querySelector('[data-type="block-ref"]'));
        const hasNonParagraphBlock = Boolean(
            wysiwygEl.querySelector(
                '[data-type="NodeCodeBlock"], [data-type="NodeMathBlock"], [data-type="NodeList"], [data-type="NodeBlockquote"], [data-type="NodeHeading"], [data-type="NodeTable"]',
            ),
        );
        const hasText = this.getPlainText().length > 0;
        const isEmpty = !hasText && !hasBlockRef && !hasNonParagraphBlock;

        if (isEmpty) {
            this.protyleHostEl.classList.add("lh-composer-card__editor--empty");
            if (!this.busy) {
                this.actionBtnEl.classList.add("lh-send-icon-btn--empty");
            }
        } else {
            this.protyleHostEl.classList.remove("lh-composer-card__editor--empty");
            this.actionBtnEl.classList.remove("lh-send-icon-btn--empty");
        }
    }

    private bindEvents(): void {
        // Click on the circular Send / Stop icon button
        this.actionBtnEl.addEventListener("click", (e) => {
            e.preventDefault();
            if (this.busy) {
                this.opts.onStop();
            } else {
                this.submit();
            }
        });

        // Monitor input mutations inside Protyle to update empty placeholder & button state
        this.protyleHostEl.addEventListener("input", () => {
            const wysiwygEl = this.getWysiwygElement();
            if (wysiwygEl && !wysiwygEl.querySelector("[data-node-id]")) {
                wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
            }
            this.syncEmptyState();
        });

        const observer = new MutationObserver(() => {
            this.syncEmptyState();
        });
        observer.observe(this.protyleHostEl, { childList: true, subtree: true, characterData: true });

        // Capture-phase keydown on the Protyle container:
        // - If Protyle's `/` or `((` hint menu is open, let Protyle handle Enter natively!
        // - If inside a code block / math block / table, let Enter add a line and Ctrl/Cmd+Enter send!
        // - Otherwise, plain Enter sends the message, and Shift+Enter dispatches a native Enter to Protyle to create a new block!
        this.protyleHostEl.addEventListener(
            "keydown",
            (e: KeyboardEvent) => {
                if ((e as any)._lhSyntheticEnter) {
                    return; // Let Protyle handle our synthetic Enter to create a new block
                }
                if (e.isComposing || e.keyCode === 229) {
                    return;
                }
                if (e.key !== "Enter") {
                    return;
                }

                // 1. Let Protyle's `/` or `((` hint popup handle Enter natively
                if (this.isHintPopupVisible()) {
                    return;
                }

                // 2. Ctrl+Enter or Cmd+Enter always submits
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.submit();
                    return;
                }

                // 3. Inside a code block, math block, or table, let plain Enter insert a newline natively
                if (this.isSelectionInsideMultilineBlock()) {
                    return;
                }

                // 4. Shift+Enter -> tell Protyle to create a new SiYuan block!
                if (e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    const wysiwygEl = this.getWysiwygElement();
                    if (wysiwygEl) {
                        const syn = new KeyboardEvent("keydown", {
                            key: "Enter",
                            code: "Enter",
                            keyCode: 13,
                            which: 13,
                            bubbles: true,
                            cancelable: true,
                        });
                        (syn as any)._lhSyntheticEnter = true;
                        wysiwygEl.dispatchEvent(syn);
                    }
                    return;
                }

                // 5. Plain Enter in a normal block -> submit the chat message!
                e.preventDefault();
                e.stopPropagation();
                this.submit();
            },
            true,
        );
    }
}
