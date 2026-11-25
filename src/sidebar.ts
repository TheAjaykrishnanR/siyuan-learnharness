/**
 * LearnHarness Docked Chat View — The single, unified view inside SiYuan Note.
 *
 * Designed to live alongside SiYuan notes in split view:
 *   - Minimal, uncluttered top header (Session selector + New Chat + Graph toggle + Settings)
 *   - Compact 1-line collapsible dependency plan strip (only shown when a plan exists)
 *   - Familiar, clean Chat Window stream (User bubbles + Assistant prose + inline Question cards)
 *   - SiYuan Block-Capable Chat Textbox at the bottom (`SiYuanBlockInput` using `.protyle-wysiwyg` & `Lute`)
 */

import { showMessage, type App } from "siyuan";
import type { SessionRunner } from "./agent/session-runner";
import {
    derivedNodeStatus,
    derivePlanStatusesLh,
    type ChatRecord,
    type LhAssistantMessage,
    type LhToolResultMessage,
    type ProbeAssessment,
    type SideNoteIntent,
    type SideNoteThread,
} from "./core/contracts";
import {
    activeProblemOf,
    danglingQuestionOf,
    newSiyuanNoteContextMessage,
    problemInputForConclude,
} from "./core/messages";
import {
    buildQuestionDataFromToolCall,
    CONFIDENCE_STOPS,
    DEFAULT_CONFIDENCE_INDEX,
    type QuestionAnswerData,
} from "./core/question-core";
import type { ProviderId } from "./core/ports";
import {
    extractAssetImagePaths,
    getBlockById,
    readNoteMarkdown,
    readSiyuanImages,
} from "./siyuan/client";
import type { SiYuanHarnessStores } from "./store/siyuan-store";
import { KnowledgeGraphView } from "./ui/graph-view";
import { localStt } from "./ui/local-stt";
import { escapeHtml, renderMarkdown } from "./ui/markdown";
import { SiYuanBlockInput, type ModelPickerGroup } from "./ui/siyuan-block-input";

const ICON = {
    help: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 .8c0 1.7-2.5 2-2.5 3.7"/><circle cx="12" cy="17.2" r="0.7" fill="currentColor"/></svg>`,
    bridge: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`,
    target: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>`,
    spark: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>`,
    ask: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/></svg>`,
    plan: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6h5a3 3 0 0 1 0 6h-3a3 3 0 0 0 0 6h5"/></svg>`,
    search: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="12" height="12"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    orb: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="22" height="22"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>`,
    chat: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    mic: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="12" height="12"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>`,
    plus: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="15" height="15"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    graph: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="15" height="15"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.2 7.2 10.8 15.8"/><path d="M15.8 7.2 13.2 15.8"/><path d="M8.5 6h7"/></svg>`,
    trash: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`,
    settings: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    minimize: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14"/></svg>`,
    back: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="15" height="15"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>`,
    chevron: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>`,
};

export interface SidebarCallbacks {
    app: App;
    onOpenSettings: () => void;
    onOpenSiyuanDoc: (docId: string) => void;
    onPreviewSiyuanBlock?: (blockId: string, targetEl: HTMLElement) => void;
}

interface ActiveQuestionDraft {
    toolCallId: string;
    selectedValues: Set<string>;
    otherSelected: boolean;
    otherText: string;
    freeText: string;
    thinking: string;
    confidenceIndex: number;
}

export class SidebarView {
    private rootElement: HTMLElement;
    private stores: SiYuanHarnessStores;
    private runner: SessionRunner;
    private callbacks: SidebarCallbacks;

    private activeChatId: string | null = null;
    private viewMode: "chat" | "chats" | "graph" = "chat";
    private planExpanded = false;
    private questionDraft: ActiveQuestionDraft | null = null;

    private sessionTitleEl!: HTMLElement;
    private backBtnEl!: HTMLElement;
    private chatsViewEl!: HTMLElement;
    private sessionSearchEl!: HTMLInputElement;
    private sessionListEl!: HTMLElement;
    private historySearchQuery = "";
    private boundDocClickListener?: (e: MouseEvent) => void;
    private boundDocKeydownListener?: (e: KeyboardEvent) => void;
    private boundSelectionChangeListener?: () => void;
    private boundDocMouseDownListener?: (e: MouseEvent) => void;
    private selectionBarEl!: HTMLElement;
    private currentSelectionQuote = "";
    private currentSelectionAnchor: {
        messageId: string;
        blockIndex: number;
        previousBlockText?: string;
    } | null = null;
    private graphBtnEl!: HTMLElement;
    private planStripEl!: HTMLElement;
    private chatBodyEl!: HTMLElement;
    private graphBodyEl!: HTMLElement;
    private streamEl!: HTMLElement;
    private scrollBottomBtnEl!: HTMLElement;
    private streamingSlotEl!: HTMLElement;
    private questionSlotEl!: HTMLElement;
    private blockInputContainerEl!: HTMLElement;

    private blockInput!: SiYuanBlockInput;
    private graphView: KnowledgeGraphView | null = null;

    private unsubStore: (() => void) | null = null;
    private unsubRunner: (() => void) | null = null;
    private unsubSideNote: (() => void) | null = null;

    constructor(
        rootElement: HTMLElement,
        stores: SiYuanHarnessStores,
        runner: SessionRunner,
        callbacks: SidebarCallbacks,
    ) {
        this.rootElement = rootElement;
        this.stores = stores;
        this.runner = runner;
        this.callbacks = callbacks;

        const existing = this.stores.chatStore.listChats();
        if (existing.length > 0) {
            this.activeChatId = existing[0]!.id;
        } else {
            const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
            this.activeChatId = created.id;
        }

        this.mount();

        this.unsubStore = this.stores.subscribe(() => {
            this.renderHeaderSelect();
            if (this.viewMode === "graph") {
                this.graphView?.refresh();
            } else if (this.viewMode === "chat") {
                this.renderPlanStrip();
                this.renderTranscript();
                this.renderQuestionCard();
                this.syncComposerState();
            }
        });

        this.unsubRunner = this.runner.subscribe((changedChatId) => {
            this.renderHeaderSelect();
            if (changedChatId === this.activeChatId && this.viewMode === "chat") {
                this.renderPlanStrip();
                this.renderTranscript();
                this.renderStreamingSlot();
                this.renderQuestionCard();
                this.syncComposerState();
            }
        });

        this.unsubSideNote = this.runner.subscribeSideNote((changedChatId, threadId) => {
            if (changedChatId === this.activeChatId && this.viewMode === "chat") {
                this.updateSideNoteInPlace(threadId);
            }
        });
    }

    public destroy(): void {
        this.unsubStore?.();
        this.unsubRunner?.();
        this.unsubSideNote?.();
        if (this.boundDocClickListener) {
            document.removeEventListener("click", this.boundDocClickListener);
        }
        if (this.boundDocKeydownListener) {
            document.removeEventListener("keydown", this.boundDocKeydownListener);
        }
        if (this.boundSelectionChangeListener) {
            document.removeEventListener("selectionchange", this.boundSelectionChangeListener);
        }
        if (this.boundDocMouseDownListener) {
            document.removeEventListener("mousedown", this.boundDocMouseDownListener);
        }
        this.blockInput?.destroy();
        this.graphView?.destroy();
    }

    public selectChat(chatId: string): void {
        this.activeChatId = chatId;
        this.viewMode = "chat";
        this.questionDraft = null;
        this.syncViewMode();
        this.renderAllChat();
    }

    /** Host a SiYuan block or note directly in the chat input box (or start a session from it). */
    public async startSessionFromSiyuanNote(docId: string, customPrompt?: string): Promise<void> {
        try {
            const exported = await readNoteMarkdown(docId);
            const title = exported.hPath.split("/").filter(Boolean).pop() || exported.hPath || docId;
            const excerpt = exported.content.slice(0, 6000);

            const chat = this.stores.chatStore.createChat({
                title,
                kind: "teach",
                linkedDocId: docId,
                linkedDocTitle: title,
            });

            chat.messages.push(
                newSiyuanNoteContextMessage({
                    docId,
                    title,
                    hPath: exported.hPath,
                    markdownExcerpt: excerpt,
                }),
            );
            this.stores.chatStore.saveChat(chat);
            this.selectChat(chat.id);

            const prompt =
                customPrompt ||
                `I want to learn and master the topic in my SiYuan note ((${docId} "${title.replace(/"/g, "'")}")).`;
            await this.runner.sendUserMessage(chat.id, prompt);
        } catch (err: any) {
            showMessage(`Could not read SiYuan note: ${err?.message ?? String(err)}`, 4000, "error");
        }
    }

    /** Insert a block reference directly into the current chat's mini Protyle editor. */
    public async insertBlockIntoInput(blockId: string): Promise<void> {
        this.viewMode = "chat";
        this.syncViewMode();
        let label = blockId;
        try {
            const match = await getBlockById(blockId);
            if (match) {
                label = match.content || match.hPath || blockId;
            }
        } catch {
            // ignore
        }
        this.blockInput.insertBlockReference(blockId, label);
    }

    private mount(): void {
        this.rootElement.innerHTML = `
            <div class="fn__flex-1 fn__flex-column lh-dock-chat">
                <div class="block__icons lh-chat-header">
                    <div class="lh-chat-header__left">
                        <button type="button" class="lh-header-icon-btn lh-back-btn" title="All Chats" aria-label="All Chats" data-action="toggle-chats-view">
                            ${ICON.back}
                        </button>
                        <span class="lh-chat-header__title"></span>
                    </div>
                    <div class="lh-chat-header__actions">
                        <button type="button" class="lh-header-icon-btn" title="New Chat" aria-label="New Chat" data-action="new-chat">
                            ${ICON.plus}
                        </button>
                        <button type="button" class="lh-header-icon-btn lh-graph-toggle-btn" title="Knowledge Graph" aria-label="Toggle Knowledge Graph" data-action="toggle-graph">
                            ${ICON.graph}
                        </button>
                        <button type="button" class="lh-header-icon-btn" title="Settings" aria-label="Settings" data-action="open-settings">
                            ${ICON.settings}
                        </button>
                        <span class="lh-header-sep" aria-hidden="true"></span>
                        <span data-type="min" class="lh-header-icon-btn" title="Minimize" aria-label="Minimize">
                            ${ICON.minimize}
                        </span>
                    </div>
                </div>

                <div class="lh-plan-strip" style="display:none;"></div>

                <div class="lh-chats-view" style="display:none;">
                    <div class="lh-chats-view__search-bar">
                        <div class="lh-history-menu__search">
                            ${ICON.search}
                            <input type="text" class="lh-history-menu__input" placeholder="Search chats..." autocomplete="off" />
                        </div>
                    </div>
                    <div class="lh-chats-view__list"></div>
                </div>

                <div class="lh-chat-main">
                    <div class="lh-chat-stream-wrap">
                        <div class="lh-chat-stream">
                            <div class="lh-transcript"></div>
                            <div class="lh-streaming-slot"></div>
                            <div class="lh-question-slot"></div>
                        </div>
                        <button type="button" class="lh-scroll-bottom-btn fn__none" data-action="scroll-to-bottom" title="Scroll to bottom" aria-label="Scroll to bottom">
                            <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 2.5a.75.75 0 0 1 .75.75v7.69l2.72-2.72a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06l2.72 2.72V3.25A.75.75 0 0 1 8 2.5z"/></svg>
                        </button>
                    </div>

                    <div class="lh-composer-host"></div>
                </div>

                <div class="lh-graph-drawer" style="display:none;"></div>
                <div class="lh-selection-bar fn__none" role="toolbar" aria-label="Ask about selected text">
                    <button type="button" class="lh-selection-bar__btn" data-sel-action="explain" title="Break down this statement">${ICON.help}<span>Don't follow</span></button>
                    <button type="button" class="lh-selection-bar__btn" data-sel-action="bridge" title="Explain how this follows from the previous step">${ICON.bridge}<span>Why it follows</span></button>
                    <button type="button" class="lh-selection-bar__btn" data-sel-action="relevance" title="Explain why this matters to the goal">${ICON.target}<span>Relevance</span></button>
                    <button type="button" class="lh-selection-bar__btn" data-sel-action="example" title="Give a concrete example or intuition">${ICON.spark}<span>Example</span></button>
                    <button type="button" class="lh-selection-bar__btn" data-sel-action="custom" title="Ask your own question about this selection">${ICON.ask}<span>Ask</span></button>
                </div>
            </div>
        `;

        this.sessionTitleEl = this.rootElement.querySelector(".lh-chat-header__title") as HTMLElement;
        this.backBtnEl = this.rootElement.querySelector(".lh-back-btn") as HTMLElement;
        this.chatsViewEl = this.rootElement.querySelector(".lh-chats-view") as HTMLElement;
        this.sessionSearchEl = this.rootElement.querySelector(".lh-history-menu__input") as HTMLInputElement;
        this.sessionListEl = this.rootElement.querySelector(".lh-chats-view__list") as HTMLElement;
        this.selectionBarEl = this.rootElement.querySelector(".lh-selection-bar") as HTMLElement;
        this.graphBtnEl = this.rootElement.querySelector(".lh-graph-toggle-btn") as HTMLElement;
        this.planStripEl = this.rootElement.querySelector(".lh-plan-strip") as HTMLElement;
        this.chatBodyEl = this.rootElement.querySelector(".lh-chat-main") as HTMLElement;
        this.graphBodyEl = this.rootElement.querySelector(".lh-graph-drawer") as HTMLElement;
        this.streamEl = this.rootElement.querySelector(".lh-chat-stream") as HTMLElement;
        this.scrollBottomBtnEl = this.rootElement.querySelector(".lh-scroll-bottom-btn") as HTMLElement;
        this.streamingSlotEl = this.rootElement.querySelector(".lh-streaming-slot") as HTMLElement;
        this.questionSlotEl = this.rootElement.querySelector(".lh-question-slot") as HTMLElement;
        this.blockInputContainerEl = this.rootElement.querySelector(".lh-composer-host") as HTMLElement;

        this.blockInput = new SiYuanBlockInput(this.blockInputContainerEl, {
            app: this.callbacks.app,
            placeholder: "Write a message, press / for blocks, (( to reference notes...",
            getSttModelId: () => this.stores.settingsStore.get().sttModel || "oido_v2a",
            getPillsState: () => {
                const chat = this.getActiveChat();
                const s = this.stores.settingsStore.get();
                const provider = chat?.settings?.provider ?? s.activeProvider;
                const cp = s.customProviders?.find((p) => p.id === provider);
                const modelLabel =
                    chat?.settings?.modelId ??
                    (provider === "deepseek"
                        ? s.deepseekModel
                        : provider === "gemini"
                          ? s.geminiModel
                          : cp
                            ? cp.model || cp.name
                            : s.customModel);
                const modeLabel = chat?.kind === "practice" ? "Practice mode" : "Teach mode";
                const mechanicLabel = s.quizzingMechanic === "explain" ? "Explain" : "Quiz";
                return { modeLabel, modelLabel, mechanicLabel };
            },
            getModelGroups: (): ModelPickerGroup[] => {
                const chat = this.getActiveChat();
                const s = this.stores.settingsStore.get();
                const activeProviderId = chat?.settings?.provider ?? s.activeProvider;
                const activeCp = s.customProviders?.find((p) => p.id === activeProviderId);
                const activeModelId =
                    chat?.settings?.modelId ??
                    (activeProviderId === "deepseek"
                        ? s.deepseekModel
                        : activeProviderId === "gemini"
                          ? s.geminiModel
                          : activeCp
                            ? activeCp.model
                            : s.customModel);

                const uniq = (list: string[]): string[] => {
                    const out: string[] = [];
                    for (const item of list) {
                        const t = item.trim();
                        if (t && !out.includes(t)) out.push(t);
                    }
                    return out;
                };

                const groups: ModelPickerGroup[] = [
                    {
                        providerId: "deepseek",
                        providerLabel: "DeepSeek",
                        models: uniq([
                            ...(s.cachedDeepseekModels ?? ["deepseek-chat", "deepseek-reasoner"]),
                            s.deepseekModel,
                        ]),
                        activeProviderId,
                        activeModelId,
                    },
                    {
                        providerId: "gemini",
                        providerLabel: "Google Gemini",
                        models: uniq([
                            ...(s.cachedGeminiModels ?? ["gemini-2.5-flash", "gemini-2.5-pro"]),
                            s.geminiModel,
                        ]),
                        activeProviderId,
                        activeModelId,
                    },
                ];

                for (const cp of s.customProviders ?? []) {
                    groups.push({
                        providerId: cp.id,
                        providerLabel: cp.name || "Custom Provider",
                        models: uniq([...(cp.cachedModels ?? []), cp.model]),
                        activeProviderId,
                        activeModelId,
                    });
                }

                const legacyModels = uniq([...(s.cachedCustomModels ?? []), s.customModel]);
                if (legacyModels.length > 0 || s.customApiKey || s.useSiyuanAiFallback) {
                    groups.push({
                        providerId: "custom",
                        providerLabel: "Custom / SiYuan",
                        models: legacyModels.length > 0 ? legacyModels : ["gpt-4o"],
                        activeProviderId,
                        activeModelId,
                    });
                }

                return groups;
            },
            onSelectModel: (providerId: string, modelId: string) => {
                const s = this.stores.settingsStore.get();
                if (providerId === "deepseek") {
                    this.stores.settingsStore.save({ activeProvider: "deepseek", deepseekModel: modelId });
                } else if (providerId === "gemini") {
                    this.stores.settingsStore.save({ activeProvider: "gemini", geminiModel: modelId });
                } else if (providerId === "custom") {
                    this.stores.settingsStore.save({ activeProvider: "custom", customModel: modelId });
                } else {
                    const updated = (s.customProviders ?? []).map((p) =>
                        p.id === providerId ? { ...p, model: modelId } : p,
                    );
                    this.stores.settingsStore.save({ activeProvider: providerId, customProviders: updated });
                }

                const chat = this.getActiveChat();
                if (chat?.settings) {
                    chat.settings = { ...chat.settings, provider: providerId, modelId };
                    this.stores.chatStore.saveChat(chat);
                }
                showMessage(`Model: ${modelId}`, 2000, "info");
            },
            onOpenSettings: () => this.callbacks.onOpenSettings(),
            onAttachActiveNote: () => {
                const docId = this.getActiveSiyuanDocId();
                if (!docId) {
                    showMessage("Open a SiYuan note first to insert it.", 2500, "info");
                    return;
                }
                void this.insertBlockIntoInput(docId);
            },
            onToggleMode: () => {
                const chat = this.getActiveChat();
                if (!chat) return;
                if (chat.messages.length === 0) {
                    chat.kind = chat.kind === "practice" ? "teach" : "practice";
                    this.stores.chatStore.saveChat(chat);
                } else {
                    const nextKind = chat.kind === "practice" ? "teach" : "practice";
                    const created = this.stores.chatStore.createChat({
                        title: nextKind === "practice" ? "Practice" : "New Chat",
                        kind: nextKind,
                    });
                    this.selectChat(created.id);
                }
            },
            onCycleModel: () => {
                const s = this.stores.settingsStore.get();
                const provider = s.activeProvider;
                const models =
                    provider === "deepseek"
                        ? s.cachedDeepseekModels || ["deepseek-chat", "deepseek-reasoner"]
                        : provider === "gemini"
                          ? s.cachedGeminiModels || ["gemini-2.5-flash", "gemini-2.5-pro"]
                          : s.cachedCustomModels?.length
                            ? s.cachedCustomModels
                            : [s.customModel || "gpt-4o"];

                const currentModel =
                    provider === "deepseek"
                        ? s.deepseekModel
                        : provider === "gemini"
                          ? s.geminiModel
                          : s.customModel;

                const currIdx = models.indexOf(currentModel);
                if (currIdx !== -1 && currIdx < models.length - 1) {
                    const nextModel = models[currIdx + 1];
                    if (provider === "deepseek") {
                        this.stores.settingsStore.save({ deepseekModel: nextModel });
                    } else if (provider === "gemini") {
                        this.stores.settingsStore.save({ geminiModel: nextModel });
                    } else {
                        this.stores.settingsStore.save({ customModel: nextModel });
                    }
                    showMessage(`Model: ${nextModel}`, 2000, "info");
                } else {
                    const nextProvider: ProviderId =
                        provider === "deepseek" ? "gemini" : provider === "gemini" ? "custom" : "deepseek";
                    const nextModels =
                        nextProvider === "deepseek"
                            ? s.cachedDeepseekModels || ["deepseek-chat", "deepseek-reasoner"]
                            : nextProvider === "gemini"
                              ? s.cachedGeminiModels || ["gemini-2.5-flash", "gemini-2.5-pro"]
                              : s.cachedCustomModels?.length
                                ? s.cachedCustomModels
                                : [s.customModel || "gpt-4o"];
                    const nextModel = nextModels[0] || (nextProvider === "deepseek" ? "deepseek-chat" : "gemini-2.5-flash");

                    if (nextProvider === "deepseek") {
                        this.stores.settingsStore.save({ activeProvider: nextProvider, deepseekModel: nextModel });
                    } else if (nextProvider === "gemini") {
                        this.stores.settingsStore.save({ activeProvider: nextProvider, geminiModel: nextModel });
                    } else {
                        this.stores.settingsStore.save({ activeProvider: nextProvider, customModel: nextModel });
                    }
                    showMessage(`Switched to ${nextProvider}: ${nextModel}`, 2000, "info");
                }
            },
            onToggleMechanic: () => {
                const s = this.stores.settingsStore.get();
                const nextMech = s.quizzingMechanic === "explain" ? "quiz" : "explain";
                this.stores.settingsStore.save({ quizzingMechanic: nextMech });
            },
            onSubmit: (payload) => void this.handleUserSubmit(payload),
            onStop: () => {
                if (this.activeChatId) this.runner.abortTurn(this.activeChatId);
            },
        });

        this.graphView = new KnowledgeGraphView(this.graphBodyEl, this.stores, {
            onOpenChat: (chatId) => this.selectChat(chatId),
            onOpenSiyuanDoc: (docId) => this.callbacks.onOpenSiyuanDoc(docId),
            onStartPracticeFromGraph: (chatId) => {
                this.selectChat(chatId);
                void this.runner.runAgentTurn(chatId);
            },
            getActiveChatId: () => this.activeChatId,
        });

        this.bindEvents();
        this.renderAllChat();
    }

    private syncViewMode(): void {
        const isGraph = this.viewMode === "graph";
        const isChats = this.viewMode === "chats";
        const isChat = this.viewMode === "chat";

        this.chatBodyEl.style.display = isChat ? "flex" : "none";
        this.chatsViewEl.style.display = isChats ? "flex" : "none";
        this.graphBodyEl.style.display = isGraph ? "flex" : "none";
        if (!isChat) this.planStripEl.style.display = "none";

        this.graphBtnEl.classList.toggle("lh-icon-active", isGraph);
        this.backBtnEl.classList.toggle("lh-icon-active", isChats);
        this.backBtnEl.title = isChat ? "All Chats" : "Back to Chat";

        this.renderHeaderSelect();

        if (isGraph) {
            window.requestAnimationFrame(() => this.graphView?.refresh());
        } else if (isChats) {
            window.requestAnimationFrame(() => this.sessionSearchEl?.focus());
        } else {
            this.renderPlanStrip();
        }
    }

    private renderAllChat(): void {
        this.renderHeaderSelect();
        this.renderPlanStrip();
        this.renderTranscript();
        this.renderStreamingSlot();
        this.renderQuestionCard();
        this.syncComposerState();
    }

    private getActiveChat(): ChatRecord | null {
        if (!this.activeChatId) return null;
        return this.stores.chatStore.getChat(this.activeChatId);
    }

    private formatRelativeTime(iso: string): string {
        const ts = Date.parse(iso);
        if (Number.isNaN(ts)) return "";
        const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diffSec < 60) return "Just now";
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.floor(diffHr / 24);
        if (diffDay === 1) return "Yesterday";
        if (diffDay < 7) return `${diffDay}d ago`;
        return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    private renderHeaderSelect(): void {
        const chats = this.stores.chatStore.listChats();
        const activeChat = this.getActiveChat();
        if (this.sessionTitleEl) {
            if (this.viewMode === "chats") {
                this.sessionTitleEl.textContent = "Chats";
                this.sessionTitleEl.title = "All Chats";
            } else if (this.viewMode === "graph") {
                this.sessionTitleEl.textContent = "Knowledge Graph";
                this.sessionTitleEl.title = "Knowledge Graph";
            } else {
                const rawTitle = activeChat?.title?.trim();
                this.sessionTitleEl.textContent = rawTitle && rawTitle !== "New Chat" ? rawTitle : "";
                this.sessionTitleEl.title = rawTitle || "";
            }
        }

        if (!this.sessionListEl) return;

        const q = this.historySearchQuery.trim().toLowerCase();
        const filtered = q
            ? chats.filter(
                  (c) =>
                      c.title.toLowerCase().includes(q) ||
                      (c.linkedDocTitle ?? "").toLowerCase().includes(q),
              )
            : chats;

        if (filtered.length === 0) {
            this.sessionListEl.innerHTML = `<div class="lh-chats-view__empty">${
                q ? "No matching chats" : "No chats yet"
            }</div>`;
            return;
        }

        const itemsHtml = filtered.map((c) => {
            const isActive = c.id === this.activeChatId;
            const icon = c.kind === "practice" ? ICON.target : ICON.chat;
            const metaParts = [
                c.linkedDocTitle ? c.linkedDocTitle : "",
                c.messageCount > 0 ? `${c.messageCount} msgs` : "Empty",
                this.formatRelativeTime(c.updatedAt),
            ].filter(Boolean);
            return `
                <div class="lh-chat-row ${isActive ? "lh-chat-row--active" : ""}" data-chat-id="${escapeHtml(c.id)}">
                    <span class="lh-chat-row__icon">${icon}</span>
                    <div class="lh-chat-row__body">
                        <div class="lh-chat-row__title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
                        <div class="lh-chat-row__meta">${escapeHtml(metaParts.join(" · "))}</div>
                    </div>
                    <button type="button" class="lh-chat-row__del-btn" data-delete-id="${escapeHtml(c.id)}" title="Delete chat">
                        ${ICON.trash}
                    </button>
                </div>
            `;
        });

        this.sessionListEl.innerHTML = itemsHtml.join("");
    }

    private renderPlanStrip(): void {
        if (this.viewMode !== "chat") {
            this.planStripEl.style.display = "none";
            return;
        }
        const chat = this.getActiveChat();
        const tree = chat?.tree;
        if (!chat || !tree || tree.nodes.length === 0) {
            this.planStripEl.style.display = "none";
            this.planStripEl.innerHTML = "";
            return;
        }

        this.planStripEl.style.display = "block";
        const statuses = derivePlanStatusesLh(tree, chat.messages);
        let visitedCount = 0;
        let currentTitle = tree.nodes[0]?.title ?? "Plan";

        for (const n of tree.nodes) {
            const st = derivedNodeStatus(statuses, n.id);
            if (st === "visited") visitedCount++;
            if (st === "current") currentTitle = n.title;
        }

        const pct = tree.nodes.length > 0 ? Math.round((visitedCount / tree.nodes.length) * 100) : 0;

        this.planStripEl.innerHTML = `
            <div class="lh-plan-strip__bar" data-action="toggle-plan-strip">
                <span class="lh-plan-strip__summary">
                    <span class="lh-plan-strip__icon">${ICON.plan}</span>
                    <strong>${escapeHtml(currentTitle)}</strong>
                    <span class="lh-plan-strip__count">${visitedCount}/${tree.nodes.length}</span>
                </span>
                <span class="lh-plan-strip__chevron">${this.planExpanded ? "▴" : "▾"}</span>
            </div>
            <div class="lh-plan-strip__progress"><div class="lh-plan-strip__progress-fill" style="width:${pct}%"></div></div>
            ${
                this.planExpanded
                    ? `
                <div class="lh-plan-strip__drawer">
                    ${tree.nodes
                        .map((n) => {
                            const st = derivedNodeStatus(statuses, n.id);
                            const dot = `<span class="lh-plan-strip__dot lh-plan-strip__dot--${st}"></span>`;
                            return `
                                <div class="lh-plan-strip__node lh-plan-strip__node--${st}">
                                    ${dot}
                                    <span>${escapeHtml(n.title)}</span>
                                </div>
                            `;
                        })
                        .join("")}
                </div>
            `
                    : ""
            }
        `;
    }

    private renderTranscript(): void {
        const chat = this.getActiveChat();
        const transcriptEl = this.rootElement.querySelector(".lh-transcript") as HTMLElement;
        if (!chat) {
            transcriptEl.innerHTML = "";
            return;
        }

        if (chat.messages.length === 0) {
            const isPractice = chat.kind === "practice";
            transcriptEl.innerHTML = `
                <div class="lh-chat-empty">
                    <div class="lh-chat-empty__orb">${ICON.orb}</div>
                    <div class="lh-chat-empty__title">
                        ${isPractice ? "Practice Mode" : "What would you like to learn?"}
                    </div>
                    <div class="lh-chat-empty__sub">
                        Type a topic below, or use <code>((</code> to reference blocks from your SiYuan notes.
                    </div>
                    ${
                        isPractice
                            ? ""
                            : `
                        <div class="lh-chat-empty__chips">
                            <button type="button" class="lh-starter-chip" data-action="starter-prompt" data-prompt="Teach me the topic in my currently open note, starting from where my understanding ends.">Teach my open note</button>
                            <button type="button" class="lh-starter-chip" data-action="starter-prompt" data-prompt="Help me work through the questions in my open note step by step.">Work through note questions</button>
                            <button type="button" class="lh-starter-chip" data-action="starter-prompt" data-prompt="Quiz me on the key concepts in my open note to find my weak spots.">Find my weak spots</button>
                        </div>
                    `
                    }
                </div>
            `;
            this.syncScrollDownButton();
            return;
        }

        const resultsByCallId = new Map<string, LhToolResultMessage>();
        for (const m of chat.messages) {
            if (m.role === "toolResult") {
                resultsByCallId.set(m.toolCallId, m);
            }
        }

        const pendingQ = danglingQuestionOf(chat.messages);
        const activeProb = activeProblemOf(chat.messages);
        const blocksHtml: string[] = [];

        for (let i = 0; i < chat.messages.length; i++) {
            const m = chat.messages[i]!;

            if (m.role === "user") {
                blocksHtml.push(`
                    <div class="lh-msg lh-msg--user">
                        <div class="lh-msg__bubble b3-typography">${renderMarkdown(m.content)}</div>
                    </div>
                `);
                continue;
            }

            if (m.role === "custom") {
                if (m.customType === "siyuan-note-context") {
                    const details = (m.details ?? {}) as {
                        docId?: string;
                        title?: string;
                        hPath?: string;
                        images?: Array<{ path: string; dataUrl: string }>;
                    };
                    if (details.docId) {
                        const imgBadge =
                            details.images && details.images.length > 0
                                ? ` · 🖼 ${details.images.length}`
                                : "";
                        blocksHtml.push(`
                            <div class="lh-inline-note">
                                <span class="lh-block-ref" data-action="open-siyuan-doc" data-doc-id="${escapeHtml(
                                    details.docId,
                                )}" data-block-ref-id="${escapeHtml(details.docId)}">📄 ${escapeHtml(
                            details.title || details.hPath || details.docId,
                        )}${imgBadge}</span>
                            </div>
                        `);
                    }
                } else if (m.customType === "practice-thinking") {
                    const details = (m.details ?? {}) as { text?: string };
                    blocksHtml.push(`
                        <div class="lh-msg lh-msg--user">
                            <div class="lh-msg__bubble b3-typography">${renderMarkdown(details.text || m.content)}</div>
                        </div>
                    `);
                }
                continue;
            }

            if (m.role === "assistant") {
                const html = this.renderAssistantMessage(
                    chat,
                    m,
                    resultsByCallId,
                    pendingQ?.toolCallId ?? null,
                    activeProb?.toolCallId ?? null,
                );
                if (html) blocksHtml.push(html);
            }
        }

        transcriptEl.innerHTML = blocksHtml.join("\n");
        this.decorateAssistantBlocks(transcriptEl, chat);
        this.syncScrollDownButton();
    }

    private renderAssistantMessage(
        chat: ChatRecord,
        m: LhAssistantMessage,
        resultsByCallId: Map<string, LhToolResultMessage>,
        pendingQuestionCallId: string | null,
        activeProblemCallId: string | null,
    ): string {
        const parts: string[] = [];

        for (const block of m.content) {
            if (block.type === "thinking" && block.thinking.trim()) {
                parts.push(`
                    <details class="lh-subtle-pill">
                        <summary>Reasoning</summary>
                        <div class="lh-subtle-pill__body">${escapeHtml(block.thinking)}</div>
                    </details>
                `);
            } else if (block.type === "text" && block.text.trim()) {
                parts.push(`<div class="lh-assistant-prose b3-typography">${renderMarkdown(block.text)}</div>`);
            } else if (block.type === "toolCall") {
                const res = resultsByCallId.get(block.id);

                // Quiet 1-line indicator for read-only SiYuan note / graph searches
                if (
                    block.name.startsWith("siyuan_") ||
                    block.name === "list_sessions" ||
                    block.name === "list_propositions"
                ) {
                    const summary = this.describeReadToolCall(block.name, block.arguments);
                    parts.push(`
                        <details class="lh-subtle-pill">
                            <summary>${ICON.search}<span>${escapeHtml(summary)}</span></summary>
                            <pre class="lh-subtle-pill__pre">${escapeHtml(
                                res ? res.content.map((c) => c.text).join("\n") : "Reading...",
                            )}</pre>
                        </details>
                    `);
                    continue;
                }

                // Compact diagnostic assessment summary
                if (block.name === "probe_done") {
                    const assessment = (block.arguments?.assessment ?? {}) as Partial<ProbeAssessment>;
                    if (assessment.summary) {
                        parts.push(`
                            <div class="lh-inline-card">
                                <div class="lh-inline-card__label">Diagnostic Summary</div>
                                <div class="b3-typography">${renderMarkdown(assessment.summary)}</div>
                            </div>
                        `);
                    }
                    continue;
                }

                // Answered question summary in the chat history
                if (["probe", "recall", "quiz", "explain", "ask_user_question"].includes(block.name)) {
                    if (block.id === pendingQuestionCallId) {
                        continue; // Active at the bottom of the chat stream
                    }
                    if (res && !res.isError && res.details) {
                        parts.push(this.renderAnsweredQuestionBubble(res.details as QuestionAnswerData));
                    }
                    continue;
                }

                // Practice Problem
                if (block.name === "problem") {
                    if (block.id === activeProblemCallId) continue;
                    const stmt = String(block.arguments?.statement ?? "");
                    parts.push(`
                        <div class="lh-inline-card">
                            <div class="lh-inline-card__label">Problem</div>
                            <div class="b3-typography">${renderMarkdown(stmt)}</div>
                        </div>
                    `);
                    continue;
                }

                // Practice Conclude
                if (block.name === "conclude" && res && !res.isError) {
                    const verdict = String(block.arguments?.verdict ?? "");
                    const probInput = problemInputForConclude(chat.messages, block.id);
                    const modelSolution =
                        typeof probInput?.modelSolution === "string" ? probInput.modelSolution : "";
                    parts.push(`
                        <div class="lh-inline-card">
                            ${verdict ? `<div class="b3-typography">${renderMarkdown(verdict)}</div>` : ""}
                            ${
                                modelSolution
                                    ? `<details class="lh-subtle-pill" open><summary>Solution</summary><div class="b3-typography">${renderMarkdown(
                                          modelSolution,
                                      )}</div></details>`
                                    : ""
                            }
                        </div>
                    `);
                }
            }
        }

        if (parts.length === 0) return "";
        return `<div class="lh-msg lh-msg--assistant" data-msg-id="${escapeHtml(m.id)}">${parts.join("\n")}</div>`;
    }

    private describeReadToolCall(name: string, args: Record<string, unknown>): string {
        if (name === "siyuan_find_notes") {
            return `Searched notes: "${String(args.query ?? "") || "recent"}"`;
        }
        if (name === "siyuan_grep_notes") {
            return `Searched blocks: "${String(args.query ?? "")}"`;
        }
        if (name === "siyuan_read_note") {
            return `Read SiYuan note (${String(args.id ?? "").slice(0, 14)}...)`;
        }
        if (name === "siyuan_list_notebooks") {
            return "Checked SiYuan notebooks";
        }
        return "Checked Knowledge Graph";
    }

    private renderAnsweredQuestionBubble(ans: QuestionAnswerData): string {
        if (ans.dismissed) {
            return `
                <div class="lh-qa-history lh-qa-history--skipped">
                    <div class="lh-qa-history__q b3-typography">${renderMarkdown(ans.questionText)}</div>
                    <div class="lh-qa-history__a">Skipped</div>
                </div>
            `;
        }

        const selectedText =
            ans.answers && ans.answers.length > 0
                ? ans.answers.map((a) => a.label).join("; ")
                : ans.text || ans.other || (ans.dontKnow ? "I don't know" : "");

        const badge =
            ans.correct === true ? "✓ " : ans.correct === false ? "✗ " : "";
        const statusMod =
            ans.correct === true
                ? "lh-qa-history--correct"
                : ans.correct === false
                  ? "lh-qa-history--wrong"
                  : "";

        return `
            <div class="lh-qa-history ${statusMod}">
                <div class="lh-qa-history__q b3-typography">${renderMarkdown(ans.questionText)}</div>
                <div class="lh-qa-history__a"><strong>${badge}You:</strong> ${escapeHtml(selectedText)}</div>
                ${
                    ans.explanation
                        ? `<div class="lh-qa-history__exp b3-typography">${renderMarkdown(ans.explanation)}</div>`
                        : ""
                }
            </div>
        `;
    }

    private renderStreamingSlot(): void {
        if (!this.activeChatId) {
            this.streamingSlotEl.innerHTML = "";
            return;
        }
        const st = this.runner.getState(this.activeChatId);
        if (!st.busy && !st.error) {
            this.streamingSlotEl.innerHTML = "";
            return;
        }

        const parts: string[] = [];
        if (st.streamingMessage) {
            for (const b of st.streamingMessage.content) {
                if (b.type === "text" && b.text) {
                    parts.push(`<div class="lh-assistant-prose b3-typography">${renderMarkdown(b.text)}</div>`);
                }
            }
        }
        if (st.activeToolStatus) {
            parts.push(
                `<div class="lh-typing-indicator"><span class="lh-typing-dots"><span></span><span></span><span></span></span><span>${escapeHtml(st.activeToolStatus)}</span></div>`,
            );
        } else if (st.busy && parts.length === 0) {
            parts.push(
                `<div class="lh-typing-indicator"><span class="lh-typing-dots"><span></span><span></span><span></span></span><span>Thinking</span></div>`,
            );
        }
        if (st.error) {
            parts.push(`<div class="lh-error-banner">${escapeHtml(st.error)}</div>`);
        }

        this.streamingSlotEl.innerHTML = `<div class="lh-msg lh-msg--assistant">${parts.join("\n")}</div>`;
        this.syncScrollDownButton();
    }

    private renderQuestionCard(): void {
        const chat = this.getActiveChat();
        if (!chat) {
            this.questionSlotEl.innerHTML = "";
            return;
        }

        const st = this.runner.getState(chat.id);
        if (st.busy) {
            this.questionSlotEl.innerHTML = "";
            return;
        }

        const pendingQ = danglingQuestionOf(chat.messages);
        const activeProb = activeProblemOf(chat.messages);

        // 1. Active Question Card (inline at the bottom of the chat stream)
        if (pendingQ) {
            const qd = buildQuestionDataFromToolCall(pendingQ.toolCallId, pendingQ.tool, pendingQ.input);
            if (!this.questionDraft || this.questionDraft.toolCallId !== pendingQ.toolCallId) {
                this.questionDraft = {
                    toolCallId: pendingQ.toolCallId,
                    selectedValues: new Set<string>(),
                    otherSelected: false,
                    otherText: "",
                    freeText: "",
                    thinking: "",
                    confidenceIndex: DEFAULT_CONFIDENCE_INDEX,
                };
            }
            const draft = this.questionDraft;
            const confValue = CONFIDENCE_STOPS[draft.confidenceIndex] ?? 50;

            this.questionSlotEl.innerHTML = `
                <div class="lh-question-card">
                    <div class="lh-question-card__q b3-typography">${renderMarkdown(qd.question)}</div>
                    ${qd.context ? `<div class="lh-question-card__ctx b3-typography">${renderMarkdown(qd.context)}</div>` : ""}

                    ${
                        qd.mode === "text"
                            ? `
                        <textarea class="b3-text-field fn__block lh-q-freetext" rows="2" placeholder="Type your answer...">${escapeHtml(
                            draft.freeText,
                        )}</textarea>
                    `
                            : `
                        <div class="lh-question-card__options">
                            ${qd.options
                                .map((opt, idx) => {
                                    const isSel = draft.selectedValues.has(opt.value);
                                    return `
                                        <div class="lh-opt ${isSel ? "lh-opt--selected" : ""}" data-action="toggle-option" data-opt-value="${escapeHtml(
                                        opt.value,
                                    )}">
                                            <span class="lh-opt__key">${idx + 1}</span>
                                            <div class="lh-opt__body b3-typography">${renderMarkdown(opt.label)}</div>
                                        </div>
                                    `;
                                })
                                .join("")}
                            ${
                                qd.kind === "ask"
                                    ? `
                                <div class="lh-opt ${draft.otherSelected ? "lh-opt--selected" : ""}" data-action="toggle-other">
                                    <span class="lh-opt__key">+</span>
                                    <input type="text" class="b3-text-field fn__block lh-q-other" placeholder="Other..." value="${escapeHtml(
                                        draft.otherText,
                                    )}" />
                                </div>
                            `
                                    : ""
                            }
                        </div>
                    `
                    }

                    <div class="lh-q-thinking-wrap">
                        <div class="lh-q-thinking-label-row">
                            <label class="lh-q-thinking-label">Thinking (optional — share your reasoning, hunches, or confusion)</label>
                            <button type="button" class="lh-q-mic-btn" data-action="toggle-thinking-mic" title="Voice your thinking (local)">${ICON.mic}<span>Speak</span></button>
                        </div>
                        <div class="lh-voice-bar lh-voice-bar--question fn__none">
                            <canvas class="lh-voice-waveform"></canvas>
                            <span class="lh-voice-status">Listening...</span>
                        </div>
                        <textarea class="b3-text-field fn__block lh-q-thinking" rows="2" placeholder="Think out loud... how are you approaching this?">${escapeHtml(
                            draft.thinking,
                        )}</textarea>
                    </div>

                    ${
                        qd.kind === "quiz"
                            ? `
                        <div class="lh-conf-bar">
                            <span>Confidence:</span>
                            <div class="lh-conf-bar__stops">
                                ${CONFIDENCE_STOPS.map(
                                    (stop, sIdx) => `
                                    <button class="lh-conf-chip ${
                                        sIdx === draft.confidenceIndex ? "lh-conf-chip--active" : ""
                                    }" type="button" data-action="set-confidence" data-conf-idx="${sIdx}">${stop}%</button>
                                `,
                                ).join("")}
                            </div>
                        </div>
                    `
                            : ""
                    }

                    <div class="lh-question-card__actions">
                        <button class="b3-button" type="button" data-action="submit-question-answer">
                            Submit${qd.kind === "quiz" ? ` (${confValue}%)` : ""}
                        </button>
                        ${
                            qd.kind !== "ask"
                                ? `<button class="b3-button b3-button--outline" type="button" data-action="submit-dont-know">I don't know</button>`
                                : ""
                        }
                        <button class="b3-button b3-button--cancel" type="button" data-action="skip-question">Skip</button>
                    </div>
                </div>
            `;

            const ftEl = this.questionSlotEl.querySelector(".lh-q-freetext") as HTMLTextAreaElement | null;
            ftEl?.addEventListener("input", () => {
                draft.freeText = ftEl.value;
            });
            const thinkingEl = this.questionSlotEl.querySelector(".lh-q-thinking") as HTMLTextAreaElement | null;
            thinkingEl?.addEventListener("input", () => {
                draft.thinking = thinkingEl.value;
            });
            const otherEl = this.questionSlotEl.querySelector(".lh-q-other") as HTMLInputElement | null;
            otherEl?.addEventListener("input", () => {
                draft.otherText = otherEl.value;
                draft.otherSelected = true;
            });
            this.syncScrollDownButton();
            return;
        }

        // 2. Active Practice Problem Card
        if (chat.kind === "practice" && activeProb) {
            const stmt = String(activeProb.input?.statement ?? "");
            this.questionSlotEl.innerHTML = `
                <div class="lh-question-card">
                    <div class="lh-question-card__q b3-typography">${renderMarkdown(stmt)}</div>
                    <div class="lh-question-card__actions">
                        <span class="lh-muted-hint">Reply in the chat box below with your work or solution</span>
                        <button class="b3-button b3-button--cancel" type="button" data-action="dismiss-problem">Give Up</button>
                    </div>
                </div>
            `;
            return;
        }

        // 3. Practice between-problem Next button
        if (chat.kind === "practice" && !activeProb && chat.messages.length > 0) {
            this.questionSlotEl.innerHTML = `
                <div class="lh-next-problem-bar">
                    <button class="b3-button" type="button" data-action="next-problem">Next Problem →</button>
                </div>
            `;
            return;
        }

        this.questionSlotEl.innerHTML = "";
    }

    private syncComposerState(): void {
        const chat = this.getActiveChat();
        const busy = chat ? this.runner.getState(chat.id).busy : false;
        this.blockInput?.setBusy(busy);
        this.blockInput?.refreshPills();
    }

    private getActiveSiyuanDocId(): string | null {
        const activeTitle = document.querySelector(
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-title, .layout__center .protyle:not(.fn__none) .protyle-title",
        ) as HTMLElement | null;
        return activeTitle?.dataset?.nodeId ?? null;
    }

    private async attachSiyuanContextForId(chat: ChatRecord, blockId: string, passive = false): Promise<boolean> {
        let title = blockId;
        let hPath = blockId;
        let rawMarkdown = "";
        let fullExcerpt = "";
        try {
            const match = await getBlockById(blockId);
            if (match) {
                title = (match.content || match.hPath || blockId).slice(0, 80);
                hPath = match.hPath || blockId;
                rawMarkdown = match.markdown || match.content || "";
                fullExcerpt = rawMarkdown;
            }
            const exported = await readNoteMarkdown(blockId);
            if (exported.content) {
                rawMarkdown = exported.content;
                fullExcerpt = exported.content.slice(0, 6000);
                if (exported.hPath) hPath = exported.hPath;
            }
        } catch {
            // Use block markdown from SQLite if exportMdContent fails on a leaf block
        }
        if (!fullExcerpt) return false;

        if (!chat.linkedDocId) {
            chat.linkedDocId = blockId;
            chat.linkedDocTitle = title;
        }

        chat.messages.push(
            newSiyuanNoteContextMessage({
                docId: blockId,
                title,
                hPath,
                markdownExcerpt: fullExcerpt,
                passive,
            }),
        );
        return true;
    }

    private async handleUserSubmit(payload: {
        displayMarkdown: string;
        referencedBlockIds: string[];
        imagePaths?: string[];
    }): Promise<void> {
        const chat = this.getActiveChat();
        if (!chat) return;

        let attachedAny = false;

        // If the user referenced any SiYuan blocks inside the mini Protyle editor,
        // attach their read-only content so the Prober / Teacher knows the exact block contents.
        if (payload.referencedBlockIds.length > 0) {
            for (const blockId of payload.referencedBlockIds) {
                if (await this.attachSiyuanContextForId(chat, blockId, false)) {
                    attachedAny = true;
                }
            }
        } else if (
            chat.messages.length === 0 &&
            !chat.messages.some((m) => m.role === "custom" && m.customType === "siyuan-note-context")
        ) {
            // Passive active-note awareness on the first turn of a fresh session:
            // automatically expose the currently open SiYuan note so the user can refer to it naturally.
            const activeDocId = this.getActiveSiyuanDocId();
            if (activeDocId) {
                attachedAny = await this.attachSiyuanContextForId(chat, activeDocId, true);
            }
        }

        if (attachedAny) {
            this.stores.chatStore.saveChat(chat);
        }

        // If we're in an active practice problem, route the message as practice thinking/solution
        const activeProb = activeProblemOf(chat.messages);
        if (chat.kind === "practice" && activeProb) {
            await this.runner.submitPracticeThinking(chat.id, payload.displayMarkdown);
            return;
        }

        const userImagePaths = Array.from(
            new Set([...(payload.imagePaths ?? []), ...extractAssetImagePaths(payload.displayMarkdown)]),
        );
        const userImages = userImagePaths.length > 0 ? await readSiyuanImages(userImagePaths, 12) : undefined;

        await this.runner.sendUserMessage(chat.id, payload.displayMarkdown, userImages);
    }

    private bindEvents(): void {
        this.boundDocKeydownListener = (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
                if (this.viewMode === "chats") {
                    this.viewMode = "chat";
                    this.syncViewMode();
                }
                this.hideSelectionBar();
            }
        };
        document.addEventListener("keydown", this.boundDocKeydownListener);

        this.sessionSearchEl?.addEventListener("input", () => {
            this.historySearchQuery = this.sessionSearchEl.value;
            this.renderHeaderSelect();
        });

        // Hover preview for SiYuan block references (`data-block-ref-id` or Protyle `data-type="block-ref"`)
        this.rootElement.addEventListener("mouseover", (e) => {
            const refEl = (e.target as HTMLElement).closest(
                '[data-block-ref-id], [data-type="block-ref"]',
            ) as HTMLElement | null;
            if (!refEl) return;
            const blockId = refEl.dataset.blockRefId || refEl.getAttribute("data-id");
            if (blockId && this.callbacks.onPreviewSiyuanBlock) {
                this.callbacks.onPreviewSiyuanBlock(blockId, refEl);
            }
        });

        // Click actions
        this.rootElement.addEventListener("click", (e) => {
            const delBtn = (e.target as HTMLElement).closest("[data-delete-id]") as HTMLElement | null;
            if (delBtn) {
                e.stopPropagation();
                const deleteId = delBtn.dataset.deleteId;
                if (deleteId) {
                    this.stores.chatStore.deleteChat(deleteId);
                    if (this.activeChatId === deleteId) {
                        const remaining = this.stores.chatStore.listChats();
                        if (remaining.length > 0) {
                            this.selectChat(remaining[0]!.id);
                        } else {
                            const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
                            this.selectChat(created.id);
                        }
                    } else {
                        this.renderHeaderSelect();
                    }
                    showMessage("Chat deleted", 2000, "info");
                }
                return;
            }

            const chatItem = (e.target as HTMLElement).closest("[data-chat-id]") as HTMLElement | null;
            if (chatItem) {
                const chatId = chatItem.dataset.chatId;
                if (chatId) {
                    this.selectChat(chatId);
                }
                return;
            }
            const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;

            if (action === "toggle-chats-view") {
                if (this.viewMode === "chat") {
                    this.historySearchQuery = "";
                    if (this.sessionSearchEl) this.sessionSearchEl.value = "";
                    this.viewMode = "chats";
                } else {
                    this.viewMode = "chat";
                }
                this.syncViewMode();
                return;
            } else if (action === "new-chat") {
                const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
                this.selectChat(created.id);
            } else if (action === "toggle-graph") {
                this.viewMode = this.viewMode === "graph" ? "chat" : "graph";
                this.syncViewMode();
            } else if (action === "delete-chat") {
                if (!this.activeChatId) return;
                this.stores.chatStore.deleteChat(this.activeChatId);
                const remaining = this.stores.chatStore.listChats();
                if (remaining.length > 0) {
                    this.activeChatId = remaining[0]!.id;
                } else {
                    const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
                    this.activeChatId = created.id;
                }
                this.renderAllChat();
            } else if (action === "open-settings") {
                this.callbacks.onOpenSettings();
            } else if (action === "toggle-plan-strip") {
                this.planExpanded = !this.planExpanded;
                this.renderPlanStrip();
            } else if (action === "open-siyuan-doc") {
                const docId = target.dataset.docId;
                if (docId) this.callbacks.onOpenSiyuanDoc(docId);
            } else if (action === "toggle-option") {
                const val = target.dataset.optValue;
                const chat = this.getActiveChat();
                if (!val || !chat || !this.questionDraft) return;
                const pending = danglingQuestionOf(chat.messages);
                if (!pending) return;
                const qd = buildQuestionDataFromToolCall(pending.toolCallId, pending.tool, pending.input);
                if (qd.mode === "multi-select") {
                    if (this.questionDraft.selectedValues.has(val)) this.questionDraft.selectedValues.delete(val);
                    else this.questionDraft.selectedValues.add(val);
                } else {
                    this.questionDraft.selectedValues = new Set([val]);
                    this.questionDraft.otherSelected = false;
                }
                this.renderQuestionCard();
            } else if (action === "toggle-other") {
                if (!this.questionDraft) return;
                this.questionDraft.otherSelected = !this.questionDraft.otherSelected;
                this.renderQuestionCard();
            } else if (action === "set-confidence") {
                const idx = Number(target.dataset.confIdx ?? DEFAULT_CONFIDENCE_INDEX);
                if (this.questionDraft && !Number.isNaN(idx)) {
                    this.questionDraft.confidenceIndex = idx;
                    this.renderQuestionCard();
                }
            } else if (action === "toggle-thinking-mic") {
                if (!this.questionDraft || target.classList.contains("lh-mic-btn--busy")) return;
                const draft = this.questionDraft;
                const voiceBar = this.questionSlotEl.querySelector(".lh-voice-bar--question") as HTMLElement | null;
                const voiceCanvas = voiceBar?.querySelector(".lh-voice-waveform") as HTMLCanvasElement | null;
                const voiceStatus = voiceBar?.querySelector(".lh-voice-status") as HTMLElement | null;

                if (localStt.isRecording()) {
                    target.classList.remove("lh-mic-btn--recording");
                    target.classList.add("lh-mic-btn--busy");
                    target.textContent = "Finishing...";
                    if (voiceStatus) voiceStatus.textContent = "Finishing...";
                    void (async () => {
                        try {
                            await localStt.stopLiveSession();
                        } catch (err: any) {
                            showMessage(`Voice error: ${err?.message ?? String(err)}`, 4000, "error");
                        } finally {
                            target.classList.remove("lh-mic-btn--busy");
                            target.innerHTML = `${ICON.mic}<span>Speak</span>`;
                            voiceBar?.classList.add("fn__none");
                        }
                    })();
                } else {
                    voiceBar?.classList.remove("fn__none");
                    if (voiceStatus) voiceStatus.textContent = "Loading Oído...";
                    const modelId = this.stores.settingsStore.get().sttModel || "oido_v2a";
                    const baseThinking = draft.thinking.trimEnd();
                    const applyLive = (text: string) => {
                        const clean = text.trim();
                        if (!clean) return;
                        draft.thinking = baseThinking ? `${baseThinking} ${clean}` : clean;
                        const ta = this.questionSlotEl.querySelector(".lh-q-thinking") as HTMLTextAreaElement | null;
                        if (ta) {
                            ta.value = draft.thinking;
                            ta.scrollTop = ta.scrollHeight;
                        }
                    };
                    void localStt
                        .startLiveSession({
                            modelId,
                            canvas: voiceCanvas,
                            onPartial: applyLive,
                            onFinal: applyLive,
                            onStatus: (st) => {
                                if (st.message && voiceStatus) voiceStatus.textContent = st.message;
                            },
                            onError: (err) => {
                                showMessage(`Voice error: ${err.message}`, 4000, "error");
                            },
                        })
                        .then(() => {
                            target.classList.add("lh-mic-btn--recording");
                            target.textContent = "⏹ Stop";
                        })
                        .catch((err: any) => {
                            voiceBar?.classList.add("fn__none");
                            showMessage(`Microphone error: ${err?.message ?? String(err)}`, 4000, "error");
                        });
                }
            } else if (action === "submit-question-answer") {
                if (!this.activeChatId || !this.questionDraft) return;
                const draft = this.questionDraft;
                const conf = CONFIDENCE_STOPS[draft.confidenceIndex] ?? 50;
                this.questionDraft = null;
                void this.runner.submitQuestionAnswer(this.activeChatId, {
                    dontKnow: false,
                    values: Array.from(draft.selectedValues),
                    other: draft.otherSelected ? draft.otherText : undefined,
                    text: draft.freeText,
                    thinking: draft.thinking,
                    confidence: conf,
                });
            } else if (action === "submit-dont-know") {
                if (!this.activeChatId || !this.questionDraft) return;
                this.questionDraft = null;
                void this.runner.submitQuestionAnswer(this.activeChatId, {
                    dontKnow: true,
                });
            } else if (action === "skip-question") {
                if (!this.activeChatId) return;
                this.questionDraft = null;
                this.runner.dismissQuestion(this.activeChatId);
            } else if (action === "dismiss-problem") {
                if (this.activeChatId) this.runner.dismissActiveProblem(this.activeChatId);
            } else if (action === "next-problem") {
                if (this.activeChatId) void this.runner.requestNextProblem(this.activeChatId);
            } else if (action === "scroll-to-bottom") {
                if (this.streamEl) {
                    this.streamEl.scrollTop = this.streamEl.scrollHeight;
                    this.syncScrollDownButton();
                }
            } else if (action === "starter-prompt") {
                const prompt = target.dataset.prompt;
                if (prompt) {
                    void this.handleUserSubmit({ displayMarkdown: prompt, referencedBlockIds: [] });
                }
            }
        });

        this.bindSelectionBarEvents();
        this.bindLatexCopyHandler();
        this.bindSideNoteEvents();
    }

    private syncScrollDownButton(): void {
        if (!this.streamEl || !this.scrollBottomBtnEl) return;
        const distanceFromBottom =
            this.streamEl.scrollHeight - this.streamEl.scrollTop - this.streamEl.clientHeight;
        if (distanceFromBottom > 32) {
            this.scrollBottomBtnEl.classList.remove("fn__none");
        } else {
            this.scrollBottomBtnEl.classList.add("fn__none");
        }
    }

    private hideSelectionBar(): void {
        this.currentSelectionQuote = "";
        this.currentSelectionAnchor = null;
        this.selectionBarEl?.classList.add("fn__none");
    }

    private extractLatexAwareText(range: Range, preserveNewlines: boolean): { text: string; hasMath: boolean } {
        const ancestorEl =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? (range.commonAncestorContainer as HTMLElement)
                : range.commonAncestorContainer.parentElement;

        // Case 1: Entire selection is inside a single rendered KaTeX equation
        const enclosingKatex = ancestorEl?.closest(".katex");
        if (enclosingKatex) {
            const ann = enclosingKatex.querySelector('annotation[encoding="application/x-tex"]');
            if (ann?.textContent) {
                const isDisplay = Boolean(enclosingKatex.closest(".lh-math-block, .katex-display"));
                const tex = ann.textContent.trim();
                return { text: isDisplay ? `$$${tex}$$` : `$${tex}$`, hasMath: true };
            }
        }

        const wrapper = document.createElement("div");
        wrapper.appendChild(range.cloneContents());
        wrapper.querySelectorAll(".lh-block-actions").forEach((el) => el.remove());

        let hasMath = false;
        wrapper.querySelectorAll(".katex").forEach((katexEl) => {
            const ann = katexEl.querySelector('annotation[encoding="application/x-tex"]');
            if (ann?.textContent) {
                hasMath = true;
                const isDisplay = Boolean(katexEl.closest(".lh-math-block, .katex-display"));
                const tex = ann.textContent.trim();
                katexEl.replaceWith(document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`));
            } else {
                katexEl.querySelectorAll(".katex-mathml").forEach((m) => m.remove());
            }
        });
        wrapper.querySelectorAll(".katex-mathml").forEach((m) => m.remove());

        if (!preserveNewlines) {
            return { text: (wrapper.textContent ?? "").replace(/\s+/g, " ").trim(), hasMath };
        }

        // Preserve paragraph/block line breaks when copying to clipboard
        const chunks: string[] = [];
        const blockTags = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "TR"]);
        const walk = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                chunks.push(node.textContent ?? "");
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const el = node as HTMLElement;
            if (el.tagName === "BR") {
                chunks.push("\n");
                return;
            }
            const isBlock = blockTags.has(el.tagName);
            if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1]!.endsWith("\n")) {
                chunks.push("\n");
            }
            for (const child of Array.from(el.childNodes)) {
                walk(child);
            }
            if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1]!.endsWith("\n")) {
                chunks.push("\n");
            }
        };
        walk(wrapper);
        const text = chunks
            .join("")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        return { text, hasMath };
    }

    private extractCleanSelectionText(range: Range): string {
        return this.extractLatexAwareText(range, false).text;
    }

    private bindLatexCopyHandler(): void {
        this.streamEl.addEventListener("copy", (ev: ClipboardEvent) => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !ev.clipboardData) return;
            const range = sel.getRangeAt(0);
            const ancestorEl =
                range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                    ? (range.commonAncestorContainer as HTMLElement)
                    : range.commonAncestorContainer.parentElement;
            if (!ancestorEl || !this.streamEl.contains(ancestorEl)) return;

            const { text, hasMath } = this.extractLatexAwareText(range, true);
            if (!hasMath || !text) return;

            ev.preventDefault();
            ev.clipboardData.setData("text/plain", text);
        });
    }

    private updateSelectionBar(): void {
        if (this.viewMode !== "chat" || !this.streamEl || !this.selectionBarEl) {
            this.hideSelectionBar();
            return;
        }
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            this.hideSelectionBar();
            return;
        }

        const range = sel.getRangeAt(0);
        const anchorEl =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? (range.commonAncestorContainer as HTMLElement)
                : range.commonAncestorContainer.parentElement;

        if (!anchorEl || !this.streamEl.contains(anchorEl)) {
            this.hideSelectionBar();
            return;
        }

        // Only show on teacher/assistant prose or question statements
        const insideTeachable = anchorEl.closest(
            ".lh-assistant-prose, .lh-question-card__q, .lh-qa-history__q, .lh-qa-history__exp",
        );
        if (!insideTeachable) {
            this.hideSelectionBar();
            return;
        }

        const quote = this.extractCleanSelectionText(range);
        if (quote.length < 2) {
            this.hideSelectionBar();
            return;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            this.hideSelectionBar();
            return;
        }

        this.currentSelectionQuote = quote.length > 420 ? `${quote.slice(0, 417)}...` : quote;

        // Capture block anchor if selection is inside a decorated assistant step block
        const stepBlock = anchorEl.closest(".lh-step-block") as HTMLElement | null;
        const msgWrap = anchorEl.closest(".lh-msg--assistant[data-msg-id]") as HTMLElement | null;
        if (stepBlock && msgWrap && msgWrap.dataset.msgId) {
            const blockIndex = Number(stepBlock.dataset.blockIdx ?? "0");
            const prevBlock = this.findPreviousStepBlock(msgWrap, blockIndex);
            this.currentSelectionAnchor = {
                messageId: msgWrap.dataset.msgId,
                blockIndex: Number.isNaN(blockIndex) ? 0 : blockIndex,
                previousBlockText: prevBlock ? this.extractBlockLatexText(prevBlock) : undefined,
            };
        } else {
            this.currentSelectionAnchor = null;
        }

        this.selectionBarEl.classList.remove("fn__none");

        // Measure and position cleanly above (or below if near top) clamped to viewport
        const barRect = this.selectionBarEl.getBoundingClientRect();
        const pad = 8;
        let left = rect.left + rect.width / 2 - barRect.width / 2;
        left = Math.max(pad, Math.min(left, window.innerWidth - barRect.width - pad));

        let top = rect.top - barRect.height - 8;
        if (top < pad) {
            top = rect.bottom + 8;
        }
        top = Math.max(pad, Math.min(top, window.innerHeight - barRect.height - pad));

        this.selectionBarEl.style.left = `${Math.round(left)}px`;
        this.selectionBarEl.style.top = `${Math.round(top)}px`;
    }

    private bindSelectionBarEvents(): void {
        const scheduleUpdate = () => {
            window.setTimeout(() => this.updateSelectionBar(), 10);
        };

        this.streamEl.addEventListener("mouseup", scheduleUpdate);
        this.streamEl.addEventListener("keyup", scheduleUpdate);
        this.streamEl.addEventListener(
            "scroll",
            () => {
                this.hideSelectionBar();
                this.syncScrollDownButton();
            },
            { passive: true },
        );

        this.boundSelectionChangeListener = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) {
                this.hideSelectionBar();
            }
        };
        document.addEventListener("selectionchange", this.boundSelectionChangeListener);

        this.boundDocMouseDownListener = (ev: MouseEvent) => {
            if (this.selectionBarEl && !this.selectionBarEl.contains(ev.target as Node)) {
                this.hideSelectionBar();
            }
        };
        document.addEventListener("mousedown", this.boundDocMouseDownListener);

        // Keep selection intact when clicking a toolbar button
        this.selectionBarEl.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
        });

        this.selectionBarEl.addEventListener("click", (ev) => {
            const btn = (ev.target as HTMLElement).closest("[data-sel-action]") as HTMLElement | null;
            if (!btn) return;
            const action = btn.dataset.selAction as SideNoteIntent | undefined;
            const quote = this.currentSelectionQuote;
            const anchor = this.currentSelectionAnchor;
            this.hideSelectionBar();
            window.getSelection()?.removeAllRanges();

            if (!quote || !this.activeChatId || !action) return;

            // Prefer non-polluting inline side-note when selection is anchored to an assistant block
            if (anchor) {
                if (action === "custom") {
                    const threadId = this.runner.openCustomSideNote({
                        chatId: this.activeChatId,
                        messageId: anchor.messageId,
                        blockIndex: anchor.blockIndex,
                        quote,
                    });
                    if (threadId) this.focusSideNoteInput(threadId);
                    return;
                }
                void this.runner.askSideNote({
                    chatId: this.activeChatId,
                    messageId: anchor.messageId,
                    blockIndex: anchor.blockIndex,
                    intent: action,
                    quote,
                    previousBlockText: anchor.previousBlockText,
                });
                return;
            }

            if (this.runner.getState(this.activeChatId).busy) {
                showMessage("Wait for the current response to finish or click Stop first.", 2500, "info");
                return;
            }

            const prompts: Record<string, string> = {
                explain: `> "${quote}"\n\nI don't follow this statement. Can you break it down more simply?`,
                bridge: `> "${quote}"\n\nI don't see how this follows from the previous step. Can you show the logical bridge?`,
                relevance: `> "${quote}"\n\nI don't see the relevance of this statement—why does it matter here and how does it connect to our goal?`,
                example: `> "${quote}"\n\nCan you give me a concrete example or intuition for this?`,
            };
            const prompt = prompts[action];
            if (!prompt) return;

            void this.runner.sendUserMessage(this.activeChatId, prompt);
        });
    }

    // ─── Per-Block Hover Actions & Inline Side-Note Drawers ─────────────────────

    private extractBlockLatexText(blockEl: HTMLElement): string {
        const clone = blockEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".lh-block-actions, .lh-sidenote-slot").forEach((el) => el.remove());
        clone.querySelectorAll(".katex").forEach((katexEl) => {
            const ann = katexEl.querySelector('annotation[encoding="application/x-tex"]');
            if (ann?.textContent) {
                const isDisplay = Boolean(katexEl.closest(".lh-math-block, .katex-display"));
                const tex = ann.textContent.trim();
                katexEl.replaceWith(document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`));
            } else {
                katexEl.querySelectorAll(".katex-mathml").forEach((m) => m.remove());
            }
        });
        clone.querySelectorAll(".katex-mathml").forEach((m) => m.remove());
        return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    }

    private findPreviousStepBlock(msgWrap: HTMLElement, blockIndex: number): HTMLElement | null {
        if (blockIndex <= 0) return null;
        return msgWrap.querySelector(`.lh-step-block[data-block-idx="${blockIndex - 1}"]`) as HTMLElement | null;
    }

    private decorateAssistantBlocks(transcriptEl: HTMLElement, chat: ChatRecord): void {
        const sideNotes = chat.sideNotes ?? [];
        const notesByKey = new Map<string, SideNoteThread[]>();
        for (const sn of sideNotes) {
            const key = `${sn.messageId}:${sn.blockIndex}`;
            const list = notesByKey.get(key) ?? [];
            list.push(sn);
            notesByKey.set(key, list);
        }

        const assistantMsgs = transcriptEl.querySelectorAll<HTMLElement>(".lh-msg--assistant[data-msg-id]");
        assistantMsgs.forEach((msgEl) => {
            const messageId = msgEl.dataset.msgId;
            if (!messageId) return;

            const proseBlocks = msgEl.querySelectorAll<HTMLElement>(".lh-assistant-prose");
            let blockIndex = 0;

            proseBlocks.forEach((proseEl) => {
                const candidates = Array.from(
                    proseEl.querySelectorAll<HTMLElement>("p, li, .lh-math-block, blockquote"),
                ).filter((el) => {
                    // Avoid double-decorating elements nested inside another matched step block (e.g. <p> inside <li>)
                    const parentMatch = el.parentElement?.closest("p, li, .lh-math-block, blockquote");
                    if (parentMatch && proseEl.contains(parentMatch)) return false;
                    // Skip tiny empty paragraphs
                    if (!el.classList.contains("lh-math-block") && !(el.textContent ?? "").trim()) return false;
                    return true;
                });

                for (const blockEl of candidates) {
                    const idx = blockIndex++;
                    blockEl.classList.add("lh-step-block");
                    blockEl.dataset.blockIdx = String(idx);

                    const actions = document.createElement("span");
                    actions.className = "lh-block-actions";
                    actions.setAttribute("contenteditable", "false");
                    actions.innerHTML = `
                        <button type="button" class="lh-block-actions__btn" data-block-action="explain" title="Don't follow — break this down">${ICON.help}</button>
                        <button type="button" class="lh-block-actions__btn" data-block-action="bridge" title="How does this follow from the previous step?">${ICON.bridge}</button>
                        <button type="button" class="lh-block-actions__btn" data-block-action="relevance" title="Why does this matter here?">${ICON.target}</button>
                        <button type="button" class="lh-block-actions__btn" data-block-action="example" title="Give an example or intuition">${ICON.spark}</button>
                        <button type="button" class="lh-block-actions__btn" data-block-action="custom" title="Ask a custom question about this block">${ICON.ask}</button>
                    `;
                    blockEl.appendChild(actions);

                    const anchored = notesByKey.get(`${messageId}:${idx}`);
                    if (anchored && anchored.length > 0) {
                        const slot = document.createElement("div");
                        slot.className = "lh-sidenote-slot";
                        slot.innerHTML = anchored.map((sn) => this.renderSideNoteHtml(sn)).join("\n");
                        if (blockEl.tagName === "LI") {
                            blockEl.appendChild(slot);
                        } else {
                            blockEl.insertAdjacentElement("afterend", slot);
                        }
                    }
                }
            });
        });
    }

    private renderSideNoteHtml(sn: SideNoteThread): string {
        const stream = this.runner.getSideNoteStream(sn.id);
        const intentLabels: Record<SideNoteIntent, string> = {
            explain: `${ICON.help}<span>Don't follow</span>`,
            bridge: `${ICON.bridge}<span>Why it follows</span>`,
            relevance: `${ICON.target}<span>Relevance</span>`,
            example: `${ICON.spark}<span>Example</span>`,
            custom: `${ICON.ask}<span>Side-note</span>`,
        };
        const badgeHtml = intentLabels[sn.intent] ?? `${ICON.ask}<span>Side-note</span>`;
        const shortQuote = sn.quote.length > 68 ? `${sn.quote.slice(0, 65)}...` : sn.quote;
        const replyCount = sn.entries.filter((e) => e.role === "assistant").length;

        if (sn.collapsed && !stream?.busy) {
            return `
                <div class="lh-sidenote lh-sidenote--collapsed" data-sidenote-id="${escapeHtml(sn.id)}">
                    <button type="button" class="lh-sidenote__pill" data-sidenote-toggle="${escapeHtml(sn.id)}" title="Expand side-note">
                        <span class="lh-sidenote__badge">${badgeHtml}</span>
                        <span class="lh-sidenote__pill-quote">"${escapeHtml(shortQuote)}"</span>
                        <span class="lh-sidenote__pill-count">${replyCount} ${replyCount === 1 ? "reply" : "replies"} ▸</span>
                    </button>
                    <button type="button" class="lh-sidenote__icon-btn" data-sidenote-delete="${escapeHtml(sn.id)}" title="Dismiss side-note">×</button>
                </div>
            `;
        }

        const entriesHtml = sn.entries
            .map((entry, idx) => {
                // Skip displaying the auto-generated first user prompt verbatim since the intent badge already shows it
                if (idx === 0 && entry.role === "user" && sn.intent !== "custom") {
                    return "";
                }
                if (entry.role === "user") {
                    return `<div class="lh-sidenote__user">${escapeHtml(entry.text)}</div>`;
                }
                return `<div class="lh-sidenote__reply b3-typography">${renderMarkdown(entry.text)}</div>`;
            })
            .filter(Boolean)
            .join("\n");

        const streamHtml = stream
            ? stream.error
                ? `<div class="lh-sidenote__error">${escapeHtml(stream.error)}</div>`
                : stream.text
                  ? `<div class="lh-sidenote__reply lh-sidenote__reply--streaming b3-typography">${renderMarkdown(stream.text)}</div>`
                  : `<div class="lh-sidenote__thinking">Thinking...</div>`
            : "";

        const hasBody = Boolean(entriesHtml || streamHtml);
        const inputPlaceholder =
            sn.entries.length === 0 ? "Ask anything about this step..." : "Ask a quick follow-up on this step...";

        return `
            <div class="lh-sidenote" data-sidenote-id="${escapeHtml(sn.id)}">
                <div class="lh-sidenote__header">
                    <button type="button" class="lh-sidenote__header-toggle" data-sidenote-toggle="${escapeHtml(sn.id)}" title="Collapse side-note">
                        <span class="lh-sidenote__badge">${badgeHtml}</span>
                        <span class="lh-sidenote__quote">"${escapeHtml(shortQuote)}"</span>
                        <span class="lh-sidenote__chev">▾</span>
                    </button>
                    <div class="lh-sidenote__header-actions">
                        ${
                            stream?.busy
                                ? `<button type="button" class="lh-sidenote__mini-btn" data-sidenote-stop="${escapeHtml(sn.id)}" title="Stop generating">Stop</button>`
                                : sn.entries.length > 0
                                  ? `<button type="button" class="lh-sidenote__mini-btn" data-sidenote-promote="${escapeHtml(sn.id)}" title="Move this question to the main chat">→ Chat</button>`
                                  : ""
                        }
                        <button type="button" class="lh-sidenote__icon-btn" data-sidenote-delete="${escapeHtml(sn.id)}" title="Dismiss side-note">×</button>
                    </div>
                </div>
                <div class="lh-sidenote__body${hasBody ? "" : " fn__none"}">
                    ${entriesHtml}
                    <div class="lh-sidenote__stream">${streamHtml}</div>
                </div>
                <form class="lh-sidenote__form" data-sidenote-form="${escapeHtml(sn.id)}">
                    <input type="text" class="lh-sidenote__input" placeholder="${inputPlaceholder}" ${
                        stream?.busy ? "disabled" : ""
                    } />
                    <button type="submit" class="lh-sidenote__send" ${stream?.busy ? "disabled" : ""} title="Send question">↵</button>
                </form>
            </div>
        `;
    }

    private focusSideNoteInput(threadId: string): void {
        window.requestAnimationFrame(() => {
            const input = this.streamEl.querySelector(
                `.lh-sidenote[data-sidenote-id="${threadId}"] .lh-sidenote__input`,
            ) as HTMLInputElement | null;
            input?.focus();
        });
    }

    private updateSideNoteInPlace(threadId: string): void {
        const chat = this.getActiveChat();
        if (!chat) return;
        const thread = chat.sideNotes?.find((t) => t.id === threadId);
        const existingEl = this.streamEl.querySelector(`.lh-sidenote[data-sidenote-id="${threadId}"]`) as HTMLElement | null;
        if (!thread) {
            existingEl?.remove();
            return;
        }
        if (!existingEl) {
            this.renderTranscript();
            return;
        }

        const stream = this.runner.getSideNoteStream(threadId);
        // While streaming tokens, update ONLY the streaming slot so we never disturb scroll or focus
        if (stream?.busy) {
            const streamSlot = existingEl.querySelector(".lh-sidenote__stream") as HTMLElement | null;
            if (streamSlot) {
                streamSlot.innerHTML = stream.text
                    ? `<div class="lh-sidenote__reply lh-sidenote__reply--streaming b3-typography">${renderMarkdown(stream.text)}</div>`
                    : `<div class="lh-sidenote__thinking">Thinking...</div>`;
                this.syncScrollDownButton();
                return;
            }
        }

        // Settled or collapsed state changed: replace just this card
        const tmp = document.createElement("div");
        tmp.innerHTML = this.renderSideNoteHtml(thread).trim();
        const replacement = tmp.firstElementChild;
        if (replacement) {
            existingEl.replaceWith(replacement);
        }
        this.syncScrollDownButton();
    }

    private bindSideNoteEvents(): void {
        this.streamEl.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement;

            // 1. Block-level hover action buttons (?, ↳, 🎯, 💡)
            const blockBtn = target.closest("[data-block-action]") as HTMLElement | null;
            if (blockBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                if (!this.activeChatId) return;
                const intent = blockBtn.dataset.blockAction as SideNoteIntent | undefined;
                const blockEl = blockBtn.closest(".lh-step-block") as HTMLElement | null;
                const msgEl = blockBtn.closest(".lh-msg--assistant[data-msg-id]") as HTMLElement | null;
                if (!intent || !blockEl || !msgEl?.dataset.msgId) return;

                const blockIndex = Number(blockEl.dataset.blockIdx ?? "0");
                const rawQuote = this.extractBlockLatexText(blockEl);
                if (!rawQuote) return;
                const quote = rawQuote.length > 420 ? `${rawQuote.slice(0, 417)}...` : rawQuote;

                if (intent === "custom") {
                    const threadId = this.runner.openCustomSideNote({
                        chatId: this.activeChatId,
                        messageId: msgEl.dataset.msgId,
                        blockIndex: Number.isNaN(blockIndex) ? 0 : blockIndex,
                        quote,
                    });
                    if (threadId) this.focusSideNoteInput(threadId);
                    return;
                }

                const prevBlock = this.findPreviousStepBlock(msgEl, blockIndex);
                const previousBlockText = prevBlock ? this.extractBlockLatexText(prevBlock) : undefined;

                void this.runner.askSideNote({
                    chatId: this.activeChatId,
                    messageId: msgEl.dataset.msgId,
                    blockIndex: Number.isNaN(blockIndex) ? 0 : blockIndex,
                    intent,
                    quote,
                    previousBlockText,
                });
                return;
            }

            // 2. Collapse / expand side-note
            const toggleBtn = target.closest("[data-sidenote-toggle]") as HTMLElement | null;
            if (toggleBtn && this.activeChatId) {
                ev.stopPropagation();
                const threadId = toggleBtn.dataset.sidenoteToggle;
                if (threadId) this.runner.toggleSideNoteCollapsed(this.activeChatId, threadId);
                return;
            }

            // 3. Stop streaming side-note
            const stopBtn = target.closest("[data-sidenote-stop]") as HTMLElement | null;
            if (stopBtn) {
                ev.stopPropagation();
                const threadId = stopBtn.dataset.sidenoteStop;
                if (threadId) this.runner.abortSideNote(threadId);
                return;
            }

            // 4. Delete / dismiss side-note
            const delBtn = target.closest("[data-sidenote-delete]") as HTMLElement | null;
            if (delBtn && this.activeChatId) {
                ev.stopPropagation();
                const threadId = delBtn.dataset.sidenoteDelete;
                if (threadId) this.runner.deleteSideNote(this.activeChatId, threadId);
                return;
            }

            // 5. Promote side-note to main chat
            const promoteBtn = target.closest("[data-sidenote-promote]") as HTMLElement | null;
            if (promoteBtn && this.activeChatId) {
                ev.stopPropagation();
                const threadId = promoteBtn.dataset.sidenotePromote;
                const chat = this.getActiveChat();
                const sn = chat?.sideNotes?.find((t) => t.id === threadId);
                if (!sn) return;
                if (this.runner.getState(this.activeChatId).busy) {
                    showMessage("Wait for the current response to finish or click Stop first.", 2500, "info");
                    return;
                }
                const lastUserQ =
                    [...sn.entries].reverse().find((e) => e.role === "user")?.text ??
                    "Can we go deeper into this step in the main lesson?";
                const prompt = `> "${sn.quote}"\n\n${lastUserQ}`;
                void this.runner.sendUserMessage(this.activeChatId, prompt);
                return;
            }
        });

        // 6. Side-note follow-up form submit
        this.streamEl.addEventListener("submit", (ev) => {
            const form = (ev.target as HTMLElement).closest("[data-sidenote-form]") as HTMLFormElement | null;
            if (!form || !this.activeChatId) return;
            ev.preventDefault();
            const threadId = form.dataset.sidenoteForm;
            const input = form.querySelector(".lh-sidenote__input") as HTMLInputElement | null;
            const text = input?.value.trim() ?? "";
            if (!threadId || !text) return;

            const chat = this.getActiveChat();
            const sn = chat?.sideNotes?.find((t) => t.id === threadId);
            if (!sn) return;

            if (input) input.value = "";
            const msgEl = form.closest(".lh-msg--assistant[data-msg-id]") as HTMLElement | null;
            const prevBlock = msgEl ? this.findPreviousStepBlock(msgEl, sn.blockIndex) : null;
            const previousBlockText = prevBlock ? this.extractBlockLatexText(prevBlock) : undefined;
            void this.runner.askSideNote({
                chatId: this.activeChatId,
                messageId: sn.messageId,
                blockIndex: sn.blockIndex,
                intent: sn.intent,
                quote: sn.quote,
                previousBlockText,
                customQuestion: text,
                threadId: sn.id,
            });
        });
    }
}
