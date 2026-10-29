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
import { getBlockById, readNoteMarkdown } from "./siyuan/client";
import type { SiYuanHarnessStores } from "./store/siyuan-store";
import { KnowledgeGraphView } from "./ui/graph-view";
import { escapeHtml, renderMarkdown } from "./ui/markdown";
import { SiYuanBlockInput } from "./ui/siyuan-block-input";

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
    private showGraphOverlay = false;
    private planExpanded = false;
    private questionDraft: ActiveQuestionDraft | null = null;

    private sessionDropdownEl!: HTMLElement;
    private sessionTitleEl!: HTMLElement;
    private sessionMenuEl!: HTMLElement;
    private sessionListEl!: HTMLElement;
    private boundDocClickListener?: (e: MouseEvent) => void;
    private graphBtnEl!: HTMLElement;
    private planStripEl!: HTMLElement;
    private chatBodyEl!: HTMLElement;
    private graphBodyEl!: HTMLElement;
    private streamEl!: HTMLElement;
    private streamingSlotEl!: HTMLElement;
    private questionSlotEl!: HTMLElement;
    private blockInputContainerEl!: HTMLElement;

    private blockInput!: SiYuanBlockInput;
    private graphView: KnowledgeGraphView | null = null;

    private unsubStore: (() => void) | null = null;
    private unsubRunner: (() => void) | null = null;

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
            if (this.showGraphOverlay) {
                this.graphView?.refresh();
            } else {
                this.renderPlanStrip();
                this.renderTranscript();
                this.renderQuestionCard();
                this.syncComposerState();
            }
        });

        this.unsubRunner = this.runner.subscribe((changedChatId) => {
            this.renderHeaderSelect();
            if (changedChatId === this.activeChatId && !this.showGraphOverlay) {
                this.renderPlanStrip();
                this.renderTranscript();
                this.renderStreamingSlot();
                this.renderQuestionCard();
                this.syncComposerState();
            }
        });
    }

    public destroy(): void {
        this.unsubStore?.();
        this.unsubRunner?.();
        if (this.boundDocClickListener) {
            document.removeEventListener("click", this.boundDocClickListener);
        }
        this.blockInput?.destroy();
        this.graphView?.destroy();
    }

    public selectChat(chatId: string): void {
        this.activeChatId = chatId;
        this.showGraphOverlay = false;
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
        this.showGraphOverlay = false;
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
                    <div class="lh-session-dropdown">
                    <button type="button" class="lh-session-dropdown__trigger" data-action="toggle-session-menu" title="Switch or manage chat sessions">
                        <span class="lh-session-dropdown__active-title">New Chat</span>
                        <svg class="lh-session-dropdown__chevron" viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 6L8 9.5 11.5 6z"/></svg>
                    </button>
                    <div class="lh-session-dropdown__menu fn__none">
                        <div class="lh-session-dropdown__actions">
                            <button type="button" class="lh-session-dropdown__new-btn" data-action="dropdown-new-chat">
                                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg>
                                <span>New Chat</span>
                            </button>
                        </div>
                        <div class="lh-session-dropdown__list"></div>
                    </div>
                </div>
                    <span class="fn__space"></span>
                    <span class="block__icon b3-tooltips b3-tooltips__sw" aria-label="New Chat" data-action="new-chat">
                        <svg><use xlink:href="#iconAdd"></use></svg>
                    </span>
                    <span class="block__icon b3-tooltips b3-tooltips__sw lh-graph-toggle-btn" aria-label="Toggle Knowledge Graph" data-action="toggle-graph">
                        <svg><use xlink:href="#iconGraph"></use></svg>
                    </span>
                    <span class="block__icon b3-tooltips b3-tooltips__sw" aria-label="Delete Chat" data-action="delete-chat">
                        <svg><use xlink:href="#iconTrashcan"></use></svg>
                    </span>
                    <span class="block__icon b3-tooltips b3-tooltips__sw" aria-label="Settings" data-action="open-settings">
                        <svg><use xlink:href="#iconSettings"></use></svg>
                    </span>
                    <span data-type="min" class="block__icon b3-tooltips b3-tooltips__sw" aria-label="Minimize">
                        <svg><use xlink:href="#iconMin"></use></svg>
                    </span>
                </div>

                <div class="lh-plan-strip" style="display:none;"></div>

                <div class="lh-chat-main">
                    <div class="lh-chat-stream">
                        <div class="lh-transcript"></div>
                        <div class="lh-streaming-slot"></div>
                        <div class="lh-question-slot"></div>
                    </div>

                    <div class="lh-composer-host"></div>
                </div>

                <div class="lh-graph-drawer" style="display:none;"></div>
            </div>
        `;

        this.sessionDropdownEl = this.rootElement.querySelector(".lh-session-dropdown") as HTMLElement;
        this.sessionTitleEl = this.rootElement.querySelector(".lh-session-dropdown__active-title") as HTMLElement;
        this.sessionMenuEl = this.rootElement.querySelector(".lh-session-dropdown__menu") as HTMLElement;
        this.sessionListEl = this.rootElement.querySelector(".lh-session-dropdown__list") as HTMLElement;
        this.graphBtnEl = this.rootElement.querySelector(".lh-graph-toggle-btn") as HTMLElement;
        this.planStripEl = this.rootElement.querySelector(".lh-plan-strip") as HTMLElement;
        this.chatBodyEl = this.rootElement.querySelector(".lh-chat-main") as HTMLElement;
        this.graphBodyEl = this.rootElement.querySelector(".lh-graph-drawer") as HTMLElement;
        this.streamEl = this.rootElement.querySelector(".lh-chat-stream") as HTMLElement;
        this.streamingSlotEl = this.rootElement.querySelector(".lh-streaming-slot") as HTMLElement;
        this.questionSlotEl = this.rootElement.querySelector(".lh-question-slot") as HTMLElement;
        this.blockInputContainerEl = this.rootElement.querySelector(".lh-composer-host") as HTMLElement;

        this.blockInput = new SiYuanBlockInput(this.blockInputContainerEl, {
            app: this.callbacks.app,
            placeholder: "Write a message, press / for blocks, (( to reference notes...",
            getPillsState: () => {
                const chat = this.getActiveChat();
                const s = this.stores.settingsStore.get();
                const provider = chat?.settings?.provider ?? s.activeProvider;
                const modelLabel =
                    chat?.settings?.modelId ??
                    (provider === "deepseek"
                        ? s.deepseekModel
                        : provider === "gemini"
                          ? s.geminiModel
                          : s.customModel);
                const modeLabel = chat?.kind === "practice" ? "Practice mode" : "Teach mode";
                const mechanicLabel = s.quizzingMechanic === "explain" ? "Explain" : "Quiz";
                return { modeLabel, modelLabel, mechanicLabel };
            },
            onAttachActiveNote: () => {
                const activeTitle = document.querySelector(
                    ".layout__wnd--active .protyle:not(.fn__none) .protyle-title, .protyle:not(.fn__none) .protyle-title",
                ) as HTMLElement | null;
                const docId = activeTitle?.dataset?.nodeId;
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
        });

        this.bindEvents();
        this.renderAllChat();
    }

    private syncViewMode(): void {
        if (this.showGraphOverlay) {
            this.chatBodyEl.style.display = "none";
            this.planStripEl.style.display = "none";
            this.graphBodyEl.style.display = "flex";
            this.graphBtnEl.classList.add("lh-icon-active");
            this.graphView?.refresh();
        } else {
            this.chatBodyEl.style.display = "flex";
            this.graphBodyEl.style.display = "none";
            this.graphBtnEl.classList.remove("lh-icon-active");
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

    private renderHeaderSelect(): void {
        const chats = this.stores.chatStore.listChats();
        const activeChat = this.getActiveChat();
        if (this.sessionTitleEl) {
            const prefix = activeChat?.kind === "practice" ? "🎯 " : "";
            this.sessionTitleEl.textContent = `${prefix}${activeChat?.title || "New Chat"}`;
        }

        if (!this.sessionListEl) return;

        if (chats.length === 0) {
            this.sessionListEl.innerHTML = `<div class="lh-session-dropdown__empty">No chats yet</div>`;
            return;
        }

        const itemsHtml = chats.map((c) => {
            const isActive = c.id === this.activeChatId;
            const icon = c.kind === "practice" ? "🎯" : "💬";
            return `
                <div class="lh-dropdown-item ${isActive ? "lh-dropdown-item--active" : ""}" data-chat-id="${escapeHtml(c.id)}">
                    <div class="lh-dropdown-item__main">
                        <span class="lh-dropdown-item__icon">${icon}</span>
                        <span class="lh-dropdown-item__title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
                    </div>
                    <button type="button" class="lh-dropdown-item__del-btn" data-delete-id="${escapeHtml(c.id)}" title="Delete chat">
                        <svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.5 2a.5.5 0 0 0-.5.5v1H2.5a.5.5 0 0 0 0 1h.541l.732 9.026A1.5 1.5 0 0 0 5.266 15h5.468a1.5 1.5 0 0 0 1.493-1.474L12.959 4.5h.541a.5.5 0 0 0 0-1H11v-1a.5.5 0 0 0-.5-.5h-5zM6 3h4v1H6V3zm-.954 2h5.908l-.715 8.818a.5.5 0 0 1-.498.482H5.266a.5.5 0 0 1-.498-.482L4.046 5z"/></svg>
                    </button>
                </div>
            `;
        });

        this.sessionListEl.innerHTML = itemsHtml.join("");
    }

    private renderPlanStrip(): void {
        if (this.showGraphOverlay) {
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

        this.planStripEl.innerHTML = `
            <div class="lh-plan-strip__bar" data-action="toggle-plan-strip">
                <span class="lh-plan-strip__summary">
                    🗺️ <strong>${escapeHtml(currentTitle)}</strong>
                    <span class="lh-plan-strip__count">(${visitedCount}/${tree.nodes.length})</span>
                </span>
                <span class="lh-plan-strip__chevron">${this.planExpanded ? "▴" : "▾"}</span>
            </div>
            ${
                this.planExpanded
                    ? `
                <div class="lh-plan-strip__drawer">
                    ${tree.nodes
                        .map((n) => {
                            const st = derivedNodeStatus(statuses, n.id);
                            const icon = st === "current" ? "🎯" : st === "visited" ? "✓" : "○";
                            return `
                                <div class="lh-plan-strip__node lh-plan-strip__node--${st}">
                                    <span>${icon}</span>
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
                    <div class="lh-chat-empty__title">
                        ${isPractice ? "Practice Mode" : "What would you like to learn?"}
                    </div>
                    <div class="lh-chat-empty__sub">
                        Type a topic below, or type <code>((</code> / paste a block from your open SiYuan note to reference it directly.
                    </div>
                </div>
            `;
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
                    const details = (m.details ?? {}) as { docId?: string; title?: string; hPath?: string };
                    if (details.docId) {
                        blocksHtml.push(`
                            <div class="lh-inline-note">
                                <span class="lh-block-ref" data-action="open-siyuan-doc" data-doc-id="${escapeHtml(
                                    details.docId,
                                )}" data-block-ref-id="${escapeHtml(details.docId)}">📄 ${escapeHtml(
                            details.title || details.hPath || details.docId,
                        )}</span>
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
                            <summary>🔍 ${escapeHtml(summary)}</summary>
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
        return `<div class="lh-msg lh-msg--assistant">${parts.join("\n")}</div>`;
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
            parts.push(`<div class="lh-typing-indicator">${escapeHtml(st.activeToolStatus)}</div>`);
        } else if (st.busy && parts.length === 0) {
            parts.push(`<div class="lh-typing-indicator">Thinking...</div>`);
        }
        if (st.error) {
            parts.push(`<div class="lh-error-banner">${escapeHtml(st.error)}</div>`);
        }

        this.streamingSlotEl.innerHTML = `<div class="lh-msg lh-msg--assistant">${parts.join("\n")}</div>`;
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
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
            const otherEl = this.questionSlotEl.querySelector(".lh-q-other") as HTMLInputElement | null;
            otherEl?.addEventListener("input", () => {
                draft.otherText = otherEl.value;
                draft.otherSelected = true;
            });
            this.streamEl.scrollTop = this.streamEl.scrollHeight;
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

    private async handleUserSubmit(payload: {
        displayMarkdown: string;
        referencedBlockIds: string[];
    }): Promise<void> {
        const chat = this.getActiveChat();
        if (!chat) return;

        // If the user referenced any SiYuan blocks inside the mini Protyle editor,
        // attach their read-only content so the Prober / Teacher knows the exact block contents.
        if (payload.referencedBlockIds.length > 0) {
            for (const blockId of payload.referencedBlockIds) {
                let title = blockId;
                let hPath = blockId;
                let fullExcerpt = "";
                try {
                    const match = await getBlockById(blockId);
                    if (match) {
                        title = (match.content || match.hPath || blockId).slice(0, 80);
                        hPath = match.hPath || blockId;
                        fullExcerpt = match.markdown || match.content || "";
                    }
                    const exported = await readNoteMarkdown(blockId);
                    if (exported.content) {
                        fullExcerpt = exported.content.slice(0, 6000);
                        if (exported.hPath) hPath = exported.hPath;
                    }
                } catch {
                    // Use block markdown from SQLite if exportMdContent fails on a leaf block
                }
                if (fullExcerpt) {
                    chat.messages.push(
                        newSiyuanNoteContextMessage({
                            docId: blockId,
                            title,
                            hPath,
                            markdownExcerpt: fullExcerpt,
                        }),
                    );
                }
            }
            this.stores.chatStore.saveChat(chat);
        }

        // If we're in an active practice problem, route the message as practice thinking/solution
        const activeProb = activeProblemOf(chat.messages);
        if (chat.kind === "practice" && activeProb) {
            await this.runner.submitPracticeThinking(chat.id, payload.displayMarkdown);
            return;
        }

        await this.runner.sendUserMessage(chat.id, payload.displayMarkdown);
    }

    private bindEvents(): void {
        // Close session dropdown when clicking outside
        this.boundDocClickListener = (ev: MouseEvent) => {
            if (this.sessionDropdownEl && !this.sessionDropdownEl.contains(ev.target as Node)) {
                this.sessionMenuEl?.classList.add("fn__none");
            }
        };
        document.addEventListener("click", this.boundDocClickListener);

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
                    this.sessionMenuEl?.classList.add("fn__none");
                }
                return;
            }
            const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;

            if (action === "toggle-session-menu") {
                this.sessionMenuEl?.classList.toggle("fn__none");
                this.renderHeaderSelect();
                return;
            } else if (action === "dropdown-new-chat") {
                const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
                this.selectChat(created.id);
                this.sessionMenuEl?.classList.add("fn__none");
                return;
            } else if (action === "new-chat") {
                const created = this.stores.chatStore.createChat({ title: "New Chat", kind: "teach" });
                this.selectChat(created.id);
            } else if (action === "toggle-graph") {
                this.showGraphOverlay = !this.showGraphOverlay;
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
            }
        });
    }
}
