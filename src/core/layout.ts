/**
 * Pure, deterministic force-directed layout engine for the Knowledge Graph.
 * Implements link springs (with half distance for implication nodes),
 * many-body charge repulsion, center gravity, cluster centroid pull,
 * and incremental warm-start anchor retention.
 */

import type { GraphNode, Position } from "./contracts";
import { seededRandom } from "./question-core";

export interface LayoutEdge {
    from: string;
    to: string;
}

export interface LayoutNode {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx?: number | null;
    fy?: number | null;
}

export const LINK_DISTANCE = 55;
export const CHARGE_STRENGTH = -260;
const IMP_ID_PREFIX = "arg_";
const ANCHOR_RETENTION = 0.85;

export interface IncrementalLayoutOptions {
    ticks?: number;
    anchorRetention?: number;
    clusters?: ReadonlyArray<{ members: ReadonlyArray<string> }>;
}

export function incrementalLayout(
    nodes: ReadonlyArray<Pick<GraphNode, "id">>,
    edges: ReadonlyArray<LayoutEdge>,
    previous: ReadonlyMap<string, Position>,
    options: IncrementalLayoutOptions = {},
): Map<string, Position> {
    const ticks = options.ticks ?? 180;
    const retention = options.anchorRetention ?? ANCHOR_RETENTION;

    const anchors = new Map<string, Position>();
    for (const node of nodes) {
        const prev = previous.get(node.id);
        if (prev) anchors.set(node.id, { x: prev.x, y: prev.y });
    }

    let cx = 0;
    let cy = 0;
    const hasCore = anchors.size > 0;
    if (hasCore) {
        for (const a of anchors.values()) {
            cx += a.x;
            cy += a.y;
        }
        cx /= anchors.size;
        cy /= anchors.size;
    }

    const adjacency = new Map<string, string[]>();
    const degree = new Map<string, number>();
    const linkTo = (a: string, b: string): void => {
        if (a === b) return;
        let list = adjacency.get(a);
        if (!list) adjacency.set(a, (list = []));
        list.push(b);
        degree.set(a, (degree.get(a) ?? 0) + 1);
    };
    for (const e of edges) {
        linkTo(e.from, e.to);
        linkTo(e.to, e.from);
    }

    const simNodes: LayoutNode[] = nodes.map((node, index) => {
        const rand = seededRandom(node.id);
        const anchor = anchors.get(node.id);
        if (anchor) {
            return { id: node.id, x: anchor.x, y: anchor.y, vx: 0, vy: 0 };
        }
        let sx = 0;
        let sy = 0;
        let found = 0;
        for (const nbr of adjacency.get(node.id) ?? []) {
            const na = anchors.get(nbr);
            if (na) {
                sx += na.x;
                sy += na.y;
                found++;
            }
        }
        if (found > 0) {
            return {
                id: node.id,
                x: sx / found + (rand() - 0.5) * 16,
                y: sy / found + (rand() - 0.5) * 16,
                vx: 0,
                vy: 0,
            };
        }
        const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 + rand() * 0.4;
        const radius = 80 + Math.sqrt(index + 1) * 32;
        return {
            id: node.id,
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
            vx: 0,
            vy: 0,
        };
    });

    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const validEdges = edges
        .map((e) => ({ source: byId.get(e.from), target: byId.get(e.to) }))
        .filter((e): e is { source: LayoutNode; target: LayoutNode } => Boolean(e.source && e.target));

    const clusters = options.clusters ?? [];
    const clusterIdx = new Map<string, number>();
    clusters.forEach((c, idx) => {
        for (const m of c.members) clusterIdx.set(m, idx);
    });

    for (let tick = 0; tick < ticks; tick++) {
        const alpha = Math.pow(1 - tick / ticks, 1.3);

        // 1. Repulsion (many-body)
        for (let i = 0; i < simNodes.length; i++) {
            const a = simNodes[i]!;
            for (let j = i + 1; j < simNodes.length; j++) {
                const b = simNodes[j]!;
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let distSq = dx * dx + dy * dy;
                if (distSq < 1) {
                    dx = (i % 2 === 0 ? 1 : -1) * 0.5;
                    dy = (j % 2 === 0 ? 1 : -1) * 0.5;
                    distSq = 1;
                }
                if (distSq > 90000) continue; // distance cutoff for speed
                const force = (CHARGE_STRENGTH * alpha) / distSq;
                const dist = Math.sqrt(distSq);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx += fx;
                a.vy += fy;
                b.vx -= fx;
                b.vy -= fy;
            }
        }

        // 2. Link springs
        for (const link of validEdges) {
            const { source, target } = link;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.hypot(dx, dy) || 1;
            const rest =
                source.id.startsWith(IMP_ID_PREFIX) || target.id.startsWith(IMP_ID_PREFIX)
                    ? LINK_DISTANCE / 2
                    : LINK_DISTANCE;
            const minDeg = Math.min(degree.get(source.id) ?? 1, degree.get(target.id) ?? 1);
            const k = (0.35 / Math.max(1, minDeg)) * alpha;
            const f = ((dist - rest) / dist) * k;
            const fx = dx * f;
            const fy = dy * f;
            source.vx += fx;
            source.vy += fy;
            target.vx -= fx;
            target.vy -= fy;
        }

        // 3. Cluster centroid pull
        if (clusters.length > 0) {
            const sumX = new Float64Array(clusters.length);
            const sumY = new Float64Array(clusters.length);
            const cnt = new Float64Array(clusters.length);
            for (const n of simNodes) {
                const ci = clusterIdx.get(n.id);
                if (ci === undefined) continue;
                sumX[ci] += n.x;
                sumY[ci] += n.y;
                cnt[ci] += 1;
            }
            for (const n of simNodes) {
                const ci = clusterIdx.get(n.id);
                if (ci === undefined || cnt[ci]! < 2) continue;
                n.vx += (sumX[ci]! / cnt[ci]! - n.x) * 0.08 * alpha;
                n.vy += (sumY[ci]! / cnt[ci]! - n.y) * 0.08 * alpha;
            }
        }

        // 4. Center gravity + integrate velocities
        const gravity = hasCore ? 0.04 : 0.08;
        for (const n of simNodes) {
            if (n.fx != null && n.fy != null) {
                n.x = n.fx;
                n.y = n.fy;
                n.vx = 0;
                n.vy = 0;
                continue;
            }
            n.vx += (cx - n.x) * gravity * alpha;
            n.vy += (cy - n.y) * gravity * alpha;
            n.vx *= 0.6;
            n.vy *= 0.6;
            n.x += n.vx;
            n.y += n.vy;

            if (hasCore && retention < 1) {
                const anchor = anchors.get(n.id);
                if (anchor) {
                    n.x = anchor.x + (n.x - anchor.x) * retention;
                    n.y = anchor.y + (n.y - anchor.y) * retention;
                }
            }
        }
    }

    const out = new Map<string, Position>();
    for (const n of simNodes) {
        out.set(n.id, { x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 });
    }
    return out;
}
