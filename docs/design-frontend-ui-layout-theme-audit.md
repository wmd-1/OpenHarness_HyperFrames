# 设计智能体前端（design-agent-frontend）UI 布局与主题审计报告

- **审计范围**：`design-agent-frontend/src` 全量（`App.tsx` / `router.tsx` / `main.tsx` / `index.css` / `styles/demo.css` / `theme/*` / `hooks/useTheme.ts` / `components/**` / `modules/**` / `shared/AppHeader.tsx`）。
- **审计日期**：2026-08-02。
- **审计方法**：静态阅读 + 模式搜索（双 token 族、硬编码色、`data-theme` 选择器、`style={{}}` 内联、`calc(100vh)` 假设、z-index 叠层）。
- **关联记忆**：`design-frontend-modal-layout` spec（2026-08-02 归档，浮层令牌已落地）的延续。

---

## 0. 执行摘要（TL;DR）

| 维度 | 严重度 | 一句话结论 |
|---|---|---|
| 主题切换不全局生效 | 🔴 致命 | 主题引擎只更新 `--app-*` 变量，但全应用 ~80% 可见面积由 `styles/demo.css` 的**另一套遗留 token**（`--bg-*` / `--text-*` / `--accent-*`）驱动，且 demo.css **零 `data-theme` 选择器**、含 37+ 硬编码 hex 色值 → 切深色时仅 `<body>` 背景翻转，顶栏/卡片/对话气泡/预览面板全部保持亮色。 |
| 布局令牌与字面值混用 | 🟠 高 | `demo.css` 1273 行定义了 `--space-*` / `--radius-*` / `--shadow-*` 令牌，但**绝大多数规则仍用字面 `px` / 硬编码阴影 / 硬编码圆角**（`.module-card` `border-radius: 16px` 与 `--radius-card: 14px` 直接冲突）。 |
| 双样式体系并存 | 🟠 高 | 一套基于 Tailwind 工具类 + `--app-*` 令牌（`components/Settings`、`Session`、`Chat`、`Common`、`Approval`，主题感知）；另一套基于 `demo.css` 扁平类 + 遗留 token（`modules/**`、`shared/AppHeader`、`components/Layout` 部分，主题盲）。两套在间距/圆角/响应式上互不对齐。 |
| 容器策略不一致 | 🟡 中 | 主页 `padding: 0 10%`（百分比，无 max-width），个人空间 `padding: 40px 32px; max-width: 1200px`（固定居中），能力域详情页 `calc(100vh - 56px)` 三栏。三种策略不共享基线。 |
| 魔法数字 `56px` 标题高 | 🟡 中 | `demo.css` 多处 `calc(100vh - 56px)` 假设顶栏恒为 56px，无 `--header-height` 令牌；顶栏一旦改高度会连锁断裂。 |
| 居中浮层三处重复 | 🟡 中 | `SettingsPanel` / `ConfirmDialog` / `SpacePage` 视频预览 Modal 各写一遍「fixed inset-0 + flex center + bg-black/40」骨架，未抽 `ModalShell`（与 `design-frontend-modal-layout` spec 待办项一致）。 |
| z-index 无全局表 | 🟡 中 | 出现 `z-50`（ConfirmDialog）/ `z-100`（app-header）/ `z-[200]`（SettingsPanel、SpacePage 预览）/ 无值（ErrorBanner），无 `--z-*` 令牌，叠层靠记忆。 |
| 响应式策略双轨 | 🟢 低 | `demo.css` 用 `@media (max-width: 1100/900/640px)`；Tailwind 组件用 `sm:`/`md:`/`lg:`。断点定义不互证。 |

**核心修复优先级**：① 统一主题 token（让 `demo.css` 的遗留 token 跟随 `--app-*` 派生，或令 ThemeProvider 同时写两套）→ ② 消灭 demo.css 硬编码色 → ③ 抽 `ModalShell` + z-index 令牌 → ④ 间距/圆角/阴影令牌化 → ⑤ 容器策略与 56px 令牌化。

---

## 1. 主题切换失效根因（用户问题 ②）

### 1.1 双 CSS 变量族并存且互不同步

应用内存在**两套完全独立的 CSS 变量族**，只有第一套跟随主题切换：

#### 族 A — 主题感知族（`--app-*`，由 ThemeProvider 驱动）

定义与驱动链：

```text
src/theme/themes.ts:62-231  → 5 套主题（default/dark/minimal/cyberpunk/solarized）的 cssVars
                                  （每套仅含 14 个 app-* 键）
src/theme/ThemeProvider.tsx:11-18  → applyTheme() 把 --app-* 写入 documentElement inline style
src/index.css:10-25  → :root 兜底 14 个 --app-* 默认值
src/index.css:27-42  → @theme inline 把 --app-* 映射为 Tailwind 颜色 token
                          （bg-base / bg-surface / bg-raised / text-fg / text-muted /
                           color-accent / color-accent-fg / text-ok / text-warn / text-err /
                           bg-user-bubble / bg-assistant-bubble / border-line）
```

只有使用上述 Tailwind token 的组件才会随主题变色。

#### 族 B — 遗留 token 族（`--bg-*` / `--text-*` / `--accent-*`，主题盲）

定义在 `src/styles/demo.css:2-35` 的 `:root` 中，**从未被 ThemeProvider 更新**：

```text
--bg-page, --bg-module, --bg-input, --bg-hover,
--border-light, --border-focus,
--accent, --accent-light, --accent-hover,
--text-primary, --text-secondary, --text-tertiary, --text-on-accent,
--shadow-card, --shadow-elevated, --shadow-header,
--radius-sm/md/lg/card, --font-stack, --transition-base/panel,
--space-xs/sm/md/lg/xl/2xl, --leading-body/tight
```

### 1.2 demo.css 零 `data-theme` 选择器（主题盲的铁证）

| 搜索项 | 结果 |
|---|---|
| `data-theme` 在 `*.css`（全 src） | **0 处命中** |
| `[data-theme="dark"]` 选择器 | **0 处** |
| `dark:` Tailwind 变体在 demo.css | **0 处**（demo.css 不用 Tailwind 工具类） |
| `tailwind.config.ts:7` | `darkMode: ['selector', '[data-theme="dark"]']` 已声明，但因 demo.css 无 `dark:` 用法 → **声明对遗留 UI 完全无效** |

### 1.3 demo.css 含 37+ 硬编码 hex 色值（绕过 token）

`src/styles/demo.css` 中硬编码 6 位 hex 色值共 37 处（不含 `rgba()`），代表性示例：

```text
demo.css:73   .header-logo-icon { background: linear-gradient(135deg, #1a56db, #3b82f6); }
demo.css:193  .icon-ui { background: linear-gradient(135deg, #1a56db 0%, #3b82f6 100%); }
demo.css:194  .icon-drawio { background: linear-gradient(135deg, #059669 0%, #10b981 100%); }
demo.css:410  .msg-ai-label { color: #059669; }
demo.css:524  .btn-upload { color: #059669; }
demo.css:625  .preview-frame-bar { background: #f8f9fb; }          ← 硬编码亮灰，深色主题下违和
demo.css:668  .preview-code { background: #1e1e2e; }                ← 硬编码代码块底色
demo.css:814  .drawio-status-bar { background: #f8f9fb; }
demo.css:856  .video-preview-body { background: #0d0d12; }          ← 视频预览恒为深色（与主题无关尚可）
demo.css:875  .video-placeholder { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); }
demo.css:1035 .video-speed-selector option { background: #1e1e2e; color: #fff; }
demo.css:1190 .thumb-ui { background: linear-gradient(135deg, #1a56db 0%, #3b82f6 100%); }
```

> 说明：`#1e1e2e`/`#0d0d12` 这类视频/代码块深色是设计意图（播放器恒深），可保留；但 `#f8f9fb`（preview-frame-bar / drawio-status-bar）是浅色硬编码，在深色主题下会撕裂。`#059669`（绿色 AI 标签/上传按钮）是品牌语义色，应提升为 `--app-success` 派生。

### 1.4 TSX 内联 `var(--*)` 引用遗留 token（主题泄漏源）

下列文件在 `style={{}}` 内联中引用族 B 遗留 token，切主题时不变色：

| 文件 | 行号 | 内联引用 |
|---|---|---|
| `src/router.tsx` | 25 | `color: 'var(--text-secondary)'`（PageFallback） |
| `src/modules/video/VideoModulePage.tsx` | 235 | `color: 'var(--text-tertiary)'`（轮次计数） |
| `src/modules/video/VideoPreviewPanel.tsx` | 52, 87-94, 104-111 | `var(--text-tertiary)` ×2、`var(--border-light)`、`var(--bg-module)`、`var(--accent-light)`、`var(--accent)` ×2 |
| `src/modules/video/HistoryPanel.tsx` | 46-54, 64, 74, 93-94 | `var(--text-tertiary)` ×3、`var(--font-stack)` |
| `src/modules/ui-design/previewCode.ts` | 多处 | 字符串常量含 `--bg-page`/`--bg-module`/`--accent`/`--text-primary`/`--shadow-card`（渲染为预览源码 HTML，非运行时样式，但误导） |
| `src/index.css` | 130-139 | `.demo-badge-inline` 用 `var(--accent-light, #e8f0fe)` / `var(--accent, #1a56db)` / `var(--border-light, #e2e6ec)` 带 fallback |
| `src/index.css` | 67-72 | `.typing-cursor::after { color: var(--app-accent); }` ← 已用族 A，正确 |

### 1.5 主题感知 vs 主题盲组件分类

| 组件/页面 | 样式来源 | 主题感知? |
|---|---|---|
| `components/Settings/SettingsPanel.tsx` | Tailwind token (`bg-surface`/`text-fg`/`border-line`) | ✅ |
| `components/Settings/ThemeSelector.tsx` | `def.cssVars['app-*']` 内联 + Tailwind | ✅ |
| `components/Settings/ApiKeyInput.tsx` | Tailwind token | ✅ |
| `components/Common/ConfirmDialog.tsx` | Tailwind token (`bg-surface`/`text-fg`/`border-line`/`bg-err`) | ✅ |
| `components/Common/ErrorBanner.tsx` | Tailwind token (`bg-accent/10`/`text-warn`/`bg-err`…) | ✅ |
| `components/Session/*`（CreateDialog/StatusBadge/SessionCard/SessionDetail/SessionWorkspace/WorkspaceFilesPanel） | Tailwind token | ✅ |
| `components/Chat/ToolCallCard.tsx` | Tailwind token | ✅ |
| `components/Approval/*`（PermissionPrompt/QuestionPrompt/ApprovalModal） | Tailwind token | ✅ |
| `components/Welcome/WelcomeScreen.tsx` | Tailwind token | ✅ |
| `components/Layout/TopBar.tsx`、`Sidebar.tsx`、`StatusBar.tsx` | Tailwind token | ✅ |
| `shared/AppHeader.tsx` | demo.css 类（`.app-header`/`.header-logo`…） | ❌ |
| `modules/home/HomePage.tsx` | demo.css 类（`.page-home`/`.module-card`…） | ❌ |
| `modules/video/VideoModulePage.tsx` | demo.css 类 + 内联遗留 token | ❌ |
| `modules/video/HistoryPanel.tsx` | demo.css 类 + 内联遗留 token | ❌ |
| `modules/video/VideoPreviewPanel.tsx` | demo.css 类 + 内联遗留 token | ❌ |
| `modules/video/CustomVideoPlayer.tsx` | demo.css 类（`.video-*`） | ❌（播放器恒深，可接受） |
| `modules/video/ModelSelector.tsx` | demo.css 类（`.btn-model`/`.model-dropdown`） | ❌ |
| `modules/drawio/DrawioPage.tsx` | demo.css 类（`.page-detail.drawio-layout`） | ❌ |
| `modules/drawio/DiagramCanvas.tsx` | demo.css 类（`.drawio-*`） | ❌ |
| `modules/ui-design/UiDesignPage.tsx` | demo.css 类 | ❌ |
| `modules/ui-design/UiPreviewPanel.tsx` | demo.css 类（`.preview-*`） | ❌ |
| `modules/space/SpacePage.tsx` | demo.css 类 + 少量 Tailwind（Modal 遮罩 `bg-black/60`、按钮 `border-white/40`） | ⚠️ 混合（遮罩感知，卡片盲） |
| `modules/demo-shared/DemoChat.tsx`、`DemoHistoryPanel.tsx` | demo.css 类 | ❌ |
| `components/Terminal/TerminalView.tsx` | xterm + `TerminalTheme`（由 `themes.ts.terminal` 驱动） | ✅（独立通道） |

**结论**：~80% 可见面积（顶栏、主页卡片矩阵、四能力域详情页、个人空间卡片网格、聊天面板与消息气泡）由 demo.css 驱动 → **主题盲**。

### 1.6 切换为「Dark」主题的可观测后果

1. `ThemeProvider` 写入 `--app-bg: #0b1120` 等到 `<html>` inline style。
2. `body`（`src/index.css:50` `@apply bg-base text-fg`）→ `--app-bg` → **背景翻深** ✅。
3. `.app-header { background: var(--bg-module) }`（demo.css:41）→ `--bg-module` 仍为 `#ffffff` → **顶栏保持亮白** ❌。
4. `.module-card`、`.chat-messages`、`.panel-history`、`.msg-user`、`.msg-ai` 全部用 `--bg-module`/`--bg-input`/`--text-primary` → **全部保持亮色** ❌。
5. `.icon-ui`/`.icon-video`/`.thumb-*` 渐变用硬编码 `#1a56db`/`#d97706` → **品牌色不随主题变**（设计意图，可接受，但应派生自 `--app-accent` 以便「cyberpunk」等主题换色）。
6. **净效果**：`<body>` 翻深，但顶栏、卡片、对话区、预览面板全亮 → 用户感知「主题切换没全局生效」。

### 1.7 主题引擎还有两个隐性缺陷

- **`ThemeProvider` 未监听系统 prefers-color-scheme**：`loadInitialTheme()`（`ThemeProvider.tsx:20-28`）只读 localStorage，无 `window.matchMedia('(prefers-color-scheme: dark)')` 兜底，首次访问无偏好时强制 default（亮）。
- **`applyTheme` 不写 `color-scheme`**：未设 `root.style.colorScheme = name === 'dark' ? 'dark' : 'light'`，导致原生表单控件（scrollbar、`<select>` 下拉）在深色主题下仍亮。

---

## 2. UI 布局审计（用户问题 ①）

### 2.1 总体架构与布局链

#### 2.1.1 入口与 Provider 链

`src/main.tsx:14-19` → `StrictMode → ThemeProvider → App`。`App.tsx:20-28` 按 `apiKey` 二分：无 key 落 `WelcomeScreen`，有 key 落 `AppRouter`。

#### 2.1.2 路由与平台布局

`src/router.tsx:33-46` `PlatformLayout`：

```text
<div style="flex column, height 100%">
  <AppHeader />              ← sticky top:0; height:56px（demo.css:45）
  <ErrorBanner />            ← 条件渲染，非 absolute，占据文档流
  <div style="flex:1; min-height:0; flex column">
    <Suspense fallback={PageFallback}>
      <Outlet />             ← 各能力域页 / 主页 / 个人空间
    </Suspense>
  </div>
  <SettingsPanel />          ← fixed inset-0 z-[200]，脱离文档流
</div>
```

**问题**：
- `PlatformLayout` 根容器用**内联 style**（`router.tsx:35-38`）而非令牌化类，与 `design-frontend-modal-layout` spec「令牌与 Tailwind 单一维度单一写法」相悖。
- `PageFallback`（`router.tsx:18-30`）用 `color: 'var(--text-secondary)'`（族 B 遗留 token）→ 主题盲。
- `ErrorBanner` 占据文档流而非 `absolute`/`sticky`，出现/消失会引发布局抖动（height 抖动）。建议改为 `sticky` 或预留固定槽位。
- `min-height: 0` 已正确设置在内容包装层（`router.tsx:38`）✅，避免 flex 子项默认 `min-height:auto` 撑爆。

#### 2.1.3 顶栏 AppHeader（`shared/AppHeader.tsx`）

- 完全依赖 demo.css 类（`.app-header`/`.header-left`/`.header-back`/`.header-logo`/`.header-title-current`/`.header-right`/`.header-user`）。
- 高度 56px 硬编码（`demo.css:45`），无 `--header-height` 令牌。
- `header-back` 同时承担「返回」与「设置」两职（`AppHeader.tsx:54-61` 复用 `.header-back.visible` 给设置按钮）—— 语义复用导致样式耦合，改其一必伤其二。
- `.header-user`（头像）无下拉菜单挂载点（无 `Menu`/`Dropdown` 组件），点击无行为。

### 2.2 模块逐一布局

#### 2.2.1 主页 HomePage（`modules/home/HomePage.tsx`）

- **布局**：垂直 flex 居中 → `<h1 home-title>` + `<p home-subtitle>` + `<div module-grid>`（2×2 grid）。
- **容器**：`.page-home { padding: 0 10%; min-height: calc(100vh - 56px); max-width: none; justify-content: center }`（demo.css:96-104）。
- **网格**：`.module-grid { grid-template-columns: repeat(2,1fr); grid-template-rows: repeat(2,1fr); gap: 24px; max-height: 68vh; flex: 1 }`（demo.css:116-123）。
- **卡片**：`.module-card { border-radius: 16px; box-shadow: 0 2px 16px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.04) }`（demo.css:124-138）。
- **问题**：
  1. 🔴 主题盲（demo.css 类）。
  2. 🟠 `border-radius: 16px` 与 `--radius-card: 14px`（demo.css:22）**直接冲突**。
  3. 🟠 `box-shadow` 用字面 rgba 而非 `var(--shadow-card)`。
  4. 🟠 `padding: 0 10%` 百分比策略与个人空间 `max-width: 1200px` 策略不一致（见 §2.4）。
  5. 🟡 `max-height: 68vh` + `justify-content: center` 在低高度视口下卡片可能溢出滚动但外层无 `overflow` 声明。
  6. 🟡 2×2 grid 硬编码行数，若 `listAgents()` 返回非 4 项（未来扩展），布局会错位。

#### 2.2.2 视频模块 VideoModulePage（`modules/video/VideoModulePage.tsx`，307 行，真实 GA 域）

- **布局**：三栏水平 flex → `HistoryPanel`（左，295px）| `panel-chat`（中，flex:1，chat-header/messages/input-area 各带 `margin: 0 10%`）| `VideoPreviewPanel`（右，0↔50% 可展开）。
- **根节点**：`<section className="page-detail visible video-layout view-fade-in ${previewOpen?' preview-open':''}">`（`VideoModulePage.tsx:217-223`）。
- **chat-header 内联**：`VideoModulePage.tsx:230` `style={{ display:'flex', alignItems:'center', gap:10 }}`；`:231` `style={{ fontSize:13 }}`；`:235` `style={{ fontSize:12, color:'var(--text-tertiary)' }}`。
- **问题**：
  1. 🔴 主题盲（demo.css + 内联遗留 token）。
  2. 🟠 `.page-detail { height: calc(100vh - 56px) }`（demo.css:199）—— 56px 魔法数。
  3. 🟠 chat-header/messages/input 用 `margin-left/right: 10%`（demo.css:316-321）造左右留白，`preview-open` 时归零（demo.css:327-331）—— 切换预览时内容宽度突变 80%→100%，视觉跳跃。
  4. 🟡 `EmptyWorkspace`（`:123`）用 `style={{ width:'auto', padding:'0 20px' }}` 覆盖 `.btn-new-session` 的 CSS 宽度——内联与类冲突。
  5. 🟡 `data-ws-status` 挂在能力域根节点（`:222` 注释说明是为 e2e 断言，因本平台不用 AppShell/StatusBar）—— 合理但应在 spec 记录。
  6. 🟡 `chat-header-right` 混用 demo.css 类（`.btn-preview-toggle`）与 Tailwind 组件（`<ModeSwitcher>`、`<StatusBadge>`）—— 两套样式体系在同一行混排。

#### 2.2.3 Drawio 模块 DrawioPage（`modules/drawio/DrawioPage.tsx`，50 行，demo 域）

- **布局**：三栏 → `DemoHistoryPanel`（左，240px，因 `.drawio-layout` 触发 demo.css:203-220）| `panel-preview`（中，常显，`flex:1 1 0%`，含 `DiagramCanvas`）| `panel-chat`（右，`flex:1 1 0%`）。
- **根节点**：`<section className="page-detail visible drawio-layout view-fade-in">`（`DrawioPage.tsx:17`）。
- **特殊**：`.drawio-layout` 关闭 `.btn-preview-toggle`/`.preview-header`/`.preview-body`（demo.css:217-219），让 `DiagramCanvas` 的 `.drawio-preview` 直接占满（demo.css:220）。
- **问题**：
  1. 🔴 主题盲。
  2. 🟠 `.demo-badge` 用绝对定位（demo.css:116-128）但 DrawioPage 在 `chat-header-title` 内用 `<span className="demo-badge" style={{ marginLeft: 8 }}>`（`DrawioPage.tsx:33`）—— `.demo-badge` 的 `position:absolute` 在非定位父级内表现异常，内联 `marginLeft` 与绝对定位混用易错位。
  3. 🟡 历史面板宽 240px（drawio）vs 295px（video/ui-design）—— 同一应用三栏宽度不统一，跨模块切换视觉跳变。

#### 2.2.4 UI 设计模块 UiDesignPage（`modules/ui-design/UiDesignPage.tsx`，65 行，demo 域）

- **布局**：三栏 → `DemoHistoryPanel`（左，295px）| `panel-chat`（中，`margin:0 10%`）| `UiPreviewPanel`（右，0↔50% 可展开）。
- **根节点**：`<section className="page-detail visible view-fade-in ${previewOpen?' preview-open':''}">`（`UiDesignPage.tsx:19-21`）—— 无 `video-layout`/`drawio-layout` 修饰，走 demo.css 默认三栏。
- **问题**：
  1. 🔴 主题盲。
  2. 🟠 同 DrawioPage 的 `.demo-badge` 内联 `marginLeft:8` 问题（`UiDesignPage.tsx:33`）。
  3. 🟡 三栏布局与 video 模块结构同构（`DemoHistoryPanel` + `panel-chat` + 可展开 `panel-preview`），但 video 用真实 `HistoryPanel`/`VideoPreviewPanel`，ui-design 用 demo 版—— 应抽统一 `<DetailLayout>` 容器。

#### 2.2.5 个人空间 SpacePage（`modules/space/SpacePage.tsx`，306 行）

- **布局**：垂直 stack → `space-header`（标题+副标题）+ `space-tabs`（能力域 tab 横排）+ `AgentAssetsTab`（`space-grid` 网格 + `space-pagination`）。
- **容器**：`.page-space { padding: 40px 32px; max-width: 1200px; margin: 0 auto; min-height: calc(100vh - 56px) }`（demo.css:1111-1117）。
- **网格**：`.space-grid { grid-template-columns: repeat(auto-fill, minmax(280px,1fr)); gap: 20px }`（demo.css:1148-1152）。
- **Modal**：视频预览 Modal 用 Tailwind 工具类 `fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8`（`SpacePage.tsx:232`），关闭按钮 `border-white/40 text-white`（`:250`）。
- **问题**：
  1. 🔴 卡片用 demo.css 类（`.space-card`/`.space-card-thumb`/`.thumb-ui`）→ 主题盲；但 Modal 遮罩用 Tailwind → 主题感知（恒深遮罩，合理）。混合体系。
  2. 🟠 容器策略 `max-width: 1200px` 居中，与主页 `padding: 0 10%; max-width: none`（全宽百分比）不一致。
  3. 🟠 Modal `style={{ width: 'min(960px, 100%)' }}`（`:236`）内联宽度—— 应令牌化。
  4. 🟠 Modal 是第三处「居中浮层」实现（与 `SettingsPanel`/`ConfirmDialog` 重复），未抽 `ModalShell`。
  5. 🟡 `.space-card` 用 `var(--radius-card)`（demo.css:1154）✅ 令牌化正确，但 `.module-card` 用字面 `16px`—— 同应用内卡片圆角不统一。

### 2.3 共享组件布局

#### 2.3.1 主题感知组件（Tailwind token，布局规范）

| 组件 | 布局要点 | 备注 |
|---|---|---|
| `SettingsPanel.tsx` | 右抽屉：`fixed inset-0 z-[200] bg-black/40` + `aside absolute top-0 right-0 h-full w-full max-w-sm` | 焦点圈定 ✅；`max-w-sm` 与 `design-frontend-modal-layout` D5 决策（ConfirmDialog 改 `max-w-md`）不冲突，因抽屉≠居中弹窗 |
| `ConfirmDialog.tsx` | 居中：`fixed inset-0 z-50 flex center bg-black/40 p-4` + `div w-full max-w-md rounded-xl p-6` | 已落地 D5（`max-w-md`）✅；按钮组 `mt-6 flex justify-end gap-3` 符合 spec |
| `ErrorBanner.tsx` | 顶栏下横幅：`flex items-center gap-2 border-b px-4 py-2` | 非 fixed/sticky，占文档流 |
| `Welcome/WelcomeScreen.tsx` | 未读源码，但 subagent 报 8 处 Tailwind token | 主题感知 |
| `Session/*`、`Chat/*`、`Approval/*`、`Layout/*` | 全 Tailwind token | 主题感知 |

#### 2.3.2 主题盲组件（demo.css 类）

| 组件 | 布局要点 | 问题 |
|---|---|---|
| `shared/AppHeader.tsx` | demo.css `.app-header` 等 | 见 §2.1.3 |
| `modules/demo-shared/DemoChat.tsx`、`DemoHistoryPanel.tsx` | demo.css `.chat-*`/`.panel-history` | 主题盲；被 ui-design/drawio 复用 |
| `modules/video/HistoryPanel.tsx`、`VideoPreviewPanel.tsx`、`ModelSelector.tsx` | demo.css + 内联遗留 token | 主题盲；内联样式多处 |
| `components/Terminal/TerminalView.tsx` | xterm + `TerminalTheme` | 主题感知（独立通道，经 `themes.ts.terminal`）✅ |

### 2.4 跨切面布局问题

#### 2.4.1 容器策略三套互不对齐

| 页面 | 容器策略 | 来源 |
|---|---|---|
| 主页 | `padding: 0 10%; max-width: none`（百分比全宽） | demo.css:97-99 |
| 个人空间 | `padding: 40px 32px; max-width: 1200px; margin: 0 auto`（固定居中） | demo.css:1111-1117 |
| 能力域详情页 | `height: calc(100vh - 56px)`（全高三栏，无外 padding） | demo.css:199 |
| SettingsPanel | `max-w-sm`（固定居右抽屉） | SettingsPanel.tsx:34 |
| ConfirmDialog | `max-w-md`（居中） | ConfirmDialog.tsx:44 |

→ 三种水平容器策略（百分比 / 固定居中 / 全宽三栏）+ 两种垂直策略（`100vh - 56px` / 自然高度），无统一 `--container-*` 令牌。

#### 2.4.2 圆角令牌 vs 字面值冲突

| 规则 | 写法 | 文件:行 | 是否令牌化 |
|---|---|---|---|
| `--radius-card` 定义 | `14px` | demo.css:22 | — |
| `.module-card` | `border-radius: 16px` | demo.css:126 | ❌ 字面，且与令牌冲突 |
| `.space-card` | `var(--radius-card)` | demo.css:1154 | ✅ |
| `.preview-frame` | `var(--radius-md)` | demo.css:615 | ✅ |
| `.btn-new-session` | `var(--radius-md)` | demo.css:252 | ✅ |
| `.chat-input-box` | `var(--radius-lg)` | demo.css:427 | ✅ |
| `.module-card-enter` | `border-radius: 10px` | demo.css:186 | ❌ 字面 |
| `.btn-model` / `.btn-upload` | `border-radius: 14px` | demo.css:477,526 | ❌ 字面 |

#### 2.4.3 阴影令牌 vs 字面值

`--shadow-card`/`--shadow-elevated`/`--shadow-header` 已定义（demo.css:9-11），但：

| 规则 | 写法 | 文件:行 |
|---|---|---|
| `.module-card` | `0 2px 16px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.04)` | demo.css:127 |
| `.module-card:hover` | `0 4px 24px rgba(0,0,0,0.1), 0 0 1px rgba(0,0,0,0.04)` | demo.css:136 |
| `.msg-ai` | `var(--shadow-card)` | demo.css:407 | ✅ |
| `.space-card` | `var(--shadow-card)` / `var(--shadow-elevated)` | demo.css:1155,1159 | ✅ |
| `.preview-frame` | `var(--shadow-elevated)` | demo.css:616 | ✅ |

#### 2.4.4 间距令牌 `--space-*` 几乎未被使用

`--space-xs/sm/md/lg/xl/2xl`（demo.css:27-32）已定义，但搜索 demo.css 全文，**绝大多数 padding/margin/gap 仍是字面 `px`**（`16px`/`24px`/`12px`/`8px`/`4px`/`20px`/`32px` 等）。`--space-*` 仅在 `design-frontend-modal-layout` 落地的浮层组件（`.model-dropdown`、`.model-option`，demo.css:493,499）及 `ConfirmDialog` 的 Tailwind `gap-3`/`mt-3`/`mt-6` 中体现。**令牌定义了却几乎没用**是最大的浪费。

#### 2.4.5 魔法数 56px 顶栏高度

`demo.css` 中 `calc(100vh - 56px)` 出现处（subagent 报告 TSX 内 0 处，全在 CSS）：

| 规则 | 文件:行 |
|---|---|
| `.page-home { min-height: calc(100vh - 56px) }` | demo.css:100 |
| `.page-detail { height: calc(100vh - 56px) }` | demo.css:199 |
| `.page-space { min-height: calc(100vh - 56px) }` | demo.css:1116 |

无 `--header-height: 56px` 令牌。顶栏高度一旦调整（如响应式收缩到 48px），三处 calc 需手改。

#### 2.4.6 z-index 无全局表

| 元素 | z-index | 来源 |
|---|---|---|
| `.app-header` | `100` | demo.css:51 |
| `ConfirmDialog` 遮罩 | `z-50`（Tailwind） | ConfirmDialog.tsx:35 |
| `SettingsPanel` 遮罩 | `z-[200]`（Tailwind 任意值） | SettingsPanel.tsx:23 |
| `SpacePage` 视频预览 Modal | `z-[200]`（Tailwind 任意值） | SpacePage.tsx:232 |
| `.model-dropdown` | `50` | demo.css:495 |
| `.panel-preview.expanded`（640px 以下） | `10` | demo.css:1088 |
| `ErrorBanner` | 无（占文档流） | ErrorBanner.tsx:24 |
| `.video-controls-bar` | `10` | demo.css:922 |

无 `--z-header`/`--z-dropdown`/`--z-modal`/`--z-toast` 令牌，叠层靠记忆与巧合（Modal `z-[200]` > Header `100` > Dropdown `50` 凑巧正确，但无约束）。

#### 2.4.7 响应式双轨

| 体系 | 断点 | 出现位置 |
|---|---|---|
| CSS `@media` | `1100px` / `900px` / `640px` | demo.css:1044-1108, 1256-1268 |
| Tailwind 工具类 | `sm:`(640) / `md:`(768) / `lg:`(1024) | ConfirmDialog.tsx、SettingsPanel.tsx:11、SpacePage.tsx:232,250、ThemeSelector.tsx:11 |

两套断点不互证（`1100px` 与 Tailwind 无对应；`640px` 恰等于 `sm:` 但语义不同）。

### 2.5 重复/应统一的布局模式

#### 2.5.1 居中浮层三处重复（与 modal-layout spec 待办一致）

| 实现 | 遮罩 | 容器 | 关闭 |
|---|---|---|---|
| `SettingsPanel.tsx:22-35` | `fixed inset-0 z-[200] bg-black/40` | `aside absolute top-0 right-0 h-full w-full max-w-sm` | `X` 按钮 + Escape + 点遮罩 |
| `ConfirmDialog.tsx:33-45` | `fixed inset-0 z-50 flex center bg-black/40 p-4` | `div w-full max-w-md rounded-xl p-6` | 取消按钮 + Escape + 点遮罩 |
| `SpacePage.tsx:229-255` | `fixed inset-0 z-[200] flex center bg-black/60 p-8` | `div style={width:min(960px,100%)}` | 关闭按钮 + 点遮罩（无 Escape、无焦点圈定） |

→ 三套遮罩、三套关闭逻辑、两套 z-index。应抽 `ModalShell`（`design-frontend-modal-layout` spec 已记待办）。

#### 2.5.2 三栏详情页模式重复

`video-layout` / `drawio-layout` / 默认（ui-design）三套三栏布局，差异仅在：
- 历史面板宽度（240 / 295 / 295）
- 预览面板可见性（常显 / 可展开 / 可展开）
- chat 区左右留白（无 / 10% / 10%）

应在 `DetailLayout` 容器上参数化（`historyWidth` / `previewMode: 'always' | 'toggle' | 'none'` / `chatInset`）。

#### 2.5.3 卡片模式重复

`.module-card`（主页）与 `.space-card`（个人空间）结构同构（thumb + body + footer），但圆角（16px vs `--radius-card`）、阴影（字面 vs 令牌）、hover 变换（`translateY(-4px)` vs `translateY(-3px)`）均不一致。

---

## 3. Top 15 布局/主题异味（按严重度排序）

| # | 严重度 | 异味 | 证据 | 修复方向 |
|---|---|---|---|---|
| 1 | 🔴 | 主题引擎只写 `--app-*`，demo.css 用遗留 token 族 B，切主题大面积不变色 | `ThemeProvider.tsx:11-18` + `demo.css:2-35` | 令 demo.css 遗留 token 派生自 `--app-*`（如 `--bg-module: var(--app-surface)`），或 ThemeProvider 同时写两套 |
| 2 | 🔴 | demo.css 零 `data-theme` 选择器，37+ 硬编码 hex | 全文搜索 0 命中；demo.css:193-196,410,625,814,875… | 删硬编码色，改用 `--app-*` 派生；深色专属覆盖用 `[data-theme="dark"] .x{...}` |
| 3 | 🔴 | TSX 内联 `var(--text-tertiary)` 等遗留 token | router.tsx:25；VideoModulePage.tsx:235；VideoPreviewPanel.tsx:52,87-94,104-111；HistoryPanel.tsx:46-94 | 改用 Tailwind token（`text-muted`/`border-line`/`bg-surface`）或族 A `var(--app-text-muted)` |
| 4 | 🟠 | `.module-card` `border-radius:16px` 与 `--radius-card:14px` 冲突 | demo.css:22,126 | 统一为 `var(--radius-card)`，或令 `--radius-card:16px` |
| 5 | 🟠 | `.module-card` 阴影字面 rgba 而非 `var(--shadow-card)` | demo.css:127,136 | 改用令牌 |
| 6 | 🟠 | `calc(100vh - 56px)` 魔法数三处 | demo.css:100,199,1116 | 定义 `--header-height: 56px`，改 `calc(100vh - var(--header-height))` |
| 7 | 🟠 | 容器策略三套（百分比/固定居中/全宽三栏）无 `--container-*` 令牌 | demo.css:97,1111,199 | 定义 `--container-page`/`--container-detail` 令牌，统一基线 |
| 8 | 🟠 | `--space-*` 令牌定义却几乎不用 | demo.css:27-32 定义；全文 `padding/gap` 多为字面 px | 逐步替换字面 px 为 `var(--space-*)` |
| 9 | 🟠 | 居中浮层三处重复（SettingsPanel/ConfirmDialog/SpacePage Modal） | 见 §2.5.1 | 抽 `ModalShell`（modal-layout spec 待办） |
| 10 | 🟡 | z-index 无全局表 | demo.css:51,495；ConfirmDialog z-50；SettingsPanel z-[200]；SpacePage z-[200] | 定义 `--z-header/dropdown/modal/toast` 令牌 |
| 11 | 🟡 | 三栏详情页三套变体（video/drawio/default）逻辑同构异写 | demo.css:202-220,304-321,1037-1041 | 抽 `DetailLayout` 参数化 |
| 11 | 🟡 | 历史面板宽度 240/295/295 三栏不统一 | demo.css:224,305-306 | 定义 `--history-width-*` 令牌 |
| 13 | 🟡 | `.demo-badge` 绝对定位 + 内联 `marginLeft` 混用 | DrawioPage.tsx:33；UiDesignPage.tsx:33；demo.css:116-128 | `.demo-badge` 在非定位父级内改 inline-flex（已有 `.demo-badge-inline`） |
| 14 | 🟡 | `ThemeProvider` 不监听 `prefers-color-scheme`，不写 `color-scheme` | ThemeProvider.tsx:20-28 | 加 `matchMedia` 兜底 + `root.style.colorScheme` |
| 15 | 🟢 | 响应式双轨（CSS @media 1100/900/640 vs Tailwind sm/md/lg） | demo.css:1044-1108；多 tsx | 统一断点令牌或在 demo.css 引入 Tailwind 断点对齐 |

---

## 4. 修复路线图（建议分阶段，不在此报告内实施）

### 阶段 A — 主题全局化（解决用户问题 ②，最高优先）

1. **统一 token 族**：在 `demo.css:2-35` 把遗留 token 改为派生自 `--app-*`，例如：
   ```css
   :root {
     --bg-page: var(--app-bg);
     --bg-module: var(--app-surface);
     --bg-input: var(--app-surface-alt);
     --bg-hover: color-mix(in srgb, var(--app-surface) 92%, var(--app-text) 8%);
     --border-light: var(--app-border);
     --accent: var(--app-accent);
     --accent-light: color-mix(in srgb, var(--app-accent) 12%, var(--app-surface));
     --accent-hover: color-mix(in srgb, var(--app-accent) 88%, #000 12%);
     --text-primary: var(--app-text);
     --text-secondary: var(--app-text-muted);
     --text-tertiary: color-mix(in srgb, var(--app-text-muted) 80%, var(--app-bg));
     --text-on-accent: var(--app-accent-fg);
   }
   ```
   （`--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*` 保持静态令牌，与主题无关。）
2. **替换 demo.css 内 37+ 硬编码 hex**：模块图标渐变改用 `var(--app-accent)` 派生；`#f8f9fb` 改 `var(--app-surface-alt)`；`#059669` 改 `var(--app-success)`；代码块深色（`#1e1e2e` 等）保留或抽 `--code-bg`。
3. **清理 TSX 内联遗留 token**：把 `var(--text-tertiary)` 等改为 Tailwind token 或 `var(--app-text-muted)`。
4. **ThemeProvider 增强**：监听 `prefers-color-scheme`；写 `root.style.colorScheme`。
5. **验收**：切 5 主题逐页截图，归档 `docs/ui-theme-before-after/`。

### 阶段 B — 布局令牌化（解决用户问题 ①）

1. 定义 `--header-height`、`--container-page`、`--container-detail`、`--history-width-*`、`--z-*` 令牌。
2. 把 `calc(100vh - 56px)`、`max-width: 1200px`、`padding: 0 10%`、z-index 任意值全部令牌化。
3. `.module-card` 圆角/阴影对齐 `.space-card`。
4. 字面 px 间距逐步替换为 `var(--space-*)`（优先改 chat-* / panel-* / module-card-*）。

### 阶段 C — 结构抽象

1. 抽 `ModalShell`（统一遮罩 + 容器 + Escape + 焦点圈定 + 点遮罩关闭）→ SettingsPanel/ConfirmDialog/SpacePage Modal 复用。
2. 抽 `DetailLayout`（参数化三栏：historyWidth / previewMode / chatInset）→ video/drawio/ui-design 复用。
3. 抽 `Card` 基组件（thumb + body + footer）→ module-card/space-card 复用。

### 阶段 D — 响应式统一

1. 选定单一响应式策略（建议 Tailwind `sm/md/lg/xl` 工具类），逐步把 `demo.css` 的 `@media` 迁移为 Tailwind 工具类或 CSS 变量断点。
2. 校验 640px 以下三栏 → 单栏堆叠的行为一致性。

---

## 5. 附录：关键文件清单

| 类别 | 文件 |
|---|---|
| 主题引擎 | `src/theme/themes.ts`、`src/theme/ThemeProvider.tsx`、`src/theme/ThemeContext.ts`、`src/hooks/useTheme.ts` |
| 样式 | `src/index.css`、`src/styles/demo.css`（1273 行）、`tailwind.config.ts` |
| 入口/路由 | `src/main.tsx`、`src/App.tsx`、`src/router.tsx` |
| 顶栏 | `src/shared/AppHeader.tsx`、`src/shared/icons.tsx` |
| 模块 | `src/modules/home/HomePage.tsx`、`src/modules/video/{VideoModulePage,HistoryPanel,VideoPreviewPanel,ModelSelector,CustomVideoPlayer}.tsx`、`src/modules/drawio/{DrawioPage,DiagramCanvas}.tsx`、`src/modules/ui-design/{UiDesignPage,UiPreviewPanel,previewCode}.ts(x)`、`src/modules/space/SpacePage.tsx`、`src/modules/demo-shared/{DemoChat,DemoHistoryPanel}.tsx` |
| 主题感知组件 | `src/components/Settings/{SettingsPanel,ThemeSelector,ApiKeyInput}.tsx`、`src/components/Common/{ConfirmDialog,ErrorBanner,HealthBadge}.tsx`、`src/components/Session/*`、`src/components/Chat/*`、`src/components/Approval/*`、`src/components/Layout/*`、`src/components/Welcome/*` |
| 终端 | `src/components/Terminal/TerminalView.tsx`、`src/components/Terminal/TerminalTheme.ts`（独立主题通道） |

---

**报告结束。** 后续将基于本报告与用户确认的优先级，落 openspec change（建议名：`2026-08-02-design-frontend-theme-unify-and-layout-tokens`），再按阶段 A→D 实施。
