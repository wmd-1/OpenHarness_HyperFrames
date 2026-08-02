# 任务清单：设计智能体前端 · 主题令牌统一与全局布局令牌

落地方式：CSS 变量派生与令牌化、demo.css 硬编码色清理、TSX 内联清零、ThemeProvider 增强；不改 DOM 结构、ARIA 契约、focus trap、交互逻辑、`themes.ts` 主题色板。
按 A（主题全局化）→ B（布局令牌）串行，每级设门禁（单测 + 五主题截图回归），门禁不过不进下一级。
测试须在既有 Docker 镜像（`openharness-design-frontend:e2e` 或 `oh-e2e-test:latest`）内执行，禁止宿主机直跑、禁止重建基础镜像。

> **进度（2026-08-02）**：Phase A（1.x/2.x/3.x/4.x）+ Phase B（6.x/7.x）代码改动全部完成。所有门禁通过（5.1/5.2/5.3/5.4/8.1/8.2）。视觉回归归档 `docs/ui-theme-before-after/`（10 张：5 主题 × {home, settings}）。计算背景铁证：`dark` 主题 `.app-header`/`.module-card` 由 `rgb(255,255,255)` 翻为 `rgb(17,24,39)`（=#111827）；`cyberpunk` 翻为 `rgb(20,10,36)`（=#140a24）；`solarized` 翻为 `rgb(238,232,213)`（=#eee8d5）—— 主题切换现已全局生效。

## 1. Phase A 前置 — demo.css token 桥接（D1 + D2 + D6 恒深）

- [x] 1.1 `src/styles/demo.css :root` 把遗留颜色 token 改为派生自 `--app-*`：`--bg-page: var(--app-bg)`、`--bg-module: var(--app-surface)`、`--bg-input: var(--app-surface-alt)`、`--border-light: var(--app-border)`、`--border-focus: var(--app-accent)`、`--accent: var(--app-accent)`、`--text-primary: var(--app-text)`、`--text-secondary: var(--app-text-muted)`、`--text-on-accent: var(--app-accent-fg)`
- [x] 1.2 派生色用 `color-mix()`：`--bg-hover`、`--accent-light`、`--accent-hover`、`--text-tertiary`
- [x] 1.3 新增恒深语义令牌：`--player-bg`/`--player-gradient`/`--player-wrapper-bg`/`--code-bg`/`--code-bar-bg`；`.video-preview-body`/`.video-placeholder`/`.video-player-wrapper`/`.preview-code`/`.preview-code-bar`/`.video-speed-selector option` 改引用这些令牌
- [x] 1.4 验证 `--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*` 保持静态不变（与主题无关）

## 2. Phase A — demo.css 硬编码色清理（D6 品牌派生/状态语义/浅灰条）

- [x] 2.1 模块图标渐变（`.icon-*`、`.thumb-*`、`.header-logo-icon`）改用 `var(--app-accent)`/`var(--app-success)`/`var(--app-warning)`/`var(--app-text-muted)` + `color-mix` 派生渐变
- [x] 2.2 状态语义色清理：`#059669` 绿 → `var(--app-success)` 派生（`.msg-ai-label`/`.btn-upload` 系/`.drawio-preview-title svg`）；`#d97706`/`#f59e0b` 视频橙 → `var(--app-warning)` 派生（`.video-preview-title svg`/`.video-placeholder-icon`/`.video-progress-bar`/`.video-volume-slider` 拇指）
- [x] 2.3 浅灰条清理：`#f8f9fb`（preview-frame-bar/preview-frame-phone-bar/drawio-status-bar）→ `var(--app-surface-alt)`；滚动条 `#d0d5dd`/`#b0b8c4` → `var(--app-border)`/`color-mix` 派生；`#d4d8de` drawio 网格点 → `var(--app-border)`
- [x] 2.4 代码语法高亮配色（`.code-tag`/`.code-attr`/`.code-val` 等 Catppuccin Mocha）保留为恒深（设计意图），加注释标记；`#ffffff` 白色（图标标题，主题无关）保留

## 3. Phase A — ThemeProvider 增强（D3 系统偏好 + color-scheme）

- [x] 3.1 `src/theme/ThemeProvider.tsx` `loadInitialTheme()`：localStorage 有偏好→用之；无偏好→读 `matchMedia('(prefers-color-scheme: dark)')`，dark→`dark`，否则 `default`
- [x] 3.2 `applyTheme()`：同步设 `root.style.colorScheme`：`dark`/`cyberpunk`→`'dark'`，`default`/`minimal`/`solarized`→`'light'`
- [x] 3.3 新增单测 `src/theme/__tests__/ThemeProvider.test.tsx`（10 例）：首次跟随系统、显式选择覆盖系统、localStorage 无效回退系统、color-scheme 同步（dark/cyberpunk→dark，default/minimal/solarized→light）、持久化

## 4. Phase A — TSX 内联遗留 token 清零

- [x] 4.1 `src/router.tsx` `PageFallback`：内联 `color: 'var(--text-secondary)'` → Tailwind `text-muted` 类（整体改 `className="flex flex-1 items-center justify-center text-muted min-h-[240px]"`）
- [x] 4.2 `src/modules/video/VideoModulePage.tsx` 轮次计数：`color: 'var(--text-tertiary)'` → Tailwind `text-muted` 类（保留 `fontSize:12` 内联）
- [x] 4.3 `src/modules/video/VideoPreviewPanel.tsx`：轮次 span → `font-normal text-muted` 类；tablist div → Tailwind `flex gap-1.5 border-b border-line bg-surface px-4 py-2 overflow-x-auto`；active tab 内联 → 族 A `var(--app-accent)` + `color-mix` 派生（保留 tinted 视觉）
- [x] 4.4 `src/modules/video/HistoryPanel.tsx`：刷新按钮/关闭按钮/加载更多按钮的 `var(--text-tertiary)` → 族 A `var(--app-text-muted)`；`var(--font-stack)` 移除（body 已继承）
- [x] 4.5 `src/modules/ui-design/previewCode.ts`：确认为「示例源码文本内容」（展示给用户看的样例），非运行时样式，加注释标记不改

## 5. Phase A 门禁 — 主题全局生效

- [x] 5.1 镜像内 `npm test`：307 passed（含新增 ThemeProvider 10 例），未改任何断言（命令：`docker run --rm -v "$(pwd)/design-agent-frontend/src:/app/src" -w /app openharness-design-frontend:test npm test`）
- [x] 5.2 镜像内 `npm run build`：1968 模块无错（tsc -b && vite build）
- [x] 5.3 五主题（default/dark/minimal/cyberpunk/solarized）逐页截图回归：主页 + 设置面板，归档至 `docs/ui-theme-before-after/`（10 张）；计算背景确认深色主题下顶栏 `.app-header`/`.module-card` 翻转（dark=#111827, cyberpunk=#140a24, solarized=#eee8d5），不再保持亮色
- [x] 5.4 `prefers-color-scheme: dark` 首访跟随系统、显式选择覆盖系统、`documentElement.style.colorScheme` 同步（ThemeProvider 单测 10 例覆盖）

## 6. Phase B 前置 — 布局令牌新增（D4）

- [x] 6.1 `src/styles/demo.css :root` 新增 `--header-height`(56px)、`--z-header`(100)、`--z-dropdown`(50)、`--z-modal`(200)、`--z-toast`(300)、`--container-page`(1200px)
- [x] 6.2 `calc(100vh - 56px)` 三处（`.page-home`、`.page-detail`、`.page-space`）改 `calc(100vh - var(--header-height))`；`.app-header` `height:56px` 改 `var(--header-height)`
- [x] 6.3 z-index 令牌化：`.app-header` → `var(--z-header)`；`.model-dropdown` → `var(--z-dropdown)`；SettingsPanel/SpacePage Modal `z-[200]` → `z-[var(--z-modal)]`（Tailwind 4 任意值变量引用）；局部 stacking context（0/1/2/10）保留字面
- [x] 6.4 `.page-space` `max-width: 1200px` → `var(--container-page)`；主页 `padding:0 10%; max-width:none` 保留（设计意图）

## 7. Phase B — 令牌矛盾修正（D5）

- [x] 7.1 `--radius-card` `14px`→`16px`；`.module-card` `border-radius:16px`→`var(--radius-card)`；`.space-card` 已用 `var(--radius-card)` 同步变 16px
- [x] 7.2 `.module-card` box-shadow 字面 rgba→`var(--shadow-card)`；`.module-card:hover` →`var(--shadow-elevated)`
- [x] 7.3 字面 px 间距替换为 `var(--space-*)`：`.chat-header` `padding:12px 20px`→`var(--space-md) var(--space-lg)`；`.chat-messages` `padding:24px 20px; gap:16px`→`var(--space-xl) var(--space-lg); gap:var(--space-lg)`；`.chat-input-area` `padding:16px 20px`→`var(--space-lg)`；`.panel-history-header` `padding:16px 16px 14px`→`var(--space-lg) var(--space-lg) var(--space-md)`
- [x] 7.4 `.module-card-icon` `padding:44px 32px 28px` 保留为卡片视觉特殊比例，加注释「设计意图，不令牌化」

## 8. Phase B 门禁与收尾

- [x] 8.1 镜像内 `npm test`（307 passed）+ `npm run build`（1968 模块无错）
- [x] 8.2 五主题视觉回归（1280×800 桌面）确认令牌化后无破版（圆角/阴影/间距一致）；375px 移动端未单独采集（home 是居中卡片矩阵，移动端仅堆叠；与主题切换正交，留待后续）
- [x] 8.3 校对 token 数值一致性：`--header-height:56px` 与顶栏实际高度、`--z-modal:200` > `--z-header:100` > `--z-dropdown:50`、`--radius-card:16px` 主页/个人空间卡片一致、`--space-lg:16px`↔`gap-4`/`p-4`、`--space-xl:24px`↔`p-6`、`--space-md:12px`↔`gap-3`
- [x] 8.4 评估 `ModalShell`/`DetailLayout`/`Card` 立项必要性：居中浮层重复 3 处（SettingsPanel 抽屉 / ConfirmDialog / SpacePage 视频预览 Modal），每处 overlay+container+focus 重复 ≥15 行；三栏详情页 3 套变体（video-layout/drawio-layout/默认）逻辑同构异写 → **建议后续单独立项**（与 modal-layout spec 8.4 待办合并为一个「design-frontend-layout-abstraction」change）
- [x] 8.5 归档 change：`openspec archive -y` → 落到 `openspec/changes/archive/`，已 `mv` 到顶层 `openspec/archive/2026-08-02-design-frontend-theme-unify-and-layout-tokens/`；specs 合并到 `openspec/specs/design-frontend-theme-system/spec.md`（12 条 requirement）
- [x] 8.6 更新 `MEMORY.md` 与当日 daily 记忆：主题双 token 族桥接方案、布局令牌清单、五主题验收结论
