# 思源笔记插件模板（Dock 侧边栏）

这是一个结构清晰、模块化、可复用的 **SiYuan Note（思源笔记）** TypeScript + SCSS 插件开发模板。模板默认在思源停靠栏（Dock）上注册自定义图标按钮，点击后打开侧边栏窗口（桌面端 `Custom` 面板 / 移动端 `MobileCustom` 面板），并内置了插件设置面板、持久化存储、多语言国际化（i18n）以及内核 API 调用示例。

## 快速开始与构建命令

```bash
# 1. 安装依赖
npm install

# 2. 基于 ./petal/siyuan.d.ts 进行 TypeScript 类型检查
npm run typecheck

# 3. 构建生产产物至 ./dist 目录（不打包 zip）
npm run build

# 4. 开发监听模式
npm run dev
```

完整开发说明与 AI Agent 复用指南请参阅 [README.md](./README.md)。
