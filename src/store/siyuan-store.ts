/**
 * SiYuan Plugin Storage Adapters implementing ChatStore, GraphStore, and SettingsStore.
 * Hydrates in-memory state on plugin onload() via plugin.loadData() and persists
 * asynchronously via plugin.saveData().
 */

import type { Plugin } from "siyuan";
import type {
    ChatKind,
    ChatRecord,
    ChatSettings,
    ChatSummary,
    CoverageEntry,
    GraphChain,
    GraphNode,
    NotesSource,
    PlanTree,
    Position,
    SessionCheckpoint,
} from "../core/contracts";
import { activeProblemOf, danglingQuestionOf, phaseAt3Lh } from "../core/messages";
import {
    DEFAULT_PLUGIN_SETTINGS,
    type ChatStore,
    type GraphStore,
    type PluginSettings,
    type SettingsStore,
} from "../core/ports";
import { randomHex } from "../core/schema";
import { deriveView, getGraph, birthSessionPartition, attachImpToCommunities, MIN_CLUSTER_SIZE } from "../core/graph";
import { incrementalLayout } from "../core/layout";

const STORAGE_CHATS = "learnharness-chats.json";
const STORAGE_GRAPH = "learnharness-graph.json";
const STORAGE_SETTINGS = "learnharness-settings.json";

interface PersistedGraphState {
    nodes: GraphNode[];
    chains: GraphChain[];
    sessions: SessionCheckpoint[];
    coverage: CoverageEntry[];
    sources: NotesSource[];
    positions: Record<string, Position>;
}

export class SiYuanHarnessStores {
    public readonly chatStore: ChatStore;
    public readonly graphStore: GraphStore;
    public readonly settingsStore: SettingsStore;

    private plugin: Plugin;
    private chats = new Map<string, ChatRecord>();
    private graph: PersistedGraphState = {
        nodes: [],
        chains: [],
        sessions: [],
        coverage: [],
        sources: [],
        positions: {},
    };
    private settings: PluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };
    private listeners = new Set<() => void>();

    private chatSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private graphSaveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;

        this.chatStore = {
            listChats: (): ChatSummary[] => {
                const summaries: ChatSummary[] = [];
                for (const rec of this.chats.values()) {
                    const kind: ChatKind = rec.kind ?? "teach";
                    summaries.push({
                        id: rec.id,
                        title: rec.title,
                        createdAt: rec.createdAt,
                        updatedAt: rec.updatedAt,
                        kind,
                        messageCount: rec.messages.length,
                        phase: phaseAt3Lh(rec.messages),
                        pendingQuestion: danglingQuestionOf(rec.messages) !== null,
                        pendingProblem: kind === "practice" && activeProblemOf(rec.messages) !== null,
                        linkedDocId: rec.linkedDocId,
                        linkedDocTitle: rec.linkedDocTitle,
                    });
                }
                return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            },

            getChat: (id: string): ChatRecord | null => {
                const rec = this.chats.get(id);
                if (!rec) return null;
                return structuredClone(rec);
            },

            createChat: (opts = {}): ChatRecord => {
                const now = new Date().toISOString();
                const id = `chat_${Date.now().toString(36)}_${randomHex(4)}`;
                const record: ChatRecord = {
                    id,
                    title: opts.title?.trim() || (opts.kind === "practice" ? "New Practice Session" : "New Learning Session"),
                    createdAt: now,
                    updatedAt: now,
                    messages: [],
                    kind: opts.kind ?? "teach",
                    settings: opts.settings,
                    linkedDocId: opts.linkedDocId,
                    linkedDocTitle: opts.linkedDocTitle,
                    version: 1,
                };
                this.chats.set(id, record);
                this.scheduleChatsSave();
                this.notify();
                return structuredClone(record);
            },

            saveChat: (record: ChatRecord): void => {
                const updated: ChatRecord = {
                    ...structuredClone(record),
                    updatedAt: new Date().toISOString(),
                    version: 1,
                };
                this.chats.set(updated.id, updated);
                this.scheduleChatsSave();
                this.notify();
            },

            saveTree: (id: string, tree: PlanTree): PlanTree => {
                const rec = this.chats.get(id);
                if (!rec) throw new Error(`Chat not found: ${id}`);
                const nextVersion = (rec.tree?.version ?? 0) + 1;
                const savedTree: PlanTree = {
                    nodes: tree.nodes.map((n) => ({ ...n })),
                    edges: tree.edges.map((e) => ({ ...e })),
                    version: nextVersion,
                };
                rec.tree = savedTree;
                rec.updatedAt = new Date().toISOString();
                this.scheduleChatsSave();
                this.notify();
                return structuredClone(savedTree);
            },

            deleteChat: (id: string): boolean => {
                const deleted = this.chats.delete(id);
                if (deleted) {
                    this.scheduleChatsSave();
                    this.notify();
                }
                return deleted;
            },
        };

        this.graphStore = {
            readNodes: () => this.graph.nodes.map((n) => structuredClone(n)),
            readChains: () => this.graph.chains.map((c) => structuredClone(c)),
            readSessions: () => this.graph.sessions.map((s) => ({ ...s })),
            readCoverage: () => this.graph.coverage.map((c) => ({ ...c })),
            readSources: () => this.graph.sources.map((s) => ({ ...s })),
            readPositions: () => ({ ...this.graph.positions }),

            appendNode: (node: GraphNode) => {
                this.graph.nodes.push(structuredClone(node));
                this.scheduleGraphSave();
            },

            appendChain: (chain: GraphChain) => {
                this.graph.chains.push(structuredClone(chain));
                this.scheduleGraphSave();
            },

            appendCheckpoint: (cp: SessionCheckpoint) => {
                const idx = this.graph.sessions.findIndex((s) => s.chatId === cp.chatId);
                if (idx >= 0) this.graph.sessions[idx] = { ...cp };
                else this.graph.sessions.push({ ...cp });
                this.recomputeLayoutPositions();
                this.scheduleGraphSave();
                this.notify();
            },

            appendCoverage: (entry: CoverageEntry) => {
                if (!this.graph.coverage.some((e) => e.chatId === entry.chatId && e.fp === entry.fp)) {
                    this.graph.coverage.push({ ...entry });
                }
                this.recomputeLayoutPositions();
                this.scheduleGraphSave();
                this.notify();
            },

            upsertSource: (source: NotesSource) => {
                const idx = this.graph.sources.findIndex((s) => s.id === source.id);
                if (idx >= 0) this.graph.sources[idx] = { ...source };
                else this.graph.sources.push({ ...source });
                this.scheduleGraphSave();
                this.notify();
            },

            writePositions: (positions: Record<string, Position>) => {
                this.graph.positions = { ...positions };
                this.scheduleGraphSave();
                this.notify();
            },

            rewriteLedgers: (next) => {
                if (next.nodes !== undefined) this.graph.nodes = structuredClone(next.nodes);
                if (next.chains !== undefined) this.graph.chains = structuredClone(next.chains);
                if (next.sessions !== undefined) this.graph.sessions = structuredClone(next.sessions);
                if (next.coverage !== undefined) this.graph.coverage = structuredClone(next.coverage);
                if (next.sources !== undefined) this.graph.sources = structuredClone(next.sources);
                this.scheduleGraphSave();
                this.notify();
            },

            deleteNode: (nodeId: string) => {
                this.graph.nodes = this.graph.nodes.filter((n) => n.id !== nodeId);
                this.graph.chains = this.graph.chains.filter(
                    (c) => c.conclusion !== nodeId && !c.premises.includes(nodeId),
                );
                delete this.graph.positions[nodeId];
                this.recomputeLayoutPositions();
                this.scheduleGraphSave();
                this.notify();
            },
        };

        this.settingsStore = {
            get: (): PluginSettings => ({ ...this.settings }),
            save: (patch: Partial<PluginSettings>): PluginSettings => {
                this.settings = { ...this.settings, ...patch };
                void this.plugin.saveData(STORAGE_SETTINGS, this.settings);
                this.notify();
                return { ...this.settings };
            },
        };
    }

    public subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public notify(): void {
        for (const fn of this.listeners) {
            try {
                fn();
            } catch (err) {
                console.error("[LearnHarness] Store listener error:", err);
            }
        }
    }

    public async hydrate(): Promise<void> {
        try {
            const rawSettings = await this.plugin.loadData(STORAGE_SETTINGS);
            if (rawSettings && typeof rawSettings === "object") {
                this.settings = { ...DEFAULT_PLUGIN_SETTINGS, ...(rawSettings as Partial<PluginSettings>) };
            }
        } catch (err) {
            console.warn("[LearnHarness] Could not load settings, using defaults:", err);
        }

        try {
            const rawChats = await this.plugin.loadData(STORAGE_CHATS);
            if (Array.isArray(rawChats)) {
                this.chats.clear();
                for (const item of rawChats as ChatRecord[]) {
                    if (item && typeof item.id === "string") {
                        this.chats.set(item.id, item);
                    }
                }
            }
        } catch (err) {
            console.warn("[LearnHarness] Could not load chats:", err);
        }

        try {
            const rawGraph = await this.plugin.loadData(STORAGE_GRAPH);
            if (rawGraph && typeof rawGraph === "object") {
                const g = rawGraph as Partial<PersistedGraphState>;
                this.graph = {
                    nodes: Array.isArray(g.nodes) ? g.nodes : [],
                    chains: Array.isArray(g.chains) ? g.chains : [],
                    sessions: Array.isArray(g.sessions) ? g.sessions : [],
                    coverage: Array.isArray(g.coverage) ? g.coverage : [],
                    sources: Array.isArray(g.sources) ? g.sources : [],
                    positions: g.positions && typeof g.positions === "object" ? g.positions : {},
                };
                if (this.graph.nodes.length > 0 && Object.keys(this.graph.positions).length === 0) {
                    this.recomputeLayoutPositions();
                }
            }
        } catch (err) {
            console.warn("[LearnHarness] Could not load graph:", err);
        }
    }

    public recomputeLayoutPositions(): void {
        const derived = getGraph(this.graphStore);
        const view = deriveView(derived);
        if (view.nodes.length === 0) return;

        const communities = birthSessionPartition(derived.nodes)
            .filter((c) => c.members.length >= MIN_CLUSTER_SIZE)
            .map((c) => ({ id: c.id, members: [...c.members] }));
        attachImpToCommunities(communities, derived.nodes, derived.chains);

        const prevMap = new Map<string, Position>(Object.entries(this.graph.positions));
        const nextMap = incrementalLayout(view.nodes, view.edges, prevMap, {
            clusters: communities,
        });
        const nextObj: Record<string, Position> = {};
        for (const [id, pos] of nextMap) {
            nextObj[id] = pos;
        }
        this.graph.positions = nextObj;
    }

    private scheduleChatsSave(): void {
        if (this.chatSaveTimer) clearTimeout(this.chatSaveTimer);
        this.chatSaveTimer = setTimeout(() => {
            this.chatSaveTimer = null;
            const list = Array.from(this.chats.values());
            void this.plugin.saveData(STORAGE_CHATS, list);
        }, 150);
    }

    private scheduleGraphSave(): void {
        if (this.graphSaveTimer) clearTimeout(this.graphSaveTimer);
        this.graphSaveTimer = setTimeout(() => {
            this.graphSaveTimer = null;
            void this.plugin.saveData(STORAGE_GRAPH, this.graph);
        }, 150);
    }

    public async flushAll(): Promise<void> {
        if (this.chatSaveTimer) {
            clearTimeout(this.chatSaveTimer);
            this.chatSaveTimer = null;
        }
        if (this.graphSaveTimer) {
            clearTimeout(this.graphSaveTimer);
            this.graphSaveTimer = null;
        }
        await Promise.all([
            this.plugin.saveData(STORAGE_CHATS, Array.from(this.chats.values())),
            this.plugin.saveData(STORAGE_GRAPH, this.graph),
            this.plugin.saveData(STORAGE_SETTINGS, this.settings),
        ]);
    }
}
