## ADDED Requirements

### Requirement: 间距与行高设计令牌
`design-agent-frontend` 的 `src/styles/demo.css :root` SHALL 定义间距令牌族 `--space-xs`(4px)/`--space-sm`(8px)/`--space-md`(12px)/`--space-lg`(16px)/`--space-xl`(24px)/`--space-2xl`(32px) 与行高令牌 `--leading-body`(1.6)/`--leading-tight`(1.45)，供原生 CSS 类与内联场景引用。令牌 MUST 为纯增量，不改动现有 `--radius-*`/`--shadow-*`/`--transition-*`/`--font-stack` 令牌。

#### Scenario: 原生 CSS 类引用令牌
- **WHEN** `demo.css` 中 `.model-option` 等原生类定义间距
- **THEN** 其 `padding`/`line-height` 使用 `var(--space-*)`/`var(--leading-*)` 表达，而非硬编码像素值

#### Scenario: 令牌数值与 Tailwind 工具类对齐
- **WHEN** 校对令牌与对应 Tailwind 工具类数值
- **THEN** `--space-md`(12px) 与 `gap-3`(12px) 一致、`--leading-body`(1.6) 与 `leading-relaxed`(1.625) 量级一致

### Requirement: 令牌与 Tailwind 工具类使用策略一致性
同一间距维度 SHALL 采用单一写法：组件 JSX 内布局间距用 Tailwind 工具类（`p-6`/`mt-3`/`gap-3`/`leading-relaxed`），`demo.css` 原生 CSS 类用 `var(--space-*)` token；禁止在 JSX 用内联 `style` 表达颜色/间距（纯动态数值如 `width: min(960px,100%)` 除外），禁止在原生 CSS 类硬编码像素间距。

#### Scenario: 组件 JSX 用 Tailwind 工具类
- **WHEN** 浮层组件在 JSX 中设置容器内边距、按钮组间距、正文行高
- **THEN** 使用 `p-6`/`gap-3`/`leading-relaxed` 等 Tailwind 工具类，而非 `style={{padding:'var(--space-xl)'}}`

#### Scenario: 禁止同维度混用
- **WHEN** 同一组件的标题间距用 `mt-3`
- **THEN** 该组件的正文间距不得用 `style={{marginTop:'var(--space-md)'}}` 混用表达同类间距

### Requirement: 浮层容器内边距基线
内容型浮层（ApprovalModal、CreateDialog）容器内边距 MUST ≥ 24px（`p-6`）；窄确认框（ConfirmDialog）MUST ≥ 20px（`p-5`）；抽屉（SettingsPanel、WorkspaceFilesPanel）body 内边距 MUST ≥ 20px。

#### Scenario: 内容浮层容器内边距达标
- **WHEN** 渲染 ApprovalModal 或 CreateDialog
- **THEN** 其容器 `className` 含 `p-6`（24px）

#### Scenario: 确认对话框内边距达标
- **WHEN** 渲染 ConfirmDialog
- **THEN** 其容器 `className` 含 `p-5` 或 `p-6`（≥20px）

### Requirement: 浮层正文行高基线
浮层正文（消息、问题文本、reason 说明、错误提示）MUST 使用 `leading-relaxed`（行高 1.625）或等价令牌；紧凑型元数据文本（文件路径、统计行、时间戳）MUST 使用 `leading-snug`（1.375）或 `--leading-tight`。任何正文文本行高不得低于 1.5。

#### Scenario: 正文行高达标
- **WHEN** 渲染 ConfirmDialog 消息或 QuestionPrompt 问题文本
- **THEN** 对应元素 `className` 含 `leading-relaxed`

#### Scenario: 元数据行高紧凑但可读
- **WHEN** 渲染 DiffApproval 文件路径或 WorkspaceFilesPanel 文件元数据
- **THEN** 对应元素 `className` 含 `leading-snug`，行高不低于 1.375

### Requirement: 标题与正文间距基线
浮层标题与正文之间 MUST ≥ 12px（`mt-3`）；正文与按钮组之间 MUST ≥ 16px（`mt-5` 或 `mt-6`）；按钮组内按钮间距 MUST ≥ 12px（`gap-3`）。

#### Scenario: 标题正文间距达标
- **WHEN** 渲染 ConfirmDialog 或 CreateDialog
- **THEN** 标题元素与紧随其后的正文元素间距 ≥ 12px

#### Scenario: 按钮组间距达标
- **WHEN** 渲染任意浮层的操作按钮组
- **THEN** 按钮容器 `className` 含 `gap-3` 或更大值（≥12px）

### Requirement: 双行列表项行间距
当列表项或卡片含两行文本（标题行 + 描述/元数据行）时，两行之间 MUST 有 ≥ 2px 间距（`mt-0.5` 或 `mt-1`），不得 `block` 贴合无间距。

#### Scenario: 策略卡双行文本有间距
- **WHEN** 渲染 CreateDialog 权限策略卡片
- **THEN** 标签行与描述行之间存在 `mt-1` 或 `mt-0.5` 间距

#### Scenario: 文件列表双行文本有间距
- **WHEN** 渲染 WorkspaceFilesPanel 文件列表项
- **THEN** 文件路径行与元数据行之间存在 `mt-0.5` 或更大间距

### Requirement: SpacePage 视频预览 Modal 去内联硬编码
`modules/space/SpacePage.tsx` 的视频预览 Modal SHALL 移除内联 `style` 中的颜色与间距硬编码（如 `rgba(255,255,255,0.4)`、`padding:32`、按钮 `padding:'6px 16px'`），改用 Tailwind 类与设计令牌表达；仅允许保留纯动态数值（如 `width: min(960px,100%)`）为内联。关闭按钮 MUST 在所有主题下可见。

#### Scenario: 移除颜色内联硬编码
- **WHEN** 检查 SpacePage 预览 Modal 的遮罩与关闭按钮
- **THEN** 其 `className` 使用 `bg-black/60`、`border-white/40` 等 Tailwind 类，而非内联 `rgba(...)` 颜色

#### Scenario: 暗主题下关闭按钮可见
- **WHEN** 在 dark/cyberpunk/minimal/solarized 主题下打开视频预览 Modal
- **THEN** 关闭按钮边框与文字清晰可见，不因主题切换而消失

### Requirement: 非回归约束（不改 DOM/ARIA/交互）
本次整改 MUST NOT 改变任何浮层组件的 DOM 结构、ARIA 契约（`role`/`aria-modal`/`aria-label`/`aria-live`）、focus trap 行为、Escape 键语义、按钮文案与回调逻辑。既有单测断言（`getByRole`/`getByText`/`getByLabelText`/`getByTestId`）在整改后 MUST 保持全绿，无需修改断言。

#### Scenario: ARIA 契约不变
- **WHEN** 整改后渲染 ApprovalModal
- **THEN** 其 `role="dialog"`、`aria-modal="true"`、`aria-label="审批请求"` 契约与整改前一致

#### Scenario: 既有单测全绿
- **WHEN** 在既有 Docker 镜像内运行 `ApprovalModal.test.tsx` 与 `CreateDialog.test.tsx`
- **THEN** 所有断言通过且无需修改测试代码

### Requirement: 多主题与响应式不破版
整改后所有浮层 MUST 在 default/dark/minimal/cyberpunk/solarized 五主题下不破版（圆角、阴影、遮罩、文字对比度正常），且在 375px（iPhone SE）视窗宽度下不溢出视窗。

#### Scenario: 五主题不破版
- **WHEN** 依次切换五个主题并打开各浮层
- **THEN** 浮层圆角、阴影、遮罩、文字对比度均正常，无样式丢失

#### Scenario: 窄视窗不溢出
- **WHEN** 视窗宽度为 375px 并打开 max-w-md/max-w-lg 浮层
- **THEN** 浮层不溢出视窗（overlay `p-4` + `w-full` 约束生效）

### Requirement: 镜像内执行测试约束
所有单测 MUST 在既有 Docker 镜像（`openharness-design-frontend:e2e` 或其 FROM 链 `oh-e2e-test:latest`）内执行，宿主机禁止直跑测试、禁止从零重建基础镜像。

#### Scenario: 单测在镜像内执行
- **WHEN** 运行 P0/P1/P2 门禁的单测
- **THEN** `vitest` 在既有镜像内执行，宿主机不直接 `npx vitest`
