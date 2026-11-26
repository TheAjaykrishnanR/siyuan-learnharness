/**
 * Fluid Interactive Knowledge Graph View — Obsidian / LearnHarness style:
 *   - Full-bleed high-DPI <canvas> with a single dirty-gated 60fps rAF loop
 *   - Live spring-force physics when dragging nodes or re-settling layout
 *   - Exponential cursor-anchored wheel-zoom glide
 *   - Smooth hover halo + Obsidian-style neighbor spotlighting
 *   - Subtle zoom-gated, word-wrapped labels (never giant overlapping text)
 *   - Floating frosted-glass Node Inspector card (only appears when a node is selected)
 */

import { showMessage } from "siyuan";
import { extractFromChat, importSiyuanNoteToGraph } from "../agent/extraction";
import type { GraphNode, GraphSnapshot, Position } from "../core/contracts";
import { chainsForSelection, formatChainLine, graphSnapshot } from "../core/graph";
import { CHARGE_STRENGTH, DEPTH_SPACING, inferenceDepths, LINK_DISTANCE } from "../core/layout";
import { newGraphContextMessage } from "../core/messages";
import { findNotes, type SiyuanDocEntry } from "../siyuan/client";
import type { SiYuanHarnessStores } from "../store/siyuan-store";
import { escapeHtml, renderInlineMarkdown, renderMarkdown } from "./markdown";

const GRAPH_ICON = {
    search: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    importNote: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg>`,
    extract: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>`,
    relayout: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
    flowDown: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="4.5" r="2"/><circle cx="6.5" cy="19.5" r="2"/><circle cx="17.5" cy="19.5" r="2"/><path d="M12 6.5v5"/><path d="M12 11.5 7.5 17"/><path d="m12 11.5 4.5 5.5"/></svg>`,
    center: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>`,
    trash: `<svg class="lh-svg-icon" viewBox="0 0 24 24" width="13" height="13"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`,
};

const colorHexCache = new Map<string, string>();
function toHexColor(raw: string, fallback: string): string {
    const key = raw.trim();
    if (!key) return fallback;
    if (/^#[0-9a-fA-F]{6}$/.test(key)) return key;
    const cached = colorHexCache.get(key);
    if (cached) return cached;
    try {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        const x = c.getContext("2d");
        if (!x) return fallback;
        x.fillStyle = key;
        x.fillRect(0, 0, 1, 1);
        const d = x.getImageData(0, 0, 1, 1).data;
        const hex = `#${[d[0]!, d[1]!, d[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        colorHexCache.set(key, hex);
        return hex;
    } catch {
        return fallback;
    }
}

interface SimNode {
    id: string;
    label: string;
    isImp: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx: number | null;
    fy: number | null;
    clusterIdx: number;
    degree: number;
}

interface SimLink {
    source: SimNode;
    target: SimNode;
    rest: number;
}

const CLICK_SLOP = 4;
const ZOOM_EASE_MS = 45;
const HOVER_FADE_MS = 160;
const PICK_PAD_PX = 10;

export interface GraphViewCallbacks {
    onOpenChat: (chatId: string) => void;
    onOpenSiyuanDoc: (docId: string) => void;
    onStartPracticeFromGraph: (chatId: string) => void;
    getActiveChatId?: () => string | null;
}

export class KnowledgeGraphView {
    private container: HTMLElement;
    private stores: SiYuanHarnessStores;
    private callbacks: GraphViewCallbacks;

    private canvas!: HTMLCanvasElement;
    private inspectorEl!: HTMLElement;
    private searchInputEl!: HTMLInputElement;
    private toolbarStatusEl!: HTMLElement;

    private snapshot: GraphSnapshot;
    private simNodes: SimNode[] = [];
    private simById = new Map<string, SimNode>();
    private simLinks: SimLink[] = [];
    private neighborsById = new Map<string, Set<string>>();
    private nodeDepths = new Map<string, number>();
    private meanDepth = 0;
    private directionalFlow = true;
    private flowBtnEl!: HTMLButtonElement;

    private searchQuery = "";
    private selectedNodeId: string | null = null;
    private practiceSelection = new Set<string>();

    // Camera: screen = world * zoom + [camX, camY] (where 0,0 is canvas center + cam offset)
    private camX = 0;
    private camY = 0;
    private zoom = 1;
    private kFit = 1;
    private hasAutoCentered = false;
    private zoomTarget: { zoom: number; mx: number; my: number } | null = null;

    // Live simulation & hover animation state
    private simAlpha = 0;
    private simActive = false;
    private simMoved = false;
    private commitTimer: ReturnType<typeof setTimeout> | null = null;

    private hoverId: string | null = null;
    private hoverLastId: string | null = null;
    private hoverFade = 0;
    private hoverFrom = 0;
    private hoverTarget = 0;
    private hoverStart = 0;

    private frameId: number | null = null;
    private lastTickAt = 0;

    // Pointer state
    private isPanning = false;
    private draggedNodeId: string | null = null;
    private downX = 0;
    private downY = 0;
    private lastPtrX = 0;
    private lastPtrY = 0;
    private pointerMoved = false;

    private resizeObserver: ResizeObserver | null = null;
    private boundKeydown?: (e: KeyboardEvent) => void;

    constructor(container: HTMLElement, stores: SiYuanHarnessStores, callbacks: GraphViewCallbacks) {
        this.container = container;
        this.stores = stores;
        this.callbacks = callbacks;
        this.snapshot = graphSnapshot({
            chatStore: this.stores.chatStore,
            graphStore: this.stores.graphStore,
        });
        this.mount();
    }

    private mount(): void {
        this.container.innerHTML = `
            <div class="lh-graph-layout">
                <div class="lh-graph-stage">
                    <canvas class="lh-graph-canvas"></canvas>

                    <div class="lh-graph-hud">
                        <div class="lh-graph-hud__search">
                            ${GRAPH_ICON.search}
                            <input type="text" class="lh-graph-hud__input" placeholder="Filter nodes..." autocomplete="off" />
                            <span class="lh-graph-hud__counts"></span>
                        </div>
                        <div class="lh-graph-hud__actions">
                            <button type="button" class="lh-header-icon-btn" data-action="extract-active-chat" title="Extract nodes from current chat">
                                ${GRAPH_ICON.extract}
                            </button>
                            <button type="button" class="lh-header-icon-btn" data-action="import-note" title="Import a SiYuan note to Knowledge Graph">
                                ${GRAPH_ICON.importNote}
                            </button>
                            <button type="button" class="lh-header-icon-btn lh-flow-toggle-btn lh-icon-active" data-action="toggle-flow" title="Top-to-bottom derivation flow (click for free layout)">
                                ${GRAPH_ICON.flowDown}
                            </button>
                            <button type="button" class="lh-header-icon-btn" data-action="relayout" title="Re-relax layout">
                                ${GRAPH_ICON.relayout}
                            </button>
                            <button type="button" class="lh-header-icon-btn" data-action="fit-view" title="Fit graph to view">
                                ${GRAPH_ICON.center}
                            </button>
                        </div>
                    </div>

                    <div class="lh-graph-status-pill fn__none"></div>
                    <button type="button" class="lh-graph-practice-fab fn__none" data-action="practice-selected"></button>

                    <div class="lh-graph-empty" style="display:none;">
                        <div class="lh-chat-empty__orb">${GRAPH_ICON.extract}</div>
                        <div class="lh-graph-empty__title">Knowledge Graph is empty</div>
                        <div class="lh-graph-empty__desc">
                            Nodes and reasoning chains are extracted automatically as you learn, or you can extract your current chat or import a SiYuan note now.
                        </div>
                        <div class="lh-chat-empty__chips">
                            <button type="button" class="lh-starter-chip" data-action="extract-active-chat">Extract current chat</button>
                            <button type="button" class="lh-starter-chip" data-action="import-note-empty">Import SiYuan note</button>
                        </div>
                    </div>

                    <div class="lh-graph-card fn__none"></div>
                </div>
            </div>
        `;

        this.canvas = this.container.querySelector(".lh-graph-canvas") as HTMLCanvasElement;
        this.inspectorEl = this.container.querySelector(".lh-graph-card") as HTMLElement;
        this.searchInputEl = this.container.querySelector(".lh-graph-hud__input") as HTMLInputElement;
        this.toolbarStatusEl = this.container.querySelector(".lh-graph-status-pill") as HTMLElement;
        this.flowBtnEl = this.container.querySelector(".lh-flow-toggle-btn") as HTMLButtonElement;

        this.bindEvents();
        this.refresh();

        this.resizeObserver = new ResizeObserver(() => {
            const ok = this.resizeCanvas();
            if (ok && !this.hasAutoCentered && this.simNodes.length > 0) {
                this.hasAutoCentered = true;
                this.reheatSim(0.65);
                this.fitView(false);
            } else {
                this.refreshFitReference();
                this.markDirty();
            }
        });
        const stage = this.container.querySelector(".lh-graph-stage");
        if (stage) this.resizeObserver.observe(stage);
    }

    public destroy(): void {
        if (this.frameId !== null) cancelAnimationFrame(this.frameId);
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.resizeObserver?.disconnect();
        if (this.boundKeydown) document.removeEventListener("keydown", this.boundKeydown);
    }

    public refresh(): void {
        this.snapshot = graphSnapshot({
            chatStore: this.stores.chatStore,
            graphStore: this.stores.graphStore,
        });

        this.rebuildSimulationGraph();

        const emptyEl = this.container.querySelector(".lh-graph-empty") as HTMLElement | null;
        if (emptyEl) {
            emptyEl.style.display = this.snapshot.propositions.length === 0 ? "flex" : "none";
        }

        const countsEl = this.container.querySelector(".lh-graph-hud__counts") as HTMLElement | null;
        if (countsEl) {
            countsEl.textContent = `${this.snapshot.propositions.length}`;
            countsEl.title = `${this.snapshot.propositions.length} propositions · ${this.snapshot.chains.length} chains`;
        }

        this.updatePracticeButton();
        const ok = this.resizeCanvas();
        if (ok && this.simNodes.length > 0 && !this.hasAutoCentered) {
            this.hasAutoCentered = true;
            this.reheatSim(0.65);
            this.fitView(false);
        } else {
            this.refreshFitReference();
            this.markDirty();
        }
        this.renderNodeCard();
    }

    private rebuildSimulationGraph(): void {
        this.nodeDepths = inferenceDepths(this.snapshot.propositions, this.snapshot.logicalEdges);
        this.meanDepth = 0;
        if (this.nodeDepths.size > 0) {
            for (const d of this.nodeDepths.values()) this.meanDepth += d;
            this.meanDepth /= this.nodeDepths.size;
        }

        const prevPos = new Map<string, { x: number; y: number }>();
        for (const n of this.simNodes) prevPos.set(n.id, { x: n.x, y: n.y });
        if (this.snapshot.positions) {
            for (const [id, p] of Object.entries(this.snapshot.positions)) {
                if (!prevPos.has(id)) prevPos.set(id, { x: p.x, y: p.y });
            }
        }

        const clusterMap = new Map<string, number>();
        this.snapshot.clusters.forEach((c, idx) => {
            for (const m of c.members) clusterMap.set(m, idx);
        });

        this.simNodes = [];
        this.simById.clear();
        this.neighborsById.clear();

        const total = Math.max(1, this.snapshot.nodes.length);
        this.snapshot.nodes.forEach((n, idx) => {
            const known = prevPos.get(n.id);
            const angle = idx * 2.39996323; // golden-angle spiral fallback
            const r = 35 + Math.sqrt(idx + 1) * 28;
            const d = this.nodeDepths.get(n.id);
            const fallbackY =
                this.directionalFlow && d !== undefined
                    ? (d - this.meanDepth) * DEPTH_SPACING
                    : Math.sin(angle) * r;
            const sn: SimNode = {
                id: n.id,
                label: n.name,
                isImp: n.id.startsWith("arg_"),
                x: known ? known.x : Math.cos(angle) * r,
                y: known ? known.y : fallbackY,
                vx: 0,
                vy: 0,
                fx: null,
                fy: null,
                clusterIdx: clusterMap.get(n.id) ?? -1,
                degree: 0,
            };
            this.simNodes.push(sn);
            this.simById.set(sn.id, sn);
            this.neighborsById.set(sn.id, new Set([sn.id]));
        });

        this.simLinks = [];
        for (const e of this.snapshot.edges) {
            const s = this.simById.get(e.from);
            const t = this.simById.get(e.to);
            if (!s || !t || s === t) continue;
            s.degree++;
            t.degree++;
            this.simLinks.push({
                source: s,
                target: t,
                rest: s.isImp || t.isImp ? LINK_DISTANCE * 0.52 : LINK_DISTANCE,
            });
            this.neighborsById.get(s.id)?.add(t.id);
            this.neighborsById.get(t.id)?.add(s.id);
        }

        // Propagate neighbor connectivity through invisible implication junctions so hovering a premise highlights its conclusion!
        for (const imp of this.simNodes) {
            if (!imp.isImp) continue;
            const connected = Array.from(this.neighborsById.get(imp.id) ?? []);
            for (const a of connected) {
                for (const b of connected) {
                    this.neighborsById.get(a)?.add(b);
                }
            }
        }
    }

    private reheatSim(alpha = 0.45): void {
        if (this.simNodes.length === 0) return;
        this.simAlpha = Math.max(this.simAlpha, alpha);
        this.simActive = true;
        this.markDirty();
    }

    private schedulePositionCommit(): void {
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.commitTimer = setTimeout(() => {
            this.commitTimer = null;
            if (!this.simMoved) return;
            this.simMoved = false;
            const out: Record<string, Position> = {};
            for (const n of this.simNodes) {
                out[n.id] = { x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 };
            }
            this.stores.graphStore.writePositions(out);
        }, 280);
    }

    private isNodeMatchingSearch(node: SimNode): boolean {
        const q = this.searchQuery.trim().toLowerCase();
        if (!q) return true;
        if (node.isImp) return true;
        const full = this.snapshot.propositions.find((p) => p.id === node.id);
        if (!full) return node.label.toLowerCase().includes(q);
        return full.name.toLowerCase().includes(q) || full.statement.toLowerCase().includes(q);
    }

    private updatePracticeButton(): void {
        const btn = this.container.querySelector(".lh-graph-practice-fab") as HTMLButtonElement | null;
        if (!btn) return;
        const count = this.practiceSelection.size;
        if (count > 0) {
            btn.classList.remove("fn__none");
            btn.textContent = `Practice ${count} selected →`;
        } else {
            btn.classList.add("fn__none");
        }
    }

    private setStatus(msg: string): void {
        if (!this.toolbarStatusEl) return;
        if (msg) {
            this.toolbarStatusEl.textContent = msg;
            this.toolbarStatusEl.classList.remove("fn__none");
        } else {
            this.toolbarStatusEl.textContent = "";
            this.toolbarStatusEl.classList.add("fn__none");
        }
    }

    private bindEvents(): void {
        this.searchInputEl?.addEventListener("input", () => {
            this.searchQuery = this.searchInputEl.value;
            this.markDirty();
        });

        this.boundKeydown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && this.selectedNodeId) {
                this.selectedNodeId = null;
                this.renderNodeCard();
                this.markDirty();
            }
        };
        document.addEventListener("keydown", this.boundKeydown);

        this.container.addEventListener("click", (e) => {
            const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;

            if (action === "extract-active-chat") {
                void this.extractActiveChat();
            } else if (action === "import-note" || action === "import-note-empty") {
                void this.openImportNoteModal();
            } else if (action === "toggle-flow") {
                this.directionalFlow = !this.directionalFlow;
                this.flowBtnEl?.classList.toggle("lh-icon-active", this.directionalFlow);
                if (this.flowBtnEl) {
                    this.flowBtnEl.title = this.directionalFlow
                        ? "Top-to-bottom derivation flow (click for free layout)"
                        : "Free organic layout (click for top-to-bottom derivation flow)";
                }
                this.reheatSim(0.9);
            } else if (action === "relayout") {
                // Re-compute fresh directional hierarchy and visibly relax the graph!
                this.stores.recomputeLayoutPositions(true);
                this.snapshot = graphSnapshot({
                    chatStore: this.stores.chatStore,
                    graphStore: this.stores.graphStore,
                });
                this.simNodes = [];
                this.rebuildSimulationGraph();
                this.fitView(true);
                this.reheatSim(0.85);
            } else if (action === "fit-view") {
                this.fitView(true);
            } else if (action === "close-node-card") {
                this.selectedNodeId = null;
                this.renderNodeCard();
                this.markDirty();
            } else if (action === "practice-selected") {
                this.launchPracticeForSelection(Array.from(this.practiceSelection));
            } else if (action === "toggle-practice-node") {
                const nodeId = target.dataset.nodeId;
                if (nodeId) {
                    if (this.practiceSelection.has(nodeId)) this.practiceSelection.delete(nodeId);
                    else this.practiceSelection.add(nodeId);
                    this.updatePracticeButton();
                    this.renderNodeCard();
                    this.markDirty();
                }
            } else if (action === "practice-single-node") {
                const nodeId = target.dataset.nodeId;
                if (nodeId) this.launchPracticeForSelection([nodeId]);
            } else if (action === "open-provenance-chat") {
                const chatId = target.dataset.chatId;
                if (chatId) this.callbacks.onOpenChat(chatId);
            } else if (action === "open-provenance-doc") {
                const docId = target.dataset.docId;
                if (docId) this.callbacks.onOpenSiyuanDoc(docId);
            } else if (action === "delete-node") {
                const nodeId = target.dataset.nodeId;
                if (nodeId) {
                    this.stores.graphStore.deleteNode(nodeId);
                    this.selectedNodeId = null;
                    this.practiceSelection.delete(nodeId);
                    this.refresh();
                }
            }
        });

        // Pointer interactions on canvas (fluid drag-reheat + pan + hover spotlight)
        this.canvas.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            const rect = this.canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const hit = this.pickNodeAt(sx, sy);

            this.downX = sx;
            this.downY = sy;
            this.lastPtrX = sx;
            this.lastPtrY = sy;
            this.pointerMoved = false;
            this.zoomTarget = null;

            try {
                this.canvas.setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }

            if (hit) {
                this.draggedNodeId = hit.id;
                hit.fx = hit.x;
                hit.fy = hit.y;
                this.canvas.style.cursor = "grabbing";
            } else {
                this.isPanning = true;
                this.canvas.style.cursor = "grabbing";
            }
        });

        this.canvas.addEventListener("pointermove", (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            if (this.draggedNodeId) {
                const node = this.simById.get(this.draggedNodeId);
                if (node) {
                    if (Math.hypot(sx - this.downX, sy - this.downY) > CLICK_SLOP) {
                        this.pointerMoved = true;
                        if (this.commitTimer) {
                            clearTimeout(this.commitTimer);
                            this.commitTimer = null;
                        }
                        this.reheatSim(0.35);
                    }
                    const world = this.screenToWorld(sx, sy);
                    node.fx = world.x;
                    node.fy = world.y;
                    this.markDirty();
                }
                this.lastPtrX = sx;
                this.lastPtrY = sy;
                return;
            }

            if (this.isPanning) {
                if (Math.hypot(sx - this.downX, sy - this.downY) > CLICK_SLOP) {
                    this.pointerMoved = true;
                }
                this.camX += sx - this.lastPtrX;
                this.camY += sy - this.lastPtrY;
                this.lastPtrX = sx;
                this.lastPtrY = sy;
                this.markDirty();
                return;
            }

            const hit = this.pickNodeAt(sx, sy);
            this.setHover(hit?.id ?? null);
            this.canvas.style.cursor = hit ? "pointer" : "grab";
        });

        const endPointer = (e: PointerEvent) => {
            try {
                this.canvas.releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }
            const rect = this.canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;

            if (this.draggedNodeId) {
                const id = this.draggedNodeId;
                this.draggedNodeId = null;
                const node = this.simById.get(id);
                if (node) {
                    node.fx = null;
                    node.fy = null;
                }
                if (!this.pointerMoved) {
                    if (e.shiftKey) {
                        if (this.practiceSelection.has(id)) this.practiceSelection.delete(id);
                        else this.practiceSelection.add(id);
                        this.updatePracticeButton();
                    }
                    this.selectedNodeId = this.selectedNodeId === id && !e.shiftKey ? null : id;
                    this.renderNodeCard();
                }
                this.canvas.style.cursor = "pointer";
                this.markDirty();
                return;
            }

            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = "grab";
                if (!this.pointerMoved) {
                    const hit = this.pickNodeAt(sx, sy);
                    this.selectedNodeId = hit ? hit.id : null;
                    this.renderNodeCard();
                }
                this.markDirty();
            }
        };

        this.canvas.addEventListener("pointerup", endPointer);
        this.canvas.addEventListener("pointercancel", endPointer);
        this.canvas.addEventListener("pointerleave", () => {
            if (!this.draggedNodeId && !this.isPanning) {
                this.setHover(null);
            }
        });

        this.canvas.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                const rect = this.canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left - (this.canvas.clientWidth || 300) / 2;
                const my = e.clientY - rect.top - (this.canvas.clientHeight || 300) / 2;
                const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0022);
                const baseZoom = this.zoomTarget ? this.zoomTarget.zoom : this.zoom;
                const nextZoom = Math.max(0.18, Math.min(5.5, baseZoom * Math.exp(delta)));
                this.zoomTarget = { zoom: nextZoom, mx, my };
                this.lastTickAt = performance.now();
                this.markDirty();
            },
            { passive: false },
        );
    }

    private setHover(id: string | null): void {
        if (id === this.hoverId && this.hoverTarget === (id ? 1 : 0)) return;
        this.hoverId = id;
        if (id) this.hoverLastId = id;
        this.hoverFrom = this.hoverFade;
        this.hoverTarget = id ? 1 : 0;
        this.hoverStart = performance.now();
        this.markDirty();
    }

    private markDirty(): void {
        if (this.frameId === null) {
            this.lastTickAt = performance.now();
            this.frameId = requestAnimationFrame(() => {
                this.frameId = null;
                this.tick();
            });
        }
    }

    private tick(): void {
        const now = performance.now();
        const dt = Math.min(Math.max(now - this.lastTickAt, 8), 80);
        this.lastTickAt = now;

        const hoverMoving = this.stepHover(now);
        const zoomMoving = this.stepZoom(dt);
        const simMoving = this.stepPhysics();

        this.draw();

        if (hoverMoving || zoomMoving || simMoving) {
            this.frameId = requestAnimationFrame(() => {
                this.frameId = null;
                this.tick();
            });
        }
    }

    private stepHover(now: number): boolean {
        if (this.hoverFade === this.hoverTarget) return false;
        const t = Math.min(1, (now - this.hoverStart) / HOVER_FADE_MS);
        const eased = t * (2 - t);
        this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * eased;
        if (t >= 1) {
            this.hoverFade = this.hoverTarget;
            if (this.hoverTarget === 0) this.hoverLastId = null;
            return false;
        }
        return true;
    }

    private stepZoom(dt: number): boolean {
        if (!this.zoomTarget) return false;
        const { zoom: targetZ, mx, my } = this.zoomTarget;
        const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
        let nextZ = this.zoom + (targetZ - this.zoom) * blend;
        let done = false;
        if (Math.abs(targetZ - nextZ) / targetZ < 0.002) {
            nextZ = targetZ;
            done = true;
        }
        const ratio = nextZ / this.zoom;
        this.camX = mx - (mx - this.camX) * ratio;
        this.camY = my - (my - this.camY) * ratio;
        this.zoom = nextZ;
        if (done) this.zoomTarget = null;
        return !done;
    }

    private stepPhysics(): boolean {
        if (!this.simActive || this.simNodes.length === 0) return false;

        // Keep dragged node hot while held; otherwise anneal smoothly to rest
        if (this.draggedNodeId) {
            this.simAlpha = Math.max(this.simAlpha, 0.28);
        } else {
            this.simAlpha *= 0.935;
        }

        const alpha = this.simAlpha;
        const nodes = this.simNodes;
        const nCount = nodes.length;

        // Center of mass anchor so the graph never drifts away
        let cx = 0,
            cy = 0;
        for (const n of nodes) {
            cx += n.x;
            cy += n.y;
        }
        cx /= nCount;
        cy /= nCount;

        // 1. Repulsion
        for (let i = 0; i < nCount; i++) {
            const a = nodes[i]!;
            for (let j = i + 1; j < nCount; j++) {
                const b = nodes[j]!;
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 1) {
                    dx = (i % 2 ? 1 : -1) * 0.5;
                    dy = (j % 2 ? 1 : -1) * 0.5;
                    d2 = 1;
                }
                if (d2 > 90000) continue;
                const d = Math.sqrt(d2);
                const rep = ((a.isImp || b.isImp ? CHARGE_STRENGTH * 0.35 : CHARGE_STRENGTH) * alpha) / d2;
                const fx = (dx / d) * rep;
                const fy = (dy / d) * rep;
                a.vx += fx;
                a.vy += fy;
                b.vx -= fx;
                b.vy -= fy;
            }
        }

        // 2. Springs
        for (const link of this.simLinks) {
            const { source: s, target: t, rest } = link;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const d = Math.hypot(dx, dy) || 1;
            const k = (0.28 / Math.max(1, Math.min(s.degree, t.degree))) * alpha;
            const f = ((d - rest) / d) * k;
            const fx = dx * f;
            const fy = dy * f;
            s.vx += fx;
            s.vy += fy;
            t.vx -= fx;
            t.vy -= fy;
        }

        // 3. Soft cluster cohesion
        const clusterCount = this.snapshot.clusters.length;
        if (clusterCount > 0) {
            const sumX = new Float64Array(clusterCount);
            const sumY = new Float64Array(clusterCount);
            const cnt = new Float64Array(clusterCount);
            for (const n of nodes) {
                if (n.clusterIdx < 0) continue;
                sumX[n.clusterIdx] += n.x;
                sumY[n.clusterIdx] += n.y;
                cnt[n.clusterIdx] += 1;
            }
            for (const n of nodes) {
                const ci = n.clusterIdx;
                if (ci < 0 || cnt[ci]! < 2) continue;
                n.vx += (sumX[ci]! / cnt[ci]! - n.x) * 0.055 * alpha;
                n.vy += (sumY[ci]! / cnt[ci]! - n.y) * 0.055 * alpha;
            }
        }

        // 4. Top-to-bottom DAG depth flow (foundational premises at top -> conclusions downward) + junction midpoint pull
        if (this.directionalFlow && this.nodeDepths.size > 0) {
            for (const n of nodes) {
                if (n.isImp) continue;
                const d = this.nodeDepths.get(n.id);
                if (d === undefined) continue;
                const targetY = cy + (d - this.meanDepth) * DEPTH_SPACING;
                n.vy += (targetY - n.y) * 0.2 * alpha;
            }
            for (const imp of this.snapshot.impLinks) {
                const jNode = this.simById.get(imp.id);
                const cNode = this.simById.get(imp.conclusion);
                if (!jNode || !cNode || imp.premises.length === 0) continue;
                let px = 0,
                    py = 0,
                    pCount = 0;
                for (const pid of imp.premises) {
                    const pNode = this.simById.get(pid);
                    if (pNode) {
                        px += pNode.x;
                        py += pNode.y;
                        pCount++;
                    }
                }
                if (pCount > 0) {
                    const midX = 0.5 * (px / pCount + cNode.x);
                    const midY = 0.5 * (py / pCount + cNode.y);
                    jNode.vx += (midX - jNode.x) * 0.28 * alpha;
                    jNode.vy += (midY - jNode.y) * 0.32 * alpha;
                }
            }
        }

        // 5. Gentle center gravity + velocity integration
        for (const n of nodes) {
            if (n.fx !== null && n.fy !== null) {
                n.x = n.fx;
                n.y = n.fy;
                n.vx = 0;
                n.vy = 0;
                continue;
            }
            n.vx += (cx - n.x) * 0.025 * alpha;
            n.vy += (cy - n.y) * (this.directionalFlow ? 0.006 : 0.025) * alpha;
            n.vx *= 0.62;
            n.vy *= 0.62;
            if (Math.abs(n.vx) > 0.002 || Math.abs(n.vy) > 0.002) {
                this.simMoved = true;
            }
            n.x += n.vx;
            n.y += n.vy;
        }

        if (!this.draggedNodeId && this.simAlpha < 0.006) {
            this.simActive = false;
            this.simAlpha = 0;
            this.schedulePositionCommit();
            return false;
        }
        return true;
    }

    private computeWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
        const props = this.simNodes.filter((n) => !n.isImp);
        if (props.length === 0) return null;
        let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
        for (const n of props) {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        }
        return { minX, maxX, minY, maxY };
    }

    private refreshFitReference(): void {
        const b = this.computeWorldBounds();
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (!b || w < 20 || h < 20) return;
        const spanX = Math.max(90, b.maxX - b.minX + 90);
        const spanY = Math.max(90, b.maxY - b.minY + 90);
        this.kFit = Math.max(0.35, Math.min(2.2, Math.min((w - 56) / spanX, (h - 90) / spanY)));
    }

    private fitView(animate = false): void {
        const b = this.computeWorldBounds();
        const w = this.canvas.clientWidth || 320;
        const h = this.canvas.clientHeight || 420;
        if (!b) {
            this.camX = 0;
            this.camY = 0;
            this.zoom = 1;
            this.kFit = 1;
            this.markDirty();
            return;
        }
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const spanX = Math.max(90, b.maxX - b.minX + 90);
        const spanY = Math.max(90, b.maxY - b.minY + 90);
        const targetK = Math.max(0.38, Math.min(1.9, Math.min((w - 56) / spanX, (h - 96) / spanY)));
        this.kFit = targetK;
        this.zoom = targetK;
        this.camX = -cx * targetK;
        this.camY = -cy * targetK + 12;
        this.zoomTarget = null;
        if (animate) this.reheatSim(0.08);
        this.markDirty();
    }

    private resizeCanvas(): boolean {
        const wrap = this.canvas.parentElement;
        if (!wrap) return false;
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        if (w < 10 || h < 10) return false;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.floor(w * dpr);
        const bh = Math.floor(h * dpr);
        if (this.canvas.width !== bw || this.canvas.height !== bh) {
            this.canvas.width = bw;
            this.canvas.height = bh;
            this.canvas.style.width = `${w}px`;
            this.canvas.style.height = `${h}px`;
        }
        return true;
    }

    private worldToScreen(wx: number, wy: number): { x: number; y: number } {
        const w = this.canvas.clientWidth || 320;
        const h = this.canvas.clientHeight || 420;
        return {
            x: w / 2 + this.camX + wx * this.zoom,
            y: h / 2 + this.camY + wy * this.zoom,
        };
    }

    private screenToWorld(sx: number, sy: number): { x: number; y: number } {
        const w = this.canvas.clientWidth || 320;
        const h = this.canvas.clientHeight || 420;
        return {
            x: (sx - w / 2 - this.camX) / this.zoom,
            y: (sy - h / 2 - this.camY) / this.zoom,
        };
    }

    private pickNodeAt(sx: number, sy: number): SimNode | null {
        const maxDist = Math.max(8, 4.5 * this.zoom) + PICK_PAD_PX;
        let best: SimNode | null = null;
        let bestDist = maxDist;
        for (const n of this.simNodes) {
            if (n.isImp) continue;
            if (!this.isNodeMatchingSearch(n)) continue;
            const scr = this.worldToScreen(n.x, n.y);
            const d = Math.hypot(sx - scr.x, sy - scr.y);
            if (d <= bestDist) {
                bestDist = d;
                best = n;
            }
        }
        return best;
    }

    private wrapLabelLines(ctx: CanvasRenderingContext2D, text: string, maxWidthPx: number): string[] {
        if (ctx.measureText(text).width <= maxWidthPx) return [text];
        const words = text.split(/\s+/).filter(Boolean);
        let line1 = "";
        let idx = 0;
        while (idx < words.length) {
            const cand = line1 ? `${line1} ${words[idx]}` : words[idx]!;
            if (ctx.measureText(cand).width <= maxWidthPx || !line1) {
                line1 = cand;
                idx++;
            } else {
                break;
            }
        }
        if (idx >= words.length) return [line1];
        let rest = words.slice(idx).join(" ");
        if (ctx.measureText(rest).width <= maxWidthPx) return [line1, rest];
        while (rest.length > 1 && ctx.measureText(`${rest}…`).width > maxWidthPx) {
            rest = rest.slice(0, -1);
        }
        return [line1, `${rest}…`];
    }

    private draw(): void {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w < 10 || h < 10) return;

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const style = getComputedStyle(document.documentElement);
        const textColor = toHexColor(style.getPropertyValue("--b3-theme-on-background"), "#e2e8f0");
        const mutedColor = toHexColor(style.getPropertyValue("--b3-theme-on-surface-light"), "#94a3b8");
        const primaryColor = toHexColor(style.getPropertyValue("--b3-theme-primary"), "#3b82f6");
        const fontFamily = style.getPropertyValue("--b3-font-family").trim() || "sans-serif";

        const focusId = this.hoverId ?? this.selectedNodeId;
        const focusSet = focusId ? this.neighborsById.get(focusId) ?? null : null;

        // 1. Soft organic radial cluster clouds (no harsh circle borders)
        const palette = ["#4f8cff", "#34d399", "#f59e0b", "#a78bfa", "#f472b6", "#38bdf8"];
        this.snapshot.clusters.forEach((cluster, idx) => {
            const color = palette[idx % palette.length]!;
            const splatR = Math.max(26, Math.min(72, 42 * this.zoom));
            for (const memberId of cluster.members) {
                const sn = this.simById.get(memberId);
                if (!sn || sn.isImp || !this.isNodeMatchingSearch(sn)) continue;
                const p = this.worldToScreen(sn.x, sn.y);
                const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, splatR);
                grad.addColorStop(0, `${color}16`);
                grad.addColorStop(0.55, `${color}0a`);
                grad.addColorStop(1, `${color}00`);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(p.x, p.y, splatR, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        // 2. Edges (crisp viewer-relative hairlines + arrowheads, dimmed smoothly when spotlighting)
        for (const link of this.simLinks) {
            const { source: s, target: t } = link;
            if (!this.isNodeMatchingSearch(s) || !this.isNodeMatchingSearch(t)) continue;

            const s1 = this.worldToScreen(s.x, s.y);
            const s2 = this.worldToScreen(t.x, t.y);
            const dx = s2.x - s1.x;
            const dy = s2.y - s1.y;
            const len = Math.hypot(dx, dy);
            if (len < 2) continue;

            const inSpotlight =
                !focusSet || (focusSet.has(s.id) && focusSet.has(t.id));
            const isDirectFocus =
                focusId !== null && (s.id === focusId || t.id === focusId || (s.isImp && focusSet?.has(s.id) && focusSet?.has(t.id)));

            ctx.globalAlpha = focusSet ? (isDirectFocus ? 0.88 : inSpotlight ? 0.45 : 0.1) : 0.34;
            ctx.strokeStyle = isDirectFocus ? primaryColor : mutedColor;
            ctx.lineWidth = isDirectFocus ? 1.4 : 1.0;

            const targetR = t.isImp
                ? Math.max(2.6, 3.2 * Math.sqrt(this.zoom)) + 1
                : Math.max(3.2, Math.min(7.5, 4.2 * this.zoom)) + 1.5;
            const endX = s2.x - (dx / len) * targetR;
            const endY = s2.y - (dy / len) * targetR;

            ctx.beginPath();
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(endX, endY);
            ctx.stroke();

            // Single arrow leaves to conclusion (co-premise lines converge onto the hollow diamond junction)
            if (!t.isImp && len > targetR + 6) {
                const angle = Math.atan2(dy, dx);
                const headLen = Math.max(4.5, Math.min(7.5, 5.5 * Math.sqrt(this.zoom)));
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(
                    endX - headLen * Math.cos(angle - 0.42),
                    endY - headLen * Math.sin(angle - 0.42),
                );
                ctx.lineTo(
                    endX - headLen * Math.cos(angle + 0.42),
                    endY - headLen * Math.sin(angle + 0.42),
                );
                ctx.closePath();
                ctx.fillStyle = isDirectFocus ? primaryColor : mutedColor;
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;

        // 3. Soft hover halo glow
        const glowTargetId = this.hoverLastId ?? this.selectedNodeId;
        if (glowTargetId) {
            const gn = this.simById.get(glowTargetId);
            if (gn && !gn.isImp) {
                const gp = this.worldToScreen(gn.x, gn.y);
                const baseR = Math.max(3.5, Math.min(8, 4.4 * this.zoom));
                const glowR = baseR * 3.4;
                const fade = glowTargetId === this.selectedNodeId ? 1 : this.hoverFade;
                const grad = ctx.createRadialGradient(gp.x, gp.y, baseR * 0.6, gp.x, gp.y, glowR);
                grad.addColorStop(0, `${primaryColor}${Math.round(fade * 85).toString(16).padStart(2, "0")}`);
                grad.addColorStop(1, `${primaryColor}00`);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(gp.x, gp.y, glowR, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 4. Proposition Nodes + Multi-Premise AND-Junction Diamonds
        for (const node of this.simNodes) {
            if (!this.isNodeMatchingSearch(node)) continue;
            const scr = this.worldToScreen(node.x, node.y);
            const inSpotlight = !focusSet || focusSet.has(node.id);

            if (node.isImp) {
                // Draw a crisp hollow diamond (◇) for multi-premise logical AND-junctions so converging edges read clearly
                const jr = Math.max(2.6, Math.min(4.8, 3.1 * Math.sqrt(this.zoom)));
                const isActiveJunction = focusId !== null && focusSet?.has(node.id);
                ctx.globalAlpha = focusSet ? (isActiveJunction ? 0.9 : 0.14) : 0.5;
                ctx.beginPath();
                ctx.moveTo(scr.x, scr.y - jr);
                ctx.lineTo(scr.x + jr, scr.y);
                ctx.lineTo(scr.x, scr.y + jr);
                ctx.lineTo(scr.x - jr, scr.y);
                ctx.closePath();
                ctx.strokeStyle = isActiveJunction ? primaryColor : mutedColor;
                ctx.lineWidth = 1.2;
                ctx.stroke();
                continue;
            }

            const isSelected = this.selectedNodeId === node.id;

            const isHovered = this.hoverId === node.id;
            const isPicked = this.practiceSelection.has(node.id);

            const degreeBoost = Math.min(2.2, Math.sqrt(node.degree) * 0.55);
            const baseR = (3.6 + degreeBoost) * Math.max(0.75, Math.min(1.45, Math.sqrt(this.zoom)));
            const r = isSelected || isHovered ? baseR * 1.22 : baseR;

            ctx.globalAlpha = inSpotlight ? 1 : 0.18;
            ctx.beginPath();
            ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
            ctx.fillStyle = isPicked ? "#10b981" : primaryColor;
            ctx.fill();

            if (isSelected || isPicked) {
                ctx.lineWidth = 1.6;
                ctx.strokeStyle = isPicked ? "#a7f3d0" : "#ffffff";
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // 5. Zoom-gated, subtle, wrapped Node Labels (never giant overlapping text)
        const ratio = this.kFit / Math.max(0.05, this.zoom);
        // Full label alpha when zoomed in past fit (ratio <= 1.05), fading smoothly down when zoomed out
        const baseLabelAlpha = Math.max(0, Math.min(1, 1 - (ratio - 1.05) / 0.75));
        const fontPx = Math.round(Math.max(9.5, Math.min(11, 10 * Math.pow(this.zoom, 0.2))) * 2) / 2;
        ctx.font = `450 ${fontPx}px ${fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        for (const node of this.simNodes) {
            if (node.isImp) continue;
            if (!this.isNodeMatchingSearch(node)) continue;

            const isSelected = this.selectedNodeId === node.id;
            const isHovered = this.hoverId === node.id;
            const inSpotlight = focusSet ? focusSet.has(node.id) : false;

            let alpha = baseLabelAlpha * 0.76;
            if (focusSet) {
                alpha = isSelected || isHovered ? 1 : inSpotlight ? Math.max(0.85, alpha) : alpha * 0.12;
            } else if (isSelected || isHovered) {
                alpha = 1;
            }
            if (alpha < 0.06) continue;

            const scr = this.worldToScreen(node.x, node.y);
            // Cull off-screen labels cleanly
            if (scr.x < -80 || scr.x > w + 80 || scr.y < -30 || scr.y > h + 40) continue;

            const degreeBoost = Math.min(2.2, Math.sqrt(node.degree) * 0.55);
            const r = (3.6 + degreeBoost) * Math.max(0.75, Math.min(1.45, Math.sqrt(this.zoom)));

            ctx.globalAlpha = alpha;
            ctx.fillStyle = isSelected || isHovered ? textColor : mutedColor;
            if (isSelected || isHovered) {
                ctx.font = `600 ${fontPx + 0.5}px ${fontFamily}`;
            }

            const lines = this.wrapLabelLines(ctx, node.label, 118);
            const startY = scr.y + r + 4;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i]!, scr.x, startY + i * (fontPx * 1.24));
            }

            if (isSelected || isHovered) {
                ctx.font = `450 ${fontPx}px ${fontFamily}`;
            }
        }

        ctx.globalAlpha = 1;
        ctx.restore();
    }

    private renderNodeCard(): void {
        if (!this.selectedNodeId) {
            this.inspectorEl.classList.add("fn__none");
            this.inspectorEl.innerHTML = "";
            return;
        }

        const node = this.snapshot.propositions.find((n) => n.id === this.selectedNodeId);
        if (!node) {
            this.selectedNodeId = null;
            this.inspectorEl.classList.add("fn__none");
            this.inspectorEl.innerHTML = "";
            return;
        }

        const namesById: Record<string, { name: string }> = {};
        for (const n of this.snapshot.propositions) namesById[n.id] = { name: n.name };

        const incomingChains = this.snapshot.chains.filter((c) => c.conclusion === node.id);
        const outgoingChains = this.snapshot.chains.filter((c) => c.premises.includes(node.id));
        const sourceIds = this.snapshot.nodeSessions[node.id] ?? [];
        const isPicked = this.practiceSelection.has(node.id);

        const renderCognitiveNotes = (label: string, items?: string[]) =>
            items && items.length > 0
                ? `<div class="lh-inspector-section">
                       <div class="lh-inspector-subtitle">${escapeHtml(label)}</div>
                       ${items.map((x) => `<div class="lh-chain-card b3-typography">${renderMarkdown(x)}</div>`).join("")}
                   </div>`
                : "";

        this.inspectorEl.classList.remove("fn__none");
        this.inspectorEl.innerHTML = `
            <div class="lh-graph-card__header">
                <div class="lh-inspector-node-name">${renderInlineMarkdown(node.name)}</div>
                <div class="lh-inspector-actions">
                    <button type="button" class="lh-sidenote__mini-btn" data-action="toggle-practice-node" data-node-id="${escapeHtml(node.id)}">
                        ${isPicked ? "✓ Selected" : "+ Select"}
                    </button>
                    <button type="button" class="lh-sidenote__mini-btn" data-action="practice-single-node" data-node-id="${escapeHtml(node.id)}">
                        Practice
                    </button>
                    <button type="button" class="lh-sidenote__icon-btn" data-action="delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete node">
                        ${GRAPH_ICON.trash}
                    </button>
                    <button type="button" class="lh-sidenote__icon-btn" data-action="close-node-card" title="Close">×</button>
                </div>
            </div>
            <div class="lh-graph-card__body">
                <div class="lh-inspector-node-stmt b3-typography">${renderMarkdown(node.statement)}</div>
                ${renderCognitiveNotes("Mental Framings", node.mentalFramings)}
                ${renderCognitiveNotes("Misconceptions Repaired", node.misconceptions)}
                ${renderCognitiveNotes("Fragility Notes", node.fragilityNotes)}
                ${
                    incomingChains.length > 0
                        ? `<div class="lh-inspector-section">
                               <div class="lh-inspector-subtitle">Derived From (${incomingChains.length})</div>
                               ${incomingChains.map((c) => `<div class="lh-chain-card">${renderInlineMarkdown(formatChainLine(c, namesById))}</div>`).join("")}
                           </div>`
                        : ""
                }
                ${
                    outgoingChains.length > 0
                        ? `<div class="lh-inspector-section">
                               <div class="lh-inspector-subtitle">Supports (${outgoingChains.length})</div>
                               ${outgoingChains.map((c) => `<div class="lh-chain-card">${renderInlineMarkdown(formatChainLine(c, namesById))}</div>`).join("")}
                           </div>`
                        : ""
                }
                ${
                    sourceIds.length > 0
                        ? `<div class="lh-inspector-section">
                               <div class="lh-inspector-subtitle">Sources</div>
                               ${sourceIds
                                   .map((sid) => {
                                       const chatTitle = this.snapshot.sessions[sid];
                                       if (chatTitle) {
                                           return `<button type="button" class="lh-provenance-link" data-action="open-provenance-chat" data-chat-id="${escapeHtml(sid)}">${escapeHtml(chatTitle)}</button>`;
                                       }
                                       const fileLabel = this.snapshot.fileSources[sid] ?? sid;
                                       const docId = this.snapshot.docSources[sid];
                                       if (docId) {
                                           return `<button type="button" class="lh-provenance-link" data-action="open-provenance-doc" data-doc-id="${escapeHtml(docId)}">${escapeHtml(fileLabel)}</button>`;
                                       }
                                       return `<div class="lh-inspector-hint">${escapeHtml(fileLabel)}</div>`;
                                   })
                                   .join("")}
                           </div>`
                        : ""
                }
            </div>
        `;
    }

    private async extractActiveChat(): Promise<void> {
        const chatId = this.callbacks.getActiveChatId?.();
        if (!chatId) {
            showMessage("No active chat to extract from.", 2500, "info");
            return;
        }
        this.setStatus("Extracting nodes...");
        try {
            const stats = await extractFromChat(
                {
                    chatStore: this.stores.chatStore,
                    graphStore: this.stores.graphStore,
                    settingsStore: this.stores.settingsStore,
                },
                chatId,
                { forceAllUncovered: true },
            );
            this.hasAutoCentered = false;
            this.refresh();
            showMessage(
                stats.nodes > 0
                    ? `Extracted ${stats.nodes} node(s) and ${stats.chains ?? 0} chain(s).`
                    : "No new uncovered teacher prose to extract.",
                3000,
                "info",
            );
        } catch (err: any) {
            showMessage(`Extraction failed: ${err?.message ?? String(err)}`, 4000, "error");
        } finally {
            this.setStatus("");
        }
    }

    private launchPracticeForSelection(nodeIds: string[]): void {
        const pickedNodes = this.snapshot.propositions.filter((n) => nodeIds.includes(n.id));
        if (pickedNodes.length === 0) return;

        const namesById: Record<string, { name: string }> = {};
        for (const n of this.snapshot.propositions) namesById[n.id] = { name: n.name };

        const relevantChains = chainsForSelection(pickedNodes, this.snapshot.chains)
            .filter((c) => c.premises.length > 0)
            .map((c) => formatChainLine(c, namesById));

        const title =
            pickedNodes.length === 1
                ? `Practice: ${pickedNodes[0]!.name}`
                : `Practice (${pickedNodes.length} propositions)`;

        const chat = this.stores.chatStore.createChat({
            title,
            kind: "practice",
        });

        chat.messages.push(
            newGraphContextMessage(
                pickedNodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
                relevantChains,
            ),
        );
        this.stores.chatStore.saveChat(chat);
        this.practiceSelection.clear();
        this.callbacks.onStartPracticeFromGraph(chat.id);
    }

    public async openImportNoteModal(): Promise<void> {
        const overlay = document.createElement("div");
        overlay.className = "lh-modal-backdrop";
        overlay.innerHTML = `
            <div class="lh-modal">
                <div class="lh-modal__header">
                    <div class="lh-modal__title">Import SiYuan Note to Knowledge Graph</div>
                    <button type="button" class="lh-sidenote__icon-btn" data-modal-close="true">×</button>
                </div>
                <div class="lh-modal__body">
                    <div class="lh-modal__desc">
                        Select any note from your SiYuan workspace to extract world-facing propositions and reasoning chains into your graph.
                    </div>
                    <input type="text" class="b3-text-field fn__block lh-note-search-input" placeholder="Search notes by title or path..." />
                    <div class="lh-note-search-results">Loading recent notes...</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const inputEl = overlay.querySelector(".lh-note-search-input") as HTMLInputElement;
        const resultsEl = overlay.querySelector(".lh-note-search-results") as HTMLElement;
        window.requestAnimationFrame(() => inputEl?.focus());

        const onEsc = (ev: KeyboardEvent) => {
            if (ev.key === "Escape") close();
        };
        const close = () => {
            document.removeEventListener("keydown", onEsc);
            overlay.remove();
        };
        document.addEventListener("keydown", onEsc);

        const renderDocs = (docs: SiyuanDocEntry[]) => {
            if (docs.length === 0) {
                resultsEl.innerHTML = `<div class="lh-inspector-empty">No matching SiYuan notes found.</div>`;
                return;
            }
            resultsEl.innerHTML = docs
                .map(
                    (d) => `
                <div class="lh-note-picker-row">
                    <div class="lh-note-picker-row__info">
                        <div class="lh-note-picker-row__title">${escapeHtml(d.name)}</div>
                        <div class="lh-note-picker-row__path">${escapeHtml(d.hPath || d.path)}</div>
                    </div>
                    <button type="button" class="lh-sidenote__mini-btn" data-import-doc-id="${escapeHtml(d.id)}">
                        Extract
                    </button>
                </div>
            `,
                )
                .join("");
        };

        const loadQuery = async (q: string) => {
            try {
                const docs = await findNotes(q, 30);
                renderDocs(docs);
            } catch (err: any) {
                resultsEl.innerHTML = `<div class="lh-inspector-empty">Error searching notes: ${escapeHtml(err?.message ?? String(err))}</div>`;
            }
        };

        void loadQuery("");

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        inputEl.addEventListener("input", () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                void loadQuery(inputEl.value);
            }, 200);
        });

        overlay.addEventListener("click", async (e) => {
            const target = e.target as HTMLElement;
            if (target === overlay || target.closest("[data-modal-close]")) {
                close();
                return;
            }
            const importBtn = target.closest("[data-import-doc-id]") as HTMLButtonElement | null;
            if (importBtn) {
                const docId = importBtn.dataset.importDocId;
                if (!docId) return;
                importBtn.disabled = true;
                importBtn.textContent = "Extracting...";
                this.setStatus("Extracting note...");
                try {
                    const res = await importSiyuanNoteToGraph(
                        {
                            chatStore: this.stores.chatStore,
                            graphStore: this.stores.graphStore,
                            settingsStore: this.stores.settingsStore,
                        },
                        docId,
                    );
                    showMessage(
                        `Extracted ${res.stats.nodes} node(s) and ${res.stats.chains ?? 0} chain(s) from "${res.hPath}"`,
                        4000,
                        "info",
                    );
                    close();
                    this.hasAutoCentered = false;
                    this.refresh();
                } catch (err: any) {
                    showMessage(`Extraction failed: ${err?.message ?? String(err)}`, 5000, "error");
                    importBtn.disabled = false;
                    importBtn.textContent = "Extract";
                } finally {
                    this.setStatus("");
                }
            }
        });
    }
}
