<!-- 最后更新：2026-08-03（v2，按评审意见收敛第一阶段范围） -->

# 设计智能体前端 — 浮层公共原语与叠层/a11y 修复计划（Phase 1）

- 日期：2026-08-03
- 状态：待评审（确认后整理为 OpenSpec change `design-frontend-overlay-primitives`）
- 范围（v2 收敛后）：**仅** `ModalShell` + `DrawerShell` 公共原语 + 4 居中浮层接入 + 2 抽屉接入 + **z-index 叠层 bug 修复** + **SpacePage 视频预览 a11y 修复**
- 前置：`design-frontend-modal-layout`（浮层间距令牌，已归档）+ `design-frontend-theme-system`（主题统一 + `--z-*` 令牌，已归档）
- 参考基准：`docs/design-frontend-ui-layout-theme-audit-2026-08-02.md` §2.5、`plans/Design_Agent_Frontend_Modal_Layout_Plan_2026-08-02.md` 附录 A

> **v2 收敛说明**（按 2026-08-03 评审意见）：
> 1. **ModalShell + DrawerShell + z-index/a11y 修复** = 第一阶段范围（收益高、风险低，公共原语明确）。
> 2. **ApprovalModal overlay 点击关闭** = **行为保现**，非 UX 调整：`ModalShell` 暴露显式 `closeOnOverlayClick` prop，各接入点按**当前**行为显式传值，不设隐式默认（见 D1）。
> 3. **DetailLayout** = 转为**可行性验证**（附录 B），不直接抽象，避免过度参数化的 God Component。
> 4. **Card** = **暂缓**，触发条件 ≥3 处同构卡片再统一（附录 C）。
> 5. **断点统一** = **策略重设计**，不引入 `md2/lg2` 第三套体系，先定未来单一标准（附录 D）。
> 6. **OpenSpec 拆分**：本计划仅落 P0/P1 小 change `design-frontend-overlay-primitives`；DetailLayout/Card/Breakpoint 各自后续独立立项。

---

## 1. 背景与目标

### 1.1 问题现象（量化，仅本次范围内）

#### A. 居中浮层 4 处重复（ModalShell 候选）

| 组件 | 文件:行 | overlay 类 | 容器类 | max-w | z-index | focus trap | overlay onClick | Escape |
|---|---|---|---|---|---|---|---|---|
| ApprovalModal | `components/Approval/ApprovalModal.tsx:56-67` | `fixed inset-0 z-50 flex center bg-black/40 p-4` | `bg-surface border-line w-full rounded-xl border p-6 shadow-xl` | `max-w-lg` | **z-50** ❌ | `useFocusTrap(ref,{onEscape:reject})` 常开 | **❌ 无** | ✅ → reject |
| ConfirmDialog | `components/Common/ConfirmDialog.tsx:33-45` | 同上 | 同上 | `max-w-md` | **z-50** ❌ | `useFocusTrap(ref,{active:open,onEscape:onCancel})` | **❌ 无** | ✅ → onCancel |
| CreateDialog | `components/Session/CreateDialog.tsx:139-152` | 同上 | 同上 | `max-w-md` | **z-50** ❌ | `useFocusTrap(ref,{active:open,onEscape:close})` | ✅ `onClick={close}` | ✅ → close |
| SpacePage 视频预览 | `modules/space/SpacePage.tsx:229-255` | `fixed inset-0 z-[var(--z-modal)] flex center bg-black/60 p-8` | `style={{width:'min(960px,100%)'}}` | `min(960px,100%)` | `z-[var(--z-modal)]` ✅ | **❌ 无** | ✅ `onClick` | **❌ 无** |

**每处 overlay+container 骨架 ≥10 行，4 处合计 ≥40 行重复**。

**缺陷（本次修复）**：
- 🔴 **z-50 < z-header(100)**：ApprovalModal/ConfirmDialog/CreateDialog 的 overlay `z-50` 低于 `.app-header` `var(--z-header)=100`，sticky 顶栏会**盖在模态框之上**（latent bug，当前因视觉巧合不明显但属真实叠层错误）。→ 修复为 `z-[var(--z-modal)]`(200)。
- 🔴 **SpacePage 视频预览无 focus trap、无 Escape**：键盘用户无法 Esc 关闭，焦点未圈定（a11y 缺陷）。→ 修复为补 `useFocusTrap` + Escape。
- 🟠 overlay-click 行为不一致：4 处中 2 处无 overlay 关闭。**本次保现，不统一**（见 D1）。

#### B. 右侧抽屉 2 处重复（DrawerShell 候选）

| 组件 | 文件:行 | overlay 类 | 容器类 | z-index | focus trap | overlay onClick |
|---|---|---|---|---|---|---|
| SettingsPanel | `components/Settings/SettingsPanel.tsx:22-35` | `fixed inset-0 z-[var(--z-modal)] bg-black/40` | `aside absolute top-0 right-0 h-full w-full max-w-sm border-l` | `z-[var(--z-modal)]` ✅ | `useFocusTrap(ref,{active:open,onEscape:close})` | ✅ |
| WorkspaceFilesPanel | `components/Session/WorkspaceFilesPanel.tsx:26-39` | `fixed inset-0 z-40 flex justify-end bg-black/40` | `bg-surface border-line flex h-full w-full flex-col border-l shadow-xl sm:w-96` | **z-40** ❌ | `useFocusTrap(ref,{active:true,onEscape:onClose})` | ✅ |

**每处 ≥13 行骨架重复**。

**缺陷（本次修复）**：
- 🔴 WorkspaceFilesPanel `z-40` < z-header(100) 且 < z-modal(200)，抽屉被顶栏盖住、且低于其他模态。→ 修复为 `z-[var(--z-modal)]`。

### 1.2 目标（第一阶段）

- 抽 `ModalShell`（居中模态）+ `DrawerShell`（右侧抽屉）公共原语，复用 `useFocusTrap`，统一 overlay/container/z-index/aria 骨架。
- **修复 z-index 叠层 bug**：3 处模态 `z-50` + 1 处抽屉 `z-40` → 统一 `z-[var(--z-modal)]`，高于 `var(--z-header)`。
- **修复 SpacePage 视频预览 a11y**：补 focus trap + Escape。
- **保现各组件 overlay-click / Escape 语义**：不借重构之名改 UX（见 D1）。
- 不改 DOM 结构契约（`role`/`aria-modal`/`aria-label`）、不改按钮文案与回调逻辑。

### 1.3 边界（本次不做）

- **不做 DetailLayout 抽象**（先做可行性验证，见附录 B）。
- **不做 Card 抽象**（暂缓，触发条件见附录 C）。
- **不做断点统一**（策略重设计，见附录 D）。
- 不改 WS/Store/API 层、不改 `themes.ts`、不改 `session-frontend/`/`web/`。
- 不引入新运行时依赖（`useFocusTrap` 已存在，复用）。
- 不做 i18n、不改业务文案。
- 不改 `ErrorBanner.tsx`（非浮层）。

---

## 2. 决策

### D1：overlay-click / Escape 行为保现（非 UX 调整）

**决策**：`ModalShell` 暴露显式 `closeOnOverlayClick?: boolean` prop，**不设隐式默认**；各接入点按**当前**行为显式传值。Escape 统一经 `useFocusTrap({onEscape})` 触发 `onClose`（即各组件当前的 Escape 语义）。

**各接入点保现映射**：

| 接入点 | `closeOnOverlayClick` | `onClose` 映射 | Escape 语义（保现） |
|---|---|---|---|
| ApprovalModal | `false`（当前无 overlay 关闭） | `reject`（当前 Escape→reject） | reject |
| ConfirmDialog | `false`（当前无） | `onCancel`（当前 Escape→onCancel） | onCancel |
| CreateDialog | `true`（当前 `onClick={close}`） | `close` | close |
| SpacePage 视频预览 | `true`（当前有） | `setPreviewRef(null)` | **新增** close（a11y 修复） |

**理由**：ApprovalModal/ConfirmDialog 当前「点遮罩不关闭」是有意的（避免误触拒绝/取消重要操作）；CreateDialog/SpacePage 当前「点遮罩关闭」是合理的（取消创建/关闭预览无副作用）。借重构统一为「全开」或「全关」都是 UX 变更，超出了「公共原语 + bug 修复」的边界。

**备选**：① 统一 `closeOnOverlayClick` 默认 true——否决，ApprovalModal 拒绝需显式操作，误触风险高；② 统一默认 false——否决，CreateDialog/SpacePage 的便捷关闭是现有合理行为。**显式 per-site 传值**是唯一能保现的方案。

**评审待确认**：ApprovalModal 的 `onClose=reject` 语义是否可接受？（即「关闭模态 = 拒绝审批」）。当前 Escape 已是此行为，本次保现不改，但若团队认为「Escape 应只关闭不决策」，需单独提 UX 议题——不在本次范围。

### D2：z-index 修复 = bug 修复（非行为变更）

**决策**：3 处 `z-50` + 1 处 `z-40` → `z-[var(--z-modal)]`(200)。这是叠层 bug 修复，使模态/抽屉正确覆盖顶栏（`--z-header:100`）。

**理由**：模态打开时应覆盖全屏含顶栏，`z-50 < z-header` 是缺陷。当前未暴露仅因视觉巧合（模态内容居中、顶栏在顶部，少重叠）。修复后行为符合用户对「模态浮在最上层」的预期，不构成 UX 变更。

### D3：SpacePage 视频预览 a11y 修复 = bug 修复

**决策**：补 `useFocusTrap({active:open,onEscape:onClose})` + overlay onClick 已有（保现）。这是 a11y 缺陷修复（键盘可达性）。

**理由**：当前视频预览 Modal 无 focus trap、无 Escape，键盘用户无法关闭、Tab 焦点逃逸到背后页面。修复符合 WCAG 2.4.3 / 2.1.2。属明确的 bug 修复，非 UX 变更。

### D4：DetailLayout/Card/Breakpoint 不纳入本次（见附录 B/C/D）

**决策**：本次仅做 ModalShell/DrawerShell + bug 修复；DetailLayout 转可行性验证、Card 暂缓、Breakpoint 策略重设计，各自后续独立立项。

**理由**：① DetailLayout 三模块未来演进方向未定（video GA 真 backend / drawio+ui-design demo），贸然参数化易成 God Component；② Card 仅 2 处，复用收益不足；③ 断点 `md2/lg2` 会形成第三套体系，需先定单一标准。三者均不应与「低风险公共原语 + bug 修复」捆绑。

---

## 3. 公共原语设计

### 3.1 `ModalShell`（`src/components/Common/ModalShell.tsx`）

```tsx
export interface ModalShellProps {
  open: boolean;
  onClose: () => void;               // dismiss handler（各 site 映射：reject/onCancel/close/...）
  ariaLabel: string;
  /** 显式控制 overlay 点击是否触发 onClose（D1：不设隐式默认，各 site 保现传值） */
  closeOnOverlayClick: boolean;
  /** 容器最大宽度类（Tailwind）：max-w-md / max-w-lg / max-w-2xl */
  maxWidthClass?: string;
  /** 内联容器宽度（如 width:min(960px,100%)），仅当 maxWidthClass 不适用时用 */
  containerStyle?: CSSProperties;
  /** overlay 内边距类：默认 p-4；视频预览等大画面用 p-8 */
  overlayPaddingClass?: string;
  /** overlay 遮罩透明度类：默认 bg-black/40；视频预览用 bg-black/60 */
  overlayDimClass?: string;
  /** 容器额外 className */
  containerClassName?: string;
  children: ReactNode;
}
```

骨架职责：
- overlay `div`：`fixed inset-0 z-[var(--z-modal)] flex items-center justify-center ${overlayDimClass ?? 'bg-black/40'} ${overlayPaddingClass ?? 'p-4'}` + `role="presentation"` + 条件 `onClick={closeOnOverlayClick ? onClose : undefined}`。
- 容器 `div`：`ref` + `role="dialog"` + `aria-modal="true"` + `aria-label={ariaLabel}` + `onClick={stopPropagation}` + `${maxWidthClass}` + `bg-surface border-line rounded-xl border shadow-xl` + `containerClassName`。
- `useFocusTrap(ref, { active: open, onEscape: onClose })`（复用既有 hook）。
- `if (!open) return null`。

### 3.2 `DrawerShell`（`src/components/Common/DrawerShell.tsx`）

```tsx
export interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  side?: 'right';                     // 当前仅右抽屉，预留扩展
  widthClass?: string;               // 默认 max-w-sm；WorkspaceFilesPanel 用 sm:w-96
  children: ReactNode;
}
```

骨架职责：
- overlay `div`：`fixed inset-0 z-[var(--z-modal)] bg-black/40` + `onClick={onClose}` + `role="presentation"`。
- 容器 `aside`：`ref` + `role="dialog"` + `aria-modal="true"` + `aria-label` + `absolute top-0 right-0 h-full w-full ${widthClass ?? 'max-w-sm'} border-l border-line bg-surface shadow-xl` + `onClick={stopPropagation}`。
- `useFocusTrap(ref, { active: open, onEscape: onClose })`。
- `if (!open) return null`。

---

## 4. 组件改动清单（P0 → P1 串行）

### P0 — ModalShell 抽取 + 4 居中浮层接入

| 任务 | 文件 | 改动 |
|---|---|---|
| P0.1 | `src/components/Common/ModalShell.tsx`（新增） | 实现公共原语（§3.1） |
| P0.2 | `components/Approval/ApprovalModal.tsx` | 替换 `:56-67` overlay+container 为 `<ModalShell open onClose={reject} ariaLabel="审批请求" maxWidthClass="max-w-lg" closeOnOverlayClick={false}>`；**修复 z-50→z-modal**；overlay-click 保现（不关闭） |
| P0.3 | `components/Common/ConfirmDialog.tsx` | 替换 `:33-45` 为 `<ModalShell open={open} onClose={onCancel} ariaLabel={title} maxWidthClass="max-w-md" closeOnOverlayClick={false}>`；修复 z-50→z-modal |
| P0.4 | `components/Session/CreateDialog.tsx` | 替换 `:139-152` 为 `<ModalShell open={open} onClose={close} ariaLabel="创建会话" maxWidthClass="max-w-md" closeOnOverlayClick>`；修复 z-50→z-modal；删除冗余 `onKeyDown`（ModalShell 经 trap 处理 Escape） |
| P0.5 | `modules/space/SpacePage.tsx` | 替换 `:229-255` 视频预览为 `<ModalShell open={!!previewRef} onClose={() => setPreviewRef(null)} ariaLabel="视频预览" overlayDimClass="bg-black/60" overlayPaddingClass="p-8" containerStyle={{width:'min(960px,100%)'}} closeOnOverlayClick>`；**补 focus trap + Escape**（a11y 修复） |
| P0.6 | `src/components/Common/__tests__/ModalShell.test.tsx`（新增） | 骨架渲染 + open=false 不渲染 + overlay-click（`closeOnOverlayClick` true/false 两种）+ Escape + role/aria-label + focus trap 调用 |

### P1 — DrawerShell 抽取 + 2 抽屉接入

| 任务 | 文件 | 改动 |
|---|---|---|
| P1.1 | `src/components/Common/DrawerShell.tsx`（新增） | 实现公共原语（§3.2） |
| P1.2 | `components/Settings/SettingsPanel.tsx` | 替换 `:22-35` 为 `<DrawerShell open={open} onClose={() => setOpen(false)} ariaLabel="设置" widthClass="max-w-sm">` |
| P1.3 | `components/Session/WorkspaceFilesPanel.tsx` | 替换 `:26-39` 为 `<DrawerShell open onClose={onClose} ariaLabel="工作区文件" widthClass="sm:w-96">`；**修复 z-40→z-modal** |
| P1.4 | `src/components/Common/__tests__/DrawerShell.test.tsx`（新增） | 骨架渲染 + overlay-click + Escape + role/aria + side=right 定位 |

---

## 5. 验收标准（门禁）

### 5.1 非回归

- DOM 结构、ARIA 契约（`role="dialog"`/`aria-modal="true"`/`aria-label`）、focus trap、Escape 语义、按钮文案与回调**不变**。
- 既有单测全绿：`ApprovalModal.test.tsx`（10）、`CreateDialog.test.tsx`（12）、`WorkspaceFilesPanel.test.tsx`（6）、`space.test.ts`（10）。
- 镜像内 `npm test` ≥ 307 passed + 新增 ModalShell/DrawerShell 单测 + `tsc -b && vite build` 无错。
- **`data-testid` 不变**：`approval-modal`、`confirm-dialog` 等既有测试钩子保留（ModalShell 接受 `data-testid` 透传或在容器上保留）。

### 5.2 叠层 bug 修复验证（Playwright）

- 打开 ApprovalModal/ConfirmDialog/CreateDialog 时，overlay z-index = `var(--z-modal)`(200) > `var(--z-header)`(100)，顶栏不盖在模态之上。
- 打开 WorkspaceFilesPanel 抽屉时同理。
- 断言：模态打开时 `.app-header` 的实际叠层低于 overlay（或 overlay 覆盖顶栏区域）。

### 5.3 a11y 修复验证（Playwright）

- SpacePage 视频预览打开后：按 Escape 可关闭；Tab 焦点圈定在 Modal 内（不逃逸到背后页面）。

### 5.4 overlay-click 行为保现验证

- ApprovalModal/ConfirmDialog：点 overlay 不关闭（`closeOnOverlayClick={false}`）。
- CreateDialog/SpacePage：点 overlay 关闭（`closeOnOverlayClick={true}`）。

### 5.5 视觉与多主题

- 5 主题（default/dark/minimal/cyberpunk/solarized）下 4 模态 + 2 抽屉不破版（圆角/阴影/遮罩/对比度正常）。
- 375px（iPhone SE）下模态 `w-full` + overlay padding 不溢出。
- 截图归档 `docs/overlay-primitives-before-after/`（before: 现状 / after: 接入后，5 主题 × 6 浮层矩阵，可子集采样）。

---

## 6. Risks / Trade-offs

- [`ModalShell` 参数过多成 God Component] → 仅 6 个 prop，每个有明确用例（max-w/containerStyle/overlayDim/overlayPadding/closeOnOverlayClick/containerClassName），不预留无用 slot；后续若需扩展再评估。
- [ApprovalModal `onClose=reject` 语义混淆] → 文档标注「关闭=拒绝」是当前行为保现；若团队认为应分离，提单独 UX 议题（D1 评审待确认）。
- [CreateDialog 删除 `onKeyDown` 后 Escape 行为变化] → `useFocusTrap({onEscape})` 已覆盖 Escape，行为等价；单测验证 Escape→close 不变。
- [`data-testid` 透传] → ModalShell 容器 `div` 接受 `data-testid` 透传或在容器上保留，确保既有 `approval-modal`/`confirm-dialog` 钩子不断。
- [改动面扩散] → 严格限文件清单（P0/P1）；P0→P1 串行门禁；每级独立 commit。

---

## 7. 文件清单（预估）

**新增（4）**：
- `src/components/Common/ModalShell.tsx` + `__tests__/ModalShell.test.tsx`
- `src/components/Common/DrawerShell.tsx` + `__tests__/DrawerShell.test.tsx`

**修改（6）**：
- `components/Approval/ApprovalModal.tsx`
- `components/Common/ConfirmDialog.tsx`
- `components/Session/CreateDialog.tsx`
- `components/Settings/SettingsPanel.tsx`
- `components/Session/WorkspaceFilesPanel.tsx`
- `modules/space/SpacePage.tsx`

**归档**：`docs/overlay-primitives-before-after/`（截图）、OpenSpec change `design-frontend-overlay-primitives`。

---

## 8. 里程碑

| 里程碑 | 内容 | 门禁 |
|---|---|---|
| M1 | ModalShell + 4 居中浮层接入（P0） | 单测 + 5 主题截图 + z-index 修复验证 + overlay-click 保现验证 |
| M2 | DrawerShell + 2 抽屉接入（P1） | 单测 + 5 主题截图 + z-40 修复验证 |
| M3 | OpenSpec change `design-frontend-overlay-primitives` 归档 + memory 更新 | openspec validate + 归档顶层 archive |

每个里程碑独立 commit，门禁不过不进下一级。测试一律在既有 Docker 镜像（`openharness-design-frontend:test`/`e2e`）内执行。

---

## 附录 B — DetailLayout 可行性验证（不在本次范围）

**为何不直接抽象**：video（GA 真 backend）/ drawio（demo）/ ui-design（demo）三模块未来演进方向未定——video 可能增文件抽屉/模型选择器嵌入、drawio 可能增图表编辑工具栏、ui-design 可能增组件库面板。贸然参数化（`historyWidth`/`previewMode`/`chatInset`）易成 God Component。

**可行性验证清单（后续独立立项前先回答）**：
1. 三模块未来 6 个月是否有新增子栏（如文件抽屉、组件库、工具栏）的需求？
2. 三栏顺序是否恒为「历史 | chat | 预览」？是否可能变「chat | 预览 | 历史」或双栏？
3. drawio 的「预览常显」与 video/ui-design 的「预览 toggle」是否会在 GA 后统一？
4. chat 区 10% 留白是否为设计恒量，还是会被未来响应式策略回收？
5. 抽象后新增模块的接入成本是否真的低于现状（复制 + 改 3 处 CSS 修饰符）？

**验证产出**：一份决策文档（落 `docs/detail-layout-feasibility.md`），回答上述 5 问后再决定是否立项 `design-frontend-detail-layout`。

---

## 附录 C — Card 暂缓触发条件（不在本次范围）

**为何暂缓**：当前仅 2 处同构卡片（HomePage `ModuleCard` / SpacePage `AssetCard`），复用收益不足，且二者 thumb/body 内容差异较大（模块卡有「进入按钮」、资产卡有「下载/类型标签」），强行抽 slot 可能反而限制表达。

**触发条件**（满足任一即重新评估）：
1. 出现第 3 处同构卡片（thumb + body 两段、用 `--radius-card`/`--shadow-card`）。
2. HomePage/SpacePage 任一卡片视觉规范变更，需统一圆角/阴影/hover 变换。

**触发后产出**：立项 `design-frontend-card-primitive`，评估 slot 设计（`thumb`/`body`/`footer` slot + `variant` prop）。

---

## 附录 D — 断点统一策略重设计（不在本次范围）

**为何不引入 `md2/lg2`**：当前已有两套断点（demo.css `@media 1100/900/640` + Tailwind `sm/md/lg`），新增 `md2:900`/`lg2:1100` 会形成**第三套**，且 `md2`/`lg2` 命名与社区约定不一致，维护成本上升。先定「未来唯一标准」再决定迁移路径。

**待回答的决策问题**：
1. 未来唯一断点标准是「Tailwind 工具类 everywhere」还是「demo.css `@media` + 令牌」？
   - 若 Tailwind：demo.css 原生类需逐步退役为 Tailwind 工具类（成本高，但响应式变体天然集成）。
   - 若 demo.css `@media`：Tailwind 组件的 `sm:`/`md:` 需对齐 demo.css 断点值（调整 `tailwind.config.screens`）。
2. demo.css 现有断点 `1100/900/640` 是否合理？是否应改为 Tailwind 标准 `1024/768/640`（`lg/md/sm`）？
3. 是否允许「demo.css `@media` 用于原生类、Tailwind 工具类用于组件 tsx」的双轨共存，只要断点值对齐？

**决策产出**：一份断点策略 ADR（落 `docs/breakpoint-strategy-adr.md`），定单一标准后再立项迁移 change。本次 ModalShell/DrawerShell 的响应式（`sm:w-96` 等）按现状保留，不预先对齐。
