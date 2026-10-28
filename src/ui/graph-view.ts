/**
 * Interactive Knowledge Graph View (<canvas> force-directed proposition & chain viewer)
 * + Node Inspector + SiYuan Note Importer + Practice Session Launcher.
 */

import { showMessage } from "siyuan";
import { importSiyuanNoteToGraph } from "../agent/extraction";
import type { GraphNode, GraphSnapshot, Position } from "../core/contracts";
import { chainsForSelection, formatChainLine, graphSnapshot } from "../core/graph";
import { newGraphContextMessage } from "../core/messages";
import { findNotes, type SiyuanDocEntry } from "../siyuan/client";
import type { SiYuanHarnessStores } from "../store/siyuan-store";
import { escapeHtml } from "./markdown";

export interface GraphViewCallbacks {
    onOpenChat: (chatId: string) => void;
    onOpenSiyuanDoc: (docId: string) => void;
    onStartPracticeFromGraph: (chatId: string) => void;
}

export class KnowledgeGraphView {
    private container: HTMLElement;
    private stores: SiYuanHarnessStores;
    private callbacks: GraphViewCallbacks;

    private canvas!: HTMLCanvasElement;
    private inspectorEl!: HTMLElement;
    private toolbarStatusEl!: HTMLElement;

    private snapshot: GraphSnapshot;
    private positions = new Map<string, Position>();
    private selectedNodeId: string | null = null;
    private practiceSelection = new Set<string>();

    // Camera state
    private camX = 0;
    private camY = 0;
    private zoom = 1.15;

    // Pointer interaction state
    private isDraggingCanvas = false;
    private draggedNodeId: string | null = null;
    private dragStartX = 0;
    private dragStartY = 0;
    private pointerMoved = false;

    private resizeObserver: ResizeObserver | null = null;

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
                <div class="lh-graph-main">
                    <div class="lh-graph-toolbar">
                        <div class="lh-graph-toolbar__left">
                            <button class="b3-button b3-button--outline" data-action="import-note">
                                + Import SiYuan Note to Graph
                            </button>
                            <button class="b3-button b3-button--outline" data-action="relayout">
                                Re-settle Layout
                            </button>
                            <button class="b3-button b3-button--outline" data-action="fit-view">
                                Center View
                            </button>
                            <span class="lh-graph-toolbar__status"></span>
                        </div>
                        <div class="lh-graph-toolbar__right">
                            <span class="lh-graph-toolbar__counts"></span>
                            <button class="b3-button b3-button--text" data-action="practice-selected" style="display:none;">
                                Practice Selected (0)
                            </button>
                        </div>
                    </div>
                    <div class="lh-graph-canvas-wrap">
                        <canvas class="lh-graph-canvas"></canvas>
                        <div class="lh-graph-empty" style="display:none;">
                            <div class="lh-graph-empty__title">Your Knowledge Graph is Empty</div>
                            <div class="lh-graph-empty__desc">
                                Propositions and reasoning chains are extracted automatically from your teaching sessions, or you can import any existing SiYuan note right now.
                            </div>
                            <button class="b3-button" data-action="import-note-empty">
                                Import a SiYuan Note into the Knowledge Graph
                            </button>
                        </div>
                    </div>
                </div>
                <div class="lh-graph-inspector"></div>
            </div>
        `;

        this.canvas = this.container.querySelector(".lh-graph-canvas") as HTMLCanvasElement;
        this.inspectorEl = this.container.querySelector(".lh-graph-inspector") as HTMLElement;
        this.toolbarStatusEl = this.container.querySelector(".lh-graph-toolbar__status") as HTMLElement;

        this.bindEvents();
        this.refresh();

        this.resizeObserver = new ResizeObserver(() => {
            this.resizeCanvas();
            this.draw();
        });
        const wrap = this.container.querySelector(".lh-graph-canvas-wrap");
        if (wrap) this.resizeObserver.observe(wrap);
    }

    public destroy(): void {
        this.resizeObserver?.disconnect();
    }

    public refresh(): void {
        this.snapshot = graphSnapshot({
            chatStore: this.stores.chatStore,
            graphStore: this.stores.graphStore,
        });

        this.positions.clear();
        if (this.snapshot.positions) {
            for (const [id, pos] of Object.entries(this.snapshot.positions)) {
                this.positions.set(id, { x: pos.x, y: pos.y });
            }
        }
        // Fallback if any node lacks a position
        this.snapshot.nodes.forEach((n, idx) => {
            if (!this.positions.has(n.id)) {
                const angle = (idx / Math.max(1, this.snapshot.nodes.length)) * Math.PI * 2;
                const r = 60 + Math.sqrt(idx + 1) * 35;
                this.positions.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
            }
        });

        const emptyEl = this.container.querySelector(".lh-graph-empty") as HTMLElement | null;
        if (emptyEl) {
            emptyEl.style.display = this.snapshot.propositions.length === 0 ? "flex" : "none";
        }

        const countsEl = this.container.querySelector(".lh-graph-toolbar__counts") as HTMLElement | null;
        if (countsEl) {
            countsEl.textContent = `${this.snapshot.propositions.length} propositions · ${this.snapshot.chains.length} chains`;
        }

        this.updatePracticeButton();
        this.resizeCanvas();
        this.draw();
        this.renderInspector();
    }

    private updatePracticeButton(): void {
        const btn = this.container.querySelector('[data-action="practice-selected"]') as HTMLButtonElement | null;
        if (!btn) return;
        const count = this.practiceSelection.size;
        if (count > 0) {
            btn.style.display = "inline-flex";
            btn.textContent = `Practice Selected (${count})`;
        } else {
            btn.style.display = "none";
        }
    }

    private bindEvents(): void {
        this.container.addEventListener("click", (e) => {
            const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;

            if (action === "import-note" || action === "import-note-empty") {
                void this.openImportNoteModal();
            } else if (action === "relayout") {
                this.stores.recomputeLayoutPositions();
                this.refresh();
            } else if (action === "fit-view") {
                this.centerView();
            } else if (action === "practice-selected") {
                this.launchPracticeForSelection(Array.from(this.practiceSelection));
            } else if (action === "toggle-practice-node") {
                const nodeId = target.dataset.nodeId;
                if (nodeId) {
                    if (this.practiceSelection.has(nodeId)) this.practiceSelection.delete(nodeId);
                    else this.practiceSelection.add(nodeId);
                    this.updatePracticeButton();
                    this.draw();
                    this.renderInspector();
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
            } else if (action === "select-node") {
                const nodeId = target.dataset.nodeId;
                if (nodeId) {
                    this.selectedNodeId = nodeId;
                    this.draw();
                    this.renderInspector();
                }
            }
        });

        this.canvas.addEventListener("mousedown", (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const hit = this.hitTestNode(sx, sy);

            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.pointerMoved = false;

            if (hit) {
                this.draggedNodeId = hit.id;
            } else {
                this.isDraggingCanvas = true;
            }
        });

        window.addEventListener("mousemove", (e) => {
            if (!this.isDraggingCanvas && !this.draggedNodeId) return;
            const dx = e.clientX - this.dragStartX;
            const dy = e.clientY - this.dragStartY;
            if (Math.hypot(dx, dy) > 3) this.pointerMoved = true;

            if (this.draggedNodeId) {
                const pos = this.positions.get(this.draggedNodeId);
                if (pos) {
                    pos.x += dx / this.zoom;
                    pos.y += dy / this.zoom;
                }
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.draw();
            } else if (this.isDraggingCanvas) {
                this.camX += dx;
                this.camY += dy;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.draw();
            }
        });

        window.addEventListener("mouseup", (e) => {
            if (!this.isDraggingCanvas && !this.draggedNodeId) return;
            if (!this.pointerMoved) {
                const rect = this.canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const hit = this.hitTestNode(sx, sy);
                if (hit) {
                    if (e.shiftKey) {
                        if (this.practiceSelection.has(hit.id)) this.practiceSelection.delete(hit.id);
                        else this.practiceSelection.add(hit.id);
                        this.updatePracticeButton();
                    }
                    this.selectedNodeId = hit.id;
                } else {
                    this.selectedNodeId = null;
                }
                this.renderInspector();
            } else if (this.draggedNodeId) {
                // Persist updated node position
                const posObj: Record<string, Position> = {};
                for (const [id, p] of this.positions) posObj[id] = p;
                this.stores.graphStore.writePositions(posObj);
            }
            this.isDraggingCanvas = false;
            this.draggedNodeId = null;
            this.draw();
        });

        this.canvas.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                const rect = this.canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left - this.canvas.clientWidth / 2;
                const my = e.clientY - rect.top - this.canvas.clientHeight / 2;

                const factor = e.deltaY < 0 ? 1.12 : 0.89;
                const nextZoom = Math.max(0.25, Math.min(4.0, this.zoom * factor));
                const ratio = nextZoom / this.zoom;
                this.camX = mx - (mx - this.camX) * ratio;
                this.camY = my - (my - this.camY) * ratio;
                this.zoom = nextZoom;
                this.draw();
            },
            { passive: false },
        );
    }

    private centerView(): void {
        if (this.positions.size === 0) {
            this.camX = 0;
            this.camY = 0;
            this.zoom = 1.15;
            this.draw();
            return;
        }
        let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
        for (const p of this.positions.values()) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const spanX = Math.max(120, maxX - minX + 120);
        const spanY = Math.max(120, maxY - minY + 120);
        const w = this.canvas.clientWidth || 600;
        const h = this.canvas.clientHeight || 400;
        this.zoom = Math.max(0.4, Math.min(2.2, Math.min(w / spanX, h / spanY)));
        this.camX = -cx * this.zoom;
        this.camY = -cy * this.zoom;
        this.draw();
    }

    private resizeCanvas(): void {
        const wrap = this.canvas.parentElement;
        if (!wrap) return;
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth || 600;
        const h = wrap.clientHeight || 400;
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
    }

    private worldToScreen(wx: number, wy: number): { x: number; y: number } {
        const w = this.canvas.clientWidth || 600;
        const h = this.canvas.clientHeight || 400;
        return {
            x: w / 2 + this.camX + wx * this.zoom,
            y: h / 2 + this.camY + wy * this.zoom,
        };
    }

    private hitTestNode(sx: number, sy: number): GraphNode | null {
        const hitRadius = Math.max(10, 12 * this.zoom);
        for (let i = this.snapshot.propositions.length - 1; i >= 0; i--) {
            const node = this.snapshot.propositions[i]!;
            const pos = this.positions.get(node.id);
            if (!pos) continue;
            const scr = this.worldToScreen(pos.x, pos.y);
            if (Math.hypot(sx - scr.x, sy - scr.y) <= hitRadius) {
                return node;
            }
        }
        return null;
    }

    private draw(): void {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth || 600;
        const h = this.canvas.clientHeight || 400;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const style = getComputedStyle(document.documentElement);
        const textColor = style.getPropertyValue("--b3-theme-on-background").trim() || "#e0e0e0";
        const mutedColor = style.getPropertyValue("--b3-theme-on-surface-light").trim() || "#888888";
        const primaryColor = style.getPropertyValue("--b3-theme-primary").trim() || "#4f8cff";

        // 1. Draw Cluster regions (birth-session communities)
        const palette = ["#4f8cff", "#34d399", "#f59e0b", "#a78bfa", "#f472b6", "#38bdf8"];
        this.snapshot.clusters.forEach((cluster, idx) => {
            const pts: Array<{ x: number; y: number }> = [];
            for (const memberId of cluster.members) {
                const p = this.positions.get(memberId);
                if (p) pts.push(this.worldToScreen(p.x, p.y));
            }
            if (pts.length < 3) return;
            let cx = 0,
                cy = 0;
            for (const pt of pts) {
                cx += pt.x;
                cy += pt.y;
            }
            cx /= pts.length;
            cy /= pts.length;
            let maxR = 25;
            for (const pt of pts) {
                maxR = Math.max(maxR, Math.hypot(pt.x - cx, pt.y - cy) + 28 * this.zoom);
            }
            const color = palette[idx % palette.length]!;
            ctx.beginPath();
            ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
            ctx.fillStyle = `${color}12`;
            ctx.strokeStyle = `${color}30`;
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();

            if (cluster.label) {
                ctx.font = "600 11px sans-serif";
                ctx.fillStyle = mutedColor;
                ctx.textAlign = "center";
                ctx.fillText(cluster.label.slice(0, 36), cx, cy - maxR - 6);
            }
        });

        // 2. Draw Edges (premise -> imp/conclusion arrows)
        for (const edge of this.snapshot.edges) {
            const fromPos = this.positions.get(edge.from);
            const toPos = this.positions.get(edge.to);
            if (!fromPos || !toPos) continue;
            const s1 = this.worldToScreen(fromPos.x, fromPos.y);
            const s2 = this.worldToScreen(toPos.x, toPos.y);

            const isImpTarget = edge.to.startsWith("arg_");
            const isHighlighted =
                this.selectedNodeId === edge.from || this.selectedNodeId === edge.to;

            ctx.beginPath();
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(s2.x, s2.y);
            ctx.strokeStyle = isHighlighted ? primaryColor : `${mutedColor}66`;
            ctx.lineWidth = isHighlighted ? 2 : 1.25;
            ctx.stroke();

            // Draw arrowhead unless target is an invisible implication junction
            if (!isImpTarget) {
                const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
                const targetRadius = 8 * this.zoom;
                const ax = s2.x - Math.cos(angle) * targetRadius;
                const ay = s2.y - Math.sin(angle) * targetRadius;
                const headLen = Math.max(6, 7 * this.zoom);

                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(ax - headLen * Math.cos(angle - Math.PI / 6), ay - headLen * Math.sin(angle - Math.PI / 6));
                ctx.lineTo(ax - headLen * Math.cos(angle + Math.PI / 6), ay - headLen * Math.sin(angle + Math.PI / 6));
                ctx.closePath();
                ctx.fillStyle = isHighlighted ? primaryColor : `${mutedColor}99`;
                ctx.fill();
            } else {
                // Small junction dot at the multi-premise convergence point
                ctx.beginPath();
                ctx.arc(s2.x, s2.y, 2.5 * this.zoom, 0, Math.PI * 2);
                ctx.fillStyle = `${mutedColor}88`;
                ctx.fill();
            }
        }

        // 3. Draw Proposition Nodes
        for (const node of this.snapshot.propositions) {
            const pos = this.positions.get(node.id);
            if (!pos) continue;
            const scr = this.worldToScreen(pos.x, pos.y);
            const isSelected = this.selectedNodeId === node.id;
            const isInPractice = this.practiceSelection.has(node.id);
            const radius = (isSelected ? 9 : 6.5) * Math.max(0.75, Math.min(1.5, this.zoom));

            ctx.beginPath();
            ctx.arc(scr.x, scr.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? primaryColor : isInPractice ? "#10b981" : "#3b82f6";
            ctx.fill();
            ctx.lineWidth = isSelected || isInPractice ? 2.5 : 1.2;
            ctx.strokeStyle = isSelected ? "#ffffff" : isInPractice ? "#a7f3d0" : "#1d4ed8";
            ctx.stroke();

            if (this.zoom >= 0.55 || isSelected) {
                ctx.font = `${isSelected ? "600 " : ""}${Math.round(
                    Math.max(10, Math.min(13, 11 * this.zoom)),
                )}px sans-serif`;
                ctx.fillStyle = textColor;
                ctx.textAlign = "center";
                ctx.fillText(node.name, scr.x, scr.y + radius + 13);
            }
        }

        ctx.restore();
    }

    private renderInspector(): void {
        if (!this.selectedNodeId) {
            const recentNodes = [...this.snapshot.propositions].reverse().slice(0, 25);
            this.inspectorEl.innerHTML = `
                <div class="lh-inspector-section">
                    <div class="lh-inspector-title">Knowledge Graph Inspector</div>
                    <div class="lh-inspector-hint">
                        Click any node on the canvas (or Shift+Click to multi-select for Practice) to inspect its full proposition statement, reasoning chains, and source SiYuan notes or sessions.
                    </div>
                </div>
                <div class="lh-inspector-section">
                    <div class="lh-inspector-subtitle">Recent Propositions (${this.snapshot.propositions.length})</div>
                    <div class="lh-inspector-list">
                        ${
                            recentNodes.length === 0
                                ? `<div class="lh-inspector-empty">No propositions extracted yet.</div>`
                                : recentNodes
                                      .map(
                                          (n) => `
                                    <div class="lh-inspector-item" data-action="select-node" data-node-id="${escapeHtml(n.id)}">
                                        <div class="lh-inspector-item__name">${escapeHtml(n.name)}</div>
                                        <div class="lh-inspector-item__stmt">${escapeHtml(n.statement)}</div>
                                    </div>
                                `,
                                      )
                                      .join("")
                        }
                    </div>
                </div>
            `;
            return;
        }

        const node = this.snapshot.propositions.find((n) => n.id === this.selectedNodeId);
        if (!node) {
            this.selectedNodeId = null;
            this.renderInspector();
            return;
        }

        const namesById: Record<string, { name: string }> = {};
        for (const n of this.snapshot.propositions) namesById[n.id] = { name: n.name };

        const incomingChains = this.snapshot.chains.filter((c) => c.conclusion === node.id);
        const outgoingChains = this.snapshot.chains.filter((c) => c.premises.includes(node.id));
        const sourceIds = this.snapshot.nodeSessions[node.id] ?? [];
        const isPicked = this.practiceSelection.has(node.id);

        this.inspectorEl.innerHTML = `
            <div class="lh-inspector-section">
                <div class="lh-inspector-header">
                    <span class="lh-badge">${escapeHtml(node.id)}</span>
                    <div class="lh-inspector-actions">
                        <button class="b3-button b3-button--outline" data-action="toggle-practice-node" data-node-id="${escapeHtml(node.id)}">
                            ${isPicked ? "✓ Picked for Practice" : "+ Pick for Practice"}
                        </button>
                        <button class="b3-button b3-button--text" data-action="practice-single-node" data-node-id="${escapeHtml(node.id)}">
                            Practice Now
                        </button>
                    </div>
                </div>
                <div class="lh-inspector-node-name">${escapeHtml(node.name)}</div>
                <div class="lh-inspector-node-stmt">${escapeHtml(node.statement)}</div>
                ${
                    node.aliases.length > 0
                        ? `
                    <div class="lh-inspector-subtitle">Aliases / Phrasings</div>
                    <ul class="lh-inspector-aliases">
                        ${node.aliases.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
                    </ul>
                `
                        : ""
                }
            </div>

            <div class="lh-inspector-section">
                <div class="lh-inspector-subtitle">Derived From (${incomingChains.length})</div>
                ${
                    incomingChains.length === 0
                        ? `<div class="lh-inspector-empty">Foundational / unconditional proposition in graph (no premise chains).</div>`
                        : incomingChains
                              .map(
                                  (c) => `
                            <div class="lh-chain-card">
                                ${escapeHtml(formatChainLine(c, namesById))}
                            </div>
                        `,
                              )
                              .join("")
                }
                <div class="lh-inspector-subtitle" style="margin-top:12px;">Supports / Entails (${outgoingChains.length})</div>
                ${
                    outgoingChains.length === 0
                        ? `<div class="lh-inspector-empty">No downstream conclusions yet.</div>`
                        : outgoingChains
                              .map(
                                  (c) => `
                            <div class="lh-chain-card">
                                ${escapeHtml(formatChainLine(c, namesById))}
                            </div>
                        `,
                              )
                              .join("")
                }
            </div>

            <div class="lh-inspector-section">
                <div class="lh-inspector-subtitle">Provenance (Sessions & SiYuan Notes)</div>
                ${
                    sourceIds.length === 0
                        ? `<div class="lh-inspector-empty">No linked sources.</div>`
                        : sourceIds
                              .map((sid) => {
                                  const chatTitle = this.snapshot.sessions[sid];
                                  if (chatTitle) {
                                      return `<button class="lh-provenance-link" data-action="open-provenance-chat" data-chat-id="${escapeHtml(sid)}">
                                          💬 Session: ${escapeHtml(chatTitle)}
                                      </button>`;
                                  }
                                  const fileLabel = this.snapshot.fileSources[sid] ?? sid;
                                  const docId = this.snapshot.docSources[sid];
                                  if (docId) {
                                      return `<button class="lh-provenance-link" data-action="open-provenance-doc" data-doc-id="${escapeHtml(docId)}">
                                          📄 SiYuan Note: ${escapeHtml(fileLabel)}
                                      </button>`;
                                  }
                                  return `<div class="lh-provenance-static">📄 ${escapeHtml(fileLabel)}</div>`;
                              })
                              .join("")
                }
            </div>

            <div class="lh-inspector-section">
                <button class="b3-button b3-button--cancel" data-action="delete-node" data-node-id="${escapeHtml(node.id)}">
                    Remove Proposition from Graph
                </button>
            </div>
        `;
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
                    <button class="b3-button b3-button--outline" data-modal-close="true">Close</button>
                </div>
                <div class="lh-modal__body">
                    <div class="lh-modal__desc">
                        Select any note from your SiYuan workspace (read-only). LearnHarness will run the <strong>Extractor → Auditor → Merger</strong> pipeline to extract world-facing propositions and reasoning chains into your graph.
                    </div>
                    <input type="text" class="b3-text-field fn__block lh-note-search-input" placeholder="Search your SiYuan notes by title or path..." />
                    <div class="lh-note-search-results">Loading recent notes...</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const inputEl = overlay.querySelector(".lh-note-search-input") as HTMLInputElement;
        const resultsEl = overlay.querySelector(".lh-note-search-results") as HTMLElement;

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
                    <button class="b3-button b3-button--text" data-import-doc-id="${escapeHtml(d.id)}">
                        Extract to Graph
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
                overlay.remove();
                return;
            }
            const importBtn = target.closest("[data-import-doc-id]") as HTMLButtonElement | null;
            if (importBtn) {
                const docId = importBtn.dataset.importDocId;
                if (!docId) return;
                importBtn.disabled = true;
                importBtn.textContent = "Extracting...";
                if (this.toolbarStatusEl) {
                    this.toolbarStatusEl.textContent = "Extracting propositions from SiYuan note...";
                }
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
                        `Extracted ${res.stats.nodes} new proposition(s) and ${res.stats.chains ?? 0} chain(s) from "${res.hPath}"`,
                        4000,
                        "info",
                    );
                    overlay.remove();
                    this.refresh();
                } catch (err: any) {
                    showMessage(`Extraction failed: ${err?.message ?? String(err)}`, 5000, "error");
                    importBtn.disabled = false;
                    importBtn.textContent = "Extract to Graph";
                } finally {
                    if (this.toolbarStatusEl) this.toolbarStatusEl.textContent = "";
                }
            }
        });
    }
}
