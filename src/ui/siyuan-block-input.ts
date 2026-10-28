/**
 * Mini SiYuan Note Chat Input (`SiYuanBlockInput`).
 *
 * Mounts a real standalone SiYuan `Protyle` editor (`lite: true`) inside an elevated,
 * shadow-floated composer card that inherits SiYuan's background grid and matches
 * modern AI chat interfaces.
 */

import {
    Atom,
    Brain,
    createElement,
    Image,
    Send,
    ShieldCheck,
    Square,
} from "lucide";
import { Protyle, type App } from "siyuan";
import { escapeHtml } from "./markdown";

export interface ComposerPillsState {
    modeLabel: string;
    modelLabel: string;
    mechanicLabel: string;
}

export interface SiYuanBlockInputOptions {
    app: App;
    placeholder?: string;
    getPillsState?: () => ComposerPillsState;
    onToggleMode?: () => void;
    onCycleModel?: () => void;
    onToggleMechanic?: () => void;
    onAttachActiveNote?: () => void;
    onSubmit: (payload: {
        displayMarkdown: string;
        referencedBlockIds: string[];
    }) => void;
    onStop: () => void;
}

// Official Lucide icons rendered directly via Lucide's createElement
// Enforce fill: none !important so SiYuan theme CSS doesn't accidentally fill outline strokes
const PAPER_PLANE_SVG = createElement(Send, {
    width: 15,
    height: 15,
    "stroke-width": 1.75,
    style: "fill: none !important; stroke: currentColor !important;",
}).outerHTML;

const STOP_SQUARE_SVG = createElement(Square, {
    width: 14,
    height: 14,
    "stroke-width": 1.75,
    fill: "currentColor",
    style: "fill: currentColor !important; stroke: none !important;",
}).outerHTML;

const NOTE_LINK_SVG = createElement(Image, {
    width: 15,
    height: 15,
    "stroke-width": 1.75,
    style: "fill: none !important; stroke: currentColor !important;",
}).outerHTML;

const SHIELD_ICON_SVG = createElement(ShieldCheck, {
    width: 14,
    height: 14,
    "stroke-width": 1.75,
    style: "fill: none !important; stroke: currentColor !important;",
}).outerHTML;

const ATOM_ICON_SVG = createElement(Atom, {
    width: 14,
    height: 14,
    "stroke-width": 1.75,
    style: "fill: none !important; stroke: currentColor !important;",
}).outerHTML;

const BRAIN_ICON_SVG = createElement(Brain, {
    width: 14,
    height: 14,
    "stroke-width": 1.75,
    style: "fill: none !important; stroke: currentColor !important;",
}).outerHTML;

export class SiYuanBlockInput {
    private container: HTMLElement;
    private opts: SiYuanBlockInputOptions;
    private protyleInstance: Protyle | null = null;
    private busy = false;

    private cardEl!: HTMLElement;
    private protyleHostEl!: HTMLElement;
    private modePillTextEl!: HTMLElement;
    private modelPillTextEl!: HTMLElement;
    private mechanicPillTextEl!: HTMLElement;
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
        const pills = this.opts.getPillsState?.() ?? {
            modeLabel: "Teach mode",
            modelLabel: "deepseek-chat",
            mechanicLabel: "Quiz",
        };

        this.cardEl = document.createElement("div");
        this.cardEl.className = "lh-composer-card";
        this.cardEl.innerHTML = `
            <div class="lh-composer-card__editor" data-placeholder="${escapeHtml(
                this.opts.placeholder ?? "Write a note or question... (/ for blocks, (( to reference notes)",
            )}"></div>
            <div class="lh-composer-card__footer">
                <div class="lh-composer-card__left">
                    <button class="lh-composer-icon-btn" type="button" data-composer-action="attach-note" title="Insert active SiYuan note into textbox">
                        ${NOTE_LINK_SVG}
                    </button>
                    <button class="lh-composer-pill" type="button" data-composer-action="toggle-mode" title="Click to switch between Teaching and Practice mode">
                        ${SHIELD_ICON_SVG}
                        <span class="lh-pill-mode-text">${escapeHtml(pills.modeLabel)}</span>
                    </button>
                </div>
                <div class="lh-composer-card__right">
                    <button class="lh-composer-pill" type="button" data-composer-action="cycle-model" title="Click to switch LLM provider/model">
                        ${ATOM_ICON_SVG}
                        <span class="lh-pill-model-text">${escapeHtml(pills.modelLabel)}</span>
                    </button>
                    <button class="lh-composer-pill" type="button" data-composer-action="toggle-mechanic" title="Click to toggle Multiple-Choice (Quiz) vs Free-Recall (Explain)">
                        ${BRAIN_ICON_SVG}
                        <span class="lh-pill-mechanic-text">${escapeHtml(pills.mechanicLabel)}</span>
                    </button>
                    <button class="lh-send-plane-btn lh-send-plane-btn--empty" type="button" title="Send (Enter)">
                        ${PAPER_PLANE_SVG}
                    </button>
                </div>
            </div>
        `;
        this.container.innerHTML = "";
        this.container.appendChild(this.cardEl);

        this.protyleHostEl = this.cardEl.querySelector(".lh-composer-card__editor") as HTMLElement;
        this.modePillTextEl = this.cardEl.querySelector(".lh-pill-mode-text") as HTMLElement;
        this.modelPillTextEl = this.cardEl.querySelector(".lh-pill-model-text") as HTMLElement;
        this.mechanicPillTextEl = this.cardEl.querySelector(".lh-pill-mechanic-text") as HTMLElement;
        this.actionBtnEl = this.cardEl.querySelector(".lh-send-plane-btn") as HTMLButtonElement;

        this.initProtyle();
        this.syncBackgroundGridFromWorkspace();
        this.bindEvents();
    }

    public refreshPills(): void {
        const pills = this.opts.getPillsState?.();
        if (!pills) return;
        if (this.modePillTextEl) this.modePillTextEl.textContent = pills.modeLabel;
        if (this.modelPillTextEl) this.modelPillTextEl.textContent = pills.modelLabel;
        if (this.mechanicPillTextEl) this.mechanicPillTextEl.textContent = pills.mechanicLabel;
    }

    /**
     * Inherit any background-image grid applied by SiYuan's background grid plugin
     * only if our inner Protyle doesn't already have it via CSS.
     */
    public syncBackgroundGridFromWorkspace(): void {
        try {
            const innerElements = Array.from(
                this.protyleHostEl.querySelectorAll(".protyle, .protyle-content, .protyle-wysiwyg"),
            ) as HTMLElement[];

            for (const inner of innerElements) {
                const innerCs = window.getComputedStyle(inner);
                if (innerCs.backgroundImage && innerCs.backgroundImage !== "none") {
                    // The background grid plugin already applies its grid directly to our inner Protyle!
                    return;
                }
            }

            const targetEl = this.getWysiwygElement() ?? this.protyleHostEl;
            const candidates = Array.from(
                document.querySelectorAll(
                    ".layout__center .protyle-wysiwyg, .layout__center .protyle-content, .layout__center .protyle",
                ),
            ) as HTMLElement[];

            for (const el of candidates) {
                if (this.cardEl.contains(el)) continue;
                const cs = window.getComputedStyle(el);
                if (cs.backgroundImage && cs.backgroundImage !== "none") {
                    targetEl.style.backgroundImage = cs.backgroundImage;
                    targetEl.style.backgroundSize = cs.backgroundSize;
                    targetEl.style.backgroundPosition = cs.backgroundPosition;
                    targetEl.style.backgroundRepeat = cs.backgroundRepeat;
                    return;
                }
            }
        } catch {
            // ignore
        }
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
                    this.syncBackgroundGridFromWorkspace();
                },
            });
            this.ensureEditableProtyle(this.protyleInstance, rootId);
        } catch {
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

        clone.querySelectorAll('[data-type="block-ref"]').forEach((el) => {
            const id = el.getAttribute("data-id") || "";
            const label = (el.textContent || id).replace(/\u200B/g, "").trim().replace(/"/g, "'");
            if (/^\d{14}-[a-z0-9]{7}$/i.test(id)) {
                refIds.add(id);
                el.replaceWith(document.createTextNode(`((${id} "${label}"))`));
            }
        });

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
            this.actionBtnEl.classList.add("lh-send-plane-btn--stop");
            this.actionBtnEl.classList.remove("lh-send-plane-btn--empty");
            this.actionBtnEl.title = "Stop generating";
        } else {
            this.actionBtnEl.innerHTML = PAPER_PLANE_SVG;
            this.actionBtnEl.classList.remove("lh-send-plane-btn--stop");
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
                this.actionBtnEl.classList.add("lh-send-plane-btn--empty");
            }
        } else {
            this.protyleHostEl.classList.remove("lh-composer-card__editor--empty");
            this.actionBtnEl.classList.remove("lh-send-plane-btn--empty");
        }
    }

    private bindEvents(): void {
        // Footer pill and icon actions
        this.cardEl.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("[data-composer-action]") as HTMLElement | null;
            if (!btn) return;
            e.preventDefault();
            const act = btn.dataset.composerAction;
            if (act === "attach-note") {
                this.opts.onAttachActiveNote?.();
            } else if (act === "toggle-mode") {
                this.opts.onToggleMode?.();
                this.refreshPills();
            } else if (act === "cycle-model") {
                this.opts.onCycleModel?.();
                this.refreshPills();
            } else if (act === "toggle-mechanic") {
                this.opts.onToggleMechanic?.();
                this.refreshPills();
            }
        });

        // Click on the paper-plane Send / Stop icon button
        this.actionBtnEl.addEventListener("click", (e) => {
            e.preventDefault();
            if (this.busy) {
                this.opts.onStop();
            } else {
                this.submit();
            }
        });

        this.protyleHostEl.addEventListener("focusin", () => {
            this.syncBackgroundGridFromWorkspace();
        });

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

        this.protyleHostEl.addEventListener(
            "keydown",
            (e: KeyboardEvent) => {
                if ((e as any)._lhSyntheticEnter) {
                    return;
                }
                if (e.isComposing || e.keyCode === 229) {
                    return;
                }
                if (e.key !== "Enter") {
                    return;
                }

                if (this.isHintPopupVisible()) {
                    return;
                }

                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.submit();
                    return;
                }

                if (this.isSelectionInsideMultilineBlock()) {
                    return;
                }

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

                e.preventDefault();
                e.stopPropagation();
                this.submit();
            },
            true,
        );
    }
}
