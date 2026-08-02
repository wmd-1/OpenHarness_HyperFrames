## Context

`design-agent-frontend` 存在两个互不连通的 CSS 变量族与一组布局令牌矛盾，详见审计报告 `docs/design-frontend-ui-layout-theme-audit.md`。现状：

- **族 A（主题感知）**：`src/theme/themes.ts` 定义 5 套主题的 `cssVars`（14 个 `--app-*` 键）；`src/theme/ThemeProvider.tsx` 的 `applyTheme()` 把 `--app-*` 写入 `documentElement` inline style；`src/index.css` `:root` 兜底 14 个 `--app-*`，`@theme inline` 把它们映射为 Tailwind 颜色 token（`bg-base`/`text-fg`/`color-accent`…）。仅 `components/{Settings,Session,Chat,Common,Approval,Layout,Welcome}` 用 Tailwind token → 主题感知。
- **族 B（主题盲，遗留）**：`src/styles/demo.css:2-35` `:root` 定义 `--bg-page`/`--bg-module`/`--bg-input`/`--bg-hover`/`--border-light`/`--accent`/`--accent-light`/`--accent-hover`/`--text-primary`/`--text-secondary`/`--text-tertiary`/`--text-on-accent`（+ `--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*`），**从不被 ThemeProvider 更新**。`demo.css` 零 `data-theme` 选择器、含 37+ 硬编码 hex。`~80%` 可见面积（顶栏、主页、四能力域详情页、个人空间、聊天面板、消息气泡）由 demo.css 驱动 → 主题盲。
- **TSX 内联遗留 token 泄漏**：`router.tsx:25`、`VideoModulePage.tsx:235`、`VideoPreviewPanel.tsx`(52/87-94/104-111)、`HistoryPanel.tsx`(46-94)、`previewCode.ts` 在 `style={{}}` 内引用族 B。
- **布局令牌矛盾**：`.module-card` `border-radius:16px` 与 `--radius-card:14px` 冲突；`.module-card` box-shadow 字面 rgba 非 `var(--shadow-card)`；`calc(100vh-56px)` 魔法数三处（`demo.css:100,199,1116`）无 `--header-height` 令牌；`--space-*` 令牌定义却几乎未被引用（字面 px 满天飞）；z-index 无全局表（`z-50`/`z-100`/`z-[200]`/无值混用）；容器策略三套（主页 `padding:0 10%` / 个人空间 `max-width:1200px` / 详情页全高三栏）。
- **ThemeProvider 隐性缺陷**：`loadInitialTheme()`（`ThemeProvider.tsx:20-28`）只读 localStorage，无 `prefers-color-scheme` 兜底；`applyTheme` 不写 `color-scheme`，原生控件仍亮。

约束：不改 DOM 结构、ARIA 契约、focus trap、交互逻辑、`themes.ts` 主题色板；测试须在既有 Docker 镜像内执行（项目硬约定）；`design-frontend-modal-layout` spec 已落地的 `--space-*`/`--leading-*` 与「单一维度单一写法」规则继续有效，本次是其姊妹扩展。

## Goals / Non-Goals

**Goals:**

- 桥接双 token 族，使 demo.css 驱动的全部 UI 跟随主题切换（用户问题②）。
- 消除 demo.css 37+ 硬编码 hex 与 TSX 内联遗留 token。
- ThemeProvider 增强：`prefers-color-scheme` 兜底 + `color-scheme` 同步。
- 新增布局令牌（`--header-height`/`--z-*`/`--container-*`），修正令牌矛盾（圆角/阴影/间距），让布局可全局调参（用户问题①）。
- 改动可分级验证、可回滚（A 主题 → B 布局令牌，每级门禁）。

**Non-Goals:**

- 不抽 `ModalShell`/`DetailLayout`/`Card` 公共组件（涉及 DOM/focus-trap 重构，风险高；与 `design-frontend-modal-layout` spec 待办一致，待本次量化重复程度后单独立项）。
- 不统一响应式策略（demo.css `@media` 与 Tailwind `sm/md/lg` 并存留待后续；本次仅令牌化不破现有断点行为）。
- 不改 `themes.ts` 主题色板、不改任何交互/ARIA/DOM 结构/WS/Store/API、不改 `ErrorBanner.tsx`（已达基线）。
- 不新增依赖、不引入 i18n。

## Decisions

### D1：桥接策略——遗留 token 在 demo.css :root 派生自 `--app-*`

**决策**：在 `src/styles/demo.css:2-35` 把遗留颜色 token 改为派生自 `--app-*`：

```css
:root {
  --bg-page: var(--app-bg);
  --bg-module: var(--app-surface);
  --bg-input: var(--app-surface-alt);
  --border-light: var(--app-border);
  --border-focus: var(--app-accent);
  --accent: var(--app-accent);
  --text-primary: var(--app-text);
  --text-secondary: var(--app-text-muted);
  --text-on-accent: var(--app-accent-fg);
  /* 派生色见 D2 */
}
```

`--shadow-*`/`--radius-*`/`--font-stack`/`--transition-*`/`--space-*`/`--leading-*` 保持静态（与主题无关）。

**理由**：单一真相源 = `themes.ts`；ThemeProvider 保持简单（只写 `--app-*`）；demo.css 类无需逐个改写（仍用 `var(--bg-module)`，只是 `--bg-module` 的值来源变了）；改动集中在 demo.css 头部 + 硬编码色清理，blast radius 小。

**备选**：① ThemeProvider 同时写两套（`--app-*` + `--bg-*`）——否决，themes.ts 需双倍维护、易漂移；② 把 demo.css 类全部改用 `--app-*`——否决，改动面巨大（151 处引用）且 demo.css 原生类无法用 Tailwind 响应式变体。

### D2：派生色用 `color-mix()` 自动适配任意主题

**决策**：派生色用 `color-mix(in srgb, ...)` 从 `--app-*` 计算：

```css
--bg-hover: color-mix(in srgb, var(--app-surface) 92%, var(--app-text) 8%);
--accent-light: color-mix(in srgb, var(--app-accent) 12%, var(--app-surface));
--accent-hover: color-mix(in srgb, var(--app-accent) 88%, #000 12%);
--text-tertiary: color-mix(in srgb, var(--app-text-muted) 70%, var(--app-bg) 30%);
```

**理由**：5 主题色板差异大（cyberpunk accent=`#ff2ea6`、solarized accent=`#268bd2`），静态 `--accent-light:#e8f0fe` 仅适配 default；`color-mix` 让派生色对任意主题自动正确，无需在 themes.ts 为每主题预计算派生色。

**备选**：在 themes.ts 为每主题预计算 `accentLight`/`bgHover`/`textTertiary`——否决，themes.ts 膨胀、新增主题需手算派生色。

**浏览器支持**：`color-mix()` Baseline 2023（Chrome 111+、Safari 16.2+、FF 113+）；E2E 镜像 `chrome-headless-shell` 为近期版本，支持。旧浏览器降级为忽略（内部工具，可接受）。

### D3：ThemeProvider 增强——系统偏好兜底 + `color-scheme` 同步

**决策**：
1. `loadInitialTheme()`：localStorage 有偏好→用之；无偏好→读 `matchMedia('(prefers-color-scheme: dark)')`，dark→`dark`，否则 `default`。
2. `applyTheme()`：除写 `--app-*` 与 `data-theme` 外，同步设 `root.style.colorScheme = name === 'dark' ? 'dark' : 'light'`（cyberpunk/minimal/solarized 按亮/暗归类：dark/cyberpunk→`dark`，default/minimal/solarized→`light`）。
3. 用户显式 `setTheme` 后写 localStorage，**不再**监听系统变化（显式选择优先）。

**理由**：首次访问跟随系统是现代 Web 默认（`prefers-color-scheme` 广泛支持）；`color-scheme` 让原生 scrollbar/`<select>`/autofill 跟随，消除「主题切了但滚动条仍亮」的违和。

**备选**：始终监听系统（`matchMedia.addEventListener('change')`）——否决，用户显式选了 solarized 后系统切 dark 不应强翻回 dark，破坏用户控制感。

### D4：布局令牌——`--header-height`/`--z-*`/`--container-*`

**决策**：demo.css `:root` 新增：

```css
--header-height: 56px;
--z-header: 100;
--z-dropdown: 50;
--z-modal: 200;
--z-toast: 300;
--container-page: 1200px;
--container-detail: none; /* 详情页全宽三栏 */
```

- `calc(100vh - 56px)` 三处 → `calc(100vh - var(--header-height))`。
- `.app-header` `z-index:100` → `var(--z-header)`；`.model-dropdown` `z-index:50` → `var(--z-dropdown)`；SettingsPanel/SpacePage Modal `z-[200]` → `var(--z-modal)`（Tailwind 任意值改为内联或类引用）。
- 主页 `padding:0 10%; max-width:none` 与个人空间 `max-width:1200px` 暂保留（策略差异是设计意图：主页全宽居中、个人空间固定居中），但 `1200px` 抽为 `var(--container-page)` 令牌化。

**理由**：消除魔法数 56px（顶栏改高度连锁断裂）；z-index 全局表防叠层错乱（Modal 200 > Header 100 > Dropdown 50，toast 预留 300）；容器宽度可全局调参。

**备选**：主页与个人空间统一为同一 `--container-page` 策略——否决，主页 2×2 卡片矩阵需全宽视觉，个人空间卡片网格需固定居中，策略差异是设计意图。

### D5：令牌矛盾修正——圆角统一 16px、阴影令牌化

**决策**：
- `--radius-card` 由 `14px` 调为 `16px`（更现代的圆角）；`.module-card` `border-radius:16px` → `var(--radius-card)`；`.space-card` 已用 `var(--radius-card)` 同步变为 16px。
- `.module-card`/`.module-card:hover` box-shadow 字面 rgba → `var(--shadow-card)`/`var(--shadow-elevated)`。
- 字面 px 间距（`.chat-*`/`.panel-*`/`.module-card-*` 的 padding/gap/margin）优先替换为 `var(--space-*)`（`.module-card-icon` `padding:44px 32px 28px` 例外，属卡片视觉特殊比例，保留但抽 `--module-icon-pad-*` 或注释为设计意图）。

**理由**：令牌定义却不用是最大浪费；圆角 16 vs 14 直接冲突必须统一；阴影令牌已存在却不用。

**备选**：`--radius-card` 保持 14px、`.module-card` 改 14px——否决，16px 更现代且 space-card 微调可接受。

### D6：硬编码色分类处理——品牌派生 / 状态语义 / 恒深保留

**决策**：demo.css 37+ 硬编码 hex 分三类：
1. **品牌/强调色**（`#1a56db`/`#3b82f6`/`#d97706`/`#f59e0b` 模块图标渐变、`#475569`/`#64748b` space 图标）→ `var(--app-accent)` + `color-mix` 派生渐变，或保留为各域品牌色但派生自 `--app-accent`（如 `.icon-ui` 用 `linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent) 70%, #fff 30%))`）。
2. **状态语义色**（`#059669` 绿 AI 标签/上传、`#d97706`/`#f59e0b` 视频、`#dc2626` 红）→ `var(--app-success)`/`var(--app-warning)`/`var(--app-error)` 派生。
3. **恒深背景**（`#0d0d12`/`#1a1a2e`/`#16213e`/`#0f3460` 视频播放器、`#1e1e2e`/`#2d2d3f` 代码块、`#f8f9fb` preview-frame-bar/drawio-status-bar）→ 视频播放器与代码块抽 `--player-bg`/`--code-bg` 语义令牌（恒深，设计意图，不随主题）；`#f8f9fb`（浅灰条）改 `var(--app-surface-alt)` 跟随主题。

**理由**：模块图标在 cyberpunk 主题下应变粉、在 solarized 下应变蓝，不应恒为 `#1a56db`；视频播放器恒深是媒体惯例（YouTube/B 站均如此），保留；代码块配色（Catppuccin 风格）恒深属设计意图。

**备选**：全部硬编码色一刀切改 `var(--app-*)`——否决，视频播放器/代码块恒深是设计意图。

## Risks / Trade-offs

- [`color-mix()` 旧浏览器不支持] → 内部工具 + E2E 镜像 chrome-headless-shell 近期版本，可接受；若需兼容旧浏览器，可加 `@supports` 兜底静态值（本次不做）。
- [桥接后某主题下对比度不足（如 solarized 派生 `--accent-light` 与文字对比）] → 五主题逐页截图验收（Requirement 多主题全局生效），不达标则调 themes.ts 色值（不在本次 spec 范围，记为 Open Question）。
- [改动 demo.css `:root` 派生后，组件视觉数值不变但来源变，可能暴露既有隐性 bug（如某处误用 `--bg-module` 当强调色）] → 改动限定在 `:root` 派生 + 硬编码色清理，不动类选择器规则体；单测全绿 + 截图回归双重门禁。
- [z-index 令牌化后 Tailwind 任意值 `z-[200]` 改为内联 `style={{zIndex:'var(--z-modal)'}}` 违反 modal-layout spec「禁止 JSX 内联间距/颜色」] → z-index 非间距/颜色维度，属动态叠层引用，允许；或改用 demo.css 类（SettingsPanel 抽屉类）。优先用 Tailwind 任意值 `z-[var(--z-modal)]`（Tailwind 4 支持变量引用）。
- [令牌化改动面扩散] → 严格限文件清单（见 Impact）；A→B 分级门禁；每级独立 commit 便于回滚。
- [`--radius-card` 14→16 改动 space-card 视觉] → 微小圆角增大，现代风格一致，截图回归确认无破版。
