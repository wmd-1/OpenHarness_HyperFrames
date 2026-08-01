## Context

`design-agent-frontend` 浮层组件（Modal/Dialog/Drawer/Dropdown）存在文字拥挤、间距不合理问题。现状：

- `src/styles/demo.css :root` 仅有 `--radius-*`/`--shadow-*`/`--transition-*`/`--font-stack`，**缺间距与行高令牌**；间距全靠各组件零散 Tailwind 类，无法全局调参。
- 正文普遍用 Tailwind `text-sm`/`text-xs`，内置 `line-height` 1.43/1.33，对中文段落偏紧（WCAG 1.4.8 建议 ≥ 1.5）。
- 各浮层 `max-w-*`/`p-*`/`gap-*` 取值不一：容器 `p-4`/`p-5` 混用、按钮组统一 `gap-2`(8px) 低于 Apple HIG 12px、标题↔正文 `mt-2`(8px) 偏紧。
- 双行列表项（`WorkspaceFilesPanel`、`CreateDialog` 策略卡）两行文本 `block` 贴合无间距。
- `modules/space/SpacePage.tsx` 视频预览 Modal 用内联 `style` 硬编码颜色/间距，绕过设计系统，暗主题下不可用。

约束：不改 DOM 结构、ARIA 契约、focus trap、交互逻辑、主题色板（`themes.ts`）；测试须在已有 Docker 镜像内执行（项目硬约定）。

## Goals / Non-Goals

**Goals:**

- 建立 `--space-*`/`--leading-*` 设计令牌，使间距可全局调参。
- 统一浮层布局基线：正文行高 ≥ 1.5、容器内边距 ≥ 20px（内容框 24px）、标题↔正文 ≥ 12px、按钮组 gap ≥ 12px、双行列表项有微间距。
- 修复 `SpacePage` 预览 Modal 暗主题不可用（去内联硬编码，接入 Tailwind 类与令牌）。
- 改动可逐级验证、可回滚（P0/P1/P2 分级 + 门禁）。

**Non-Goals:**

- 不抽取 `ModalShell` 公共原语（涉及 focus trap/ARIA/DOM 重构，风险高于样式调整；待本次落地后量化重复程度再单独立项）。
- 不改 `themes.ts` 主题色板、不改 WS/Store/API 层、不改 `ErrorBanner.tsx`（已达基线）。
- 不改任何交互逻辑、文案、ARIA 语义、DOM 结构。
- 不新增依赖、不引入 i18n。

## Decisions

### D1：令牌与 Tailwind 工具类单一维度单一写法

**决策**：组件 JSX 内布局间距用 Tailwind 工具类（`p-6`/`mt-3`/`gap-3`/`leading-relaxed`）；`demo.css` 原生 CSS 类（`.btn-*`/`.history-item`/`.model-option`）用 `var(--space-*)`/`var(--leading-*)` token；内联 `style` 仅允许纯动态数值（如 `width: min(960px,100%)`），颜色/间距必须走 token。

**理由**：Tailwind 工具类与响应式/状态变体（`md:`/`hover:`）天然集成、可读性好；原生 CSS 类无法用 Tailwind 类，需 token 提供旋钮。两者数值必须对齐（`--space-md:12px` ↔ `gap-3`），是"同一间距体系两层的两种表达"而非两套规范。

**备选**：① 全部用 token（在 JSX 写 `style={{padding:'var(--space-xl)'}}`）——否决，丧失 Tailwind 响应式变体能力、可读性差；② 全部用 Tailwind 类、不引入 token——否决，`demo.css` 原生类无法表达、内联场景无旋钮。

**反模式（禁止）**：JSX 用 `style` 表达容器内边距；`demo.css` 原生类硬编码 `padding:24px`；同组件同维度 token 与 Tailwind 类混用。

### D2：剥离 ModalShell，本次仅纯样式整改

**决策**：不抽取 `ModalShell` 公共原语；所有组件就地 className 调整，不改 DOM 结构。

**理由**：ModalShell 涉及 `useFocusTrap` 复用、ARIA 契约、DOM 结构调整，风险显著高于 className 调整；且整改前难以量化重复程度。

**备选**：本次同步抽 ModalShell——否决，风险叠加、评审与回滚成本高；改为待本次落地后统计各浮层 overlay/container 重复行数，若 ≥3 处且每处 ≥15 行，再单独立项。

### D3：P0/P1/P2 分级 + 阶段门禁

**决策**：P0（ApprovalModal 三件套 + ConfirmDialog + CreateDialog）→ P1（SettingsPanel + WorkspaceFilesPanel 抽屉）→ P2（ModelSelector 下拉 + SpacePage 预览去内联）；每级完成后跑单测 + 视觉回归，门禁不过不进下一级。

**理由**：用户直接感知的"提示框拥挤"集中在 P0；分级隔离风险，避免一次性大改。

### D4：关键数值依据

**决策**：正文 `leading-relaxed`(1.625)、容器 `p-6`(24px)、按钮组 `gap-3`(12px)、标题↔正文 `mt-3`(12px)——对齐 Material 3/Apple HIG/WCAG。专项：

- `DiffApproval` diff 区 `max-h-64→max-h-72`：256px 容 12 行（20px/行），OH 编辑 diff 常 15–20 行需频繁滚动；288px 容 14 行，且在 768px 视窗占 37%（<40% 阈值）。
- `QuestionPrompt` textarea `rows=3→4`：3 行 60px 多行回答需频繁滚动；4 行 80px 配合 `leading-relaxed` 不超浮层视窗 40%。

**理由**：每个非显然数值附依据，便于 Review 与后续调参决策可追溯。

### D5：ConfirmDialog `max-w` 作为实施时验证项

**决策**：`max-w-sm→max-w-md` 标注为"实施时结合实际页面效果确认"；若仅增加 padding(`p-6`) + 行高(`leading-relaxed`) 即消除长消息 orphan 折行，则保留 `max-w-sm`，不强制改宽。

**理由**：用户反馈"如果仅通过增加 padding 和行高即可达到预期，也可以保留 `max-w-sm`"。`max-w-md`(448px) 的依据是 28 字长消息在 384px 下折行 orphan，但 padding/行高调整后视觉可能已达标，应以实际效果为准避免不必要增宽。

## Risks / Trade-offs

- [`max-w` 增宽使窄屏浮层溢出] → overlay `p-4` + `w-full` 保障不溢出；375px 响应式回归验证。
- [SpacePage 去内联后 `CustomVideoPlayer` 宽度异常] → 保留 `width: min(960px,100%)` 内联（纯动态数值，D1 允许），仅移除颜色/间距内联。
- [`leading-relaxed` 使多行文本变高，低分辨率视窗溢出] → diff 区有 `max-h-72` 滚动约束；其余浮层内容量小，768px 视窗下不溢出。
- [5 主题下表现不一] → `--space-*`/`--leading-*` 不随主题变（仅颜色主题化），间距全主题一致；SpacePage 预览 Modal 重点验暗主题。
- [改动范围扩散] → 严格限 11 文件清单；P0/P1/P2 门禁隔离；每级独立 commit 便于按级回滚。
