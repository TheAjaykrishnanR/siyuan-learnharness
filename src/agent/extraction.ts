/**
 * Knowledge Graph Extraction Pipeline (Extractor -> Auditor -> Merger)
 * Ported from learnharness/src/agent/subagents/extraction.ts for in-plugin execution.
 *
 * Supports:
 * 1. Extracting uncovered teacher prose from a learning session (`extractFromChat`)
 * 2. Importing any SiYuan Note (by docId) directly into the Knowledge Graph (`importSiyuanNoteToGraph`)
 */

import type {
    AuditVerdicts,
    CoverageEntry,
    EmissionStats,
    ExtractedChain,
    ExtractedProposition,
    LhMessage,
    SessionFindings,
} from "../core/contracts";
import { batchRuns, coverageOf, messageViewLines, type CoverageSlot } from "../core/coverage";
import {
    getGraph,
    graphSessionIndex,
    graphSessionPropositions,
    mergeFindings,
    type GraphDeps,
} from "../core/graph";
import { newUserMessage } from "../core/messages";
import type { SettingsStore } from "../core/ports";
import { syncHashHex, Type } from "../core/schema";
import { readNoteMarkdown } from "../siyuan/client";
import { resolveModelConfig, streamModelStep } from "./llm-client";
import { healToolRecord, proberGraphTools, type AgentToolDefinition } from "./tools";

const EXTRACTOR_SYSTEM_PROMPT = `You are the Knowledge Graph Extractor for a learning harness.
Your job is to extract the true, world-facing propositions and the reasoning chains (arguments) from the provided teaching passages or personal notes, and submit them by calling the \`submit\` tool.

### Rules for Propositions
1. Every proposition must be a **true, self-contained, world-facing claim** stated at full precision.
2. Never reference "the learner", "the teacher", "the session", or "the note". Misconceptions corrected in the text are stated only as the true correction.
3. Give each proposition:
   - \`id\`: a short local id like \`"p1"\`, \`"p2"\`, ...
   - \`name\`: a compact 2–5 word glossary-style handle (e.g., \`"Chain rule"\`, \`"Gradient descent step"\`).
   - \`statement\`: the full, self-contained true proposition.
   - \`aliases\`: 1–3 verbatim phrasings used in the source text.
   - \`messageId\` (when extracting from a session with \`TEACHER [msg_...]\` tags): copy the exact \`msg_...\` id of the passage where the proposition was articulated.

### Rules for Reasoning Chains
1. A chain \`{ premises: ["p1", "p2"], conclusion: "p3" }\` means those premises **jointly entail or support** that conclusion in the source text.
2. You may also reference existing proposition IDs from \`THE GRAPH SO FAR\` digest if the text builds on them.
3. Call \`submit\` once with all extracted propositions and chains.`;

const AUDITOR_SYSTEM_PROMPT = `You are the Knowledge Graph Auditor.
You receive a list of freshly extracted propositions from a session or note. Your ONLY job is to decide whether each fresh proposition is equivalent to an EXISTING node in the knowledge graph, using your exploration tools (\`find_nodes\`, \`list_sessions\`, \`list_propositions\`), and then call \`submit\` with your \`links\`.

### Equivalence Bias
- If a fresh proposition is a paraphrase, rewording, or compression of an existing node's statement, **link it** (\`{ id: "p1", linkTo: "n_..." }\`).
- Only leave a proposition unlinked when it is a genuinely distinct claim not yet in the graph.
- When the existing graph is empty, call \`submit({ links: [] })\` immediately.`;

export interface ExtractionDependencies extends GraphDeps {
    settingsStore: SettingsStore;
}

function buildDigestForSource(deps: GraphDeps, sourceId: string): string {
    const graph = getGraph(deps.graphStore);
    const owned = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
    if (owned.length === 0) return "";
    const lines = owned.map((n) => `- [${n.id}] ${n.name}: ${n.statement}`);
    return `THE GRAPH SO FAR (from earlier stretches of this source — you may reference these [n_...] ids in chains):\n${lines.join("\n")}\n\n`;
}

async function runExtractorStage(
    deps: ExtractionDependencies,
    sourceText: string,
    digest: string,
    validMessageIds?: Set<string>,
): Promise<SessionFindings> {
    const config = resolveModelConfig(deps.settingsStore.get());
    let captured: SessionFindings = { propositions: [], chains: [] };

    const submitSchema = Type.Object({
        propositions: Type.Array(
            Type.Object({
                id: Type.String({ description: "Local id like 'p1', 'p2'" }),
                name: Type.String({ description: "Short 2-5 word concept handle" }),
                statement: Type.String({ description: "Full self-contained true proposition" }),
                aliases: Type.Optional(Type.Array(Type.String())),
                messageId: Type.Optional(Type.String({ description: "Exact TEACHER [msg_...] id if present" })),
            }),
        ),
        chains: Type.Array(
            Type.Object({
                premises: Type.Array(Type.String(), { minItems: 1 }),
                conclusion: Type.String(),
            }),
        ),
    });

    const tools: Record<string, AgentToolDefinition> = healToolRecord({
        submit: {
            name: "submit",
            description: "Submit the extracted propositions and reasoning chains.",
            parameters: submitSchema,
            execute: async (_id, args) => {
                const rawProps = Array.isArray(args.propositions) ? args.propositions : [];
                const rawChains = Array.isArray(args.chains) ? args.chains : [];
                const propositions: ExtractedProposition[] = rawProps
                    .filter((p: any) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.statement === "string")
                    .map((p: any) => ({
                        id: String(p.id).trim(),
                        name: String(p.name).trim(),
                        statement: String(p.statement).trim(),
                        aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
                        messageId:
                            typeof p.messageId === "string" && (!validMessageIds || validMessageIds.has(p.messageId))
                                ? p.messageId
                                : undefined,
                    }));
                const chains: ExtractedChain[] = rawChains
                    .filter((c: any) => c && Array.isArray(c.premises) && typeof c.conclusion === "string")
                    .map((c: any) => ({
                        premises: c.premises.map(String),
                        conclusion: String(c.conclusion).trim(),
                    }));
                captured = { propositions, chains };
                return { text: JSON.stringify({ ok: true }), terminal: true };
            },
        },
    });

    const prompt = `${digest}SOURCE MATERIAL TO EXTRACT:\n\n${sourceText}\n\nExtract all world-facing propositions and reasoning chains and call \`submit\`.`;
    const history: LhMessage[] = [newUserMessage(prompt)];

    for (let step = 0; step < 3; step++) {
        const msg = await streamModelStep({
            config,
            systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
            messages: history,
            tools,
        });
        history.push(msg);
        const toolCalls = msg.content.filter((b) => b.type === "toolCall");
        if (toolCalls.length === 0) break;
        for (const call of toolCalls) {
            if (call.type !== "toolCall") continue;
            const tool = tools[call.name];
            if (!tool) continue;
            const prepared = (tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments) as Record<
                string,
                unknown
            >;
            const res = await tool.execute(call.id, prepared);
            if (res.terminal) return captured;
        }
    }

    return captured;
}

async function runAuditorStage(
    deps: ExtractionDependencies,
    findings: SessionFindings,
): Promise<AuditVerdicts> {
    const existingNodes = getGraph(deps.graphStore).nodes;
    if (existingNodes.length === 0 || findings.propositions.length === 0) {
        return { links: [] };
    }

    const config = resolveModelConfig(deps.settingsStore.get());
    let verdicts: AuditVerdicts = { links: [] };

    const submitAuditSchema = Type.Object({
        links: Type.Array(
            Type.Object({
                id: Type.String({ description: "The fresh proposition's local id (e.g. 'p1')" }),
                linkTo: Type.String({ description: "The existing graph node id (e.g. 'n_...')" }),
            }),
        ),
    });

    const findNodesSchema = Type.Object({
        query: Type.String({ description: "Keyword to search existing graph propositions by name or statement." }),
    });

    const tools: Record<string, AgentToolDefinition> = healToolRecord({
        ...proberGraphTools(deps),
        find_nodes: {
            name: "find_nodes",
            description: "Search existing propositions in the knowledge graph by keyword.",
            parameters: findNodesSchema,
            execute: async (_id, args) => {
                const q = String(args.query ?? "").toLowerCase().trim();
                const matches = existingNodes
                    .filter(
                        (n) =>
                            !q ||
                            n.name.toLowerCase().includes(q) ||
                            n.statement.toLowerCase().includes(q) ||
                            n.aliases.some((a) => a.toLowerCase().includes(q)),
                    )
                    .slice(0, 30);
                if (matches.length === 0) return { text: `(no existing nodes matching "${q}")` };
                return {
                    text: matches.map((n) => `[${n.id}] ${n.name}: ${n.statement}`).join("\n"),
                };
            },
        },
        submit: {
            name: "submit",
            description: "Submit identity links mapping fresh proposition ids to equivalent existing graph node ids.",
            parameters: submitAuditSchema,
            execute: async (_id, args) => {
                const rawLinks = Array.isArray(args.links) ? args.links : [];
                verdicts = {
                    links: rawLinks
                        .filter((l: any) => l && typeof l.id === "string" && typeof l.linkTo === "string")
                        .map((l: any) => ({ id: String(l.id).trim(), linkTo: String(l.linkTo).trim() })),
                };
                return { text: JSON.stringify({ ok: true }), terminal: true };
            },
        },
    });

    const freshList = findings.propositions
        .map((p) => `- [${p.id}] ${p.name}: ${p.statement}`)
        .join("\n");
    const existingPreview = existingNodes
        .slice(0, 60)
        .map((n) => `- [${n.id}] ${n.name}: ${n.statement}`)
        .join("\n");

    const prompt = [
        `FRESH PROPOSITIONS TO AUDIT:\n${freshList}`,
        `EXISTING GRAPH NODES (${existingNodes.length} total, showing up to 60):\n${existingPreview}`,
        `Check if any fresh propositions are equivalent to existing graph nodes (use find_nodes if needed), then call submit({ links }).`,
    ].join("\n\n");

    const history: LhMessage[] = [newUserMessage(prompt)];

    for (let step = 0; step < 5; step++) {
        const msg = await streamModelStep({
            config,
            systemPrompt: AUDITOR_SYSTEM_PROMPT,
            messages: history,
            tools,
        });
        history.push(msg);
        const toolCalls = msg.content.filter((b) => b.type === "toolCall");
        if (toolCalls.length === 0) break;
        for (const call of toolCalls) {
            if (call.type !== "toolCall") continue;
            const tool = tools[call.name];
            if (!tool) continue;
            const prepared = (tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments) as Record<
                string,
                unknown
            >;
            const res = await tool.execute(call.id, prepared);
            if (res.terminal) return verdicts;
            history.push({
                id: `tr_${Date.now()}_${ call.id }`,
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: res.text }],
                isError: Boolean(res.isError),
                timestamp: Date.now(),
            });
        }
    }

    return verdicts;
}

/** Extract uncovered teacher prose from a chat session into the Knowledge Graph. */
export async function extractFromChat(
    deps: ExtractionDependencies,
    chatId: string,
    opts: { forceAllUncovered?: boolean } = {},
): Promise<EmissionStats> {
    const chat = deps.chatStore.getChat(chatId);
    if (!chat || chat.kind === "practice") return { nodes: 0, chains: 0 };

    const settings = deps.settingsStore.get();
    const budget = Math.max(256, settings.extractionChunkTokens || 2048);
    const cov = coverageOf(chat.messages, deps.graphStore.readCoverage(), chatId);
    if (cov.uncovered.length === 0) return { nodes: 0, chains: 0 };

    if (!opts.forceAllUncovered && cov.uncoveredTokens < budget) {
        return { nodes: 0, chains: 0 };
    }

    const runs: CoverageSlot[][] = batchRuns(cov.slots, cov.uncovered, budget);
    const totalStats: EmissionStats = { nodes: 0, chains: 0, droppedChains: 0 };

    for (const batch of runs) {
        const lines: string[] = [];
        const validMessageIds = new Set<string>();
        for (const slot of batch) {
            validMessageIds.add(slot.message.id);
            lines.push(...messageViewLines(slot.message, slot.message.id));
        }
        const sourceText = lines.join("\n\n");
        if (!sourceText.trim()) continue;

        const digest = buildDigestForSource(deps, chatId);
        const findings = await runExtractorStage(deps, sourceText, digest, validMessageIds);
        const verdicts = await runAuditorStage(deps, findings);

        const now = new Date().toISOString();
        const coverageEntries: CoverageEntry[] = batch.map((slot) => ({
            chatId,
            fp: slot.fp,
            tokens: slot.tokens,
            foldedAt: now,
        }));

        const stats = mergeFindings(chatId, findings, verdicts, deps, {
            foldedAt: now,
            coverage: coverageEntries,
        });
        totalStats.nodes += stats.nodes;
        totalStats.chains = (totalStats.chains ?? 0) + (stats.chains ?? 0);
        totalStats.droppedChains = (totalStats.droppedChains ?? 0) + (stats.droppedChains ?? 0);
    }

    return totalStats;
}

/** Import a SiYuan Note (by docId) through Extractor -> Auditor -> Merger into the Knowledge Graph. */
export async function importSiyuanNoteToGraph(
    deps: ExtractionDependencies,
    docId: string,
): Promise<{ stats: EmissionStats; hPath: string; sourceId: string }> {
    const exported = await readNoteMarkdown(docId);
    if (!exported.content.trim()) {
        throw new Error("The selected SiYuan note is empty.");
    }

    const sourceId = `src_${syncHashHex(`siyuan://${docId}`).slice(0, 12)}`;
    const now = new Date().toISOString();

    deps.graphStore.upsertSource({
        id: sourceId,
        filePath: `siyuan://${docId}`,
        docId: exported.id,
        hPath: exported.hPath || exported.id,
        importedAt: now,
    });

    const digest = buildDigestForSource(deps, sourceId);
    const findings = await runExtractorStage(
        deps,
        `# ${exported.hPath}\n\n${exported.content}`,
        digest,
    );
    const verdicts = await runAuditorStage(deps, findings);
    const stats = mergeFindings(sourceId, findings, verdicts, deps, {
        foldedAt: now,
    });

    return { stats, hPath: exported.hPath || exported.id, sourceId };
}
