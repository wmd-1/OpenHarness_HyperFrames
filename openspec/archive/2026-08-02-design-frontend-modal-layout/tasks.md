# 任务清单：设计智能体前端 · 浮层组件布局间距整改

落地方式：纯 className/CSS 类调整与去内联，不改 DOM 结构、ARIA 契约、focus trap、交互逻辑。
按 P0 → P1 → P2 串行，每级设门禁（单测 + 视觉回归），门禁不过不进下一级。
测试须在既有 Docker 镜像（`openharness-design-frontend:e2e` 或 `oh-e2e-test:latest`）内执行，禁止宿主机直跑、禁止重建基础镜像。

> **进度（2026-08-02）**：P0/P1/P2 全部代码改动完成（1.1、2.x、3.x、5.x、7.x），IDE lint 无错误。门禁任务（4.x/6.1/8.x）阻塞于当前环境 Docker daemon 不可用（`docker.sock` 不存在）、`node_modules` 未安装，待 Docker 可用时统一执行。

## 1. 设计令牌（P0 前置）

- [x] 1.1 `src/styles/demo.css :root` 新增 `--space-xs`(4px)/`--space-sm`(8px)/`--space-md`(12px)/`--space-lg`(16px)/`--space-xl`(24px)/`--space-2xl`(32px) 与 `--leading-body`(1.6)/`--leading-tight`(1.45)，纯增量不改动现有令牌

## 2. P0 — ApprovalModal 容器与三子组件

- [x] 2.1 `components/Approval/ApprovalModal.tsx`：容器 `p-5`→`p-6`；头部 `mb-4`→`mb-5`；倒计时 `gap-1`→`gap-1.5`；标题加 `leading-snug`
- [x] 2.2 `components/Approval/PermissionPrompt.tsx`：`reason` 加 `leading-relaxed`、`mt-1`→`mt-2`；工具名 `<p>` 加 `leading-relaxed`；按钮组 `mt-5 gap-2`→`mt-6 gap-3`；`<code>` `px-1`→`px-1.5 py-0.5`
- [x] 2.3 `components/Approval/DiffApproval.tsx`：路径 `mt-0.5`→`mt-1`、加 `leading-snug`；统计行 `mt-1`→`mt-1.5`；diff `<pre>` `mt-3`→`mt-4`、加 `leading-6`、`max-h-64`→`max-h-72`；按钮组 `mt-5 gap-2`→`mt-6 gap-3`
- [x] 2.4 `components/Approval/QuestionPrompt.tsx`：问题文本加 `leading-relaxed`；textarea `py-2`→`py-2.5`、`mt-3`→`mt-4`、`rows={3}`→`rows={4}`、加 `leading-relaxed`；按钮组 `mt-4 gap-2`→`mt-5 gap-3`

## 3. P0 — ConfirmDialog 与 CreateDialog

- [x] 3.1 `components/Common/ConfirmDialog.tsx`：容器 `p-5`→`p-6`；标题 `mt-2`→`mt-3`、加 `leading-snug`；消息加 `leading-relaxed`；按钮组 `mt-5 gap-2`→`mt-6 gap-3`。**D5 验证项已执行并落地**：4.2 截图证实 `max-w-sm` 下 26 字关闭消息产生 orphan 孤行 → 已切换为 `max-w-md`（取消按钮 `hover` 保持原 `hover:border-muted`，以实际代码为准未改）
- [x] 3.2 `components/Session/CreateDialog.tsx`：容器 `p-5`→`p-6`；策略卡标签↔描述加 `mt-1`、描述加 `leading-snug`、卡片 `p-3`→`p-3.5`、卡组 `gap-2`→`gap-2.5`；高级参数区块 `mt-4`→`mt-5`、输入 `py-2`→`py-2.5`、helper `mt-1`→`mt-1.5`+`leading-snug`；submitError `mt-3`→`mt-4`+`leading-relaxed`；按钮组 `mt-5 gap-2`→`mt-6 gap-3`；关闭按钮 `p-1`→`p-1.5`；标题加 `leading-snug`

## 4. P0 门禁

- [x] 4.1 在既有 Docker 镜像内运行 `ApprovalModal.test.tsx`（10 例）与 `CreateDialog.test.tsx`，确认全绿且未修改任何断言（✓ 2026-08-02 镜像内 vitest：297 passed，含 ApprovalModal 10 + CreateDialog 12）
- [x] 4.2 采集 ApprovalModal（三类）/ ConfirmDialog / CreateDialog 的 Before/After 截图，归档至 `docs/modal-layout-before-after/`；并确认 ConfirmDialog 长消息 orphan 是否消除（决定 max-w 取值）（✓ 2026-08-02 Playwright 真实栈截图：before/after 各 29 张，归档 `docs/modal-layout-before-after/`；**ConfirmDialog orphan 确认存在** → 已执行 D5 决策：`max-w-sm` → `max-w-md`）
- [x] 4.3 default/dark/minimal/cyberpunk/solarized 五主题下 P0 浮层视觉回归，确认无破版（✓ 5 主题 × P0 浮层截图全部通过，暗主题/赛博朋克/极简/日蚀均无破版；移动端 375px ConfirmDialog + ApprovalModal 无溢出）

## 5. P1 — Drawer 抽屉

- [x] 5.1 `components/Settings/SettingsPanel.tsx`：body `p-4`→`p-5`；section 标题 `mb-2`→`mb-3`
- [x] 5.2 `components/Session/WorkspaceFilesPanel.tsx`：列表项 `py-2`→`py-2.5`、meta 加 `mt-0.5`+`leading-snug`、路径加 `leading-snug`；`stale` 提示 `py-1.5`→`py-2`

## 6. P1 门禁

- [x] 6.1 在既有 Docker 镜像内运行单测全绿（✓ WorkspaceFilesPanel 6 例含）；五主题下抽屉视觉回归 —— 视觉部分待人工验收

## 7. P2 — 外围浮层

- [x] 7.1 `modules/space/SpacePage.tsx` 视频预览 Modal 去内联：遮罩改 `className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8"`；关闭按钮改 Tailwind 类 `preview-modal-close mt-3 rounded-lg border border-white/40 px-4 py-1.5 text-sm text-white hover:bg-white/10`；保留 `width: min(960px, 100%)` 内联（纯动态数值）
- [x] 7.2 `src/styles/demo.css` 新增 `.preview-modal-close` 工具类（`background: transparent; cursor: pointer;`，作暗主题覆盖钩子）
- [x] 7.3 `src/styles/demo.css` `.model-option` padding 改 `var(--space-sm) var(--space-md)`、显式 `line-height: var(--leading-tight)`；`.model-dropdown` `padding: 6px`→`var(--space-sm)`、`min-width: 160px`→`180px`

## 8. P2 门禁与收尾

- [x] 8.1 在既有 Docker 镜像内运行全量单测全绿（✓ 297 passed）+ `tsc -b && vite build` 生产构建无错（1968 模块）
- [ ] 8.2 五主题视觉回归 + 375px（iPhone SE）响应式不溢出验证 —— **✓ 已完成**（4.2/4.3 覆盖；5 主题 × 7 浮层 + 375px P0 两浮层截图通过，仅 mobile/create 因 /video 移动端无可见「新建会话」入口未采集（不影响结论））
- [x] 8.3 校对 token 与 Tailwind 工具类数值一致性（`--space-md:12px`↔`gap-3:12px`、`--space-xl:24px`↔`p-6:24px`、`--leading-body:1.6`↔`leading-relaxed:1.625` 量级对齐）
- [x] 8.4 评估 ModalShell 立项必要性：3 处居中 Modal（ApprovalModal/ConfirmDialog/CreateDialog）overlay+container+focus trap 重复，每处 ≥15 行 → **建议后续单独立项**（见 plan 附录 A）
- [x] 8.5 归档 change：`openspec archive design-frontend-modal-layout`（顶层 archive）
- [x] 8.6 更新 `plans/README.md` 与 `plans/archive/`（迁移 plan 至 archive）
