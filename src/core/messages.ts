/**
 * Native message history, phase derivation, and question/problem state folds.
 */

import {
    CONCLUDE_ACK_TEXT,
    HANDOFF_TEXT,
    NEXT_PROBLEM_TEXT,
    THINKING_LABEL,
    type LhAssistantMessage,
    type LhMarkerMessage,
    type LhMessage,
    type LhToolResultMessage,
    type LhUserMessage,
    type Phase3,
} from "./contracts";
import { QUESTION_TOOLS, compactAnswerForModel, type QuestionAnswerData } from "./question-core";
import { randomHex } from "./schema";

export const INTERRUPTED_TEXT =
    "The question was interrupted — the learner never answered; continue without holding a result for it.";

export const PRACTICE_PROBLEM_TOOL = "problem";
export const PRACTICE_CONCLUDE_TOOL = "conclude";

export function newMessageId(): string {
    return `msg_${Date.now().toString(36)}_${randomHex(4)}`;
}

export function newUserMessage(text: string): LhUserMessage {
    return {
        id: newMessageId(),
        role: "user",
        content: text,
        timestamp: Date.now(),
    };
}

export function newAnswerResult(
    toolCallId: string,
    toolName: string,
    answer: QuestionAnswerData,
): LhToolResultMessage {
    return {
        id: newMessageId(),
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer)) }],
        details: answer,
        isError: false,
        timestamp: Date.now(),
    };
}

export function newHandoffMessage(chatId: string): LhMarkerMessage {
    return {
        id: `steer_probe_${chatId}_${Date.now().toString(36)}`,
        role: "custom",
        customType: "probe-handoff",
        content: HANDOFF_TEXT,
        display: true,
        details: { chatId },
        timestamp: Date.now(),
    };
}

export interface GraphContextPick {
    id: string;
    name: string;
    statement: string;
}

export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage {
    const lines = [
        "[Session context] — picked from the learner's knowledge map when starting this session:",
        "",
        "Propositions (id — name: statement; the problem tool's target field uses these ids):",
        ...picks.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
    ];
    if (chains.length > 0) {
        lines.push("", "Reasoning chains among them (premises → conclusion):", ...chains.map((c) => `- ${c}`));
    }
    return {
        id: newMessageId(),
        role: "custom",
        customType: "graph-context",
        content: lines.join("\n"),
        display: true,
        details: { propositions: picks, chains },
        timestamp: Date.now(),
    };
}

export function newSiyuanNoteContextMessage(opts: {
    docId: string;
    title: string;
    hPath: string;
    markdownExcerpt: string;
}): LhMarkerMessage {
    const content = [
        `[SiYuan Note Context] — the learner launched this session from their SiYuan note "${opts.title}" (docId: \`${opts.docId}\`, path: \`${opts.hPath}\`).`,
        `You can read additional sections or related notes using \`siyuan_read_note\`, \`siyuan_find_notes\`, or \`siyuan_grep_notes\`.`,
        "",
        "--- BEGIN NOTE EXCERPT ---",
        opts.markdownExcerpt,
        "--- END NOTE EXCERPT ---",
    ].join("\n");
    return {
        id: newMessageId(),
        role: "custom",
        customType: "siyuan-note-context",
        content,
        display: true,
        details: opts,
        timestamp: Date.now(),
    };
}

export function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage {
    return {
        id: newMessageId(),
        role: "custom",
        customType: "practice-thinking",
        content: `${THINKING_LABEL}:\n${text}`,
        display: true,
        details: { problemCallId, text },
        timestamp: Date.now(),
    };
}

export function newNextMessage(): LhMarkerMessage {
    return {
        id: newMessageId(),
        role: "custom",
        customType: "practice-next",
        content: NEXT_PROBLEM_TEXT,
        display: true,
        details: {},
        timestamp: Date.now(),
    };
}

export function resultIdsFrom(messages: readonly LhMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const m of messages) {
        if (m.role === "toolResult") {
            ids.add(m.toolCallId);
        }
    }
    return ids;
}

function cleanToolCallIds(messages: readonly LhMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const m of messages) {
        if (m.role === "toolResult" && !m.isError) {
            ids.add(m.toolCallId);
        }
    }
    return ids;
}

export function danglingQuestionOf(
    messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: Record<string, unknown> } | null {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const m = messages[mi]!;
        if (m.role !== "assistant") continue;
        const answered = resultIdsFrom(messages.slice(mi + 1));
        for (const block of m.content) {
            if (block.type !== "toolCall") continue;
            if (!(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
            if (answered.has(block.id)) continue;
            return { toolCallId: block.id, tool: block.name, input: block.arguments };
        }
        return null;
    }
    return null;
}

export function probeDoneResultIds(messages: readonly LhMessage[]): Set<string> {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const m of messages) {
        if (m.role === "assistant") {
            if (m.stopReason === "error" || m.stopReason === "aborted") continue;
            for (const block of m.content) {
                if (block.type === "toolCall" && block.name === "probe_done") calls.add(block.id);
            }
        } else if (
            m.role === "toolResult" &&
            m.toolName === "probe_done" &&
            calls.has(m.toolCallId) &&
            !m.isError &&
            (m.details as { ok?: unknown } | null | undefined)?.ok !== false
        ) {
            results.add(m.id);
        }
    }
    return results;
}

export function hasProbeDone(messages: readonly LhMessage[]): boolean {
    return probeDoneResultIds(messages).size > 0;
}

function taggedNodeId(input: unknown): boolean {
    return (
        typeof input === "object" &&
        input !== null &&
        typeof (input as { nodeId?: unknown }).nodeId === "string" &&
        (input as { nodeId: string }).nodeId.length > 0
    );
}

export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3 {
    let phase: Phase3 = "probe";
    if (messages.length === 0) return phase;
    const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
    const concluded = probeDoneResultIds(messages.slice(0, last + 1));
    for (let i = 0; i <= last; i++) {
        const m = messages[i]!;
        if (m.role === "toolResult") {
            if (phase === "probe" && concluded.has(m.id)) phase = "plan";
        } else if (m.role === "assistant") {
            if (phase === "plan") {
                for (const block of m.content) {
                    if (
                        block.type === "toolCall" &&
                        (block.name === "quiz" || block.name === "explain") &&
                        taggedNodeId(block.arguments)
                    ) {
                        phase = "teach";
                        break;
                    }
                }
            }
        }
    }
    return phase;
}

export function activeProblemOf(
    messages: readonly LhMessage[],
): { toolCallId: string; input: Record<string, unknown> } | null {
    const cleanCallIds = cleanToolCallIds(messages);
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const m = messages[mi]!;
        if (m.role === "custom" && m.customType === "problem-dismissed") {
            return null;
        }
        if (m.role === "assistant") {
            for (let bi = m.content.length - 1; bi >= 0; bi--) {
                const block = m.content[bi]!;
                if (block.type !== "toolCall") continue;
                if (block.name === PRACTICE_CONCLUDE_TOOL) {
                    if (cleanCallIds.has(block.id)) return null;
                    continue;
                }
                if (block.name === PRACTICE_PROBLEM_TOOL) {
                    if (cleanCallIds.has(block.id)) {
                        return { toolCallId: block.id, input: block.arguments };
                    }
                }
            }
        }
    }
    return null;
}

export function problemInputForConclude(
    messages: readonly LhMessage[],
    concludeCallId: string,
): { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown } | undefined {
    let mi = messages.findIndex(
        (m) =>
            m.role === "assistant" &&
            m.content.some((b) => b.type === "toolCall" && b.id === concludeCallId),
    );
    if (mi < 0) return undefined;
    const clean = cleanToolCallIds(messages);
    for (; mi >= 0; mi--) {
        const m = messages[mi]!;
        if (m.role !== "assistant") continue;
        for (let bi = m.content.length - 1; bi >= 0; bi--) {
            const block = m.content[bi]!;
            if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL) continue;
            if (!clean.has(block.id)) continue;
            return block.arguments;
        }
    }
    return undefined;
}

export function userFacingTextOf(content: LhAssistantMessage["content"]): string[] {
    const out: string[] = [];
    for (const block of content) {
        if (block.type === "text" && block.text.trim().length > 0) {
            out.push(block.text.trim());
        }
    }
    return out;
}

export function concludedByDismissalPair(
    problemCallId: string,
): [LhAssistantMessage, LhToolResultMessage] {
    const callId = `call_conc_${problemCallId}`;
    const now = Date.now();
    return [
        {
            id: newMessageId(),
            role: "assistant",
            content: [{ type: "toolCall", id: callId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }],
            stopReason: "toolUse",
            timestamp: now,
        },
        {
            id: newMessageId(),
            role: "toolResult",
            toolCallId: callId,
            toolName: PRACTICE_CONCLUDE_TOOL,
            content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
            details: { outcome: "dismissed", problemCallId },
            isError: false,
            timestamp: now,
        },
    ];
}
