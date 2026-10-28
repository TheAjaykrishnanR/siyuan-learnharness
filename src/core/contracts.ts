/**
 * Shared domain contracts for LearnHarness in SiYuan:
 * - Plan tree (session dependency DAG)
 * - Knowledge graph (nodes, reasoning chains, clusters, provenance)
 * - Chat sessions & native message history
 * - Probe assessment & handoff
 * - LLM provider & model configuration (DeepSeek + Gemini + Custom)
 */

import { Type } from "./schema";

// ─── Plan Tree Contracts ────────────────────────────────────────────────────

export interface PlanNode {
    id: string;
    title: string;
    summary?: string;
}

export interface PlanEdge {
    from: string;
    to: string;
}

export interface PlanTree {
    nodes: PlanNode[];
    edges: PlanEdge[];
    version: number;
}

export type PlanNodeStatus = "current" | "visited" | "upcoming";

export interface DerivedPlanStatuses {
    current: string | null;
    visited: ReadonlySet<string>;
}

export function derivedNodeStatus(statuses: DerivedPlanStatuses, nodeId: string): PlanNodeStatus {
    if (statuses.current === nodeId) return "current";
    if (statuses.visited.has(nodeId)) return "visited";
    return "upcoming";
}

export interface PlanToolResult {
    ok: boolean;
    error?: string;
    tree?: PlanTree;
}

// ─── Knowledge Graph Contracts ──────────────────────────────────────────────

export interface GraphEdge {
    from: string;
    to: string;
}

export interface ProvenancePoint {
    chatId: string;
    messageId: string;
}

export interface GraphChain {
    id: string;
    premises: string[];
    conclusion: string;
    provenance: ProvenancePoint[];
    createdAt: string;
}

export interface EmissionStats {
    nodes: number;
    chains?: number;
    droppedChains?: number;
}

export interface NotesSource {
    id: string;
    filePath: string;
    /** Optional SiYuan document ID when imported from a SiYuan note */
    docId?: string;
    /** Human-readable notebook + document path in SiYuan */
    hPath?: string;
    importedAt: string;
}

export interface GraphNode {
    id: string;
    name: string;
    statement: string;
    aliases: string[];
    createdAt: string;
    provenance: ProvenancePoint[];
}

export interface SessionCheckpoint {
    chatId: string;
    foldedAt: string;
}

export interface CoverageEntry {
    chatId: string;
    fp: string;
    tokens: number;
    foldedAt: string;
}

export interface ExtractedProposition {
    id: string;
    name: string;
    statement: string;
    aliases: string[];
    messageId?: string;
}

export interface ExtractedChain {
    premises: string[];
    conclusion: string;
}

export interface SessionFindings {
    propositions: ExtractedProposition[];
    chains: ExtractedChain[];
}

export interface IdentityLink {
    id: string;
    linkTo: string;
}

export interface AuditVerdicts {
    links: IdentityLink[];
}

export interface Cluster {
    id: string;
    label: string | null;
    members: string[];
}

export interface Position {
    x: number;
    y: number;
}

export interface GraphSnapshot {
    nodes: GraphNode[];
    propositions: GraphNode[];
    edges: GraphEdge[];
    logicalEdges: GraphEdge[];
    impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
    chains: GraphChain[];
    sessions: Record<string, string>;
    fileSources: Record<string, string>;
    /** srcId -> SiYuan docId for click-to-open SiYuan note */
    docSources: Record<string, string>;
    nodeSessions: Record<string, string[]>;
    clusters: Cluster[];
    positions?: Record<string, Position>;
}

export const TITLE_MAX_CHARS = 72;

export function titleFromPrompt(prompt: string): string {
    const oneLine = prompt.replace(/\s+/g, " ").trim();
    if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
    let cut = -1;
    for (let i = TITLE_MAX_CHARS; i > 0; i--) {
        if (oneLine[i - 1] === " ") {
            cut = i - 1;
            break;
        }
    }
    if (cut < 0) cut = TITLE_MAX_CHARS;
    return `${oneLine.slice(0, cut)}…`;
}

// ─── Native Message & Session Contracts ─────────────────────────────────────

export type Phase3 = "probe" | "plan" | "teach";
export type ChatKind = "teach" | "practice";

export interface TextContentBlock {
    type: "text";
    text: string;
}

export interface ThinkingContentBlock {
    type: "thinking";
    thinking: string;
}

export interface ToolCallContentBlock {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export type AssistantContentBlock = TextContentBlock | ThinkingContentBlock | ToolCallContentBlock;

export interface LhUserMessage {
    id: string;
    role: "user";
    content: string;
    timestamp: number;
}

export interface LhAssistantMessage {
    id: string;
    role: "assistant";
    content: AssistantContentBlock[];
    stopReason?: "stop" | "toolUse" | "error" | "aborted";
    model?: string;
    provider?: string;
    timestamp: number;
}

export interface LhToolResultMessage {
    id: string;
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: TextContentBlock[];
    details?: unknown;
    isError: boolean;
    timestamp: number;
}

export interface LhMarkerMessage {
    id: string;
    role: "custom";
    customType:
        | "graph-context"
        | "siyuan-note-context"
        | "probe-handoff"
        | "plan-block"
        | "practice-thinking"
        | "practice-next"
        | "problem-dismissed";
    content: string;
    display: boolean;
    details: unknown;
    timestamp: number;
}

export type LhMessage = LhUserMessage | LhAssistantMessage | LhToolResultMessage | LhMarkerMessage;

export interface ChatSettings {
    provider?: "deepseek" | "gemini" | "custom";
    modelId?: string;
    quizzingMechanic?: "quiz" | "explain";
}

export interface ChatRecord {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: LhMessage[];
    kind?: ChatKind;
    tree?: PlanTree;
    settings?: ChatSettings;
    /** Optional linked SiYuan note context when launched from a note */
    linkedDocId?: string;
    linkedDocTitle?: string;
    version?: number;
}

export interface ChatSummary {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    kind: ChatKind;
    messageCount: number;
    phase: Phase3;
    pendingQuestion: boolean;
    pendingProblem: boolean;
    linkedDocId?: string;
    linkedDocTitle?: string;
}

export function derivePlanStatusesLh(tree: PlanTree, messages: readonly LhMessage[]): DerivedPlanStatuses {
    const ids = new Set(tree.nodes.map((n) => n.id));
    const runs: string[] = [];
    for (const m of messages) {
        if (m.role !== "assistant") continue;
        for (const block of m.content) {
            if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
            const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
            if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
            if (runs.at(-1) !== nodeId) runs.push(nodeId);
        }
    }
    const current = runs.at(-1) ?? null;
    const visited = new Set(runs.slice(0, -1));
    return { current, visited };
}

// ─── Probe Contracts & Canonical Texts ──────────────────────────────────────

export interface ProbeStrand {
    strand: string;
    assessment: string;
}

export interface ProbeAssessment {
    strands: ProbeStrand[];
    summary?: string;
}

export interface ProbeDoneInput {
    assessment: ProbeAssessment;
}

export const probeDoneInputSchema = Type.Object({
    assessment: Type.Object(
        {
            strands: Type.Array(
                Type.Object({
                    strand: Type.String({
                        description:
                            "The dependency strand (e.g. 'the derivative as a limit') — a name the plan can hang a node on.",
                    }),
                    assessment: Type.String({
                        description:
                            "Where his edge sits on this strand: the floor (what he reliably gets right), the ceiling (where it runs out), " +
                            "misconceptions found, and what the lesson should build from.",
                    }),
                }),
                { minItems: 1, description: "Every strand the planned lesson will depend on, each with your read of his edge on it." },
            ),
            summary: Type.Optional(
                Type.String({
                    description: "Optional overall synthesis: his apparent goal and where the teaching should enter.",
                }),
            ),
        },
        { description: "The learner assessment — the probe's distilled output." },
    ),
});

export const PROBE_DONE_ACK_TEXT =
    "Assessment recorded — it is shown to the learner now and the teacher plans from it. Say your closing sentence and end your turn; the teaching phase takes over from here.";

export const HANDOFF_TEXT =
    "Next: plan the full teaching arc from my current understanding to the goal understanding. " +
    "Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
    "Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
    "Take your time here and really think this through. " +
    "When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

export const THINKING_LABEL = "Your thinking";

export const CONCLUDE_ACK_TEXT =
    "Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

export const NEXT_PROBLEM_TEXT =
    "[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";
