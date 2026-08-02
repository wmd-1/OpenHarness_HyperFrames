## ADDED Requirements

### Requirement: 双 CSS 变量族桥接
`src/styles/demo.css :root` 的遗留颜色 token SHALL 派生自 `src/index.css :root` 与 `ThemeProvider` 写入的 `--app-*` 变量：`--bg-page` SHALL 为 `var(--app-bg)`、`--bg-module` SHALL 为 `var(--app-surface)`、`--bg-input` SHALL 为 `var(--app-surface-alt)`、`--border-light` SHALL 为 `var(--app-border)`、`--border-focus` SHALL 为 `var(--app-accent)`、`--accent` SHALL 为 `var(--app-accent)`、`--text-primary` SHALL 为 `var(--app-text)`、`--text-secondary` SHALL 为 `var(--app-text-muted)`、`--text-on-accent` SHALL 为 `var(--app-accent-fg)`。`--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*` SHALL 保持静态值（与主题无关）。

#### Scenario: 切换主题后 demo.css 驱动的 UI 变色
- **WHEN** 在设置面板切换到 dark 主题
- **THEN** 使用 `var(--bg-module)`/`var(--bg-input)`/`var(--text-primary)` 的元素（`.app-header`、`.module-card`、`.chat-messages`、`.panel-history`、`.msg-user`、`.msg-ai`）背景与文字跟随变为深色，而非保持亮色

#### Scenario: 静态令牌不随主题变
- **WHEN** 切换 default 与 dark 主题
- **THEN** `--shadow-card`、`--radius-md`、`--space-xl`、`--leading-body`、`--font-stack`、`--transition-base` 的值在两主题下保持一致

### Requirement: 派生色用 color-mix 自动适配任意主题
demo.css 的派生颜色 token（`--bg-hover`、`--accent-light`、`--accent-hover`、`--text-tertiary`）SHALL 用 `color-mix(in srgb, ...)` 从 `--app-*` 计算，使任意主题（含 cyberpunk accent=`#ff2ea6`、solarized accent=`#268bd2`）下派生色自动正确，而非静态硬编码值。

#### Scenario: 派生强调色跟随主题
- **WHEN** 切换到 cyberpunk 主题（accent=`#ff2ea6`、surface=`#140a24`）
- **THEN** `--accent-light` 经 `color-mix(in srgb, var(--app-accent) 12%, var(--app-surface))` 计算为 cyberpunk 派生色，而非静态 `#e8f0fe`

#### Scenario: 派生悬停色跟随主题
- **WHEN** 切换到 dark 主题（surface=`#111827`、text=`#e5e7eb`）
- **THEN** `--bg-hover` 经 `color-mix` 计算为 dark 主题下的悬停色，而非静态 `#f0f2f6`

### Requirement: demo.css 硬编码色清零
`src/styles/demo.css` SHALL NOT 含与主题相关的硬编码 hex 色值。模块图标渐变（`.icon-ui`/`.icon-drawio`/`.icon-video`/`.icon-space`/`.thumb-ui`/`.thumb-drawio`/`.thumb-video`）SHALL 用 `var(--app-accent)` 派生（经 `color-mix` 生成渐变变体）。状态语义色（`#059669` 绿、`#d97706`/`#f59e0b` 视频橙）SHALL 用 `var(--app-success)`/`var(--app-warning)` 派生。浅灰条（`#f8f9fb` preview-frame-bar/drawio-status-bar）SHALL 改为 `var(--app-surface-alt)` 跟随主题。

#### Scenario: 模块图标跟随主题
- **WHEN** 切换到 cyberpunk 主题
- **THEN** `.icon-ui`/`.icon-video`/`.thumb-ui`/`.thumb-video` 渐变色基于 `var(--app-accent)` 派生，呈 cyberpunk 粉色调，而非静态 `#1a56db`/`#3b82f6`

#### Scenario: 状态语义色跟随主题
- **WHEN** 切换到 dark 主题（success=`#22c55e`）
- **THEN** `.msg-ai-label`、`.btn-upload` 的绿色用 `var(--app-success)` 派生，呈 dark 主题绿，而非静态 `#059669`

### Requirement: 恒深背景抽语义令牌
视频播放器恒深背景（`#0d0d12` video-preview-body、`#1a1a2e`/`#16213e`/`#0f3460` video-placeholder 渐变、`#000` video-player-wrapper）与代码块恒深背景（`#1e1e2e`/`#2d2d3f` preview-code）SHALL 抽为 `--player-bg`/`--player-gradient`/`--code-bg`/`--code-bar-bg` 语义令牌，值保持深色不随主题变（设计意图）。`--player-bg`/`--code-bg` SHALL 在 demo.css `:root` 定义为静态深色值。

#### Scenario: 视频播放器背景恒深
- **WHEN** 在 default 与 dark 主题下分别渲染视频预览
- **THEN** `.video-preview-body`/`.video-placeholder` 背景均保持 `--player-bg`/`--player-gradient` 深色，不随主题翻转

#### Scenario: 代码块配色恒深
- **WHEN** 在任意主题下渲染 ui-design 预览的代码视图
- **THEN** `.preview-code`/`.preview-code-bar` 背景保持 `--code-bg`/`--code-bar-bg` 深色，语法高亮配色（Catppuccin 风格）不变

### Requirement: ThemeProvider 系统偏好兜底
`ThemeProvider.loadInitialTheme` SHALL 在无 localStorage 主题偏好时读取 `matchMedia('(prefers-color-scheme: dark)')`：系统为 dark → 初始化 `dark` 主题；否则 `default`。用户经 `setTheme` 显式选择主题后 SHALL 写入 localStorage，且后续系统主题变化 SHALL NOT 覆盖用户选择。

#### Scenario: 首次访问跟随系统深色
- **WHEN** 首次访问（localStorage 无 `sf.theme`）且系统 `prefers-color-scheme: dark`
- **THEN** 应用以 `dark` 主题初始化

#### Scenario: 显式选择覆盖系统
- **WHEN** 用户在设置面板显式选择 `solarized` 主题后，系统主题变化为 dark
- **THEN** 应用保持 `solarized`，不随系统翻转

### Requirement: ThemeProvider 同步 color-scheme
`applyTheme` SHALL 在写入 `--app-*` 与 `data-theme` 属性的同时，设置 `documentElement.style.colorScheme` 为 `dark` 或 `light`，使原生表单控件（scrollbar、`<select>` 下拉、autofill 背景）跟随主题。dark 与 cyberpunk 归为 `dark`；default、minimal、solarized 归为 `light`。

#### Scenario: 原生控件跟随深色主题
- **WHEN** 切换到 dark 主题
- **THEN** `documentElement.style.colorScheme === 'dark'`，页面 scrollbar 与 `<select>` 下拉呈深色

#### Scenario: 原生控件跟随亮色主题
- **WHEN** 切换到 solarized 主题
- **THEN** `documentElement.style.colorScheme === 'light'`，原生控件呈亮色

### Requirement: TSX 内联遗留 token 清零
TSX 文件的内联 `style` SHALL NOT 引用族 B 遗留颜色 token（`var(--text-tertiary)`/`var(--text-secondary)`/`var(--border-light)`/`var(--bg-module)`/`var(--accent-light)`/`var(--accent)`/`var(--font-stack)`）。颜色/间距 SHALL 用 Tailwind token（`text-muted`/`border-line`/`bg-surface`/`bg-accent`/`text-fg`）或族 A `var(--app-text-muted)`/`var(--app-border)` 表达。仅允许纯动态数值（如 `width: min(960px,100%)`、`animationDelay`、`fontSize` 数值）为内联。

#### Scenario: VideoModulePage 轮次计数颜色
- **WHEN** 渲染 `VideoModulePage` chat-header 的轮次计数 span
- **THEN** 其颜色用 Tailwind `text-muted` 类或 `var(--app-text-muted)`，而非内联 `var(--text-tertiary)`

#### Scenario: router PageFallback 颜色
- **WHEN** 渲染路由懒加载 `PageFallback`
- **THEN** 其颜色用 Tailwind `text-muted` 类，而非内联 `var(--text-secondary)`

#### Scenario: HistoryPanel 内联清零
- **WHEN** 检查 `HistoryPanel.tsx` 的内联 `style`
- **THEN** 不出现 `var(--text-tertiary)`/`var(--font-stack)` 等族 B 引用

### Requirement: 布局令牌新增
`src/styles/demo.css :root` SHALL 新增 `--header-height`(56px)、`--z-header`(100)、`--z-dropdown`(50)、`--z-modal`(200)、`--z-toast`(300)、`--container-page`(1200px) 令牌。`calc(100vh - 56px)` 三处（`.page-home`、`.page-detail`、`.page-space`）SHALL 改为 `calc(100vh - var(--header-height))`。`.app-header` 的 `z-index` SHALL 用 `var(--z-header)`；`.model-dropdown` SHALL 用 `var(--z-dropdown)`；SettingsPanel 与 SpacePage 预览 Modal 遮罩 SHALL 用 `var(--z-modal)`。

#### Scenario: 顶栏高度令牌化
- **WHEN** 调整 `--header-height` 令牌值（如 48px）
- **THEN** `.page-home`/`.page-detail`/`.page-space` 的 `min-height`/`height` 跟随变化，无需改 calc 字面值

#### Scenario: Modal 叠层高于顶栏
- **WHEN** 渲染 SettingsPanel 抽屉或 SpacePage 视频预览 Modal
- **THEN** 遮罩 z-index 为 `var(--z-modal)`(200)，高于 `var(--z-header)`(100) 的顶栏

### Requirement: 令牌矛盾修正
`.module-card` 圆角 SHALL 用 `var(--radius-card)` 而非字面 `16px`；`--radius-card` 取值 SHALL 统一为 `16px`（`.space-card` 同步）。`.module-card` 与 `.module-card:hover` 的 box-shadow SHALL 用 `var(--shadow-card)`/`var(--shadow-elevated)` 而非字面 rgba。字面 px 间距（`.chat-*`/`.panel-*` 的 padding/gap/margin）SHALL 优先替换为 `var(--space-*)`；例外：卡片图标区特殊视觉比例（`.module-card-icon` `padding:44px 32px 28px`）可保留并注释为设计意图。

#### Scenario: 卡片圆角统一
- **WHEN** 渲染主页 `.module-card` 与个人空间 `.space-card`
- **THEN** 两者圆角均为 `var(--radius-card)`(16px)，无不一致

#### Scenario: 卡片阴影令牌化
- **WHEN** 检查 `.module-card` 与 `.module-card:hover` 的 box-shadow 声明
- **THEN** 引用 `var(--shadow-card)`/`var(--shadow-elevated)`，无字面 `rgba(0,0,0,...)` 硬编码

#### Scenario: 间距令牌引用
- **WHEN** 检查 `.chat-header`/`.chat-messages`/`.chat-input-area` 的 padding 声明
- **THEN** 引用 `var(--space-*)` 令牌而非字面 `12px`/`16px`/`20px`/`24px`

### Requirement: 非回归约束（不改 DOM/ARIA/交互）
本次整改 MUST NOT 改变任何组件的 DOM 结构、ARIA 契约（`role`/`aria-modal`/`aria-label`/`aria-live`/`data-ws-status` 等）、focus trap 行为、Escape 键语义、按钮文案与回调逻辑。既有单测断言（`getByRole`/`getByText`/`getByLabelText`/`getByTestId`）在整改后 MUST 保持全绿，无需修改断言。

#### Scenario: ARIA 契约不变
- **WHEN** 整改后渲染 `VideoModulePage`
- **THEN** 其 `data-ws-status` 钩子与 `page-detail` 类契约与整改前一致

#### Scenario: 既有单测全绿
- **WHEN** 在既有 Docker 镜像内运行全量 vitest
- **THEN** 所有断言通过且无需修改测试代码

### Requirement: 多主题全局生效验收
整改后 default/dark/minimal/cyberpunk/solarized 五主题下，顶栏、主页、四能力域详情页（video/ui-design/drawio）、个人空间、聊天面板、消息气泡、预览面板 SHALL 全部跟随主题变色（背景/文字/边框/强调色），无亮色残留；且不破版（圆角、阴影、遮罩、文字对比度正常）。

#### Scenario: 五主题全页面变色
- **WHEN** 依次切换五主题并截取顶栏、主页、视频模块、个人空间页面
- **THEN** 各页面背景/文字/边框/强调色均跟随主题，无亮色残留（特别是顶栏 `.app-header`、主页 `.module-card`、聊天 `.msg-user`/`.msg-ai`）

#### Scenario: cyberpunk 主题无破版
- **WHEN** 切换到 cyberpunk 主题（高对比粉/紫）
- **THEN** 各页面圆角、阴影、遮罩、文字对比度正常，无样式丢失或溢出

### Requirement: 镜像内执行测试约束
所有单测与构建 MUST 在既有 Docker 镜像（`openharness-design-frontend:e2e` 或其 FROM 链 `oh-e2e-test:latest`）内执行，宿主机禁止直跑测试、禁止从零重建基础镜像。源码经 volume 挂载进容器，改码无需重建即可测。

#### Scenario: 单测在镜像内执行
- **WHEN** 运行门禁单测
- **THEN** `vitest` 在既有镜像内执行，宿主机不直接 `npx vitest`

#### Scenario: 构建在镜像内执行
- **WHEN** 运行门禁构建
- **THEN** `tsc -b && vite build` 在既有镜像内执行并产线构建无错
