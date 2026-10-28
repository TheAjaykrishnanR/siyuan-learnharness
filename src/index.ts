import {
    getFrontend,
    openTab,
    Plugin,
    Setting,
    showMessage,
} from "siyuan";
import { fetchAvailableModels } from "./agent/llm-client";
import { SessionRunner } from "./agent/session-runner";
import type { ProviderId } from "./core/ports";
import "./index.scss";
import { SidebarView } from "./sidebar";
import { SiYuanHarnessStores } from "./store/siyuan-store";
import { escapeHtml } from "./ui/markdown";

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
        const initial = this.stores.settingsStore.get();
        let currentProvider: ProviderId = initial.activeProvider;
        let selectedProviderTab: ProviderId = initial.activeProvider;
        let activeMainTab: "providers" | "preferences" = "providers";

        let deepseekApiKey = initial.deepseekApiKey;
        let deepseekModel = initial.deepseekModel || "deepseek-chat";
        let deepseekModels = initial.cachedDeepseekModels?.length
            ? [...initial.cachedDeepseekModels]
            : ["deepseek-chat", "deepseek-reasoner"];

        let geminiApiKey = initial.geminiApiKey;
        let geminiModel = initial.geminiModel || "gemini-2.5-flash";
        let geminiModels = initial.cachedGeminiModels?.length
            ? [...initial.cachedGeminiModels]
            : [
                  "gemini-2.5-flash",
                  "gemini-2.5-pro",
                  "gemini-2.0-flash",
                  "gemini-2.0-flash-lite",
                  "gemini-1.5-flash",
                  "gemini-1.5-pro",
              ];

        let customApiKey = initial.customApiKey || "";
        let customBaseUrl = initial.customBaseUrl || "";
        let customModel = initial.customModel || "";
        let customModels = initial.cachedCustomModels?.length ? [...initial.cachedCustomModels] : [];

        let quizzingMechanic = initial.quizzingMechanic || "quiz";
        let proactiveSiyuanNoteSearch = initial.proactiveSiyuanNoteSearch;
        let autoExtractGraph = initial.autoExtractGraph;

        const fetchStatus: Record<ProviderId, { text: string; type: "loading" | "success" | "error" | "" }> = {
            deepseek: { text: "", type: "" },
            gemini: { text: "", type: "" },
            custom: { text: "", type: "" },
        };

        const container = document.createElement("div");
        container.className = "lh-settings-view";

        const renderModelOptions = (models: string[], selected: string) => {
            const isCustom = !models.includes(selected);
            const options = models.map((m) => {
                let label = m;
                if (m === "deepseek-chat") label = "deepseek-chat (V3 - Fast & recommended)";
                else if (m === "deepseek-reasoner") label = "deepseek-reasoner (R1 - Deep Thinking)";
                else if (m === "gemini-2.5-flash") label = "gemini-2.5-flash (Fast & recommended)";
                else if (m === "gemini-2.5-pro") label = "gemini-2.5-pro (High intelligence)";
                return `<option value="${escapeHtml(m)}" ${m === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
            });
            options.push(`<option value="__custom__" ${isCustom ? "selected" : ""}>Custom model ID...</option>`);
            return options.join("");
        };

        const renderView = () => {
            const isProvidersTab = activeMainTab === "providers";

            container.innerHTML = `
                <div class="lh-settings-nav">
                    <button type="button" class="lh-nav-tab ${isProvidersTab ? "lh-nav-tab--active" : ""}" data-nav="providers">
                        🤖 LLM Providers
                    </button>
                    <button type="button" class="lh-nav-tab ${!isProvidersTab ? "lh-nav-tab--active" : ""}" data-nav="preferences">
                        🎓 Learning Preferences
                    </button>
                </div>

                ${
                    isProvidersTab
                        ? `
                    <div class="lh-provider-subnav">
                        <button type="button" class="lh-provider-subtab ${
                            selectedProviderTab === "deepseek" ? "lh-provider-subtab--active" : ""
                        }" data-ptab="deepseek">DeepSeek</button>
                        <button type="button" class="lh-provider-subtab ${
                            selectedProviderTab === "gemini" ? "lh-provider-subtab--active" : ""
                        }" data-ptab="gemini">Google Gemini</button>
                        <button type="button" class="lh-provider-subtab ${
                            selectedProviderTab === "custom" ? "lh-provider-subtab--active" : ""
                        }" data-ptab="custom">Custom / SiYuan</button>
                    </div>

                    ${
                        selectedProviderTab === "deepseek"
                            ? `
                        <div class="lh-provider-card">
                            <div class="lh-provider-card__header">
                                <div class="lh-provider-card__title-group">
                                    <span class="lh-provider-card__title">DeepSeek API</span>
                                    ${
                                        currentProvider === "deepseek"
                                            ? `<span class="lh-provider-card__active-badge">● Active Provider</span>`
                                            : ""
                                    }
                                </div>
                                ${
                                    currentProvider !== "deepseek"
                                        ? `<button type="button" class="b3-button b3-button--outline" data-action="set-active" data-provider="deepseek">Set as Active</button>`
                                        : ""
                                }
                            </div>

                            <div class="lh-setting-field">
                                <div class="lh-setting-field__label-row">
                                    <label class="lh-setting-field__label">DeepSeek API Key</label>
                                    <a class="lh-setting-field__link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">Get API Key ↗</a>
                                </div>
                                <div class="lh-key-input-wrap">
                                    <input type="password" class="b3-text-field fn__block" id="lh-deepseek-key" placeholder="sk-..." value="${escapeHtml(
                                        deepseekApiKey,
                                    )}" />
                                    <button type="button" class="b3-button b3-button--text" data-action="toggle-pwd" data-target="lh-deepseek-key">Show</button>
                                </div>
                                <span class="lh-setting-field__desc">Stored locally in your SiYuan data directory.</span>
                            </div>

                            <div class="lh-setting-field">
                                <div class="lh-setting-field__label-row">
                                    <label class="lh-setting-field__label">Model</label>
                                    <button type="button" class="lh-fetch-btn" data-action="fetch-models" data-provider="deepseek">↻ Fetch Models</button>
                                </div>
                                <div id="lh-deepseek-status" class="lh-fetch-status ${fetchStatus.deepseek.type ? `lh-fetch-status--${fetchStatus.deepseek.type}` : ""}">${escapeHtml(fetchStatus.deepseek.text)}</div>
                                <select class="b3-select fn__block" id="lh-deepseek-model-select">
                                    ${renderModelOptions(deepseekModels, deepseekModel)}
                                </select>
                                <input type="text" class="b3-text-field fn__block" id="lh-deepseek-model-custom" placeholder="Custom model name" value="${escapeHtml(
                                    deepseekModel,
                                )}" style="display: ${
                                  !deepseekModels.includes(deepseekModel) ? "block" : "none"
                              }; margin-top: 6px;" />
                            </div>
                        </div>
                    `
                            : selectedProviderTab === "gemini"
                              ? `
                        <div class="lh-provider-card">
                            <div class="lh-provider-card__header">
                                <div class="lh-provider-card__title-group">
                                    <span class="lh-provider-card__title">Google Gemini API</span>
                                    ${
                                        currentProvider === "gemini"
                                            ? `<span class="lh-provider-card__active-badge">● Active Provider</span>`
                                            : ""
                                    }
                                </div>
                                ${
                                    currentProvider !== "gemini"
                                        ? `<button type="button" class="b3-button b3-button--outline" data-action="set-active" data-provider="gemini">Set as Active</button>`
                                        : ""
                                }
                            </div>

                            <div class="lh-setting-field">
                                <div class="lh-setting-field__label-row">
                                    <label class="lh-setting-field__label">Gemini API Key</label>
                                    <a class="lh-setting-field__link" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get API Key ↗</a>
                                </div>
                                <div class="lh-key-input-wrap">
                                    <input type="password" class="b3-text-field fn__block" id="lh-gemini-key" placeholder="AIza..." value="${escapeHtml(
                                        geminiApiKey,
                                    )}" />
                                    <button type="button" class="b3-button b3-button--text" data-action="toggle-pwd" data-target="lh-gemini-key">Show</button>
                                </div>
                                <span class="lh-setting-field__desc">Stored locally in your SiYuan data directory.</span>
                            </div>

                            <div class="lh-setting-field">
                                <div class="lh-setting-field__label-row">
                                    <label class="lh-setting-field__label">Model</label>
                                    <button type="button" class="lh-fetch-btn" data-action="fetch-models" data-provider="gemini">↻ Fetch Models</button>
                                </div>
                                <div id="lh-gemini-status" class="lh-fetch-status ${fetchStatus.gemini.type ? `lh-fetch-status--${fetchStatus.gemini.type}` : ""}">${escapeHtml(fetchStatus.gemini.text)}</div>
                                <select class="b3-select fn__block" id="lh-gemini-model-select">
                                    ${renderModelOptions(geminiModels, geminiModel)}
                                </select>
                                <input type="text" class="b3-text-field fn__block" id="lh-gemini-model-custom" placeholder="Custom model name" value="${escapeHtml(
                                    geminiModel,
                                )}" style="display: ${
                                  !geminiModels.includes(geminiModel) ? "block" : "none"
                              }; margin-top: 6px;" />
                            </div>
                        </div>
                    `
                              : `
                        <div class="lh-provider-card">
                            <div class="lh-provider-card__header">
                                <div class="lh-provider-card__title-group">
                                    <span class="lh-provider-card__title">Custom / SiYuan Built-in AI</span>
                                    ${
                                        currentProvider === "custom"
                                            ? `<span class="lh-provider-card__active-badge">● Active Provider</span>`
                                            : ""
                                    }
                                </div>
                                ${
                                    currentProvider !== "custom"
                                        ? `<button type="button" class="b3-button b3-button--outline" data-action="set-active" data-provider="custom">Set as Active</button>`
                                        : ""
                                }
                            </div>

                            <div class="lh-setting-field">
                                <label class="lh-setting-field__label">API Base URL / Endpoint (Optional)</label>
                                <input type="text" class="b3-text-field fn__block" id="lh-custom-endpoint" placeholder="https://api.openai.com/v1" value="${escapeHtml(
                                    customBaseUrl,
                                )}" />
                            </div>

                            <div class="lh-setting-field">
                                <label class="lh-setting-field__label">API Key</label>
                                <div class="lh-key-input-wrap">
                                    <input type="password" class="b3-text-field fn__block" id="lh-custom-key" placeholder="Leave empty to use SiYuan's global OpenAI config" value="${escapeHtml(
                                        customApiKey,
                                    )}" />
                                    <button type="button" class="b3-button b3-button--text" data-action="toggle-pwd" data-target="lh-custom-key">Show</button>
                                </div>
                            </div>

                            <div class="lh-setting-field">
                                <div class="lh-setting-field__label-row">
                                    <label class="lh-setting-field__label">Model Name</label>
                                    <button type="button" class="lh-fetch-btn" data-action="fetch-models" data-provider="custom">↻ Fetch Models</button>
                                </div>
                                <div id="lh-custom-status" class="lh-fetch-status ${fetchStatus.custom.type ? `lh-fetch-status--${fetchStatus.custom.type}` : ""}">${escapeHtml(fetchStatus.custom.text)}</div>
                                ${
                                    customModels.length > 0
                                        ? `
                                    <select class="b3-select fn__block" id="lh-custom-model-select">
                                        ${renderModelOptions(customModels, customModel)}
                                    </select>
                                    <input type="text" class="b3-text-field fn__block" id="lh-custom-model-custom" placeholder="Custom model name" value="${escapeHtml(
                                        customModel,
                                    )}" style="display: ${
                                      !customModels.includes(customModel) ? "block" : "none"
                                  }; margin-top: 6px;" />
                                `
                                        : `
                                    <input type="text" class="b3-text-field fn__block" id="lh-custom-model" placeholder="gpt-4o-mini" value="${escapeHtml(
                                        customModel,
                                    )}" />
                                `
                                }
                            </div>
                        </div>
                    `
                    }
                `
                        : `
                    <div class="lh-pref-card">
                        <div class="lh-pref-row">
                            <div class="lh-pref-row__info">
                                <div class="lh-pref-row__title">Quizzing Mechanic</div>
                                <div class="lh-pref-row__desc">Choose between Multiple Choice options (probe & quiz) or testing free recall in your own words (recall & explain).</div>
                            </div>
                            <select class="b3-select fn__size160" id="lh-pref-mechanic">
                                <option value="quiz" ${quizzingMechanic === "quiz" ? "selected" : ""}>Multiple Choice</option>
                                <option value="explain" ${quizzingMechanic === "explain" ? "selected" : ""}>Free Recall</option>
                            </select>
                        </div>

                        <div class="lh-pref-row">
                            <div class="lh-pref-row__info">
                                <div class="lh-pref-row__title">Proactive Note Personalization</div>
                                <div class="lh-pref-row__desc">Automatically search your existing SiYuan notes on a topic (read-only) so Prober and Teacher know what you already know.</div>
                            </div>
                            <input type="checkbox" class="b3-switch" id="lh-pref-proactive" ${
                                proactiveSiyuanNoteSearch ? "checked" : ""
                            } />
                        </div>

                        <div class="lh-pref-row">
                            <div class="lh-pref-row__info">
                                <div class="lh-pref-row__title">Knowledge Graph Auto-Extraction</div>
                                <div class="lh-pref-row__desc">Automatically extract propositions & reasoning chains from teaching steps into your local Knowledge Graph.</div>
                            </div>
                            <input type="checkbox" class="b3-switch" id="lh-pref-extract" ${
                                autoExtractGraph ? "checked" : ""
                            } />
                        </div>
                    </div>
                `
                }
            `;
        };

        const syncInputsToMemory = () => {
            const dsKey = container.querySelector("#lh-deepseek-key") as HTMLInputElement | null;
            if (dsKey) deepseekApiKey = dsKey.value.trim();
            const dsSel = container.querySelector("#lh-deepseek-model-select") as HTMLSelectElement | null;
            const dsCustom = container.querySelector("#lh-deepseek-model-custom") as HTMLInputElement | null;
            if (dsSel) {
                deepseekModel = dsSel.value === "__custom__" ? dsCustom?.value.trim() || "" : dsSel.value;
            }

            const gmKey = container.querySelector("#lh-gemini-key") as HTMLInputElement | null;
            if (gmKey) geminiApiKey = gmKey.value.trim();
            const gmSel = container.querySelector("#lh-gemini-model-select") as HTMLSelectElement | null;
            const gmCustom = container.querySelector("#lh-gemini-model-custom") as HTMLInputElement | null;
            if (gmSel) {
                geminiModel = gmSel.value === "__custom__" ? gmCustom?.value.trim() || "" : gmSel.value;
            }

            const cKey = container.querySelector("#lh-custom-key") as HTMLInputElement | null;
            if (cKey) customApiKey = cKey.value.trim();
            const cEp = container.querySelector("#lh-custom-endpoint") as HTMLInputElement | null;
            if (cEp) customBaseUrl = cEp.value.trim();
            const cSel = container.querySelector("#lh-custom-model-select") as HTMLSelectElement | null;
            const cCustom = container.querySelector("#lh-custom-model-custom") as HTMLInputElement | null;
            if (cSel) {
                customModel = cSel.value === "__custom__" ? cCustom?.value.trim() || "" : cSel.value;
            } else {
                const cModel = container.querySelector("#lh-custom-model") as HTMLInputElement | null;
                if (cModel) customModel = cModel.value.trim();
            }

            const mech = container.querySelector("#lh-pref-mechanic") as HTMLSelectElement | null;
            if (mech) quizzingMechanic = mech.value === "explain" ? "explain" : "quiz";
            const pro = container.querySelector("#lh-pref-proactive") as HTMLInputElement | null;
            if (pro) proactiveSiyuanNoteSearch = pro.checked;
            const ext = container.querySelector("#lh-pref-extract") as HTMLInputElement | null;
            if (ext) autoExtractGraph = ext.checked;
        };

        const handleFetchModels = async (provider: ProviderId) => {
            syncInputsToMemory();
            let key = "";
            let base = "";

            if (provider === "deepseek") {
                key = deepseekApiKey;
            } else if (provider === "gemini") {
                key = geminiApiKey;
            } else {
                key = customApiKey;
                base = customBaseUrl;
                if (!key && initial.useSiyuanAiFallback) {
                    const syOpenAI = (window as any)?.siyuan?.config?.ai?.openAI;
                    if (syOpenAI?.apiKey) key = String(syOpenAI.apiKey).trim();
                    if (!base && syOpenAI?.apiBaseURL) base = String(syOpenAI.apiBaseURL).trim();
                }
            }

            if (!key && provider !== "custom") {
                fetchStatus[provider] = { text: "Please enter an API key first.", type: "error" };
                renderView();
                return;
            }

            fetchStatus[provider] = { text: "Fetching models from API key...", type: "loading" };
            renderView();

            try {
                const fetched = await fetchAvailableModels(provider, key, base);
                const ids = fetched.map((m) => m.id);
                if (ids.length === 0) throw new Error("No models returned for this key.");

                if (provider === "deepseek") {
                    deepseekModels = ids;
                    if (!deepseekModels.includes(deepseekModel)) {
                        deepseekModel = deepseekModels[0];
                    }
                } else if (provider === "gemini") {
                    geminiModels = ids;
                    if (!geminiModels.includes(geminiModel)) {
                        geminiModel = geminiModels[0];
                    }
                } else {
                    customModels = ids;
                    if (!customModel && customModels.length > 0) {
                        customModel = customModels[0];
                    }
                }

                // Cache to settings store
                this.stores.settingsStore.save({
                    cachedDeepseekModels: deepseekModels,
                    cachedGeminiModels: geminiModels,
                    cachedCustomModels: customModels,
                    deepseekModel,
                    geminiModel,
                    customModel,
                });

                fetchStatus[provider] = {
                    text: `✓ Retrieved ${ids.length} models from key`,
                    type: "success",
                };
            } catch (err: any) {
                fetchStatus[provider] = {
                    text: `⚠ ${err?.message || "Failed to fetch models"}`,
                    type: "error",
                };
            }
            renderView();
        };

        container.addEventListener("input", () => syncInputsToMemory());
        container.addEventListener("change", (e) => {
            const target = e.target as HTMLElement;
            if (target.id === "lh-deepseek-model-select") {
                const sel = target as HTMLSelectElement;
                const customEl = container.querySelector("#lh-deepseek-model-custom") as HTMLElement | null;
                if (customEl) customEl.style.display = sel.value === "__custom__" ? "block" : "none";
            } else if (target.id === "lh-gemini-model-select") {
                const sel = target as HTMLSelectElement;
                const customEl = container.querySelector("#lh-gemini-model-custom") as HTMLElement | null;
                if (customEl) customEl.style.display = sel.value === "__custom__" ? "block" : "none";
            } else if (target.id === "lh-custom-model-select") {
                const sel = target as HTMLSelectElement;
                const customEl = container.querySelector("#lh-custom-model-custom") as HTMLElement | null;
                if (customEl) customEl.style.display = sel.value === "__custom__" ? "block" : "none";
            }
            syncInputsToMemory();
        });

        container.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
            if (!btn) return;
            syncInputsToMemory();

            if (btn.dataset.nav) {
                activeMainTab = btn.dataset.nav as any;
                renderView();
            } else if (btn.dataset.ptab) {
                selectedProviderTab = btn.dataset.ptab as any;
                renderView();
            } else if (btn.dataset.action === "set-active" && btn.dataset.provider) {
                currentProvider = btn.dataset.provider as ProviderId;
                renderView();
            } else if (btn.dataset.action === "toggle-pwd" && btn.dataset.target) {
                const input = container.querySelector(`#${btn.dataset.target}`) as HTMLInputElement | null;
                if (input) {
                    const isPwd = input.type === "password";
                    input.type = isPwd ? "text" : "password";
                    btn.textContent = isPwd ? "Hide" : "Show";
                }
            } else if (btn.dataset.action === "fetch-models" && btn.dataset.provider) {
                void handleFetchModels(btn.dataset.provider as ProviderId);
            }
        });

        renderView();

        this.setting = new Setting({
            width: "660px",
            height: "520px",
            confirmCallback: () => {
                syncInputsToMemory();
                this.stores.settingsStore.save({
                    activeProvider: currentProvider,
                    deepseekApiKey,
                    deepseekModel: deepseekModel || "deepseek-chat",
                    geminiApiKey,
                    geminiModel: geminiModel || "gemini-2.5-flash",
                    customApiKey,
                    customBaseUrl,
                    customModel,
                    cachedDeepseekModels: deepseekModels,
                    cachedGeminiModels: geminiModels,
                    cachedCustomModels: customModels,
                    quizzingMechanic,
                    proactiveSiyuanNoteSearch,
                    autoExtractGraph,
                });
                showMessage("LearnHarness settings saved", 2500, "info");
            },
        });

        this.setting.addItem({
            title: "",
            direction: "column",
            createActionElement: () => container,
        });
    }
}
