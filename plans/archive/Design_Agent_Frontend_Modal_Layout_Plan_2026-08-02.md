<!-- 最后更新：2026-08-02（v2，按评审意见收敛） -->

# 设计智能体前端 — 提示框/模态框布局间距整改方案

- 日期：2026-08-02
- 状态：待评审（v2 收敛后，确认再整理为 OpenSpec）
- 范围：`design-agent-frontend/src/` 下浮层组件的**纯样式/间距/排版整改**
- 参考基准：现代 UI 设计标准（Material 3 / Apple HIG / Tailwind UI）、demo 设计令牌（`src/styles/demo.css :root`）、`plans/Design_Agent_Frontend_Four_Modules_Plan_2026-07-31.md`

> **v2 收敛说明**（相对 v1）：① **剥离 ModalShell 抽象**，本次仅做纯样式整改，ModalShell 单独立项（见附录 A）；② 增加 **P0/P1/P2 优先级**；③ 补充**关键数值依据**；④ 增加 **Before/After 视觉对比矩阵**；⑤ 明确**设计令牌使用策略**，避免 token 与 Tailwind 工具类两套并存。

---

## 1. 背景与目标

### 1.1 问题现象

`design-agent-frontend` 中多处浮层组件文字显示拥挤、间距不合理，主要表现：

1. **行高偏紧**：正文用 Tailwind `text-sm`/`text-xs`，其内置 `line-height` 分别为 1.43 / 1.33，对中文段落偏紧，多行时阅读吃力。
2. **内边距偏小**：容器多用 `p-5`（20px）/ `p-4`（16px），在 `max-w-sm`（384px）级窄对话框内文字几乎贴边。
3. **段落间距不一致**：标题↔正文、正文↔按钮之间 `mt-2`（8px）/ `mt-3`（12px）/ `mt-5`（20px）混用，无统一节奏。
4. **按钮组 gap 偏小**：统一用 `gap-2`（8px），低于现代标准 12px，多按钮换行时尤为拥挤。
5. **双行列表项无间距**：`WorkspaceFilesPanel`、`CreateDialog` 策略卡的两行文本均为 `block` 且无 `mt`，行间几乎贴合。
6. **`SpacePage` 视频预览用内联 style** 硬编码颜色/间距，绕过设计系统，暗色主题下不可用。

### 1.2 目标

- 建立统一的**浮层间距/排版令牌**，并在组件层用 Tailwind 工具类落地，使间距可全局调参。
- 使所有提示框符合现代 UI 标准：正文 `line-height ≥ 1.5`、容器内边距 ≥ 20px（内容框 24px）、标题↔正文 ≥ 12px、按钮组 `gap ≥ 12px`。
- **不改变任何交互逻辑、文案、ARIA 契约、DOM 结构**；现有单测（语义查询 `getByRole`/`getByText`）不受影响。
- 不引入新依赖；改动集中在 className 与少量 CSS 类调整。

### 1.3 边界（本次不做）

- **不抽取 ModalShell 公共原语**（涉及 focus trap/ARIA/DOM 结构，风险高于样式调整；待本次样式整改落地、确认重复确实显著后，单独立项，见附录 A）。
- 不改动 `session-frontend/`、`web/`。
- 不调整主题色板（`themes.ts`）。
- 不重构 WS/Store/API 逻辑。
- 不新增 i18n。
- `ErrorBanner.tsx`（横幅）已达基线，不改。

---

## 2. 设计令牌与基线标准

### 2.1 新增间距/排版令牌（落入 `src/styles/demo.css :root`）

当前 `:root` 仅有 `--radius-*` / `--shadow-*` / `--transition-*` / `--font-stack`，**缺间距/行高令牌**。新增：

```css
:root {
  /* ...existing tokens... */
  --space-xs: 4px;     /* 行内紧凑 */
  --space-sm: 8px;     /* 同组元素 */
  --space-md: 12px;    /* 标题↔正文 / 按钮组 gap（新基线） */
  --space-lg: 16px;    /* 段落间 */
  --space-xl: 24px;    /* 容器内边距 / 区块间 */
  --space-2xl: 32px;   /* 大区块留白 */
  --leading-body: 1.6;     /* 正文行高（对应 Tailwind leading-relaxed 1.625） */
  --leading-tight: 1.45;   /* 紧凑文本（路径/元数据） */
}
```

> 去掉了 v1 的 `--modal-pad/gap-block/btn-gap` 派生令牌——因本次不复用 ModalShell，组件层直接用 Tailwind 工具类表达，派生令牌只会增加间接层、形成两套规范。仅保留原子 `--space-*`/`--leading-*` 供 `demo.css` 原生类使用。

### 2.2 浮层布局基线（Modern UI Standard）

| 维度 | 旧值（现状） | 新基线 | 依据 |
| --- | --- | --- | --- |
| 容器内边距 | `p-5`(20px) / `p-4`(16px) | 内容框 `p-6`(24px)；窄确认框 `p-5`(20px) | Material 3 dialog padding 24px |
| 正文行高 | `text-sm`(1.43) / `text-xs`(1.33) | 正文 `leading-relaxed`(1.625)；元数据 `leading-snug`(1.375) | WCAG 1.4.8 行高 ≥ 1.5 |
| 标题↔正文 | `mt-2`(8px) | `mt-3`(12px) | 视觉分组最小间距（8px 易被误读为同组） |
| 正文↔按钮组 | `mt-5`(20px) | `mt-6`(24px) | 区块分隔（操作区独立分组） |
| 按钮组 gap | `gap-2`(8px) | `gap-3`(12px) | Apple HIG 按钮间距 12px |
| 双行列表项行距 | 无（block 贴合） | `mt-0.5`(2px) 或 `mt-1`(4px) | 同组行内紧凑，不破坏分组 |
| 对话框 max-width | `max-w-sm/md/lg` 混用 | 确认框 `max-w-md`；内容框 `max-w-lg` | 按内容量分级（见 §2.5） |
| 圆角 | `rounded-xl`(12px) | 保持 | 已达标 |
| 阴影 | `shadow-xl` | 保持 | 已达标 |
| 遮罩 | `bg-black/40` | 保持（视频预览 `bg-black/60`） | 已达标 |

### 2.3 关键数值依据（Review 焦点）

集中说明几个"非显然"数值的取舍依据，避免 Review 时反复追问：

| 调整 | 现状 | 新值 | 依据 |
| --- | --- | --- | --- |
| ConfirmDialog `max-w-sm → max-w-md` | 384px | 448px | 现状长消息（如"确认关闭当前会话？关闭后不可再对话，历史消息与文件仍可查看。"约 28 字）在 384px − 2×24px = 336px 内容宽、14px 字号下约 24 字/行，会折成 2 行且第二行仅 4 字（孤立行/orphan）；448px → 内容宽 400px ≈ 28 字/行，单行容纳。可读性最优行长中文 22–37 字，400px 接近区间下限 |
| QuestionPrompt `rows=3 → 4` | 3 行 | 4 行 | 现状 3 行 × `text-sm`(20px 行高) ≈ 60px 可视高度，多行回答需频繁滚动；4 行 ≈ 80px，配合 `leading-relaxed` 后仍不超浮层视窗 40%。表单最佳实践 textarea 默认 3–5 行 |
| DiffApproval `max-h-64 → max-h-72` | 256px | 288px | diff `text-xs`(12px) × `leading-5`(20px) = 20px/行；256px 容约 12 行，OH 编辑 diff 常 15–20 行需频繁滚动；288px 容约 14 行，且在 max-w-lg 浮层 + 768px 视窗下占 37%（< 40% 视窗阈值） |
| 容器 `p-5 → p-6` | 20px | 24px | Material 3 dialog 内边距 24px；现状 20px 在 `max-w-sm` 下文字距边 20px 略贴 |
| 按钮 `gap-2 → gap-3` | 8px | 12px | Apple HIG 按钮间距 12px；8px 在三按钮换行时第二行按钮易被误点 |
| 正文 `leading-relaxed` | 默认 1.43 | 1.625 | WCAG 1.4.8 正文行高 ≥ 1.5；中文笔画密集需更大行高，1.625 为 Tailwind 内置最接近 1.6 的档位 |
| CreateDialog 策略卡 `gap-2 → gap-2.5` | 8px | 10px | 两个 radio 卡片需明显分组但不过分疏离；10px 在视觉上既区分又不松散（介于 `gap-2`/`gap-3` 之间） |

### 2.4 设计令牌使用策略（避免两套并存）

> **核心原则：单一维度单一写法。** 不在同一个组件内用 token 和 Tailwind 类表达同类间距，避免"两套规范长期并存"。

| 场景 | 用什么 | 理由 |
| --- | --- | --- |
| **组件 JSX 内布局间距**（`p-6`/`mt-3`/`gap-3`/`leading-relaxed`） | **Tailwind 工具类** | 与响应式/状态变体（`md:`/`hover:`）天然集成，可读性好，IDE 补全完整 |
| **`demo.css` 内原生 CSS 类**（`.btn-*`/`.history-item`/`.model-option`/`.space-*`） | **`var(--space-*)`/`var(--leading-*)` token** | 原生 CSS 无法用 Tailwind 工具类，需 token 提供可调旋钮 |
| **内联 `style`**（仅 SpacePage 残留动态尺寸） | **token**（颜色/间距）/ 内联（纯动态数值如 `width: min(960px,100%)`） | 颜色/间距必须走 token 以适配多主题；纯动态数值可内联 |
| **跨主题需统一切换的间距基线** | **token** | 通过改 `:root` 一处全局生效 |

**一致性约束**：token 数值与 Tailwind 工具类数值必须对齐（`--space-md: 12px` ↔ `gap-3` = 12px；`--leading-body: 1.6` ↔ `leading-relaxed` = 1.625）。两者是"同一间距体系在两层的两种表达"，不是两套规范。定期校对：若调整 token，同步检查对应 Tailwind 类是否需更新（反之亦然）。

**反模式（禁止）**：
- ❌ 在组件 JSX 写 `style={{ padding: 'var(--space-xl)' }}` 表达容器内边距（应用 `className="p-6"`）。
- ❌ 在 `demo.css` 原生类写 `padding: 24px` 硬编码（应用 `var(--space-xl)`）。
- ❌ 同一组件的标题间距用 `mt-3`、正文间距用 `style={{marginTop:'var(--space-md)'}}` 混用。

---

## 3. 优先级与逐组件整改清单

### 3.0 优先级总表

| 优先级 | 范围 | 组件 | 理由 |
| --- | --- | --- | --- |
| **P0** | Modal/Dialog 核心 | `ApprovalModal`（含 PermissionPrompt/DiffApproval/QuestionPrompt）、`ConfirmDialog`、`CreateDialog` | 用户直接感知的"提示框拥挤"主战场；审批弹窗在 interactive 策略下高频出现 |
| **P1** | Drawer 抽屉 | `SettingsPanel`、`WorkspaceFilesPanel` | 侧滑抽屉，文字密集度次之，但列表项双行贴合需修 |
| **P2** | 外围浮层 | `ModelSelector` 下拉、`SpacePage` 视频预览 Modal（去内联） | 下拉仅微调；SpacePage 预览 Modal 去 inline style 接设计系统（暗主题可用性） |

> 实施按 P0 → P1 → P2 串行，每级完成后跑一次单测 + 视觉回归，避免一次性大改。

### 3.1 `components/Approval/ApprovalModal.tsx`（容器）【P0】

**现状**（`ApprovalModal.tsx:62-91`）：
- 容器 `max-w-lg ... p-5`（20px）偏紧。
- 头部 `mb-4`（16px）→ 正文节奏断裂。
- 倒计时 `gap-1`（4px）与图标过近。

**改法**（就地 className 调整，不动 DOM 结构）：
- `p-5` → `p-6`（24px）。
- 头部 `mb-4` → `mb-5`（20px）。
- 倒计时 `gap-1` → `gap-1.5`（6px）。
- 标题 `text-base` → `text-base leading-snug`。

### 3.2 `components/Approval/PermissionPrompt.tsx`【P0】

**现状**（`PermissionPrompt.tsx:15-24`）：
- 工具名 `<p>` 与 `reason` 之间 `mt-1`（4px）偏紧。
- `reason` 用 `text-xs`（行高 1.33）多行拥挤。

**改法**：
- `reason`：`text-xs` → `text-xs leading-relaxed`，`mt-1` → `mt-2`（8px）。
- 工具名 `<p>`：`text-sm` → `text-sm leading-relaxed`。
- 按钮组 `mt-5 gap-2` → `mt-6 gap-3`（`DiffApproval`/`QuestionPrompt` 同步）。
- 内联 `<code>` `px-1` → `px-1.5 py-0.5`。

### 3.3 `components/Approval/DiffApproval.tsx`【P0】

**现状**（`DiffApproval.tsx:24-47`）：
- "请求修改文件" 与路径 `mt-0.5`（2px）贴合。
- 统计行 `mt-1`（4px）。
- diff `<pre>` `mt-3 max-h-64 p-3 text-xs leading-5` —— `p-3`(12px) 偏紧，`max-h-64` 容行不足。

**改法**：
- 路径 `mt-0.5` → `mt-1`（4px）；`text-xs` → `text-xs leading-snug`。
- 统计行 `mt-1` → `mt-1.5`（6px）。
- diff `<pre>`：`mt-3` → `mt-4`（16px）；`p-3` 保持但加 `leading-6`(24px) 使 diff 行更清晰；`max-h-64` → `max-h-72`（288px，依据见 §2.3）。
- 按钮组 `mt-5 gap-2` → `mt-6 gap-3`。

### 3.4 `components/Approval/QuestionPrompt.tsx`【P0】

**现状**（`QuestionPrompt.tsx:22-47`）：
- 问题文本 `text-sm font-medium whitespace-pre-wrap` 无显式行高，多行问题偏紧。
- textarea `mt-3 px-3 py-2 text-sm` —— `py-2`(8px) 偏紧，`rows=3` 可视行数不足。
- 按钮组 `mt-4 gap-2`。

**改法**：
- 问题文本：`text-sm` → `text-sm leading-relaxed`。
- textarea：`py-2` → `py-2.5`(10px)；`mt-3` → `mt-4`；`rows={3}` → `rows={4}`（依据见 §2.3）；`text-sm` → `text-sm leading-relaxed`。
- 按钮组 `mt-4 gap-2` → `mt-5 gap-3`。

### 3.5 `components/Common/ConfirmDialog.tsx`【P0】

**现状**（`ConfirmDialog.tsx:39-63`）：
- 容器 `max-w-sm`(384px) `p-5` —— 窄框 + 20px 内边距，长消息易贴边。
- 标题↔消息 `mt-2`(8px) 偏紧。
- 消息 `text-muted text-sm` 无行高覆盖。
- 按钮组 `mt-5 gap-2`。

**改法**：
- 容器 `max-w-sm` → `max-w-md`(448px，依据见 §2.3)；`p-5` → `p-6`(24px)。
- 标题 `text-base` → `text-base leading-snug`；`mt-2` → `mt-3`(12px)。
- 消息 `text-sm` → `text-sm leading-relaxed`。
- 按钮组 `mt-5 gap-2` → `mt-6 gap-3`。
- 取消按钮 `hover:bg-raised` → `hover:bg-raised/60`（更柔和）。

### 3.6 `components/Session/CreateDialog.tsx`【P0】

**现状**（`CreateDialog.tsx:139-256`）：
- 容器 `max-w-md p-5`。
- 策略卡 `p-3`，标签 `text-sm block` + 描述 `text-xs block` **无间距**（贴合）。
- 高级参数 `mt-4`，输入 `px-3 py-2`，helper `mt-1 text-xs`。
- submitError `mt-3 text-sm`。
- 按钮组 `mt-5 gap-2`。
- 关闭按钮 `p-1` 点击区偏小。

**改法**：
- 容器 `p-5` → `p-6`。
- 策略卡：标签与描述之间加 `mt-1`（4px）；描述 `text-xs` → `text-xs leading-snug`；卡片 `p-3` → `p-3.5`(14px)；卡组 `gap-2` → `gap-2.5`(10px，依据见 §2.3)。
- 高级参数区块 `mt-4` → `mt-5`；输入 `py-2` → `py-2.5`；helper `mt-1` → `mt-1.5`，`text-xs` → `text-xs leading-snug`。
- submitError `mt-3` → `mt-4`，`text-sm` → `text-sm leading-relaxed`。
- 按钮组 `mt-5 gap-2` → `mt-6 gap-3`。
- 关闭按钮 `p-1` → `p-1.5`（6px，命中触控区）。

### 3.7 `components/Settings/SettingsPanel.tsx`（抽屉）【P1】

**现状**（`SettingsPanel.tsx:28-56`）：
- 抽屉 `max-w-sm`，body `space-y-6 p-4`(16px) 偏紧。
- section 标题 `mb-2`。

**改法**：
- body `p-4` → `p-5`(20px)；`space-y-6`(24px) 保持。
- section 标题 `mb-2` → `mb-3`(12px)。
- 头部 `px-4 py-3` 保持。

### 3.8 `components/Session/WorkspaceFilesPanel.tsx`（抽屉）【P1】

**现状**（`WorkspaceFilesPanel.tsx:113-137`）：
- 列表项 `px-4 py-2`，路径 `block text-xs` + meta `block text-xs` **无间距**。

**改法**：
- 列表项 `py-2` → `py-2.5`(10px)；meta `block` → `block mt-0.5`(2px) + `leading-snug`。
- 路径 `text-xs` → `text-xs leading-snug`。
- `stale` 提示 `py-1.5` → `py-2`。
- prefix 输入 `py-1.5` 保持（紧凑工具栏可接受）。

### 3.9 `modules/space/SpacePage.tsx`（视频预览 Modal —— 去内联）【P2】

**现状**（`SpacePage.tsx:228-273`）：
- 整个预览 Modal 用 **内联 `style`** 硬编码 `padding:32`、按钮 `padding:'6px 16px'`、`border:1px solid rgba(255,255,255,0.4)`，绕过设计系统，暗主题下颜色不可控。

**改法**（去 inline style，接 Tailwind/设计系统；不引入 ModalShell）：
- 遮罩 `div`：内联 `style` → `className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8"`。
- 内容容器：`width: min(960px, 100%)` 保留为内联（纯动态尺寸，按 §2.4 允许）；其余抽到类。
- 关闭按钮：内联 `style` → `className="mt-3 rounded-lg border border-white/40 px-4 py-1.5 text-sm text-white hover:bg-white/10"`。
- 新增 `.preview-modal-close` 工具类到 `demo.css`（用 token 表达颜色/间距），供暗主题复用。

### 3.10 `modules/video/ModelSelector.tsx`（下拉）【P2】

**现状**（demo.css `.model-option padding: 8px 12px`）：
- 选项 `8px 12px`，字号 13px，长列表略密。

**改法**（`demo.css` 原生类，用 token）：
- `.model-option` `padding: 8px 12px` → `padding: var(--space-sm) var(--space-md)`（9px/12px 量级，用 token 表达）；显式 `line-height: var(--leading-tight)`。
- `.model-dropdown` `min-width: 160px` → `180px`（容纳长模型名）。
- 优先级最低，仅微调。

### 3.11 `components/Common/ErrorBanner.tsx`（横幅，不改）

`px-4 py-2 text-sm gap-2` 已达基线，**不改**，仅记录覆盖完整性。

---

## 4. 改动文件清单

| 文件 | 优先级 | 改动类型 | 说明 |
| --- | --- | --- | --- |
| `src/styles/demo.css` | P0 | 新增令牌 + 微调 `.model-option` | 间距/行高令牌（§2.1） |
| `src/components/Approval/ApprovalModal.tsx` | P0 | className 调整 | 容器/头部间距（§3.1） |
| `src/components/Approval/PermissionPrompt.tsx` | P0 | className 调整 | 行高/间距（§3.2） |
| `src/components/Approval/DiffApproval.tsx` | P0 | className 调整 | 间距/diff 容器（§3.3） |
| `src/components/Approval/QuestionPrompt.tsx` | P0 | className 调整 | 行高/textarea（§3.4） |
| `src/components/Common/ConfirmDialog.tsx` | P0 | className 调整 | max-w/间距/行高（§3.5） |
| `src/components/Session/CreateDialog.tsx` | P0 | className 调整 | 策略卡间距/排版（§3.6） |
| `src/components/Settings/SettingsPanel.tsx` | P1 | className 调整 | body padding（§3.7） |
| `src/components/Session/WorkspaceFilesPanel.tsx` | P1 | className 调整 | 列表项间距（§3.8） |
| `modules/space/SpacePage.tsx` | P2 | 去内联样式 | 预览 Modal 接设计系统（§3.9） |
| `modules/video/ModelSelector.tsx`（+ demo.css） | P2 | className/CSS 调整 | 下拉项间距（§3.10） |

**不改动**：`ErrorBanner.tsx`、`themes.ts`、所有 `__tests__`、WS/Store/API 层、DOM 结构。
**不新增**：`ModalShell.tsx`（剥离至附录 A 后续立项）。

---

## 5. 验证与测试

### 5.1 单元测试（既有，必须在已有 Docker 镜像内跑）

按项目约定（`always_applied_user_rules` + MEMORY.md），所有测试在**已有 Docker 镜像**内执行，禁止宿主机直跑、禁止重建基础镜像。

- `design-agent-frontend` 单测容器：基于 `openharness-design-frontend:e2e`（FROM 链 `oh-e2e-test:latest`）挂载源码跑 `vitest`。
- 受影响用例：
  - `src/components/Approval/__tests__/ApprovalModal.test.tsx`（10 例）
  - `src/components/Session/__tests__/CreateDialog.test.tsx`
- **断言均为语义查询**（`getByRole`/`getByText`/`getByLabelText`/`getByTestId`），不依赖 className/padding；且本次**不改 DOM 结构**（仅 className 调整），故单测预期全绿，无需改断言。

### 5.2 视觉验收流程

在 `design-agent-frontend` dev 容器内启动 vite，按 §5.3 对比矩阵逐项核对，并采集 Before/After 截图归档至 `docs/modal-layout-before-after/`。

- 多主题回归：default / dark / minimal / cyberpunk / solarized 五主题下浮层均不破版（重点验 SpacePage 预览 Modal，因原内联样式仅适用亮色）。
- 响应式：375px（iPhone SE）宽度下 `max-w-md`/`max-w-lg` 浮层不溢出（overlay `p-4` + `w-full` 保障）。

### 5.3 Before/After 视觉对比矩阵

> 截图待实施后采集（P0 完成后先采 ApprovalModal/ConfirmDialog/CreateDialog 三组）。下表为文字版对比，供评审预判效果。

| 组件 | Before（现状痛点） | After（预期改善） | 验收点 |
| --- | --- | --- | --- |
| **ApprovalModal / PermissionPrompt** | 工具名与 reason 仅 4px 间距；reason `text-xs` 行高 1.33，多行挤压；三按钮 `gap-2`(8px) 换行时易误点 | reason 行高 1.625，与工具名 8px 间距；按钮 `gap-3`(12px)；容器 `p-6`(24px) 文字距边舒展 | 多行 reason 可读性；按钮 hover 不重叠 |
| **ApprovalModal / DiffApproval** | diff 区 `max-h-64` 容 12 行需频繁滚动；路径与标题 2px 贴合 | diff 区 `max-h-72` 容 14 行；路径 `mt-1`(4px) + `leading-snug` | 15 行 diff 首屏可见行数增加 |
| **ApprovalModal / QuestionPrompt** | textarea `rows=3` 60px，多行回答需滚动；问题文本无行高覆盖 | textarea `rows=4` 80px + `leading-relaxed`；问题文本行高 1.625 | 4 行回答不滚动；多行问题不挤压 |
| **ConfirmDialog** | `max-w-sm`(384px) 长消息折行 orphan；标题↔消息 8px；消息无行高覆盖 | `max-w-md`(448px) 长消息单行；标题↔消息 12px；消息行高 1.625 | 28 字消息单行容纳；多行长消息行距舒展 |
| **CreateDialog** | 策略卡标签与描述贴合无间距；卡组 `gap-2`；关闭按钮 `p-1` 触控区小 | 卡片标签↔描述 `mt-1`；卡组 `gap-2.5`；关闭按钮 `p-1.5` | 两行文本有明显分组；关闭按钮易点中 |
| **WorkspaceFilesPanel** | 列表项路径与 meta 贴合；`py-2` 偏紧 | meta `mt-0.5` + `leading-snug`；`py-2.5` | 双行项有微间距；列表不拥挤 |
| **SpacePage 预览 Modal** | 关闭按钮内联 `rgba(255,255,255,0.4)`，暗主题下颜色不可控 | Tailwind 类 `border-white/40`，多主题适配 | dark/cyberpunk 主题下按钮可见 |

### 5.4 E2E（真实后端，按需）

现有 `e2e/real-*.spec.ts` 覆盖审批/创建会话/关闭会话交互路径，间距改动不改变选择器语义与 DOM 结构，预期无需新增 E2E。若评审要求，可在 `real-category2.spec.ts` 故障注入用例后追加一次"审批弹窗按钮可点性"断言（可选）。

---

## 6. 实施步骤（按优先级串行）

**P0（核心 Modal/Dialog）**：
1. **令牌层**：`demo.css` 新增 `--space-*` / `--leading-*`（低风险，纯增量）。
2. ApprovalModal 容器 + 三子 Prompt（Permission/Diff/Question）className 整改。
3. ConfirmDialog className 整改。
4. CreateDialog className 整改。
5. **P0 门禁**：跑单测 + 采集 ApprovalModal/ConfirmDialog/CreateDialog Before/After 截图 + 5 主题回归。门禁不过不进 P1。

**P1（Drawer）**：
6. SettingsPanel、WorkspaceFilesPanel className 微调。
7. **P1 门禁**：单测 + 视觉回归。

**P2（外围）**：
8. SpacePage 预览 Modal 去内联（接 Tailwind/设计系统）。
9. ModelSelector 下拉微调（demo.css）。
10. **P2 门禁**：全量单测 + 5 主题视觉回归 + 响应式 375px 验证。

**收尾**：
11. 更新 `plans/README.md`；完成后归档至 `plans/archive/`。
12. 视 ModalShell 立项必要性（见附录 A）决定是否开启新 OpenSpec change。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `max-w-sm`→`max-w-md` 使窄屏浮层变宽 | 低 | overlay `p-4` + `w-full` 保证不溢出；375px 回归验证（§5.2） |
| SpacePage 预览 Modal 去内联后 `CustomVideoPlayer` 宽度异常 | 中 | 保留 `width: min(960px, 100%)` 内联（动态尺寸，§2.4 允许），仅移除颜色/间距内联 |
| `leading-relaxed` 使多行文本变高，浮层在低分辨率视窗溢出 | 低 | diff 区有 `max-h-72` 滚动约束；其余浮层内容量小，768px 视窗下不溢出 |
| 5 主题下 token/类表现不一 | 低 | `--space-*`/`--leading-*` 不随主题变（仅颜色主题化），间距全主题一致 |
| 改动范围扩散 | 中 | 严格按 §4 清单，不触碰未列文件；P0/P1/P2 门禁隔离 |

回滚：每优先级独立 commit，必要时按优先级 `git revert`；令牌为 `:root` 纯增量，删除即恢复。

---

## 8. 验收标准

**P0 必达**：
- [ ] 所有 P0 浮层正文 `line-height ≥ 1.5`（`leading-relaxed`）。
- [ ] 所有 P0 浮层容器内边距 ≥ 24px（`p-6`）。
- [ ] 所有 P0 按钮组 `gap ≥ 12px`（`gap-3`）。
- [ ] 标题↔正文间距 ≥ 12px（`mt-3`）。
- [ ] ApprovalModal/ConfirmDialog/CreateDialog Before/After 截图已采集归档。
- [ ] 既有单测全绿（容器内执行）。

**P1 必达**：
- [ ] 双行列表项行间有 ≥ 2px 间距（`mt-0.5`+）。
- [ ] 抽屉 body padding ≥ 20px。

**P2 必达**：
- [ ] `SpacePage` 预览 Modal 不含硬编码颜色内联样式。
- [ ] ModelSelector 下拉项用 token 表达间距。

**全量**：
- [ ] 5 主题下浮层无破版。
- [ ] 375px 响应式不溢出。
- [ ] token 与 Tailwind 工具类数值一致性校对通过（§2.4）。

---

## 附录 A：ModalShell 公共原语（后续独立立项，不在本次范围）

**为何剥离**：ModalShell 涉及 `useFocusTrap` 复用、ARIA 契约、DOM 结构调整，风险显著高于纯 className 整改；且本次样式整改前难以量化"重复程度"。建议本次 P0–P2 落地后，统计各浮层 overlay/container 代码重复行数，若重复 ≥ 3 处且每处 ≥ 15 行，再单独立项推进 ModalShell，届时配套 focus trap/Escape/ARIA 单测。

**立项前置条件**（本次整改产物作为输入）：
- 各浮层 className 已统一为基线（§2.2），重复模式清晰可抽。
- 间距令牌已落地，ModalShell 可直接引用 token 而非硬编码。
- 现有 `useFocusTrap` hook 稳定（已用于 ApprovalModal/ConfirmDialog/CreateDialog/SettingsPanel/WorkspaceFilesPanel）。

**预期收益**（立项时评估）：overlay + container + focus trap 收敛为单一原语，新增浮层零成本对齐；`max-w`/`p-`/`rounded`/`shadow` 单一来源。

---

## 附：现代 UI 间距参考

| 来源 | 容器内边距 | 正文行高 | 按钮间距 | 标题↔正文 |
| --- | --- | --- | --- | --- |
| Material 3 (Dialog) | 24px | 1.5 | 8–12px | 16px |
| Apple HIG (Modals) | 20–24px | 1.4–1.5 | 12px | 12–16px |
| Tailwind UI | `p-6`(24px) | `leading-6`(1.5) | `gap-3`(12px) | `mt-3`(12px) |
| 本方案 | `p-6`/`p-5` | `leading-relaxed`(1.625) | `gap-3`(12px) | `mt-3`(12px) |
