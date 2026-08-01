# 设计智能体前端：浮层组件布局间距整改

## Why

`design-agent-frontend` 中多处浮层组件（Modal/Dialog/Drawer/Dropdown）文字显示拥挤、间距不合理，影响可读性与用户体验。根因有三：① `demo.css :root` 仅有 radius/shadow/transition/font 令牌，**缺间距与行高令牌**，间距全靠各组件零散 Tailwind 类，无法全局调参；② 正文普遍使用 Tailwind `text-sm`/`text-xs`，其内置 `line-height` 仅 1.43/1.33，对中文段落偏紧；③ 各浮层 `max-w-*`/`p-*`/`gap-*` 取值不一，标题↔正文、按钮组间距低于现代 UI 标准（Material 3 / Apple HIG / WCAG 1.4.8）。本次建立统一的浮层间距/排版规范并落地，使正文行高 ≥ 1.5、容器内边距 ≥ 20px、按钮组 gap ≥ 12px。

## What Changes

- **新增间距/排版设计令牌**：在 `src/styles/demo.css :root` 引入 `--space-xs..2xl` 与 `--leading-body/tight`，供原生 CSS 类与内联场景全局调参；组件 JSX 层继续用 Tailwind 工具类，二者数值对齐、单一维度单一写法（禁止混用）。
- **P0 核心 Modal/Dialog 整改**：`ApprovalModal`（含 PermissionPrompt/DiffApproval/QuestionPrompt 三子组件）、`ConfirmDialog`、`CreateDialog` 的容器内边距、正文行高、标题↔正文间距、按钮组 gap、双行文本间距就地调整为基线值。
- **P1 Drawer 抽屉整改**：`SettingsPanel`、`WorkspaceFilesPanel` 的 body padding、列表项双行间距。
- **P2 外围浮层整改**：`ModelSelector` 下拉项间距；`SpacePage` 视频预览 Modal 去除内联硬编码颜色/间距，接入 Tailwind 类与设计令牌，修复暗主题下不可用问题。
- **关键数值调整**（附依据）：正文 `leading-relaxed`(1.625)、容器 `p-6`(24px)、按钮组 `gap-3`(12px)、标题↔正文 `mt-3`(12px)；DiffApproval diff 区 `max-h-64→max-h-72`、QuestionPrompt textarea `rows=3→4`；ConfirmDialog `max-w-sm→max-w-md` 作为实施时验证项（若仅加 padding+行高即达标可保留 `max-w-sm`）。
- **不抽取 ModalShell 公共原语**：本次仅纯样式整改，不改 DOM 结构、ARIA 契约、focus trap、交互逻辑；ModalShell 抽象待本次落地后量化重复程度再单独立项。

## Capabilities

### New Capabilities

- `design-frontend-modal-layout`：设计前端浮层组件（Modal/Dialog/Drawer/Dropdown）的布局间距与排版规范——间距/行高设计令牌、浮层布局基线（容器内边距、正文行高、标题↔正文间距、按钮组 gap、双行列表项间距）、令牌与 Tailwind 工具类的使用策略与一致性约束、多主题与响应式验收基线。

### Modified Capabilities

（无既有 spec 的 Requirements 被修改。本次仅规范化视觉实现，不改变 `design-agent-video` / `session-approval` / `design-agent-platform` / `design-agent-space` 等既有契约声明的交互行为、API 契约或 ARIA 语义。）

## Impact

- **前端代码**：`design-agent-frontend/src/` 下 11 个文件（1 CSS + 10 tsx），均为 className/CSS 类调整或去内联，不改 DOM 结构与交互逻辑。
- **设计令牌**：`src/styles/demo.css :root` 新增 `--space-*`/`--leading-*`（纯增量，不改动现有令牌）。
- **后端/API**：零改动。
- **测试**：既有单测（`ApprovalModal.test.tsx`、`CreateDialog.test.tsx`）断言均为语义查询（`getByRole`/`getByText`/`getByLabelText`），不依赖 className/padding，预期全绿；按项目约定在已有 Docker 镜像内执行，禁止宿主机直跑、禁止重建基础镜像。
- **新增文件**：`openspec/changes/design-frontend-modal-layout/`（本 change 四件套）；视觉验收截图归档目录 `docs/modal-layout-before-after/`（实施后采集）。
- **不改动**：`themes.ts` 主题色板、所有 `__tests__`、WS/Store/API 层、`session-frontend/`、`web/`、`ErrorBanner.tsx`（已达基线）。
