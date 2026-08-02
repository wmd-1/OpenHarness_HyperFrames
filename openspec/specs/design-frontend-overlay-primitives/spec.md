# design-frontend-overlay-primitives Specification

## Purpose
TBD - created by archiving change design-frontend-overlay-primitives. Update Purpose after archive.
## Requirements
### Requirement: ModalShell 居中模态公共原语
`design-agent-frontend` SHALL 提供 `src/components/Common/ModalShell.tsx` 公共原语，封装居中模态的 overlay + container + focus trap + Escape + role/aria 骨架。overlay SHALL 用 `z-[var(--z-modal)]` + `bg-black/40`（默认，可经 `overlayDimClass` 覆盖）+ `p-4`（默认，可经 `overlayPaddingClass` 覆盖）+ `role="presentation"`。容器 SHALL 用 `role="dialog"` + `aria-modal="true"` + `aria-label` + `bg-surface border-line rounded-xl border shadow-xl`。SHALL 经 `useFocusTrap(ref, { active: open, onEscape: onClose })` 处理焦点圈定与 Escape。`open=false` 时 SHALL 返回 `null`。

#### Scenario: open=false 不渲染
- **WHEN** 渲染 `<ModalShell open={false} ...>`
- **THEN** 返回 null，DOM 中不出现 overlay 与 dialog

#### Scenario: role 与 aria 契约
- **WHEN** 渲染 `<ModalShell open onClose={fn} ariaLabel="标题">`
- **THEN** overlay 含 `role="presentation"`，容器含 `role="dialog"`、`aria-modal="true"`、`aria-label="标题"`

#### Scenario: 容器接受 data-testid 透传
- **WHEN** 接入点（如 ApprovalModal）需保留既有测试钩子
- **THEN** ModalShell 容器接受 `data-testid` 透传，断言 `getByTestId('approval-modal')` 不断

### Requirement: closeOnOverlayClick 显式 prop 无隐式默认
`ModalShell` SHALL 暴露 `closeOnOverlayClick: boolean` 必填 prop，控制 overlay 点击是否触发 `onClose`。SHALL NOT 设隐式默认值（接入点 MUST 显式传值以保现各自行为）。当 `closeOnOverlayClick={true}` 时 overlay `onClick={onClose}`；当 `closeOnOverlayClick={false}` 时 overlay 不挂 `onClick`（点遮罩不关闭）。容器 SHALL `onClick={stopPropagation}` 防止点击内容冒泡触发 overlay 关闭。

#### Scenario: closeOnOverlayClick=false 点遮罩不关闭
- **WHEN** 渲染 `<ModalShell closeOnOverlayClick={false} ...>` 并点击 overlay 区域
- **THEN** `onClose` 不被调用，模态保持打开

#### Scenario: closeOnOverlayClick=true 点遮罩关闭
- **WHEN** 渲染 `<ModalShell closeOnOverlayClick={true} ...>` 并点击 overlay 区域
- **THEN** `onClose` 被调用

#### Scenario: 点容器内容不冒泡关闭
- **WHEN** `closeOnOverlayClick={true}` 且点击容器内内容
- **THEN** `onClose` 不被调用（stopPropagation 生效）

### Requirement: DrawerShell 右抽屉公共原语
`design-agent-frontend` SHALL 提供 `src/components/Common/DrawerShell.tsx` 公共原语，封装右侧抽屉的 overlay + aside 容器 + focus trap + Escape + overlay onClick + role/aria 骨架。overlay SHALL 用 `z-[var(--z-modal)]` + `bg-black/40` + `role="presentation"` + `onClick={onClose}`。容器 SHALL 用 `<aside>` + `role="dialog"` + `aria-modal="true"` + `aria-label` + `absolute top-0 right-0 h-full` + `bg-surface border-l border-line shadow-xl` + `onClick={stopPropagation}`。SHALL 经 `useFocusTrap(ref, { active: open, onEscape: onClose })` 处理焦点与 Escape。`open=false` 时 SHALL 返回 `null`。

#### Scenario: overlay 点击关闭抽屉
- **WHEN** 渲染 `<DrawerShell open onClose={fn} ...>` 并点击 overlay 区域
- **THEN** `onClose` 被调用，抽屉关闭

#### Scenario: aside 容器定位与 role
- **WHEN** 渲染 DrawerShell
- **THEN** 容器为 `<aside>` 元素，含 `role="dialog"`、`aria-modal="true"`、`aria-label`，绝对定位于右上角全高

### Requirement: 浮层 z-index 叠层基线
所有居中模态与右抽屉的 overlay SHALL 用 `z-[var(--z-modal)]`(200)，高于 `.app-header` 的 `var(--z-header)`(100)。SHALL NOT 使用字面 `z-50`/`z-40` 或其他低于 `var(--z-header)` 的值。

#### Scenario: 模态 overlay 高于顶栏
- **WHEN** 打开 ApprovalModal / ConfirmDialog / CreateDialog / SpacePage 视频预览
- **THEN** overlay 的 z-index 为 `var(--z-modal)`(200)，大于 `.app-header` 的 `var(--z-header)`(100)，顶栏不盖在模态之上

#### Scenario: 抽屉 overlay 高于顶栏
- **WHEN** 打开 SettingsPanel 或 WorkspaceFilesPanel 抽屉
- **THEN** overlay 的 z-index 为 `var(--z-modal)`(200)，大于顶栏

### Requirement: SpacePage 视频预览 a11y 修复
`modules/space/SpacePage.tsx` 的视频预览 Modal SHALL 接入 `ModalShell`，从而获得 focus trap（`useFocusTrap({active:open,onEscape})`）与 Escape 关闭能力。当前缺失的 focus trap 与 Escape SHALL 在接入后具备。

#### Scenario: Escape 关闭视频预览
- **WHEN** 视频预览 Modal 打开且按 Escape 键
- **THEN** `onClose` 被调用，预览关闭

#### Scenario: 焦点圈定在 Modal 内
- **WHEN** 视频预览 Modal 打开且按 Tab 循环
- **THEN** 焦点在 Modal 内元素间循环，不逃逸到背后页面

### Requirement: 接入点行为保现
各浮层接入 `ModalShell`/`DrawerShell` 后 SHALL 保留其当前的 overlay-click 与 Escape 语义，不借重构改变 UX：ApprovalModal `closeOnOverlayClick={false}` + Escape→reject；ConfirmDialog `closeOnOverlayClick={false}` + Escape→onCancel；CreateDialog `closeOnOverlayClick={true}` + Escape→close；SpacePage `closeOnOverlayClick={true}` + Escape→close（新增）；SettingsPanel/WorkspaceFilesPanel overlay-click 关闭 + Escape→onClose。

#### Scenario: ApprovalModal 点遮罩不拒绝
- **WHEN** ApprovalModal 打开且点击 overlay 区域
- **THEN** 审批不被拒绝（`closeOnOverlayClick={false}`），模态保持打开

#### Scenario: CreateDialog 点遮罩关闭
- **WHEN** CreateDialog 打开且点击 overlay 区域
- **THEN** 对话框关闭（`closeOnOverlayClick={true}`）

### Requirement: 非回归约束（不改 DOM/ARIA/交互）
本次整改 MUST NOT 改变任何浮层的 DOM 结构契约（`role`/`aria-modal`/`aria-label`）、focus trap 行为、Escape 语义、按钮文案与回调逻辑、`data-testid` 钩子。既有单测断言（`getByRole`/`getByText`/`getByLabelText`/`getByTestId`）在整改后 MUST 保持全绿，无需修改断言。

#### Scenario: ARIA 契约不变
- **WHEN** 整改后渲染 ApprovalModal
- **THEN** 其 `role="dialog"`、`aria-modal="true"`、`aria-label="审批请求"` 与 `data-testid="approval-modal"` 契约与整改前一致

#### Scenario: 既有单测全绿
- **WHEN** 在既有 Docker 镜像内运行 `ApprovalModal.test.tsx`、`CreateDialog.test.tsx`、`WorkspaceFilesPanel.test.tsx`、`space.test.ts`
- **THEN** 所有断言通过且无需修改测试代码

### Requirement: 多主题与响应式不破版
整改后所有浮层 MUST 在 default/dark/minimal/cyberpunk/solarized 五主题下不破版（遮罩、圆角、阴影、文字对比度正常），且在 375px（iPhone SE）视窗宽度下模态 `w-full` + overlay padding 不溢出视窗。

#### Scenario: 五主题不破版
- **WHEN** 依次切换五主题并打开各浮层
- **THEN** 浮层遮罩、圆角、阴影、文字对比度均正常，无样式丢失

#### Scenario: 窄视窗不溢出
- **WHEN** 视窗宽度为 375px 并打开模态/抽屉
- **THEN** 浮层不溢出视窗（overlay padding + `w-full`/`max-w-*` 约束生效）

### Requirement: 镜像内执行测试约束
所有单测与构建 MUST 在既有 Docker 镜像（`openharness-design-frontend:test` 或 `openharness-design-frontend:e2e` 及其 FROM 链 `oh-e2e-test:latest`）内执行，宿主机禁止直跑测试、禁止从零重建基础镜像。源码经 volume 挂载进容器，改码无需重建即可测。

#### Scenario: 单测在镜像内执行
- **WHEN** 运行门禁单测
- **THEN** `vitest` 在既有镜像内执行，宿主机不直接 `npx vitest`

#### Scenario: 构建在镜像内执行
- **WHEN** 运行门禁构建
- **THEN** `tsc -b && vite build` 在既有镜像内执行且无错

