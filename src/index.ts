import {
    getFrontend,
    openTab,
    Plugin,
    Setting,
    showMessage,
} from "siyuan";
import { SessionRunner } from "./agent/session-runner";
import type { ProviderId } from "./core/ports";
import "./index.scss";
import { SidebarView } from "./sidebar";
import { SiYuanHarnessStores } from "./store/siyuan-store";

const DOCK_TYPE = "learnharness_sidebar_dock";

const LEARNHARNESS_ICON_SVG = `<symbol id="iconLearnHarness" viewBox="0 0 24 24">
    <path d="M12 3L1 9l11 6 9-4.91V17h2V9M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82Z"/>
</symbol>`;

export default class LearnHarnessPlugin extends Plugin {
    private isMobile = false;
    private stores!: SiYuanHarnessStores;
    private runner!: SessionRunner;
    private sidebarView?: SidebarView;

    private boundDocTreeMenu = this.onDocTreeMenu.bind(this);
    private boundEditorTitleMenu = this.onEditorTitleMenu.bind(this);

    async onload() {
        const frontEnd = getFrontend();
        this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";

        this.addIcons(LEARNHARNESS_ICON_SVG);

        // 1. Initialize stores & session runner
        this.stores = new SiYuanHarnessStores(this);
        await this.stores.hydrate();
        this.runner = new SessionRunner({
            chatStore: this.stores.chatStore,
            graphStore: this.stores.graphStore,
            settingsStore: this.stores.settingsStore,
        });

        // 2. Register the single unified Docked Chat View (designed for split-screen alongside SiYuan notes)
        this.addDock({
            config: {
                position: "RightTop",
                size: { width: 420, height: 0 },
                icon: "iconLearnHarness",
                title: "LearnHarness",
                hotkey: "⌥⇧L",
            },
            data: {},
            type: DOCK_TYPE,
            init: (dock) => {
                this.sidebarView = new SidebarView(
                    dock.element as HTMLElement,
                    this.stores,
                    this.runner,
                    {
                        app: this.app,
                        onOpenSettings: () => this.openSetting(),
                        onOpenSiyuanDoc: (docId) => this.openSiyuanDocument(docId),
                        onPreviewSiyuanBlock: (blockId, targetEl) => this.previewSiyuanBlock(blockId, targetEl),
                    },
                );
            },
            destroy: () => {
                this.sidebarView?.destroy();
                this.sidebarView = undefined;
            },
        });

        // 3. Register Document Tree & Editor Title Context Menus
        this.eventBus.on("open-menu-doctree", this.boundDocTreeMenu);
        this.eventBus.on("click-editortitleicon", this.boundEditorTitleMenu);

        // 4. Build Settings Dialog
        this.buildSettingDialog();
    }

    onunload() {
        this.eventBus.off("open-menu-doctree", this.boundDocTreeMenu);
        this.eventBus.off("click-editortitleicon", this.boundEditorTitleMenu);
        this.sidebarView?.destroy();
        void this.stores.flushAll();
    }

    private openSiyuanDocument(docId: string): void {
        if (!docId) return;
        openTab({
            app: this.app,
            doc: {
                id: docId,
            },
        });
    }

    private previewSiyuanBlock(blockId: string, targetElement: HTMLElement): void {
        if (!blockId) return;
        try {
            this.addFloatLayer({
                refDefs: [{ refID: blockId }],
                targetElement,
                isBacklink: false,
            });
        } catch {
            // Ignore if float layer cannot be created
        }
    }

    private onDocTreeMenu(e: CustomEvent<any>): void {
        const elements: NodeListOf<HTMLElement> | undefined = e.detail?.elements;
        if (!elements || elements.length === 0) return;
        const firstEl = elements[0]!;
        const docId = firstEl.dataset.nodeId;
        if (!docId) return;

        e.detail.menu.addItem({
            icon: "iconLearnHarness",
            label: "Insert Note in LearnHarness Chat",
            click: () => {
                if (this.sidebarView) {
                    void this.sidebarView.insertBlockIntoInput(docId);
                } else {
                    showMessage("Open the LearnHarness dock from the right sidebar first.", 3000, "info");
                }
            },
        });

        e.detail.menu.addItem({
            icon: "iconLearnHarness",
            label: "Learn this Note in LearnHarness",
            click: () => {
                if (this.sidebarView) {
                    void this.sidebarView.startSessionFromSiyuanNote(docId);
                } else {
                    showMessage("Open the LearnHarness dock from the right sidebar first.", 3000, "info");
                }
            },
        });
    }

    private onEditorTitleMenu(e: CustomEvent<any>): void {
        const docId: string | undefined = e.detail?.data?.id;
        if (!docId) return;

        e.detail.menu.addItem({
            icon: "iconLearnHarness",
            label: "Insert Note in LearnHarness Chat",
            click: () => {
                if (this.sidebarView) {
                    void this.sidebarView.insertBlockIntoInput(docId);
                } else {
                    showMessage("Open the LearnHarness dock from the right sidebar first.", 3000, "info");
                }
            },
        });

        e.detail.menu.addItem({
            icon: "iconLearnHarness",
            label: "Learn this Note in LearnHarness",
            click: () => {
                if (this.sidebarView) {
                    void this.sidebarView.startSessionFromSiyuanNote(docId);
                } else {
                    showMessage("Open the LearnHarness dock from the right sidebar first.", 3000, "info");
                }
            },
        });
    }

    private buildSettingDialog(): void {
        let providerSelect!: HTMLSelectElement;
        let deepseekKeyInput!: HTMLInputElement;
        let deepseekModelInput!: HTMLInputElement;
        let geminiKeyInput!: HTMLInputElement;
        let geminiModelInput!: HTMLInputElement;
        let mechanicSelect!: HTMLSelectElement;
        let proactiveCheck!: HTMLInputElement;
        let autoExtractCheck!: HTMLInputElement;

        this.setting = new Setting({
            confirmCallback: () => {
                this.stores.settingsStore.save({
                    activeProvider: (providerSelect.value as ProviderId) || "deepseek",
                    deepseekApiKey: deepseekKeyInput.value.trim(),
                    deepseekModel: deepseekModelInput.value.trim() || "deepseek-chat",
                    geminiApiKey: geminiKeyInput.value.trim(),
                    geminiModel: geminiModelInput.value.trim() || "gemini-2.5-flash",
                    quizzingMechanic: mechanicSelect.value === "explain" ? "explain" : "quiz",
                    proactiveSiyuanNoteSearch: proactiveCheck.checked,
                    autoExtractGraph: autoExtractCheck.checked,
                });
                showMessage("LearnHarness settings saved", 2500, "info");
            },
        });

        this.setting.addItem({
            title: "Active LLM Provider",
            description: "Primary provider for Prober, Teacher, Practitioner, and Knowledge Graph Extraction",
            createActionElement: () => {
                providerSelect = document.createElement("select");
                providerSelect.className = "b3-select fn__flex-center fn__size200";
                const cur = this.stores.settingsStore.get().activeProvider;
                providerSelect.innerHTML = `
                    <option value="deepseek" ${cur === "deepseek" ? "selected" : ""}>DeepSeek API</option>
                    <option value="gemini" ${cur === "gemini" ? "selected" : ""}>Google Gemini API</option>
                    <option value="custom" ${cur === "custom" ? "selected" : ""}>SiYuan Built-in AI / Custom</option>
                `;
                return providerSelect;
            },
        });

        this.setting.addItem({
            title: "DeepSeek API Key",
            description: "Your DeepSeek API key (https://api.deepseek.com)",
            createActionElement: () => {
                deepseekKeyInput = document.createElement("input");
                deepseekKeyInput.type = "password";
                deepseekKeyInput.className = "b3-text-field fn__flex-center fn__size200";
                deepseekKeyInput.placeholder = "sk-...";
                deepseekKeyInput.value = this.stores.settingsStore.get().deepseekApiKey;
                return deepseekKeyInput;
            },
        });

        this.setting.addItem({
            title: "DeepSeek Model",
            description: "e.g., deepseek-chat (V3) or deepseek-reasoner (R1)",
            createActionElement: () => {
                deepseekModelInput = document.createElement("input");
                deepseekModelInput.type = "text";
                deepseekModelInput.className = "b3-text-field fn__flex-center fn__size200";
                deepseekModelInput.value = this.stores.settingsStore.get().deepseekModel || "deepseek-chat";
                return deepseekModelInput;
            },
        });

        this.setting.addItem({
            title: "Google Gemini API Key",
            description: "Your Gemini API key from Google AI Studio",
            createActionElement: () => {
                geminiKeyInput = document.createElement("input");
                geminiKeyInput.type = "password";
                geminiKeyInput.className = "b3-text-field fn__flex-center fn__size200";
                geminiKeyInput.placeholder = "AIza...";
                geminiKeyInput.value = this.stores.settingsStore.get().geminiApiKey;
                return geminiKeyInput;
            },
        });

        this.setting.addItem({
            title: "Google Gemini Model",
            description: "e.g., gemini-2.5-flash or gemini-2.5-pro",
            createActionElement: () => {
                geminiModelInput = document.createElement("input");
                geminiModelInput.type = "text";
                geminiModelInput.className = "b3-text-field fn__flex-center fn__size200";
                geminiModelInput.value = this.stores.settingsStore.get().geminiModel || "gemini-2.5-flash";
                return geminiModelInput;
            },
        });

        this.setting.addItem({
            title: "Quizzing Mechanic",
            description: "Multiple-choice (probe / quiz) or Free-recall in your own words (recall / explain)",
            createActionElement: () => {
                mechanicSelect = document.createElement("select");
                mechanicSelect.className = "b3-select fn__flex-center fn__size200";
                const cur = this.stores.settingsStore.get().quizzingMechanic;
                mechanicSelect.innerHTML = `
                    <option value="quiz" ${cur === "quiz" ? "selected" : ""}>Multiple Choice (probe / quiz)</option>
                    <option value="explain" ${cur === "explain" ? "selected" : ""}>Free Recall (recall / explain)</option>
                `;
                return mechanicSelect;
            },
        });

        this.setting.addItem({
            title: "Proactive Read-Only SiYuan Note Discovery",
            description:
                "Automatically search your existing SiYuan notes (read-only) when starting a topic so the Prober knows what you already know",
            createActionElement: () => {
                proactiveCheck = document.createElement("input");
                proactiveCheck.type = "checkbox";
                proactiveCheck.className = "b3-switch fn__flex-center";
                proactiveCheck.checked = this.stores.settingsStore.get().proactiveSiyuanNoteSearch;
                return proactiveCheck;
            },
        });

        this.setting.addItem({
            title: "Auto-Extract Sessions to Knowledge Graph",
            description: "Automatically extract world-facing propositions & reasoning chains from teaching sessions",
            createActionElement: () => {
                autoExtractCheck = document.createElement("input");
                autoExtractCheck.type = "checkbox";
                autoExtractCheck.className = "b3-switch fn__flex-center";
                autoExtractCheck.checked = this.stores.settingsStore.get().autoExtractGraph;
                return autoExtractCheck;
            },
        });
    }
}
