## Context

`design-agent-frontend` 有 6 处浮层（4 居中模态 + 2 右抽屉）各自手写 overlay+container+focus-trap+close 骨架，重复 ≥66 行，且含两个真实缺陷。现状（详见 `plans/Design_Agent_Frontend_Layout_Abstraction_Plan_2026-08-03.md` §1.1）：

**A. 居中模态 4 处**：
- ApprovalModal（`components/Approval/ApprovalModal.tsx:56-67`）：overlay `z-50`、`useFocusTrap({onEscape:reject})` 常开、**无 overlay onClick**（点遮罩不关闭，有意避免误触拒绝）。
- ConfirmDialog（`components/Common/ConfirmDialog.tsx:33-45`）：overlay `z-50`、`useFocusTrap({active:open,onEscape:onCancel})`、无 overlay onClick。
- CreateDialog（`components/Session/CreateDialog.tsx:139-152`）：overlay `z-50`、`useFocusTrap({active:open,onEscape:close})`、有 `onClick={close}`。
- SpacePage 视频预览（`modules/space/SpacePage.tsx:229-255`）：overlay `z-[var(--z-modal)]`、**无 focus trap、无 Escape**、有 onClick。

**B. 右抽屉 2 处**：
- SettingsPanel（`components/Settings/SettingsPanel.tsx:22-35`）：overlay `z-[var(--z-modal)]`、`useFocusTrap({active:open,onEscape})`、有 onClick。
- WorkspaceFilesPanel（`components/Session/WorkspaceFilesPanel.tsx:26-39`）：overlay `z-40`、`useFocusTrap({active:true,onEscape})`、有 onClick。

**缺陷**：
- 🔴 `z-50`/`z-40` < `--z-header:100`：3 模态 + 1 抽屉打开时被 sticky 顶栏盖住（latent bug）。
- 🔴 SpacePage 视频预览无 focus trap、无 Escape（a11y 缺陷，违反 WCAG 2.4.3/2.1.2）。
- 🟠 overlay-click 行为不一致（4 处中 2 处无）——**本次保现不统一**。

约束：不改 DOM 结构契约、ARIA 语义、按钮文案、回调逻辑、`themes.ts`；测试在既有 Docker 镜像内执行；`design-frontend-modal-layout`（间距令牌）与 `design-frontend-theme-system`（`--z-*` 令牌）已落地，本次复用其令牌。

## Goals / Non-Goals

**Goals:**
- 抽 `ModalShell` + `DrawerShell` 公共原语，复用 `useFocusTrap`，统一 overlay/container/z-index/aria 骨架。
- 修复 z-index 叠层 bug（3×`z-50` + 1×`z-40` → `z-[var(--z-modal)]`）。
- 修复 SpacePage 视频预览 a11y（补 focus trap + Escape）。
- 保现各接入点 overlay-click / Escape 语义（不借重构改 UX）。

**Non-Goals:**
- 不做 DetailLayout 抽象（先做可行性验证，见 plan 附录 B）。
- 不做 Card 抽象（暂缓，见 plan 附录 C）。
- 不做断点统一（策略重设计，见 plan 附录 D）。
- 不改 ApprovalModal「Escape=reject」语义（保现；若需分离「关闭/拒绝」提单独 UX 议题）。
- 不改 `themes.ts`、WS/Store/API、`session-frontend/`/`web/`、`ErrorBanner.tsx`。
- 不引入新运行时依赖。

## Decisions

### D1：overlay-click / Escape 行为保现（非 UX 调整）

**决策**：`ModalShell` 暴露显式 `closeOnOverlayClick: boolean` prop，**不设隐式默认**；各接入点按当前行为显式传值。Escape 统一经 `useFocusTrap({onEscape})` 触发 `onClose`（即各组件当前的 Escape 语义）。

| 接入点 | `closeOnOverlayClick` | `onClose` 映射 | Escape（保现） |
|---|---|---|---|
| ApprovalModal | `false` | `reject` | reject |
| ConfirmDialog | `false` | `onCancel` | onCancel |
| CreateDialog | `true` | `close` | close |
| SpacePage 视频预览 | `true` | `setPreviewRef(null)` | **新增** close（a11y 修复） |

**理由**：ApprovalModal/ConfirmDialog「点遮罩不关闭」是有意的（避免误触拒绝/取消重要操作）；CreateDialog/SpacePage「点遮罩关闭」是合理的（取消创建/关闭预览无副作用）。借重构统一为全开或全关都是 UX 变更，超出「公共原语 + bug 修复」边界。

**备选**：① 统一默认 true——否决，ApprovalModal 误触拒绝风险高；② 统一默认 false——否决，CreateDialog/SpacePage 便捷关闭是现有合理行为。显式 per-site 传值是唯一保现方案。

### D2：z-index 修复 = bug 修复（非行为变更）

**决策**：3×`z-50` + 1×`z-40` → `z-[var(--z-modal)]`(200)，高于 `var(--z-header)`(100)。

**理由**：模态打开时应覆盖全屏含顶栏，`z-50 < z-header` 是缺陷。当前未暴露仅因视觉巧合（模态内容居中、顶栏在顶部少重叠）。修复后符合「模态浮在最上层」的预期，非 UX 变更。

### D3：SpacePage a11y 修复 = bug 修复

**决策**：补 `useFocusTrap({active:open,onEscape:onClose})`，overlay onClick 已有（保现）。

**理由**：当前无 focus trap、无 Escape，键盘用户无法关闭、Tab 焦点逃逸。修复符合 WCAG 2.4.3/2.1.2，属 bug 修复非 UX 变更。

### D4：DetailLayout/Card/Breakpoint 不纳入

**决策**：本次仅 ModalShell/DrawerShell + bug 修复；DetailLayout 转可行性验证、Card 暂缓、Breakpoint 策略重设计，各自后续独立立项。

**理由**：① DetailLayout 三模块未来演进未定（video GA / drawio+ui-design demo），贸然参数化易成 God Component；② Card 仅 2 处复用收益不足；③ 断点 `md2/lg2` 会形成第三套体系，需先定单一标准。三者不应与「低风险公共原语 + bug 修复」捆绑。

## Risks / Trade-offs

- [`ModalShell` 参数过多成 God Component] → 仅 6 个 prop，每个有明确用例，不预留无用 slot；后续若需扩展再评估。
- [ApprovalModal `onClose=reject` 语义混淆] → 文档标注「关闭=拒绝」是当前保现；若团队认为应分离，提单独 UX 议题（D1 评审待确认）。
- [CreateDialog 删除 `onKeyDown` 后 Escape 行为变化] → `useFocusTrap({onEscape})` 已覆盖 Escape，行为等价；单测验证 Escape→close 不变。
- [`data-testid` 透传] → ModalShell/DrawerShell 容器接受 `data-testid` 透传，确保既有 `approval-modal`/`confirm-dialog` 钩子不断。
- [改动面扩散] → 严格限文件清单（8 文件）；P0→P1 串行门禁；每级独立 commit。

## 实现期约束（评审确认，2026-08-03）

1. **ApprovalModal `onClose=reject` 保现是有意为之**：经核 `ApprovalModal.tsx:50-51` 注释「焦点圈定 + Escape 拒绝（task 10.6）」+ `useFocusTrap(dialogRef,{onEscape:reject})`，属 task 10.6 显式业务设计决策，非历史遗留。本次保现不改；「关闭≠拒绝」若需分离，单独提 UX change，不混入本次公共原语重构。
2. **ModalShell/DrawerShell 实现不得继续泛化**：严格限定已定义的 props（ModalShell 6 个、DrawerShell 4 个），实现期不新增 variant、slot、`as` 多态等能力。先覆盖现有 4 模态 + 2 抽屉的真实需求，后续确实出现新场景再扩展（届时提单独 change 评估）。
3. **保现映射严格执行**：各接入点按 D1 表显式传 `closeOnOverlayClick`，不得为「一致性」擅自统一为全开或全关。
