/**
 * Storage port interfaces (Hexagonal Architecture) for LearnHarness in SiYuan.
 */

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
} from "./contracts";

export type ProviderId = "deepseek" | "gemini" | "custom";

export interface PluginSettings {
    /** Active LLM provider for Prober / Teacher / Practice */
    activeProvider: ProviderId;
    /** DeepSeek configuration */
    deepseekApiKey: string;
    deepseekModel: string;
    deepseekBaseUrl: string;
    /** Google Gemini configuration */
    geminiApiKey: string;
    geminiModel: string;
    geminiBaseUrl: string;
    /** Custom / OpenAI-compatible or SiYuan AI fallback */
    customApiKey: string;
    customModel: string;
    customBaseUrl: string;
    useSiyuanAiFallback: boolean;
    /** Cached available models fetched from API keys */
    cachedDeepseekModels?: string[];
    cachedGeminiModels?: string[];
    cachedCustomModels?: string[];
    /** Pedagogical preferences */
    quizzingMechanic: "quiz" | "explain";
    /** Proactive read-only SiYuan note search during probing & teaching */
    proactiveSiyuanNoteSearch: boolean;
    /** Enable Knowledge Graph tools (list_sessions, list_propositions) */
    graphToolsEnabled: boolean;
    /** Token threshold of uncovered teacher prose before auto-extracting into graph */
    extractionChunkTokens: number;
    /** Auto-extract teacher prose in background */
    autoExtractGraph: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
    activeProvider: "deepseek",
    deepseekApiKey: "",
    deepseekModel: "deepseek-chat",
    deepseekBaseUrl: "https://api.deepseek.com/v1",
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    customApiKey: "",
    customModel: "gpt-4o",
    customBaseUrl: "https://api.openai.com/v1",
    useSiyuanAiFallback: true,
    cachedDeepseekModels: ["deepseek-chat", "deepseek-reasoner"],
    cachedGeminiModels: [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
    ],
    cachedCustomModels: [],
    quizzingMechanic: "quiz",
    proactiveSiyuanNoteSearch: true,
    graphToolsEnabled: true,
    extractionChunkTokens: 2048,
    autoExtractGraph: true,
};

export interface ChatStore {
    listChats(): ChatSummary[];
    getChat(id: string): ChatRecord | null;
    createChat(opts?: {
        title?: string;
        kind?: ChatKind;
        settings?: ChatSettings;
        linkedDocId?: string;
        linkedDocTitle?: string;
    }): ChatRecord;
    saveChat(record: ChatRecord): void;
    saveTree(id: string, tree: PlanTree): PlanTree;
    deleteChat(id: string): boolean;
}

export interface GraphStore {
    readNodes(): GraphNode[];
    readChains(): GraphChain[];
    readSessions(): SessionCheckpoint[];
    readCoverage(): CoverageEntry[];
    readSources(): NotesSource[];
    readPositions(): Record<string, Position>;
    appendNode(node: GraphNode): void;
    appendChain(chain: GraphChain): void;
    appendCheckpoint(cp: SessionCheckpoint): void;
    appendCoverage(entry: CoverageEntry): void;
    upsertSource(source: NotesSource): void;
    writePositions(positions: Record<string, Position>): void;
    rewriteLedgers(next: {
        nodes?: GraphNode[];
        chains?: GraphChain[];
        sessions?: SessionCheckpoint[];
        coverage?: CoverageEntry[];
        sources?: NotesSource[];
    }): void;
    deleteNode(nodeId: string): void;
}

export interface SettingsStore {
    get(): PluginSettings;
    save(patch: Partial<PluginSettings>): PluginSettings;
}
