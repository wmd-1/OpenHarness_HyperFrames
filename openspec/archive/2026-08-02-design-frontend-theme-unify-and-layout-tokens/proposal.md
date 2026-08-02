## Why

`design-agent-frontend` 存在两个互不连通的 CSS 变量族与一组布局令牌矛盾，导致：① **主题切换不全局生效**——`ThemeProvider` 只写 `--app-*` 14 个变量，但全应用 ~80% 可见面积由 `src/styles/demo.css :root` 的**另一套遗留 token**（`--bg-page`/`--bg-module`/`--accent`/`--text-primary`…）驱动，且 demo.css **零 `data-theme` 选择器**、含 37+ 硬编码 hex，切换深色时仅 `<body>` 翻深，顶栏/卡片/对话气泡/预览面板全亮；② **布局令牌自相矛盾**——`.module-card` `border-radius:16px` 与 `--radius-card:14px` 冲突、box-shadow 用字面 rgba 而非 `var(--shadow-card)`、`calc(100vh-56px)` 魔法数三处无 `--header-height` 令牌、`--space-*` 令牌定义却几乎未被引用、z-index 无全局表、容器策略三套不统一。审计报告见 `docs/design-frontend-ui-layout-theme-audit.md`。

## What Changes

- **统一双 token 族**：在 `src/styles/demo.css :root` 把遗留颜色 token 改为派生自 `--app-*`（如 `--bg-module: var(--app-surface)`、`--text-primary: var(--app-text)`、`--accent: var(--app-accent)`），使 demo.css 驱动的全部 UI 跟随主题切换；`--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*` 保持静态（与主题无关）。
- **消除 demo.css 硬编码 hex**：37+ 硬编码色值改用 `--app-*` 派生或遗留 token（模块图标渐变 `--app-accent` 派生、`#f8f9fb`→`--app-surface-alt`、`#059669`→`--app-success`）；代码块/视频播放器恒深色保留并抽 `--code-bg`/`--player-bg` 语义令牌。
- **清理 TSX 内联遗留 token 泄漏**：`router.tsx`、`VideoModulePage.tsx`、`VideoPreviewPanel.tsx`、`HistoryPanel.tsx`、`previewCode.ts` 中的 `var(--text-tertiary)`/`var(--border-light)` 等内联改为 Tailwind token（`text-muted`/`border-line`）或族 A `var(--app-text-muted)`。
- **ThemeProvider 增强**：监听 `prefers-color-scheme`（首次访问无 localStorage 偏好时跟随系统）、写入 `root.style.colorScheme`（让原生控件 scrollbar/`<select>` 下拉跟随主题）。
- **新增布局令牌**：`--header-height`(56px)、`--z-header`/`--z-dropdown`/`--z-modal`/`--z-toast`、`--container-page`/`--container-detail`；替换 `calc(100vh-56px)` 三处、z-index 任意值、容器策略散字面值。
- **修正令牌矛盾**：`.module-card` 圆角 `16px`→`var(--radius-card)` 并统一 `--radius-card` 取值；`.module-card` box-shadow 字面 rgba→`var(--shadow-card)`/`var(--shadow-elevated)`；逐步把 chat-*/panel-*/module-card-* 的字面 px 间距替换为 `var(--space-*)`。
- **非目标（延后）**：不抽 `ModalShell`/`DetailLayout`/`Card` 公共组件（涉及 DOM/focus-trap 重构，风险高，待本次量化后单独立项，与 `design-frontend-modal-layout` spec 待办一致）；不统一响应式策略（demo.css `@media` 与 Tailwind `sm/md/lg` 并存留待后续；本次仅令牌化不破现有断点行为）；不改 `themes.ts` 主题色板、不改任何交互/ARIA/DOM 结构/WS/Store/API。

## Capabilities

### New Capabilities
- `design-frontend-theme-system`: 设计前端主题令牌统一与全局布局令牌体系——双 CSS 变量族桥接（遗留 token 派生自 `--app-*`）、硬编码色消除、ThemeProvider 增强（`prefers-color-scheme` + `color-scheme`）、布局令牌（`--header-height`/`--z-*`/`--container-*`）、令牌矛盾修正（圆角/阴影/间距统一）、TSX 内联遗留 token 清零、多主题全局生效验收基线。

### Modified Capabilities
（无既有 spec 的 Requirements 被修改。本次新增 `design-frontend-theme-system` 作为 `design-frontend-modal-layout`（浮层间距令牌）的姊妹能力，扩展令牌体系到全局主题与布局层，但不改动 modal-layout spec 已声明的浮层间距/行高/非回归 Requirements。`design-agent-platform`/`design-agent-video`/`design-agent-space`/`design-agent-demo-modules` 等既有契约的交互/API/ARIA 语义不变。）

## Impact

- **前端代码**：`design-agent-frontend/src/` 下约 12-15 个文件：① `src/styles/demo.css`（token 派生 + 硬编码色清理 + 布局令牌新增，主体改动）；② `src/theme/ThemeProvider.tsx`（增强）；③ `src/index.css`（`:root` 兜底与 `@theme inline` 可能微调）；④ `src/router.tsx`、`src/modules/video/{VideoModulePage,HistoryPanel,VideoPreviewPanel}.tsx`、`src/modules/ui-design/previewCode.ts`（清内联遗留 token）；⑤ 可能涉及 `shared/AppHeader.tsx` 与各模块页 className（若 demo.css 类已令牌化则无需改 tsx）。均为 CSS 变量/类名/内联清理，不改 DOM 结构与交互逻辑。
- **设计令牌**：`demo.css :root` 新增 `--header-height`/`--z-*`/`--container-*`/`--code-bg`/`--player-bg`（纯增量）；遗留颜色 token 由静态值改为 `var(--app-*)` 派生（值不变、来源变）。
- **后端/API**：零改动。
- **测试**：既有单测（`ApprovalModal`/`CreateDialog`/`WorkspaceFilesPanel`/`HistoryPanel` 等）断言均为语义查询，不依赖颜色/className，预期全绿；按项目硬约定在已有 Docker 镜像（`openharness-design-frontend:e2e` 或 `oh-e2e-test:latest`）内执行 `vitest` 与 `tsc -b && vite build`，禁止宿主机直跑、禁止重建基础镜像。
- **新增文件**：`openspec/changes/design-frontend-theme-unify-and-layout-tokens/`（本 change 四件套）；主题验收截图归档目录 `docs/ui-theme-before-after/`（实施后采集，5 主题 × 关键页面）。
- **不改动**：`themes.ts` 主题色板、所有 `__tests__`、WS/Store/API 层、`session-frontend/`、`web/`、`ErrorBanner.tsx`（已达基线）、浮层 DOM/ARIA/focus-trap。
