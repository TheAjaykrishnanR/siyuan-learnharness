/**
 * Session Runner — orchestrates Prober -> Teacher -> Practitioner turns,
 * tool execution, question dock answering, probe_done handoff steers,
 * and automatic Knowledge Graph extraction.
 */

import {
    titleFromPrompt,
    type ChatRecord,
    type LhAssistantMessage,
    type LhMessage,
    type LhToolResultMessage,
    type NoteImageAttachment,
    type SideNoteIntent,
    type SideNoteThread,
} from "../core/contracts";
import { getGraph, type GraphDeps } from "../core/graph";
import {
    activeProblemOf,
    concludedByDismissalPair,
    danglingQuestionOf,
    hasProbeDone,
    newAnswerResult,
    newHandoffMessage,
    newMessageId,
    newNextMessage,
    newSiyuanNoteContextMessage,
    newThinkingMessage,
    newUserMessage,
} from "../core/messages";
import type { ChatStore, GraphStore, SettingsStore } from "../core/ports";
import {
    buildAnswer,
    buildQuestionDataFromToolCall,
    dismissedAnswer,
    type AnswerRequest,
} from "../core/question-core";
import { extractFromChat } from "./extraction";
import { resolveModelConfig, streamModelStep } from "./llm-client";
import {
    buildPracticeSystemPrompt,
    buildProberSystemPrompt,
    buildTeacherSystemPrompt,
} from "./prompts";
import {
    createPracticeToolSet,
    createQuestionTools,
    healToolRecord,
    planTools,
    probeDoneTool,
    proberGraphTools,
    siyuanNoteTools,
    type AgentToolDefinition,
} from "./tools";

export interface SessionRunnerDeps {
    chatStore: ChatStore;
    graphStore: GraphStore;
    settingsStore: SettingsStore;
}

export interface TurnStreamState {
    chatId: string;
    busy: boolean;
    streamingMessage: LhAssistantMessage | null;
    activeToolStatus: string | null;
    error: string | null;
}

export interface SideNoteStreamState {
    chatId: string;
    threadId: string;
    busy: boolean;
    text: string;
    error: string | null;
}

const SIDENOTE_SYSTEM_PROMPT = `You are a concise, clear tutor answering an inline side-note clarification for a learner reading a lesson.
Rules:
- Focus strictly on the quoted statement/equation and the learner's specific confusion (breaking it down, showing how it follows from the previous step, explaining its relevance to the goal, or giving a concrete example/intuition).
- Keep your reply compact and scannable (typically 2–6 short sentences or a brief derivation).
- Use clean LaTeX: $...$ for inline math and $$...$$ on its own line for standalone equations.
- Do not restart the lesson, do not add meta-commentary or filler greetings.`;

export class SessionRunner {
    private deps: SessionRunnerDeps;
    private activeControllers = new Map<string, AbortController>();
    private states = new Map<string, TurnStreamState>();
    private listeners = new Set<(chatId: string) => void>();
    private sideNoteControllers = new Map<string, AbortController>();
    private sideNoteStreams = new Map<string, SideNoteStreamState>();
    private sideNoteListeners = new Set<(chatId: string, threadId: string) => void>();
    private extractingChats = new Set<string>();

    constructor(deps: SessionRunnerDeps) {
        this.deps = deps;
    }

    public subscribe(fn: (chatId: string) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    public subscribeSideNote(fn: (chatId: string, threadId: string) => void): () => void {
        this.sideNoteListeners.add(fn);
        return () => this.sideNoteListeners.delete(fn);
    }

    public getSideNoteStream(threadId: string): SideNoteStreamState | null {
        return this.sideNoteStreams.get(threadId) ?? null;
    }

    private emitSideNote(chatId: string, threadId: string): void {
        for (const fn of this.sideNoteListeners) fn(chatId, threadId);
    }

    public abortSideNote(threadId: string): void {
        const ctrl = this.sideNoteControllers.get(threadId);
        if (ctrl) {
            ctrl.abort();
            this.sideNoteControllers.delete(threadId);
        }
        const st = this.sideNoteStreams.get(threadId);
        if (st) {
            this.sideNoteStreams.delete(threadId);
            this.emitSideNote(st.chatId, threadId);
        }
    }

    public toggleSideNoteCollapsed(chatId: string, threadId: string): void {
        const record = this.deps.chatStore.getChat(chatId);
        if (!record?.sideNotes) return;
        const thread = record.sideNotes.find((t) => t.id === threadId);
        if (!thread) return;
        thread.collapsed = !thread.collapsed;
        this.deps.chatStore.saveChat(record);
        this.emitSideNote(chatId, threadId);
    }

    public deleteSideNote(chatId: string, threadId: string): void {
        this.abortSideNote(threadId);
        const record = this.deps.chatStore.getChat(chatId);
        if (!record?.sideNotes) return;
        record.sideNotes = record.sideNotes.filter((t) => t.id !== threadId);
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);
    }

    /** Create an empty inline side-note drawer anchored to a block so the learner can type a custom question. */
    public openCustomSideNote(opts: {
        chatId: string;
        messageId: string;
        blockIndex: number;
        quote: string;
    }): string {
        const record = this.deps.chatStore.getChat(opts.chatId);
        if (!record) return "";
        if (!record.sideNotes) record.sideNotes = [];

        const thread: SideNoteThread = {
            id: `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            messageId: opts.messageId,
            blockIndex: opts.blockIndex,
            intent: "custom",
            quote: opts.quote,
            entries: [],
            collapsed: false,
            createdAt: Date.now(),
        };
        record.sideNotes.push(thread);
        this.deps.chatStore.saveChat(record);
        this.emit(opts.chatId);
        return thread.id;
    }

    /** Run a non-polluting inline side-note clarification anchored to a specific message block. */
    public async askSideNote(opts: {
        chatId: string;
        messageId: string;
        blockIndex: number;
        intent: SideNoteIntent;
        quote: string;
        previousBlockText?: string;
        customQuestion?: string;
        threadId?: string;
    }): Promise<string> {
        const record = this.deps.chatStore.getChat(opts.chatId);
        if (!record) return "";

        if (!record.sideNotes) record.sideNotes = [];

        const intentQuestions: Record<SideNoteIntent, string> = {
            explain: "I don't follow this statement. Break it down more simply.",
            bridge: "I don't see how this follows from the previous step. Show the logical bridge.",
            relevance: "Why does this statement matter here, and how does it connect to our goal?",
            example: "Give me a concrete example or intuition for this.",
            custom: opts.customQuestion?.trim() || "Can you clarify this?",
        };

        const userQuestion = opts.customQuestion?.trim() || intentQuestions[opts.intent];

        let thread: SideNoteThread | undefined;
        if (opts.threadId) {
            thread = record.sideNotes.find((t) => t.id === opts.threadId);
        }
        if (!thread) {
            thread = {
                id: `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                messageId: opts.messageId,
                blockIndex: opts.blockIndex,
                intent: opts.intent,
                quote: opts.quote,
                entries: [],
                collapsed: false,
                createdAt: Date.now(),
            };
            record.sideNotes.push(thread);
        } else {
            thread.collapsed = false;
        }

        thread.entries.push({
            role: "user",
            text: userQuestion,
            timestamp: Date.now(),
        });
        this.deps.chatStore.saveChat(record);

        const threadId = thread.id;
        // Abort any in-flight stream on this same thread
        this.sideNoteControllers.get(threadId)?.abort();
        const ctrl = new AbortController();
        this.sideNoteControllers.set(threadId, ctrl);
        this.sideNoteStreams.set(threadId, {
            chatId: opts.chatId,
            threadId,
            busy: true,
            text: "",
            error: null,
        });
        this.emit(opts.chatId);
        this.emitSideNote(opts.chatId, threadId);

        // Build compact lesson context around the anchor message
        const anchorIdx = record.messages.findIndex((m) => m.id === opts.messageId);
        const contextSlice =
            anchorIdx >= 0
                ? record.messages.slice(Math.max(0, anchorIdx - 3), anchorIdx + 1)
                : record.messages.slice(-4);
        const contextLines: string[] = [];
        for (const m of contextSlice) {
            if (m.role === "user" && m.content.trim()) {
                contextLines.push(`LEARNER: ${m.content.trim().slice(0, 600)}`);
            } else if (m.role === "assistant") {
                const txt = m.content
                    .filter((b) => b.type === "text")
                    .map((b) => (b.type === "text" ? b.text : ""))
                    .join("\n")
                    .trim();
                if (txt) contextLines.push(`TEACHER: ${txt.slice(0, 2400)}`);
            }
        }

        const wireHistory: LhMessage[] = [];
        const introParts = [
            contextLines.length > 0 ? `LESSON CONTEXT:\n${contextLines.join("\n\n")}` : "",
            opts.previousBlockText ? `PREVIOUS STEP:\n${opts.previousBlockText}` : "",
            `TARGET STATEMENT / EQUATION:\n> ${thread.quote}`,
        ].filter(Boolean);

        // First turn combines context + first question; subsequent turns follow naturally
        for (let i = 0; i < thread.entries.length; i++) {
            const entry = thread.entries[i]!;
            if (entry.role === "user") {
                const body =
                    i === 0 ? `${introParts.join("\n\n")}\n\nLEARNER QUESTION:\n${entry.text}` : entry.text;
                wireHistory.push(newUserMessage(body));
            } else {
                wireHistory.push({
                    id: newMessageId(),
                    role: "assistant",
                    content: [{ type: "text", text: entry.text }],
                    timestamp: entry.timestamp,
                });
            }
        }

        try {
            const settings = this.deps.settingsStore.get();
            const config = resolveModelConfig(settings, record.settings);
            const replyMsg = await streamModelStep({
                config,
                systemPrompt: SIDENOTE_SYSTEM_PROMPT,
                messages: wireHistory,
                tools: {},
                callbacks: {
                    signal: ctrl.signal,
                    onPartialUpdate: (partial) => {
                        if (ctrl.signal.aborted) return;
                        const text = partial.content
                            .filter((b) => b.type === "text")
                            .map((b) => (b.type === "text" ? b.text : ""))
                            .join("");
                        this.sideNoteStreams.set(threadId, {
                            chatId: opts.chatId,
                            threadId,
                            busy: true,
                            text,
                            error: null,
                        });
                        this.emitSideNote(opts.chatId, threadId);
                    },
                },
            });

            if (ctrl.signal.aborted) return threadId;

            const finalText = replyMsg.content
                .filter((b) => b.type === "text")
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("")
                .trim();

            const fresh = this.deps.chatStore.getChat(opts.chatId);
            const freshThread = fresh?.sideNotes?.find((t) => t.id === threadId);
            if (fresh && freshThread && finalText) {
                freshThread.entries.push({
                    role: "assistant",
                    text: finalText,
                    timestamp: Date.now(),
                });
                this.deps.chatStore.saveChat(fresh);
            }
            this.sideNoteStreams.delete(threadId);
            this.emitSideNote(opts.chatId, threadId);
        } catch (err: any) {
            if (!ctrl.signal.aborted && err?.name !== "AbortError") {
                this.sideNoteStreams.set(threadId, {
                    chatId: opts.chatId,
                    threadId,
                    busy: false,
                    text: "",
                    error: err?.message ?? String(err),
                });
                this.emitSideNote(opts.chatId, threadId);
            }
        } finally {
            if (this.sideNoteControllers.get(threadId) === ctrl) {
                this.sideNoteControllers.delete(threadId);
            }
        }

        return threadId;
    }

    public getState(chatId: string): TurnStreamState {
        return (
            this.states.get(chatId) ?? {
                chatId,
                busy: false,
                streamingMessage: null,
                activeToolStatus: null,
                error: null,
            }
        );
    }

    public isExtracting(chatId: string): boolean {
        return this.extractingChats.has(chatId);
    }

    private setState(chatId: string, patch: Partial<TurnStreamState>): void {
        const prev = this.getState(chatId);
        this.states.set(chatId, { ...prev, ...patch });
        this.emit(chatId);
    }

    private emit(chatId: string): void {
        for (const fn of this.listeners) {
            try {
                fn(chatId);
            } catch (err) {
                console.error("[LearnHarness] Runner listener error:", err);
            }
        }
    }

    public abortTurn(chatId: string): void {
        const ctrl = this.activeControllers.get(chatId);
        if (ctrl) {
            ctrl.abort();
            this.activeControllers.delete(chatId);
        }
        this.setState(chatId, { busy: false, streamingMessage: null, activeToolStatus: null });
    }

    /** Send a learner user message and run the agent turn. */
    public async sendUserMessage(chatId: string, text: string, images?: NoteImageAttachment[]): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return;
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) throw new Error(`Chat not found: ${chatId}`);

        // If a Question Card was open when the user chose to reply in chat,
        // cleanly resolve the dangling toolCall before appending the user message.
        const pending = danglingQuestionOf(record.messages);
        if (pending) {
            const qd = buildQuestionDataFromToolCall(pending.toolCallId, pending.tool, pending.input);
            const ans = dismissedAnswer(qd.kind, qd.question);
            record.messages.push(newAnswerResult(pending.toolCallId, pending.tool, ans));
        }

        // Auto-title on first user message
        const hasUserMsg = record.messages.some((m) => m.role === "user");
        if (!hasUserMsg && (record.title === "New Learning Session" || record.title === "New Practice Session")) {
            record.title = titleFromPrompt(trimmed);
        }

        record.messages.push(newUserMessage(trimmed, images));
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);

        await this.runAgentTurn(chatId);
    }

    /** Submit an answer from the Question Dock (`probe`, `recall`, `quiz`, `explain`, `ask_user_question`). */
    public async submitQuestionAnswer(chatId: string, req: AnswerRequest): Promise<void> {
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) throw new Error(`Chat not found: ${chatId}`);

        const pending = danglingQuestionOf(record.messages);
        if (!pending) return;

        const qd = buildQuestionDataFromToolCall(pending.toolCallId, pending.tool, pending.input);
        const answerData = buildAnswer(qd, req, pending.tool);
        const resultMsg = newAnswerResult(pending.toolCallId, pending.tool, answerData);

        record.messages.push(resultMsg);
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);

        await this.runAgentTurn(chatId);
    }

    /** Skip the currently open question and immediately continue the agent turn. */
    public dismissQuestion(chatId: string): void {
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) return;
        const pending = danglingQuestionOf(record.messages);
        if (!pending) return;

        const qd = buildQuestionDataFromToolCall(pending.toolCallId, pending.tool, pending.input);
        const ans = dismissedAnswer(qd.kind, qd.question);
        const resultMsg = newAnswerResult(pending.toolCallId, pending.tool, ans);
        record.messages.push(resultMsg);
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);

        void this.runAgentTurn(chatId);
    }

    /** Submit a thinking trace or solution attempt during a Practice session. */
    public async submitPracticeThinking(chatId: string, text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) return;

        const active = activeProblemOf(record.messages);
        if (active) {
            record.messages.push(newThinkingMessage(active.toolCallId, trimmed));
        } else {
            record.messages.push(newUserMessage(trimmed));
        }
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);

        await this.runAgentTurn(chatId);
    }

    /** Request the next problem in a Practice session. */
    public async requestNextProblem(chatId: string): Promise<void> {
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) return;
        record.messages.push(newNextMessage());
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);

        await this.runAgentTurn(chatId);
    }

    /** Dismiss the active problem in a Practice session. */
    public dismissActiveProblem(chatId: string): void {
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) return;
        const active = activeProblemOf(record.messages);
        if (!active) return;

        const [synthAssist, synthResult] = concludedByDismissalPair(active.toolCallId);
        record.messages.push(synthAssist, synthResult);
        this.deps.chatStore.saveChat(record);
        this.emit(chatId);
    }

    /** Build the active toolset and system prompt for a session's current state. */
    private composeAgentForTurn(
        record: ChatRecord,
        onProbeConcluded: () => void,
    ): { systemPrompt: string; tools: Record<string, AgentToolDefinition> } {
        const settings = this.deps.settingsStore.get();
        const mechanic = record.settings?.quizzingMechanic ?? settings.quizzingMechanic;
        const proactiveNotes = settings.proactiveSiyuanNoteSearch;
        const graphDeps: GraphDeps = {
            chatStore: this.deps.chatStore,
            graphStore: this.deps.graphStore,
        };

        if (record.kind === "practice") {
            return {
                systemPrompt: buildPracticeSystemPrompt({ proactiveNotes }),
                tools: createPracticeToolSet({
                    chatId: record.id,
                    chatStore: this.deps.chatStore,
                    graphDeps,
                    graphNodes: () => getGraph(this.deps.graphStore).nodes,
                }),
            };
        }

        const isTeacherPhase = hasProbeDone(record.messages);

        if (!isTeacherPhase) {
            // Prober Phase
            const tools = healToolRecord({
                ...createQuestionTools({
                    chatId: record.id,
                    chatStore: this.deps.chatStore,
                    phase: "probe",
                    mechanic,
                }),
                ...probeDoneTool({
                    chatId: record.id,
                    chatStore: this.deps.chatStore,
                    onProbeConcluded,
                }),
                ...siyuanNoteTools(),
                ...(settings.graphToolsEnabled ? proberGraphTools(graphDeps) : {}),
            });
            return {
                systemPrompt: buildProberSystemPrompt({ proactiveNotes, mechanic }),
                tools,
            };
        }

        // Teacher Phase (Planning + Teaching)
        const tools = healToolRecord({
            ...planTools({ chatId: record.id, chatStore: this.deps.chatStore }),
            ...createQuestionTools({
                chatId: record.id,
                chatStore: this.deps.chatStore,
                phase: "teach",
                mechanic,
            }),
            ...siyuanNoteTools(),
            ...(settings.graphToolsEnabled ? proberGraphTools(graphDeps) : {}),
        });
        return {
            systemPrompt: buildTeacherSystemPrompt({ proactiveNotes, mechanic }),
            tools,
        };
    }

    /** Core multi-step streaming agent turn loop. */
    public async runAgentTurn(chatId: string): Promise<void> {
        if (this.getState(chatId).busy) return;

        const ctrl = new AbortController();
        this.activeControllers.set(chatId, ctrl);
        this.setState(chatId, { busy: true, streamingMessage: null, activeToolStatus: null, error: null });

        let probeJustConcluded = false;

        try {
            const settings = this.deps.settingsStore.get();
            const MAX_STEPS = 12;

            for (let step = 0; step < MAX_STEPS; step++) {
                if (ctrl.signal.aborted) break;

                const record = this.deps.chatStore.getChat(chatId);
                if (!record) break;

                const config = resolveModelConfig(settings, record.settings);
                const { systemPrompt, tools } = this.composeAgentForTurn(record, () => {
                    probeJustConcluded = true;
                });

                const assistantMsg = await streamModelStep({
                    config,
                    systemPrompt,
                    messages: record.messages,
                    tools,
                    callbacks: {
                        signal: ctrl.signal,
                        onPartialUpdate: (partial) => {
                            if (!ctrl.signal.aborted) {
                                this.setState(chatId, { streamingMessage: partial });
                            }
                        },
                    },
                });

                if (ctrl.signal.aborted) break;

                // Reload latest record and append settled assistant message
                const freshRecord = this.deps.chatStore.getChat(chatId);
                if (!freshRecord) break;
                freshRecord.messages.push(assistantMsg);
                this.deps.chatStore.saveChat(freshRecord);
                this.setState(chatId, { streamingMessage: null });

                const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
                if (toolCalls.length === 0) {
                    break;
                }

                let pausedOnTerminalTool = false;
                const requestedImages: NoteImageAttachment[] = [];

                for (const call of toolCalls) {
                    if (ctrl.signal.aborted) break;
                    if (call.type !== "toolCall") continue;
                    const tool = tools[call.name];
                    if (!tool) {
                        const unknownResult: LhToolResultMessage = {
                            id: newMessageId(),
                            role: "toolResult",
                            toolCallId: call.id,
                            toolName: call.name,
                            content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` }) }],
                            isError: true,
                            timestamp: Date.now(),
                        };
                        freshRecord.messages.push(unknownResult);
                        this.deps.chatStore.saveChat(freshRecord);
                        continue;
                    }

                    this.setState(chatId, { activeToolStatus: `Running ${call.name}…` });
                    const preparedArgs = (
                        tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments
                    ) as Record<string, unknown>;

                    // Update persisted toolCall arguments with healed arguments so UI cards read clean values
                    call.arguments = preparedArgs;
                    this.deps.chatStore.saveChat(freshRecord);

                    const result = await tool.execute(call.id, preparedArgs);
                    if (ctrl.signal.aborted) break;

                    if (result.terminal && !result.isError) {
                        // Do not append a toolResult yet for question tools (probe, recall, quiz, explain, ask_user_question):
                        // the learner's answer IS the toolResult!
                        // Exception: `problem` in practice mode gets an immediate clean ack so activeProblemOf activates.
                        if (call.name === "problem") {
                            const problemAck: LhToolResultMessage = {
                                id: newMessageId(),
                                role: "toolResult",
                                toolCallId: call.id,
                                toolName: call.name,
                                content: [{ type: "text", text: result.text }],
                                details: result.details,
                                isError: false,
                                timestamp: Date.now(),
                            };
                            freshRecord.messages.push(problemAck);
                            this.deps.chatStore.saveChat(freshRecord);
                        }
                        pausedOnTerminalTool = true;
                        break;
                    }

                    const toolResultMsg: LhToolResultMessage = {
                        id: newMessageId(),
                        role: "toolResult",
                        toolCallId: call.id,
                        toolName: call.name,
                        content: [{ type: "text", text: result.text }],
                        details: result.details,
                        isError: Boolean(result.isError),
                        timestamp: Date.now(),
                    };
                    freshRecord.messages.push(toolResultMsg);
                    this.deps.chatStore.saveChat(freshRecord);

                    if (call.name === "siyuan_view_image" && !result.isError) {
                        const img = (result.details as { image?: NoteImageAttachment } | undefined)?.image;
                        if (img?.path && img?.dataUrl) {
                            requestedImages.push(img);
                        }
                    }
                }

                if (!ctrl.signal.aborted && !pausedOnTerminalTool && requestedImages.length > 0) {
                    freshRecord.messages.push(
                        newSiyuanNoteContextMessage({
                            docId: requestedImages[0]!.path,
                            title: requestedImages.map((i) => i.path.split("/").pop() || i.path).join(", "),
                            hPath: requestedImages[0]!.path,
                            markdownExcerpt: `Requested image(s): ${requestedImages.map((i) => i.path).join(", ")}`,
                            images: requestedImages,
                        }),
                    );
                    this.deps.chatStore.saveChat(freshRecord);
                }

                this.setState(chatId, { activeToolStatus: null });

                if (pausedOnTerminalTool) {
                    break;
                }
            }
        } catch (err: any) {
            if (!ctrl.signal.aborted && err?.name !== "AbortError") {
                console.error("[LearnHarness] Agent turn error:", err);
                this.setState(chatId, { error: err?.message ?? String(err) });
            }
        } finally {
            if (this.activeControllers.get(chatId) === ctrl) {
                this.activeControllers.delete(chatId);
                this.setState(chatId, { busy: false, streamingMessage: null, activeToolStatus: null });
            }
        }

        // Automatic Prober -> Teacher Handoff Steer when probe_done just concluded!
        if (probeJustConcluded && !ctrl.signal.aborted) {
            const postProbeRecord = this.deps.chatStore.getChat(chatId);
            if (postProbeRecord && hasProbeDone(postProbeRecord.messages)) {
                postProbeRecord.messages.push(newHandoffMessage(chatId));
                this.deps.chatStore.saveChat(postProbeRecord);
                this.emit(chatId);
                await this.runAgentTurn(chatId);
                return;
            }
        }

        // Background Knowledge Graph Extraction if enabled and in teacher mode
        if (ctrl.signal.aborted) return;
        const finalRecord = this.deps.chatStore.getChat(chatId);
        const settings = this.deps.settingsStore.get();
        if (
            finalRecord &&
            finalRecord.kind !== "practice" &&
            hasProbeDone(finalRecord.messages) &&
            settings.autoExtractGraph
        ) {
            void this.triggerExtractionInBackground(chatId, false);
        }
    }

    public async triggerExtractionInBackground(chatId: string, forceAllUncovered = true): Promise<void> {
        if (this.extractingChats.has(chatId)) return;
        this.extractingChats.add(chatId);
        this.emit(chatId);
        try {
            await extractFromChat(
                {
                    chatStore: this.deps.chatStore,
                    graphStore: this.deps.graphStore,
                    settingsStore: this.deps.settingsStore,
                },
                chatId,
                { forceAllUncovered },
            );
        } catch (err) {
            console.warn("[LearnHarness] Background graph extraction error:", err);
        } finally {
            this.extractingChats.delete(chatId);
            this.emit(chatId);
        }
    }
}
