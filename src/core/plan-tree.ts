import type { PlanEdge, PlanNode, PlanTree } from "./contracts";

export class PlanTreeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PlanTreeError";
    }
}

export function emptyTree(): PlanTree {
    return { nodes: [], edges: [], version: 0 };
}

function assertValidNode(node: PlanNode): void {
    if (!node || typeof node.id !== "string" || node.id.trim() === "") {
        throw new PlanTreeError("Every node needs a non-empty `id` (a stable slug like 'chain-rule-intuition').");
    }
    if (typeof node.title !== "string" || node.title.trim() === "") {
        throw new PlanTreeError(`Node "${node.id}" needs a non-empty \`title\`.`);
    }
}

function nodeMap(nodes: PlanNode[]): Map<string, PlanNode> {
    const map = new Map<string, PlanNode>();
    for (const node of nodes) {
        assertValidNode(node);
        if (map.has(node.id)) {
            throw new PlanTreeError(`Duplicate node id "${node.id}" — node ids must be unique.`);
        }
        map.set(node.id, node);
    }
    return map;
}

function requireNode(map: Map<string, PlanNode>, id: string, what: string): void {
    if (!map.has(id)) {
        throw new PlanTreeError(`${what} references unknown node id "${id}" — it is not in the tree.`);
    }
}

function createsCycle(edges: PlanEdge[], from: string, to: string): boolean {
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
        const list = adjacency.get(e.from);
        if (list) list.push(e.to);
        else adjacency.set(e.from, [e.to]);
    }
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === from) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of adjacency.get(current) ?? []) stack.push(next);
    }
    return false;
}

function assertValidEdge(from: string, to: string, nodes: PlanNode[], existingEdges: PlanEdge[]): void {
    const map = nodeMap(nodes);
    requireNode(map, from, "Edge `from`");
    requireNode(map, to, "Edge `to`");
    if (from === to) {
        throw new PlanTreeError(`Edge "${from}" → "${to}" is a self-loop — a node can't require itself.`);
    }
    if (existingEdges.some((e) => e.from === from && e.to === to)) {
        throw new PlanTreeError(`Edge "${from}" → "${to}" already exists — duplicate edges are not allowed.`);
    }
    if (createsCycle(existingEdges, from, to)) {
        throw new PlanTreeError(
            `Edge "${from}" → "${to}" would create a cycle: "${to}" already leads (directly or transitively) back to "${from}". ` +
                `"from" must be understood before "to" — the tree is a DAG.`,
        );
    }
}

export function createTree(nodes: PlanNode[], edges: PlanEdge[]): PlanTree {
    const map = nodeMap(nodes);
    for (const e of edges) {
        requireNode(map, e.from, "Edge `from`");
        requireNode(map, e.to, "Edge `to`");
    }
    const accepted: PlanEdge[] = [];
    for (const e of edges) {
        assertValidEdge(e.from, e.to, nodes, accepted);
        accepted.push({ from: e.from, to: e.to });
    }
    return { nodes: nodes.map((n) => ({ ...n })), edges: accepted, version: 1 };
}
