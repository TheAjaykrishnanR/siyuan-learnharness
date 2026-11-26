/**
 * Mini SiYuan Note Chat Input (`SiYuanBlockInput`).
 *
 * Mounts a real standalone SiYuan `Protyle` editor (`lite: true`) inside an elevated,
 * shadow-floated composer card that inherits SiYuan's background grid and matches
 * modern AI chat interfaces.
 */

import {
    BookOpen,
    Check,
    ChevronDown,
    createElement,
    Dumbbell,
    ListChecks,
    MessageSquareText,
    Mic,
    Paperclip,
    Send,
    Settings,
    Square,
} from "lucide";
import { Protyle, showMessage, type App } from "siyuan";
import { localStt } from "./local-stt";
import { escapeHtml } from "./markdown";

export interface ComposerPillsState {
    modeLabel: string;
    modelLabel: string;
    mechanicLabel: string;
}

export interface ModelPickerGroup {
    providerId: string;
    providerLabel: string;
    models: string[];
    activeProviderId: string;
    activeModelId: string;
}

export interface SiYuanBlockInputOptions {
    app: App;
    placeholder?: string;
    getPillsState?: () => ComposerPillsState;
    getModelGroups?: () => ModelPickerGroup[];
    getSttModelId?: () => string;
    onSelectModel?: (providerId: string, modelId: string) => void;
    onOpenSettings?: () => void;
    onToggleMode?: () => void;
    onCycleModel?: () => void;
    onToggleMechanic?: () => void;
    onAttachActiveNote?: () => void;
    onSubmit: (payload: {
        displayMarkdown: string;
        referencedBlockIds: string[];
        imagePaths: string[];
    }) => void;
    onStop: () => void;
}

// Official Lucide icons rendered directly via Lucide's createElement
// Enforce fill: none !important so SiYuan theme CSS doesn't accidentally fill outline strokes
const svgOpts = (size = 15) => ({
    width: size,
    height: size,
    "stroke-width": 1.8,
    style: "fill: none !important; stroke: currentColor !important;",
});

const PAPER_PLANE_SVG = createElement(Send, svgOpts(14)).outerHTML;

const STOP_SQUARE_SVG = createElement(Square, {
    width: 12,
    height: 12,
    "stroke-width": 1.8,
    fill: "currentColor",
    style: "fill: currentColor !important; stroke: none !important;",
}).outerHTML;

const NOTE_LINK_SVG = createElement(Paperclip, svgOpts(15)).outerHTML;
const TEACH_ICON_SVG = createElement(BookOpen, svgOpts(15)).outerHTML;
const PRACTICE_ICON_SVG = createElement(Dumbbell, svgOpts(15)).outerHTML;
const QUIZ_ICON_SVG = createElement(ListChecks, svgOpts(15)).outerHTML;
const EXPLAIN_ICON_SVG = createElement(MessageSquareText, svgOpts(15)).outerHTML;
const MIC_ICON_SVG = createElement(Mic, svgOpts(15)).outerHTML;
const CHEVRON_DOWN_SVG = createElement(ChevronDown, svgOpts(12)).outerHTML;
const CHECK_SVG = createElement(Check, svgOpts(13)).outerHTML;
const SETTINGS_SVG = createElement(Settings, svgOpts(13)).outerHTML;

export class SiYuanBlockInput {
    private container: HTMLElement;
    private opts: SiYuanBlockInputOptions;
    private protyleInstance: Protyle | null = null;
    private busy = false;

    private cardEl!: HTMLElement;
    private protyleHostEl!: HTMLElement;
    private modeBtnEl!: HTMLButtonElement;
    private modelBtnEl!: HTMLButtonElement;
    private modelPillTextEl!: HTMLElement;
    private mechanicBtnEl!: HTMLButtonElement;
    private modelMenuEl!: HTMLElement;
    private micBtnEl!: HTMLButtonElement;
    private voiceBarEl!: HTMLElement;
    private voiceCanvasEl!: HTMLCanvasElement;
    private voiceStatusEl!: HTMLElement;
    private liveVoiceTextNode: Text | null = null;
    private liveVoicePrefix = "";
    private actionBtnEl!: HTMLButtonElement;
    private boundDocClick: ((e: MouseEvent) => void) | null = null;
    private boundDocKeydown: ((e: KeyboardEvent) => void) | null = null;

    constructor(container: HTMLElement, opts: SiYuanBlockInputOptions) {
        this.container = container;
        this.opts = opts;
        this.mount();
    }

    public destroy(): void {
        if (this.boundDocClick) {
            document.removeEventListener("click", this.boundDocClick);
            this.boundDocClick = null;
        }
        if (this.boundDocKeydown) {
            document.removeEventListener("keydown", this.boundDocKeydown);
            this.boundDocKeydown = null;
        }
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
            <div class="lh-voice-bar fn__none">
                <canvas class="lh-voice-waveform"></canvas>
                <span class="lh-voice-status">Listening...</span>
            </div>
            <div class="lh-composer-card__footer">
                <div class="lh-composer-card__left">
                    <button class="lh-composer-icon-btn" type="button" data-composer-action="attach-note" title="Attach active SiYuan note">
                        ${NOTE_LINK_SVG}
                    </button>
                    <button class="lh-composer-icon-btn lh-mic-btn" type="button" data-composer-action="toggle-mic" title="Voice input (local)">
                        ${MIC_ICON_SVG}
                    </button>
                    <span class="lh-composer-sep" aria-hidden="true"></span>
                    <button class="lh-composer-icon-btn lh-mode-btn" type="button" data-composer-action="toggle-mode" title="Mode: ${escapeHtml(pills.modeLabel)} (click to switch)">
                        ${TEACH_ICON_SVG}
                    </button>
                    <button class="lh-composer-icon-btn lh-mechanic-btn" type="button" data-composer-action="toggle-mechanic" title="Quizzing: ${escapeHtml(pills.mechanicLabel)} (click to toggle)">
                        ${QUIZ_ICON_SVG}
                    </button>
                </div>
                <div class="lh-composer-card__right">
                    <button class="lh-model-trigger" type="button" data-composer-action="cycle-model" title="Choose model">
                        <span class="lh-pill-model-text">${escapeHtml(pills.modelLabel)}</span>
                        <span class="lh-model-trigger__chev">${CHEVRON_DOWN_SVG}</span>
                    </button>
                    <button class="lh-send-plane-btn lh-send-plane-btn--empty" type="button" title="Send (Enter)">
                        ${PAPER_PLANE_SVG}
                    </button>
                </div>
            </div>
        `;
        this.modelMenuEl = document.createElement("div");
        this.modelMenuEl.className = "lh-model-menu fn__none";

        this.container.innerHTML = "";
        this.container.appendChild(this.modelMenuEl);
        this.container.appendChild(this.cardEl);
        this.protyleHostEl = this.cardEl.querySelector(".lh-composer-card__editor") as HTMLElement;
        this.micBtnEl = this.cardEl.querySelector(".lh-mic-btn") as HTMLButtonElement;
        this.voiceBarEl = this.cardEl.querySelector(".lh-voice-bar") as HTMLElement;
        this.voiceCanvasEl = this.cardEl.querySelector(".lh-voice-waveform") as HTMLCanvasElement;
        this.voiceStatusEl = this.cardEl.querySelector(".lh-voice-status") as HTMLElement;
        this.modeBtnEl = this.cardEl.querySelector(".lh-mode-btn") as HTMLButtonElement;
        this.mechanicBtnEl = this.cardEl.querySelector(".lh-mechanic-btn") as HTMLButtonElement;
        this.modelBtnEl = this.cardEl.querySelector(".lh-model-trigger") as HTMLButtonElement;
        this.modelPillTextEl = this.cardEl.querySelector(".lh-pill-model-text") as HTMLElement;
        this.actionBtnEl = this.cardEl.querySelector(".lh-send-plane-btn") as HTMLButtonElement;

        this.refreshPills();
        this.initProtyle();
        this.syncBackgroundGridFromWorkspace();
        this.bindEvents();
    }

    public refreshPills(): void {
        const pills = this.opts.getPillsState?.();
        if (!pills) return;
        const isPractice = pills.modeLabel.toLowerCase().includes("practice");
        const isExplain = pills.mechanicLabel.toLowerCase().includes("explain");

        if (this.modeBtnEl) {
            this.modeBtnEl.innerHTML = isPractice ? PRACTICE_ICON_SVG : TEACH_ICON_SVG;
            this.modeBtnEl.classList.toggle("lh-composer-icon-btn--active", isPractice);
            this.modeBtnEl.title = isPractice
                ? "Practice Mode (click to switch to Teach)"
                : "Teach Mode (click to switch to Practice)";
        }
        if (this.mechanicBtnEl) {
            this.mechanicBtnEl.innerHTML = isExplain ? EXPLAIN_ICON_SVG : QUIZ_ICON_SVG;
            this.mechanicBtnEl.classList.toggle("lh-composer-icon-btn--active", isExplain);
            this.mechanicBtnEl.title = isExplain
                ? "Free-Recall / Explain (click to switch to Quiz)"
                : "Multiple-Choice Quiz (click to switch to Explain)";
        }
        if (this.modelPillTextEl) {
            this.modelPillTextEl.textContent = pills.modelLabel;
        }
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

    /** Extract clean Markdown + all referenced SiYuan block IDs + pasted image paths from the Protyle WYSIWYG DOM. */
    public extractContent(): { markdown: string; referencedBlockIds: string[]; imagePaths: string[] } {
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return { markdown: "", referencedBlockIds: [], imagePaths: [] };

        const refIds = new Set<string>();
        const imgPaths = new Set<string>();
        const clone = wysiwygEl.cloneNode(true) as HTMLElement;

        clone.querySelectorAll("img").forEach((img) => {
            const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
            if (raw.trim()) imgPaths.add(raw.trim());
        });

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
            imagePaths: Array.from(imgPaths),
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
        const { markdown, referencedBlockIds, imagePaths } = this.extractContent();
        if (!markdown && referencedBlockIds.length === 0 && imagePaths.length === 0) return;

        this.clear();
        this.opts.onSubmit({
            displayMarkdown: markdown,
            referencedBlockIds,
            imagePaths,
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

    /** Append dictated plain text into the Protyle editor. */
    public insertPlainText(text: string): void {
        const clean = text.trim();
        if (!clean) return;
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return;

        const editables = wysiwygEl.querySelectorAll('[contenteditable="true"]');
        let targetEditable = (editables.length > 0 ? editables[editables.length - 1] : null) as HTMLElement | null;
        if (!targetEditable) {
            wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
            targetEditable = wysiwygEl.querySelector('[contenteditable="true"]') as HTMLElement | null;
        }
        if (targetEditable) {
            const existing = (targetEditable.textContent ?? "").replace(/\u200B/g, "");
            const prefix = existing.length > 0 && !/\s$/.test(existing) ? " " : "";
            targetEditable.appendChild(document.createTextNode(`${prefix}${clean}`));
        }
        this.syncEmptyState();
        this.protyleHostEl.scrollTop = this.protyleHostEl.scrollHeight;
    }

    private updateLiveVoiceText(text: string): void {
        const clean = text.trim();
        if (!clean) return;
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return;

        if (!this.liveVoiceTextNode || !wysiwygEl.contains(this.liveVoiceTextNode)) {
            const editables = wysiwygEl.querySelectorAll('[contenteditable="true"]');
            let targetEditable = (editables.length > 0 ? editables[editables.length - 1] : null) as HTMLElement | null;
            if (!targetEditable) {
                wysiwygEl.innerHTML = this.createEmptyParagraphHtml();
                targetEditable = wysiwygEl.querySelector('[contenteditable="true"]') as HTMLElement | null;
            }
            if (!targetEditable) return;
            const existing = (targetEditable.textContent ?? "").replace(/\u200B/g, "");
            this.liveVoicePrefix = existing.length > 0 && !/\s$/.test(existing) ? " " : "";
            this.liveVoiceTextNode = document.createTextNode(`${this.liveVoicePrefix}${clean}`);
            targetEditable.appendChild(this.liveVoiceTextNode);
        } else {
            this.liveVoiceTextNode.data = `${this.liveVoicePrefix}${clean}`;
        }
        this.syncEmptyState();
        this.protyleHostEl.scrollTop = this.protyleHostEl.scrollHeight;
    }

    private async handleMicClick(): Promise<void> {
        if (this.micBtnEl.classList.contains("lh-mic-btn--busy")) return;
        if (localStt.isRecording()) {
            this.micBtnEl.classList.remove("lh-mic-btn--recording");
            this.micBtnEl.classList.add("lh-mic-btn--busy");
            this.voiceStatusEl.textContent = "Finishing...";
            try {
                await localStt.stopLiveSession();
            } catch (err: any) {
                showMessage(`Voice error: ${err?.message ?? String(err)}`, 4000, "error");
            } finally {
                this.liveVoiceTextNode = null;
                this.liveVoicePrefix = "";
                this.micBtnEl.classList.remove("lh-mic-btn--busy");
                this.micBtnEl.title = "Voice input (Oído WASM)";
                this.voiceBarEl.classList.add("fn__none");
            }
        } else {
            try {
                this.liveVoiceTextNode = null;
                this.liveVoicePrefix = "";
                this.voiceBarEl.classList.remove("fn__none");
                this.voiceStatusEl.textContent = "Loading Oído...";
                await localStt.startLiveSession({
                    modelId: this.opts.getSttModelId?.(),
                    canvas: this.voiceCanvasEl,
                    onPartial: (text) => {
                        this.updateLiveVoiceText(text);
                    },
                    onFinal: (text) => {
                        this.updateLiveVoiceText(text);
                    },
                    onStatus: (st) => {
                        if (st.message) this.voiceStatusEl.textContent = st.message;
                    },
                    onError: (err) => {
                        showMessage(`Voice error: ${err.message}`, 4000, "error");
                    },
                });
                this.micBtnEl.classList.add("lh-mic-btn--recording");
                this.micBtnEl.title = "Stop recording";
            } catch (err: any) {
                this.liveVoiceTextNode = null;
                this.voiceBarEl.classList.add("fn__none");
                showMessage(`Voice error: ${err?.message ?? String(err)}`, 4000, "error");
            }
        }
    }

    private syncEmptyState(): void {
        const wysiwygEl = this.getWysiwygElement();
        if (!wysiwygEl) return;
        const hasBlockRef = Boolean(wysiwygEl.querySelector('[data-type="block-ref"]'));
        const hasImage = Boolean(wysiwygEl.querySelector("img"));
        const hasNonParagraphBlock = Boolean(
            wysiwygEl.querySelector(
                '[data-type="NodeCodeBlock"], [data-type="NodeMathBlock"], [data-type="NodeList"], [data-type="NodeBlockquote"], [data-type="NodeHeading"], [data-type="NodeTable"]',
            ),
        );
        const hasText = this.getPlainText().length > 0;
        const isEmpty = !hasText && !hasBlockRef && !hasImage && !hasNonParagraphBlock;

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

    private closeModelMenu(): void {
        this.modelMenuEl?.classList.add("fn__none");
        this.modelBtnEl?.classList.remove("lh-model-trigger--open");
    }

    private toggleModelMenu(): void {
        if (!this.opts.getModelGroups) {
            this.opts.onCycleModel?.();
            this.refreshPills();
            return;
        }
        const isOpen = !this.modelMenuEl.classList.contains("fn__none");
        if (isOpen) {
            this.closeModelMenu();
            return;
        }
        const groups = this.opts.getModelGroups();
        const groupsHtml = groups
            .filter((g) => g.models.length > 0)
            .map(
                (g) => `
                <div class="lh-model-menu__group">
                    <div class="lh-model-menu__group-label">${escapeHtml(g.providerLabel)}</div>
                    ${g.models
                        .map((m) => {
                            const isActive = g.providerId === g.activeProviderId && m === g.activeModelId;
                            return `
                            <button type="button" class="lh-model-menu__item ${
                                isActive ? "lh-model-menu__item--active" : ""
                            }" data-model-provider="${escapeHtml(g.providerId)}" data-model-id="${escapeHtml(m)}">
                                <span class="lh-model-menu__name">${escapeHtml(m)}</span>
                                <span class="lh-model-menu__check">${isActive ? CHECK_SVG : ""}</span>
                            </button>
                        `;
                        })
                        .join("")}
                </div>
            `,
            )
            .join("");

        this.modelMenuEl.innerHTML = `
            <div class="lh-model-menu__list">
                ${groupsHtml || `<div class="lh-model-menu__empty">No models configured yet.</div>`}
            </div>
            <div class="lh-model-menu__footer">
                <button type="button" class="lh-model-menu__config-btn" data-model-action="open-settings">${SETTINGS_SVG}<span>Configure providers</span></button>
            </div>
        `;
        this.modelMenuEl.classList.remove("fn__none");
        this.modelBtnEl?.classList.add("lh-model-trigger--open");
    }

    private bindEvents(): void {
        this.boundDocClick = (e: MouseEvent) => {
            if (!this.container.contains(e.target as Node)) {
                this.closeModelMenu();
            }
        };
        document.addEventListener("click", this.boundDocClick);

        this.boundDocKeydown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !this.modelMenuEl.classList.contains("fn__none")) {
                e.preventDefault();
                e.stopPropagation();
                this.closeModelMenu();
            }
        };
        document.addEventListener("keydown", this.boundDocKeydown);

        this.modelMenuEl.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const cfgBtn = target.closest('[data-model-action="open-settings"]') as HTMLElement | null;
            if (cfgBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.closeModelMenu();
                this.opts.onOpenSettings?.();
                return;
            }
            const itemBtn = target.closest("[data-model-provider][data-model-id]") as HTMLElement | null;
            if (itemBtn) {
                e.preventDefault();
                e.stopPropagation();
                const pid = itemBtn.dataset.modelProvider!;
                const mid = itemBtn.dataset.modelId!;
                this.closeModelMenu();
                this.opts.onSelectModel?.(pid, mid);
                this.refreshPills();
            }
        });

        // Footer pill and icon actions
        this.cardEl.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("[data-composer-action]") as HTMLElement | null;
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const act = btn.dataset.composerAction;
            if (act === "attach-note") {
                this.closeModelMenu();
                this.opts.onAttachActiveNote?.();
            } else if (act === "toggle-mic") {
                this.closeModelMenu();
                void this.handleMicClick();
            } else if (act === "toggle-mode") {
                this.closeModelMenu();
                this.opts.onToggleMode?.();
                this.refreshPills();
            } else if (act === "cycle-model") {
                this.toggleModelMenu();
            } else if (act === "toggle-mechanic") {
                this.closeModelMenu();
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
