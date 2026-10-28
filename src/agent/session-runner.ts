/**
 * Session Runner — orchestrates Prober -> Teacher -> Practitioner turns,
 * tool execution, question dock answering, probe_done handoff steers,
 * and automatic Knowledge Graph extraction.
 */

import {
    titleFromPrompt,
    type ChatRecord,
    type LhAssistantMessage,
    type LhToolResultMessage,
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

export class SessionRunner {
    private deps: SessionRunnerDeps;
    private activeControllers = new Map<string, AbortController>();
    private states = new Map<string, TurnStreamState>();
    private listeners = new Set<(chatId: string) => void>();
    private extractingChats = new Set<string>();

    constructor(deps: SessionRunnerDeps) {
        this.deps = deps;
    }

    public subscribe(fn: (chatId: string) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
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
    public async sendUserMessage(chatId: string, text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        const record = this.deps.chatStore.getChat(chatId);
        if (!record) throw new Error(`Chat not found: ${chatId}`);

        // Auto-title on first user message
        const hasUserMsg = record.messages.some((m) => m.role === "user");
        if (!hasUserMsg && (record.title === "New Learning Session" || record.title === "New Practice Session")) {
            record.title = titleFromPrompt(trimmed);
        }

        record.messages.push(newUserMessage(trimmed));
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

    /** Dismiss/skip the currently open question. */
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
                            this.setState(chatId, { streamingMessage: partial });
                        },
                    },
                });

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

                for (const call of toolCalls) {
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
                }

                this.setState(chatId, { activeToolStatus: null });

                if (pausedOnTerminalTool) {
                    break;
                }
            }
        } catch (err: any) {
            if (err?.name !== "AbortError") {
                console.error("[LearnHarness] Agent turn error:", err);
                this.setState(chatId, { error: err?.message ?? String(err) });
            }
        } finally {
            this.activeControllers.delete(chatId);
            this.setState(chatId, { busy: false, streamingMessage: null, activeToolStatus: null });
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
