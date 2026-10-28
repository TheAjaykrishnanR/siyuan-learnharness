/**
 * The knowledge graph: deterministic merger + simplifyChains + derivation + chains & clusters.
 */

import type {
    AuditVerdicts,
    Cluster,
    CoverageEntry,
    EmissionStats,
    ExtractedChain,
    GraphChain,
    GraphEdge,
    GraphNode,
    GraphSnapshot,
    ProvenancePoint,
    SessionFindings,
} from "./contracts";
import type { ChatStore, GraphStore } from "./ports";
import { randomHex } from "./schema";
import { stripModelValueDebris } from "./value-debris";

export const MIN_CLUSTER_SIZE = 3;

export interface GraphDeps {
    chatStore: ChatStore;
    graphStore: GraphStore;
}

export interface ReasoningChain {
    id: string;
    premises: string[];
    conclusion: string;
}

export function chainsForSelection(
    nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
    chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
    const selected = new Set(nodes.map((n) => n.id));
    const chained = new Set<string>();
    const included: ReasoningChain[] = [];
    for (const chain of chains) {
        if (!selected.has(chain.conclusion)) continue;
        if (!chain.premises.every((premise) => selected.has(premise))) continue;
        included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
        chained.add(chain.conclusion);
        for (const premise of chain.premises) chained.add(premise);
    }
    for (const node of nodes) {
        if (!chained.has(node.id)) {
            included.push({ id: node.id, premises: [], conclusion: node.id });
        }
    }
    return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function resolveTargetId(
    target: string,
    nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
    const t = stripModelValueDebris(target);
    if (t.length === 0) return null;
    if (nodes.some((n) => n.id === t)) return t;
    const lower = t.toLowerCase();
    for (const n of nodes) {
        if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
    }
    return null;
}

export function formatChainLine(
    chain: Pick<ReasoningChain, "premises" | "conclusion">,
    propositions: Readonly<Record<string, { name: string }>>,
): string {
    const nameOf = (id: string) => propositions[id]?.name ?? id;
    const premises = [...chain.premises].sort().map(nameOf).join(", ");
    return premises !== ""
        ? `${premises} → ${nameOf(chain.conclusion)}`
        : `${nameOf(chain.conclusion)} (no premises)`;
}

export interface BirthSessionCluster {
    id: string;
    members: string[];
}

export function birthSessionOf(node: Pick<GraphNode, "provenance">): string | null {
    return node.provenance[0]?.chatId ?? null;
}

export function birthSessionPartition(nodes: readonly GraphNode[]): BirthSessionCluster[] {
    const members = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const birth = birthSessionOf(node);
        if (birth === null) continue;
        const bucket = members.get(birth);
        if (bucket) bucket.push(node.id);
        else members.set(birth, [node.id]);
    }
    return [...members.entries()]
        .map(([id, list]) => ({ id, members: [...list].sort() }))
        .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}

export function impClusterKey(
    chain: Pick<GraphChain, "premises" | "provenance">,
    birthOf: (nodeId: string) => string | null,
): string | null {
    const counts = new Map<string, number>();
    for (const premise of chain.premises) {
        const birth = birthOf(premise);
        if (birth !== null) counts.set(birth, (counts.get(birth) ?? 0) + 1);
    }
    const own = chain.provenance[0]?.chatId ?? null;
    if (counts.size === 0) return own;
    let max = 0;
    for (const n of counts.values()) if (n > max) max = n;
    const winners: string[] = [];
    for (const [key, n] of counts) if (n === max) winners.push(key);
    if (winners.length === 1) return winners[0]!;
    return own ?? winners.sort()[0]!;
}

export function attachImpToCommunities(
    communities: Array<{ id: string; members: string[] }>,
    propositions: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>,
    chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion" | "provenance">>,
): void {
    const birthById = new Map(propositions.map((node) => [node.id, birthSessionOf(node)]));
    const live = new Set(propositions.map((node) => node.id));
    for (const chain of chains) {
        if (chain.premises.length < 2) continue;
        if (!live.has(chain.conclusion) || !chain.premises.every((p) => live.has(p))) continue;
        const key = impClusterKey(chain, (id) => birthById.get(id) ?? null);
        const community = key === null ? undefined : communities.find((c) => c.id === key);
        if (!community) continue;
        community.members.push(chain.id);
    }
    for (const community of communities) community.members.sort();
}

function newGraphNodeId(): string {
    return `n_${randomHex(6)}`;
}

function newGraphChainId(): string {
    return `arg_${randomHex(6)}`;
}

function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
    return `${[...premises].sort().join("+")}>${conclusion}`;
}

export interface MergeSource {
    foldedAt: string;
    coverage?: CoverageEntry[];
}

function pointOf(chatId: string, messageId?: string): ProvenancePoint[] {
    return [{ chatId, messageId: messageId ?? "" }];
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
    a.chatId === b.chatId && a.messageId === b.messageId;

export function mergeFindings(
    chatId: string,
    findings: SessionFindings,
    verdicts: AuditVerdicts,
    deps: GraphDeps,
    source: MergeSource,
): EmissionStats {
    const { graphStore: ledgers } = deps;
    const stats: EmissionStats = { nodes: 0, chains: 0 };

    const existingIds = new Set(ledgers.readNodes().map((n) => n.id));
    const mapping = new Map<string, string>();
    const now = new Date().toISOString();
    const linkOf = new Map(verdicts.links.map((l) => [l.id, l.linkTo]));

    for (const p of findings.propositions) {
        if (mapping.has(p.id)) continue;
        const points = pointOf(chatId, p.messageId);
        const linkTo = linkOf.get(p.id);
        let graphNodeId: string;
        if (linkTo !== undefined && existingIds.has(linkTo)) {
            graphNodeId = linkTo;
            ledgers.appendNode({
                id: graphNodeId,
                name: p.name,
                statement: p.statement,
                aliases: [...(p.aliases ?? [])],
                createdAt: now,
                provenance: points,
            });
        } else {
            const node: GraphNode = {
                id: newGraphNodeId(),
                name: p.name,
                statement: p.statement,
                aliases: [...(p.aliases ?? [])],
                createdAt: now,
                provenance: points,
            };
            ledgers.appendNode(node);
            stats.nodes++;
            graphNodeId = node.id;
            existingIds.add(graphNodeId);
        }
        mapping.set(p.id, graphNodeId);
    }

    const assertedByChat = new Set<string>();
    const idOfKey = new Map<string, string>();
    for (const line of ledgers.readChains()) {
        const key = chainKey(line.premises, line.conclusion);
        if (!idOfKey.has(key)) idOfKey.set(key, line.id);
        if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
    }

    const emitChain = (chain: ExtractedChain): void => {
        const resolve = (endpoint: string): string | undefined =>
            mapping.get(endpoint) ?? (existingIds.has(endpoint) ? endpoint : undefined);
        const conclusion = resolve(chain.conclusion);
        if (conclusion === undefined) return;
        const premises = [...new Set(chain.premises.map(resolve))].filter(
            (p): p is string => p !== undefined && p !== conclusion,
        );
        if (premises.length === 0) return;
        const key = chainKey(premises, conclusion);
        if (assertedByChat.has(key)) return;
        const id = idOfKey.get(key) ?? newGraphChainId();
        ledgers.appendChain({ id, premises, conclusion, createdAt: now, provenance: pointOf(chatId) });
        idOfKey.set(key, id);
        assertedByChat.add(key);
        stats.chains!++;
    };
    for (const chain of findings.chains ?? []) emitChain(chain);

    const allChains = ledgers.readChains();
    const keptChains = simplifyChains(allChains);
    if (keptChains.length !== allChains.length) {
        ledgers.rewriteLedgers({ chains: keptChains });
        stats.droppedChains = allChains.length - keptChains.length;
    }

    if (source.coverage !== undefined) {
        for (const entry of source.coverage) ledgers.appendCoverage(entry);
    } else {
        ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
    }
    return stats;
}

export function simplifyChains(lines: GraphChain[]): GraphChain[] {
    if (lines.length < 2) return lines;

    const groups = new Map<string, GraphChain[]>();
    for (const line of lines) {
        const key = chainKey(line.premises, line.conclusion);
        const bucket = groups.get(key);
        if (bucket === undefined) groups.set(key, [line]);
        else bucket.push(line);
    }

    const premisesOf = new Map<string, string[][]>();
    for (const line of lines) {
        const bucket = premisesOf.get(line.conclusion);
        if (bucket === undefined) premisesOf.set(line.conclusion, [line.premises]);
        else bucket.push(line.premises);
    }
    const ancestryMemo = new Map<string, Set<string>>();
    const ancestry = (id: string, visiting: Set<string>): Set<string> => {
        const memo = ancestryMemo.get(id);
        if (memo !== undefined) return memo;
        const out = new Set<string>();
        if (visiting.has(id)) return out;
        visiting.add(id);
        for (const premises of premisesOf.get(id) ?? []) {
            for (const premise of premises) {
                out.add(premise);
                for (const ancestor of ancestry(premise, visiting)) out.add(ancestor);
            }
        }
        visiting.delete(id);
        ancestryMemo.set(id, out);
        return out;
    };

    const byConclusion = new Map<
        string,
        Array<{ key: string; premises: string[]; createdAt: string }>
    >();
    for (const [key, bucket] of groups) {
        const head = bucket[0]!;
        const entry = { key, premises: head.premises, createdAt: head.createdAt };
        const list = byConclusion.get(head.conclusion);
        if (list === undefined) byConclusion.set(head.conclusion, [entry]);
        else list.push(entry);
    }
    const droppedKeys = new Set<string>();
    for (const candidates of byConclusion.values()) {
        candidates.sort(
            (a, b) =>
                a.premises.length - b.premises.length ||
                a.createdAt.localeCompare(b.createdAt) ||
                a.key.localeCompare(b.key),
        );
        const kept: typeof candidates = [];
        for (const candidate of candidates) {
            const candidateSet = new Set(candidate.premises);
            const redundant = kept.some((k) => {
                if (k.premises.every((p) => candidateSet.has(p))) return true;
                const covered = new Set(k.premises);
                for (const p of k.premises) {
                    for (const ancestor of ancestry(p, new Set())) covered.add(ancestor);
                }
                return candidate.premises.every((p) => covered.has(p));
            });
            if (redundant) droppedKeys.add(candidate.key);
            else kept.push(candidate);
        }
    }
    if (droppedKeys.size === 0) return lines;
    return lines.filter((line) => !droppedKeys.has(chainKey(line.premises, line.conclusion)));
}

export interface DerivedGraph {
    nodes: GraphNode[];
    chains: GraphChain[];
}

export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph {
    const byId = new Map<string, GraphNode>();
    for (const line of graphStore.readNodes()) {
        const existing = byId.get(line.id);
        if (!existing) {
            byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
            continue;
        }
        for (const phrasing of [line.statement, ...line.aliases]) {
            if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
        }
        for (const pt of line.provenance) {
            if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
        }
    }

    const chains: GraphChain[] = [];
    const byKey = new Map<string, GraphChain>();
    for (const line of graphStore.readChains()) {
        const key = chainKey(line.premises, line.conclusion);
        const existing = byKey.get(key);
        if (existing) {
            for (const pt of line.provenance) {
                if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
            }
        } else {
            const chain: GraphChain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
            byKey.set(key, chain);
            chains.push(chain);
        }
    }
    return { nodes: [...byId.values()], chains };
}

export function deriveView(graph: DerivedGraph): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    logicalEdges: GraphEdge[];
    impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
    const names: Record<string, { name: string }> = {};
    for (const node of graph.nodes) names[node.id] = { name: node.name };
    const live = new Set(graph.nodes.map((node) => node.id));
    const impNodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
    const logicalEdges: GraphEdge[] = [];
    const logicalSeen = new Set<string>();
    const emitLogical = (from: string, to: string): void => {
        const key = from + "\u0000" + to;
        if (logicalSeen.has(key)) return;
        logicalSeen.add(key);
        logicalEdges.push({ from, to });
    };
    for (const chain of graph.chains) {
        if (!live.has(chain.conclusion) || !chain.premises.every((premise) => live.has(premise))) continue;
        for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
        if (chain.premises.length === 1) {
            edges.push({ from: chain.premises[0]!, to: chain.conclusion });
            continue;
        }
        impNodes.push({
            id: chain.id,
            name: "⟹",
            statement: formatChainLine(chain, names),
            aliases: [],
            createdAt: chain.createdAt,
            provenance: [...chain.provenance],
        });
        impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
        for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
        edges.push({ from: chain.id, to: chain.conclusion });
    }
    return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
    const graph = getGraph(deps.graphStore);
    const view = deriveView(graph);
    const nodes = view.nodes;

    const nodeChats = new Map<string, Set<string>>();
    const touch = (nodeId: string, chatId: string): void => {
        let chats = nodeChats.get(nodeId);
        if (!chats) {
            chats = new Set();
            nodeChats.set(nodeId, chats);
        }
        chats.add(chatId);
    };
    for (const node of nodes) {
        for (const pt of node.provenance) touch(node.id, pt.chatId);
    }

    const sourceIds = new Set<string>();
    for (const chats of nodeChats.values()) {
        for (const id of chats) sourceIds.add(id);
    }
    const sessions: Record<string, string> = {};
    const fileSources: Record<string, string> = {};
    const docSources: Record<string, string> = {};
    const allSources = deps.graphStore.readSources();
    for (const id of sourceIds) {
        const chat = deps.chatStore.getChat(id);
        if (chat) {
            sessions[id] = chat.title;
            continue;
        }
        const source = allSources.find((s) => s.id === id);
        if (source) {
            fileSources[id] = source.hPath || source.filePath;
            if (source.docId) docSources[id] = source.docId;
        }
    }

    const nodeSessions: Record<string, string[]> = {};
    for (const [nodeId, chats] of nodeChats) {
        const ids = [...chats].filter((id) => sessions[id] !== undefined || fileSources[id] !== undefined);
        if (ids.length > 0) nodeSessions[nodeId] = ids;
    }

    const communities = birthSessionPartition(graph.nodes);
    const clusters: Cluster[] = communities
        .filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
        .map((community) => ({
            id: community.id,
            label: sessions[community.id] ?? fileSources[community.id] ?? null,
            members: community.members,
        }));
    attachImpToCommunities(clusters, graph.nodes, graph.chains);

    const positions = deps.graphStore.readPositions();

    return {
        nodes,
        propositions: graph.nodes,
        edges: view.edges,
        logicalEdges: view.logicalEdges,
        impLinks: view.impLinks,
        chains: graph.chains,
        sessions,
        fileSources,
        docSources,
        nodeSessions,
        clusters,
        ...(Object.keys(positions).length > 0 ? { positions } : {}),
    };
}

export interface GraphSessionEntry {
    id: string;
    name: string;
    kind: "chat" | "file";
    createdAt: string | null;
    updatedAt: string | null;
    propositions: number;
}

export function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[] {
    const counts = new Map<string, number>();
    const born = getGraph(deps.graphStore);
    for (const cluster of birthSessionPartition(born.nodes)) {
        counts.set(cluster.id, cluster.members.length);
    }
    const chats = new Map(deps.chatStore.listChats().map((chat) => [chat.id, chat]));
    const sources = new Map(deps.graphStore.readSources().map((s) => [s.id, s]));
    const entries: GraphSessionEntry[] = [];
    for (const [id, propositions] of counts) {
        const chat = chats.get(id);
        if (chat) {
            entries.push({
                id,
                name: chat.title,
                kind: "chat",
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt,
                propositions,
            });
            continue;
        }
        const source = sources.get(id);
        entries.push({
            id,
            name: source?.hPath ?? source?.filePath ?? id,
            kind: "file",
            createdAt: source?.importedAt ?? null,
            updatedAt: source?.importedAt ?? null,
            propositions,
        });
    }
    return entries.sort(
        (a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
            (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
            (a.id < b.id ? -1 : 1),
    );
}

export interface GraphSessionProposition {
    nodeId: string;
    name: string;
    statement: string;
}

export function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[] {
    const born = getGraph(deps.graphStore).nodes.filter((node) => birthSessionOf(node) === sessionId);
    return born
        .map((node) => ({ nodeId: node.id, name: node.name, statement: node.statement }))
        .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}
