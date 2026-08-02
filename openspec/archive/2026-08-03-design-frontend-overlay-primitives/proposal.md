## Why

`design-agent-frontend` 有 6 处浮层（4 居中模态 + 2 右抽屉）各自手写 overlay+container+focus-trap+close 骨架，合计 ≥66 行重复，且含两个真实缺陷：① **z-index 叠层 bug**——ApprovalModal/ConfirmDialog/CreateDialog 的 overlay `z-50` 与 WorkspaceFilesPanel 的 `z-40` 均低于 `.app-header` 的 `var(--z-header):100`，模态/抽屉打开时被 sticky 顶栏盖住（当前因视觉巧合未暴露但属真实叠层错误）；② **SpacePage 视频预览 a11y 缺陷**——无 focus trap、无 Escape，键盘用户无法关闭、Tab 焦点逃逸。详见 `plans/Design_Agent_Frontend_Layout_Abstraction_Plan_2026-08-03.md`（v2 收敛后第一阶段）。

经评审收敛：本 change 仅做 ModalShell + DrawerShell 公共原语 + z-index/a11y 修复（收益高、风险低）；DetailLayout/Card/断点统一不纳入（各自后续独立立项，见 plan 附录 B/C/D）。

## What Changes

- **新增 `ModalShell` 公共原语**（`src/components/Common/ModalShell.tsx`）：统一 overlay `z-[var(--z-modal)]` + `bg-black/40` + `p-4` + `useFocusTrap({active,onEscape})` + overlay onClick（显式 `closeOnOverlayClick` prop，**不设隐式默认**）+ `role="presentation"`/`role="dialog"`/`aria-modal`/`aria-label` + slot 化 `maxWidthClass`/`containerStyle`/`overlayDimClass`/`overlayPaddingClass`。
- **新增 `DrawerShell` 公共原语**（`src/components/Common/DrawerShell.tsx`）：统一右抽屉 overlay + `aside` 容器 + focus trap + overlay onClick + `z-[var(--z-modal)]`。
- **4 居中模态接入**：ApprovalModal、ConfirmDialog、CreateDialog、SpacePage 视频预览 Modal 改用 `ModalShell`，**保现各自 overlay-click/Escape 语义**（ApprovalModal/ConfirmDialog `closeOnOverlayClick={false}`，CreateDialog/SpacePage `closeOnOverlayClick={true}`）。
- **2 抽屉接入**：SettingsPanel、WorkspaceFilesPanel 改用 `DrawerShell`。
- **修复 z-index bug**：3 处 `z-50` + 1 处 `z-40` → `z-[var(--z-modal)]`，使模态/抽屉正确覆盖顶栏。
- **修复 SpacePage a11y**：补 focus trap + Escape（当前缺失）。
- **新增单测**：ModalShell/DrawerShell 各一套（骨架渲染 + overlay-click 两种 + Escape + role/aria + focus trap 调用）。
- **非目标**：不做 DetailLayout 抽象（先做可行性验证，见 plan 附录 B）；不做 Card 抽象（暂缓，见 plan 附录 C）；不做断点统一（策略重设计，见 plan 附录 D）；不改 ApprovalModal「Escape=reject」语义（保现，若需分离「关闭/拒绝」提单独 UX 议题）；不改 DOM 结构契约、按钮文案、回调逻辑、`themes.ts`、WS/Store/API。

## Capabilities

### New Capabilities
- `design-frontend-overlay-primitives`: 设计前端浮层公共原语与叠层/a11y 规范——ModalShell（居中模态骨架：overlay + container + focus trap + 显式 closeOnOverlayClick + role/aria + z-index 令牌化）、DrawerShell（右抽屉骨架）、z-index 叠层基线（模态/抽屉 MUST 用 `var(--z-modal)` 高于 `var(--z-header)`）、a11y 基线（所有浮层 MUST 有 focus trap + Escape）、overlay-click 行为保现约束（接入点显式传值，原语不设隐式默认）。

### Modified Capabilities
（无既有 spec 的 Requirements 被修改。本 change 是 `design-frontend-modal-layout`（浮层间距令牌）与 `design-frontend-theme-system`（`--z-*` 令牌）的姊妹能力，扩展到浮层公共骨架与叠层/a11y 契约，但不改动二者已声明的间距/行高/非回归/令牌 Requirements。`session-approval`/`design-agent-video`/`design-agent-space` 等既有契约的交互/API/ARIA 语义不变。）

## Impact

- **前端代码**：`design-agent-frontend/src/` 下约 8 个文件：① 新增 `ModalShell.tsx` + `DrawerShell.tsx` + 各自 `__tests__`；② 修改 `ApprovalModal.tsx`、`ConfirmDialog.tsx`、`CreateDialog.tsx`、`SettingsPanel.tsx`、`WorkspaceFilesPanel.tsx`、`SpacePage.tsx` 把 overlay+container 骨架替换为原语调用。均为骨架替换 + bug 修复，不改 DOM 语义契约与交互逻辑。
- **设计令牌**：复用 `design-frontend-theme-system` 已落地的 `--z-modal`/`--z-header`，无新增令牌。
- **后端/API**：零改动。
- **测试**：既有单测（`ApprovalModal.test.tsx` 10、`CreateDialog.test.tsx` 12、`WorkspaceFilesPanel.test.tsx` 6、`space.test.ts` 10）断言均为语义查询（`getByRole`/`getByText`/`getByLabelText`/`getByTestId`），不依赖 z-index/className，预期全绿；按项目硬约定在既有 Docker 镜像（`openharness-design-frontend:test`/`e2e`）内执行 `vitest` 与 `tsc -b && vite build`。
- **新增文件**：`openspec/changes/design-frontend-overlay-primitives/`（本 change 四件套）；视觉验收截图 `docs/overlay-primitives-before-after/`（实施后采集）。
- **不改动**：`themes.ts`、所有 `__tests__` 断言、WS/Store/API 层、`session-frontend/`、`web/`、`ErrorBanner.tsx`、DetailLayout/Card/断点（见 plan 附录）。
