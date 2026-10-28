/**
 * Extraction coverage — pure core.
 * The teacher's prose is the unit of coverage, fingerprinted deterministically.
 */

import type { CoverageEntry, LhMessage } from "./contracts";
import { userFacingTextOf } from "./messages";
import { syncHashHex } from "./schema";

export type { CoverageEntry };

export function messageViewLines(message: LhMessage, mid: string): string[] {
    const lines: string[] = [];
    if (message.role !== "assistant") return lines;
    for (const text of userFacingTextOf(message.content)) {
        lines.push(`TEACHER [${mid}] ${text.trim()}`);
    }
    return lines;
}

export function teacherProseBlocks(messages: ReadonlyArray<LhMessage>): string[] {
    const out: string[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const text of userFacingTextOf(message.content)) {
            out.push(text.trim());
        }
    }
    return out;
}

export function viewTokens(lines: string[]): number {
    return Math.ceil(lines.join("\n").length / 4);
}

export function messageFingerprint(message: LhMessage): string {
    return syncHashHex(JSON.stringify([message.role, messageViewLines(message, message.id)]));
}

export interface CoverageSlot {
    message: LhMessage;
    fp: string;
    tokens: number;
}

export function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[] {
    return messages.map((message) => ({
        message,
        fp: messageFingerprint(message),
        tokens: viewTokens(messageViewLines(message, message.id)),
    }));
}

export function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
    const out = new Set<string>();
    for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
    return out;
}

export function coverageOf(
    messages: ReadonlyArray<LhMessage>,
    entries: ReadonlyArray<CoverageEntry>,
    chatId: string,
): {
    slots: CoverageSlot[];
    uncovered: number[];
    coveredTokens: number;
    uncoveredTokens: number;
    coveredCount: number;
    uncoveredCount: number;
} {
    const covered = coveredSet(entries, chatId);
    const slots = coverageSlots(messages);
    const uncovered: number[] = [];
    let coveredTokens = 0;
    let uncoveredTokens = 0;
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        if (slot.tokens === 0) continue;
        if (covered.has(slot.fp)) coveredTokens += slot.tokens;
        else {
            uncovered.push(i);
            uncoveredTokens += slot.tokens;
        }
    }
    const visibleCount = slots.filter((s) => s.tokens > 0).length;
    return {
        slots,
        uncovered,
        coveredTokens,
        uncoveredTokens,
        coveredCount: visibleCount - uncovered.length,
        uncoveredCount: uncovered.length,
    };
}

export function batchRuns(
    slots: ReadonlyArray<CoverageSlot>,
    uncovered: ReadonlyArray<number>,
    budget: number,
): CoverageSlot[][] {
    if (budget <= 0 || uncovered.length === 0) return [];
    const runs: CoverageSlot[][] = [];
    let current: CoverageSlot[] = [];
    let currentTokens = 0;
    const flush = () => {
        if (current.length > 0) runs.push(current);
        current = [];
        currentTokens = 0;
    };
    for (const i of uncovered) {
        const slot = slots[i]!;
        if (current.length > 0 && currentTokens + slot.tokens > budget) flush();
        current.push(slot);
        currentTokens += slot.tokens;
    }
    flush();
    return runs;
}
