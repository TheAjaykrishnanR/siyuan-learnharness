# SiYuan Plugin Template (Dock Sidebar)

A clean, modular, and reusable starter template for building **SiYuan Note** plugins in TypeScript and SCSS. Out of the box, this template registers a custom icon and button on the SiYuan **Dock** that opens a **Sidebar Window** (`Custom` dock panel on desktop, `MobileCustom` on mobile), complete with plugin settings, persistent storage, i18n localization, and Kernel API integration.

---

## Quick Start & Build Commands

```bash
# 1. Install dependencies
npm install

# 2. Type-check TypeScript sources against ./petal/siyuan.d.ts
npm run typecheck

# 3. Build production bundle into ./dist (unpacked, no zip archive generated)
npm run build

# 4. Watch mode for live development (outputs index.js, index.css, i18n/ in root)
npm run dev
```

### Build Output (`./dist`)
Running `npm run build` compiles and copies all required SiYuan plugin artifacts directly into the `./dist` directory (without creating a `package.zip`):
- `dist/index.js` — Compiled CommonJS2 plugin bundle (`siyuan` externalized)
- `dist/index.css` — Compiled styles from `src/index.scss`
- `dist/plugin.json` — Plugin manifest
- `dist/i18n/*` — Localization JSON files (`en.json`, `en_US.json`, `zh-CN.json`, `zh_CN.json`)
- `dist/icon.png` & `dist/preview.png` — Marketplace / plugin icons
- `dist/README*.md` — Documentation files

To test the built plugin in SiYuan, copy or symlink the contents of `./dist` into `{SiYuan Workspace}/data/plugins/<your-plugin-name>/`, then enable the plugin under **Settings → Marketplace → Downloaded**.

---

## Repository Structure & Reference Directories

```text
siyuan-template/
├── src/
│   ├── index.ts              # Main Plugin class (lifecycle, addIcons, addDock, Setting, storage)
│   ├── sidebar.ts            # SidebarPanel class (Dock sidebar DOM, events, and Kernel API calls)
│   ├── index.scss            # Theme-aware styles using SiYuan --b3-* CSS variables
│   ├── declarations.d.ts     # TypeScript module declarations for *.scss
│   └── i18n/                 # Localization strings (en.json, en_US.json, zh-CN.json, zh_CN.json)
├── petal/                    # [REFERENCE] Official SiYuan Plugin SDK & TypeScript definitions
│   ├── siyuan.d.ts           # Frontend Plugin API types (Plugin, addDock, addTab, Dialog, Menu, Setting, etc.)
│   ├── kernel.d.ts           # Kernel plugin runtime types
│   └── types/
│       ├── index.d.ts        # Core SiYuan runtime models (App, Custom, Dock, Protyle, IBlock, etc.)
│       └── api.d.ts          # Typed Kernel HTTP API routes (APIPOSTRoutes, APIGETRoutes)
├── plugin-sample/            # [REFERENCE] Official SiYuan sample plugin demonstrating all APIs
├── dist/                     # Compiled plugin output produced by `npm run build`
├── plugin.json               # SiYuan plugin manifest
├── package.json              # Dependencies & build scripts ("siyuan": "file:./petal")
├── tsconfig.json             # TypeScript compiler configuration
└── webpack.config.js         # Webpack build config (outputs to ./dist without zipping)
```

> **Note for AI Agents**: Always consult `./petal/siyuan.d.ts` and `./petal/types/api.d.ts` before using any SiYuan API to verify exact method signatures, event names, and HTTP payload types. You can also inspect `./plugin-sample/src/index.ts` for working examples of tabs, dialogs, slash commands, custom blocks, and menus.

---

## Guide for AI Agents Reusing This Template

When creating a new SiYuan plugin from this template, follow this checklist:

### 1. Update Plugin Identity
1. **`plugin.json`**:
   - Change `"name"` to your new plugin's unique package/folder name (must match the directory name in `{workspace}/data/plugins/<name>`).
   - Update `"author"`, `"url"`, `"version"`, `"displayName"`, `"description"`, and `"keywords"`.
2. **`package.json`**:
   - Update `"name"`, `"version"`, and `"description"`.
3. **`src/index.ts`**:
   - Update `DOCK_TYPE`, `ICON_ID`, and `STORAGE_NAME` constants if needed.

### 2. Customize the Dock Button & Sidebar Window
The dock button is registered synchronously inside `onload()` in [`src/index.ts`](./src/index.ts):

```ts
this.addDock({
    config: {
        position: "LeftBottom", // "LeftTop" | "LeftBottom" | "RightTop" | "RightBottom" | "BottomLeft" | "BottomRight"
        size: { width: 260, height: 0 },
        icon: ICON_ID,          // Symbol ID registered via this.addIcons(...) or built-in SiYuan icon ID
        title: String(this.i18n.dockTitle || "Template Sidebar"),
        hotkey: "⌥⌘W",          // Mac-style hotkey notation: ⌥ (Alt), ⇧ (Shift), ⌘ (Ctrl/Cmd)
    },
    data: { plugin: this },
    type: DOCK_TYPE,
    init(dock) { ... },
    resize() { ... },
    update() { ... },
    destroy() { ... },
});
```

- **Important Rule**: `this.addDock(...)`, `this.addTab(...)`, and `this.addStatusBar(...)` **must** be called synchronously inside `onload()` (before any `await`), as required by SiYuan's layout initialization lifecycle.
- **Customizing the Sidebar UI**: Edit [`src/sidebar.ts`](./src/sidebar.ts) (`SidebarPanel`).
  - Keep the desktop `.block__icons` header (which includes the native minimize button `data-type="min"` that SiYuan's dock controller hooks into) and mobile `.toolbar` header.
  - Mount your custom UI (vanilla DOM, React, Vue, Svelte, etc.) inside `this.bodyElement` (`.siyuan-template__sidebar-body`).
  - Always clean up event listeners, timers, or framework roots inside `SidebarPanel.destroy()`.

### 3. Calling SiYuan Kernel HTTP APIs
Use `fetchPost` or `fetchSyncPost` from `"siyuan"` to communicate with the SiYuan Kernel. All routes and payload types are defined in [`./petal/types/api.d.ts`](./petal/types/api.d.ts).

```ts
import { fetchPost, fetchSyncPost } from "siyuan";

// Async/await with fetchSyncPost:
const res = await fetchSyncPost("/api/query/sql", {
    stmt: "SELECT * FROM blocks WHERE type = 'd' LIMIT 10",
});
if (res.code === 0) {
    console.log("Documents:", res.data);
}

// Callback style with fetchPost:
fetchPost("/api/block/insertBlock", {
    dataType: "markdown",
    data: "Hello from plugin!",
    parentID: notebookDocId,
}, (response) => {
    console.log("Inserted block:", response.data);
});
```

- **Critical Data Safety Rule**: Never use Node.js `fs` or Electron APIs to directly read/write files inside SiYuan's `data/` directory, as bypassing the kernel corrupts sync snapshots. Always use:
  - `this.loadData(storageName)` / `this.saveData(storageName, data)` / `this.removeData(storageName)` for plugin settings and private storage (`/data/storage/petal/<plugin-name>/`).
  - `/api/file/getFile`, `/api/file/putFile`, `/api/file/removeFile` for general workspace file access.

### 4. Subscribing to SiYuan Events (`eventBus`)
Use `this.eventBus` in `onload()` and always unsubscribe in `onunload()`. Available events are typed in `IEventBusMap` in [`./petal/siyuan.d.ts`](./petal/siyuan.d.ts):
- `"switch-protyle"` — User switched active editor tab (`detail.protyle`)
- `"loaded-protyle-static"` / `"loaded-protyle-dynamic"` — Editor finished loading block content
- `"click-blockicon"` — Block gutter icon clicked (`detail.menu`, `detail.blockElements`, `detail.protyle`)
- `"click-editortitleicon"` — Document title icon clicked (`detail.menu`, `detail.data`, `detail.protyle`)
- `"open-menu-content"` — Editor context menu opened (`detail.menu`, `detail.range`)
- `"ws-main"` — Kernel WebSocket push message

### 5. Styling with SiYuan Theme Variables
Scope all styles in [`src/index.scss`](./src/index.scss) under your plugin's root class and use SiYuan's native CSS custom properties so your sidebar automatically adapts to light/dark themes and custom community themes:
- Backgrounds: `var(--b3-theme-background)`, `var(--b3-theme-surface)`, `var(--b3-theme-surface-lighter)`
- Text colors: `var(--b3-theme-on-background)`, `var(--b3-theme-on-surface)`, `var(--b3-theme-on-surface-light)`
- Accent/Primary: `var(--b3-theme-primary)`, `var(--b3-theme-on-primary)`
- Borders & Radius: `var(--b3-border-color)`, `var(--b3-border-radius)`
- Native UI classes: `.b3-button`, `.b3-button--outline`, `.b3-button--text`, `.b3-text-field`, `.b3-select`, `.b3-switch`, `.block__icons`, `.block__icon`, `.fn__flex-1`, `.fn__flex-column`, `.fn__none`, `.fn__space`

### 6. Plugin Lifecycle Rules
- `onload()`: Register icons, docks, tabs, commands, slash items, and event listeners synchronously.
- `onLayoutReady()`: Load persisted plugin data (`await this.loadData(...)`), inspect workspace state, or manipulate DOM elements that depend on the main layout being ready.
- `onDataChanged()`: Handle external data sync or updates without requiring a full plugin reload.
- `onunload()`: Remove all event listeners and clean up UI instances. Must complete within SiYuan's 5-second teardown budget.
- `uninstall()`: Clean up persisted plugin files (`await this.removeData(...)`) when the user uninstalls the plugin.
