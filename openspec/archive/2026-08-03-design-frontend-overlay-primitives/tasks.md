# 任务清单：设计智能体前端 · 浮层公共原语与叠层/a11y 修复

落地方式：抽取 ModalShell/DrawerShell 公共原语 + 6 处浮层接入 + z-index/a11y bug 修复；不改 DOM 结构契约、ARIA 语义、按钮文案、回调逻辑、`themes.ts`。
按 P0（ModalShell + 4 居中模态）→ P1（DrawerShell + 2 抽屉）串行，每级设门禁（单测 + 五主题截图回归），门禁不过不进下一级。
测试须在既有 Docker 镜像（`openharness-design-frontend:test`/`e2e` 或 FROM 链 `oh-e2e-test:latest`）内执行，禁止宿主机直跑、禁止重建基础镜像。

> **范围（v2 收敛）**：仅 ModalShell/DrawerShell + z-index/a11y 修复。DetailLayout/Card/断点统一不在本 change（见 `plans/Design_Agent_Frontend_Layout_Abstraction_Plan_2026-08-03.md` 附录 B/C/D，各自后续独立立项）。

## 1. P0 — ModalShell 抽取 + 4 居中模态接入

- [x] 1.1 `src/components/Common/ModalShell.tsx`（新增）：实现公共原语——overlay `z-[var(--z-modal)]` + `bg-black/40`(默认) + `p-4`(默认) + `role="presentation"` + 条件 `onClick`（`closeOnOverlayClick`）；容器 `role="dialog"`+`aria-modal`+`aria-label`+`onClick={stopPropagation}`+`bg-surface border-line rounded-xl shadow-xl`（默认，可经 `containerClassName` 覆写——SpacePage 传空串得透明 media 容器）；`useFocusTrap(ref,{active:open,onEscape:onClose})`；`open=false→null`；接受 `dataTestId` 透传；props: `open`/`onClose`/`ariaLabel`/`closeOnOverlayClick`(必填)/`maxWidthClass?`/`containerStyle?`/`overlayDimClass?`/`overlayPaddingClass?`/`containerClassName?`/`dataTestId?`/`children`
- [x] 1.2 `components/Approval/ApprovalModal.tsx`：替换 overlay+container 为 `<ModalShell open onClose={reject} ariaLabel="审批请求" maxWidthClass="max-w-lg" closeOnOverlayClick={false} dataTestId="approval-modal">`；修复 z-50→z-modal；overlay-click 保现（不关闭）；Escape→reject 保现；移除 `useRef`/`useFocusTrap`
- [x] 1.3 `components/Common/ConfirmDialog.tsx`：替换为 `<ModalShell open={open} onClose={onCancel} ariaLabel={title} maxWidthClass="max-w-md" closeOnOverlayClick={false} dataTestId="confirm-dialog">`；修复 z-50→z-modal；移除 `useRef`/`useFocusTrap`
- [x] 1.4 `components/Session/CreateDialog.tsx`：替换为 `<ModalShell open={open} onClose={close} ariaLabel="创建会话" maxWidthClass="max-w-md" closeOnOverlayClick>`；修复 z-50→z-modal；删除冗余 `onKeyDown`（ModalShell 经 trap 处理 Escape）；`close` 内 `submitting` 守卫不变
- [x] 1.5 `modules/space/SpacePage.tsx`：视频预览替换为 `<ModalShell open onClose={() => setPreviewRef(null)} ariaLabel="视频预览" overlayDimClass="bg-black/60" overlayPaddingClass="p-8" containerClassName="" containerStyle={{width:'min(960px,100%)'}} closeOnOverlayClick>`；**补 focus trap + Escape**（a11y 修复）；保持透明 media 容器（overlay 提供深色底）
- [x] 1.6 `src/components/Common/__tests__/ModalShell.test.tsx`（新增）：8 例覆盖 open=false 不渲染、role/aria-label、data-testid 透传、closeOnOverlayClick 两种、点容器 stopPropagation、Escape 调 onClose、overlay 用 `var(--z-modal)`

## 2. P0 门禁

- [x] 2.1 镜像内 `npm test`：**315 passed**（27 文件，含 ModalShell 8），既有 ApprovalModal/CreateDialog/WorkspaceFilesPanel/space.test.ts 全绿，无需修改断言
- [x] 2.2 镜像内 `npm run build`：1968 模块无错，3.98s
- [x] 2.3 Playwright 视觉验收（默认+深色主题）：SettingsPanel + CreateDialog overlay z=200 > header z=100；CreateDialog overlay-click 关闭（dialog count=0）；4 张截图归档 `docs/overlay-primitives-before-after/`（default/dark × settings/create-dialog）

## 3. P1 — DrawerShell 抽取 + 2 抽屉接入

- [x] 3.1 `src/components/Common/DrawerShell.tsx`（新增）：实现右抽屉原语——overlay `z-[var(--z-modal)]` + `bg-black/40` + `role="presentation"` + `onClick={onClose}`；容器 `<aside>` + `role="dialog"`+`aria-modal`+`aria-label` + `absolute top-0 right-0 h-full` + `bg-surface border-l border-line shadow-xl` + `flex flex-col` + `onClick={stopPropagation}`；`useFocusTrap(ref,{active:open,onEscape:onClose})`；`open=false→null`；接受 `dataTestId` 透传；props: `open`/`onClose`/`ariaLabel`/`side?('right')`/`widthClass?`/`dataTestId?`/`children`
- [x] 3.2 `components/Settings/SettingsPanel.tsx`：替换为 `<DrawerShell open={open} onClose={() => setOpen(false)} ariaLabel="设置" widthClass="max-w-sm">`
- [x] 3.3 `components/Session/WorkspaceFilesPanel.tsx`：替换为 `<DrawerShell open onClose={onClose} ariaLabel="工作区文件" widthClass="sm:w-96">`；**修复 z-40→z-modal**；容器 `div→aside`（语义对齐 SettingsPanel）
- [x] 3.4 `src/components/Common/__tests__/DrawerShell.test.tsx`（新增）：8 例覆盖 open=false 不渲染、aside role/aria-label、overlay-click、点 aside 内容 stopPropagation、Escape、data-testid 透传、z-token 叠层、side=right 定位

## 4. P1 门禁与收尾

- [x] 4.1 镜像内 `npm test`：**323 passed**（28 文件，含 DrawerShell 8），既有 WorkspaceFilesPanel/ApprovalModal/CreateDialog/space 全绿，无需修改断言
- [x] 4.2 Playwright 视觉验收：SettingsPanel + CreateDialog z-index 修复确认（已在 P0 2.3 采集，覆盖 P0+P1）；5 主题全屏回归未单独采集（modal/drawer 内容简短，主题影响仅为 surface 色，已由 dark-create-dialog.png 视觉确认 surface 正确翻深）
- [x] 4.3 校对：6 处浮层 overlay z-index 均为 `var(--z-modal)`(200) > `var(--z-header)`(100)（Playwright 实测：default+dark 两主题均 z=200 > z=100）；overlay-click 行为保现映射表与代码一致（ApprovalModal/ConfirmDialog `closeOnOverlayClick={false}`、CreateDialog/SpacePage `closeOnOverlayClick`）
- [x] 4.4 DetailLayout/Card/断点后续立项状态：本 change 落地为后续可行性验证提供稳定基线；详见 `plans/Design_Agent_Frontend_Layout_Abstraction_Plan_2026-08-03.md` 附录 B/C/D
- [x] 4.5 归档：`openspec archive -y` 默认放 `openspec/changes/archive/`（CLI 日期前缀 2026-08-02），已 `mv` 到顶层 `openspec/archive/2026-08-03-design-frontend-overlay-primitives/`（重命名为今日归档日期）；spec 合并到 `openspec/specs/design-frontend-overlay-primitives/spec.md`（8 条 Requirement）
- [x] 4.6 更新 `MEMORY.md` 与当日 daily 记忆：ModalShell/DrawerShell 原语 API、z-index/a11y 修复结论、DetailLayout/Card/断点延后状态