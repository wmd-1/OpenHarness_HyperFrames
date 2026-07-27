# Session UI Shell Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-service-frontend` (2026-07-27)

应用外壳：响应式布局、会话列表侧栏、Chat/Terminal 模式切换、5 主题系统、健康状态、底部状态栏、全局错误横幅。

---

## Requirements

### Requirement: 响应式整体布局
系统 SHALL 提供三段式响应式布局：左侧栏（会话列表）、主区域（对话/终端视图）、顶栏（健康状态/设置）。

#### Scenario: 桌面布局 (≥1280px)
- **WHEN** 视口宽度 ≥ 1280px
- **THEN** 侧栏固定展开（280px 宽），主区域占据剩余空间

#### Scenario: 平板布局 (768-1279px)
- **WHEN** 视口宽度在 768px 到 1279px 之间
- **THEN** 侧栏可折叠为 64px 图标模式，通过点击展开

#### Scenario: 移动端布局 (<768px)
- **WHEN** 视口宽度 < 768px
- **THEN** 侧栏隐藏，通过汉堡菜单按钮唤出抽屉式侧栏

### Requirement: 会话列表侧栏
系统 SHALL 在侧栏中展示会话列表，每个会话以卡片形式显示状态、策略和最近活跃时间。

#### Scenario: 会话卡片展示
- **WHEN** 侧栏加载会话列表
- **THEN** 每个会话卡片显示：状态徽章（颜色编码）、权限策略图标、轮次数、相对时间

#### Scenario: 选中会话
- **WHEN** 用户点击会话卡片
- **THEN** 卡片高亮，主区域切换到该会话的对话视图

#### Scenario: 新建会话按钮
- **WHEN** 用户点击侧栏顶部的 "+ 新会话" 按钮
- **THEN** 弹出创建会话对话框

### Requirement: 模式切换
系统 SHALL 在顶栏提供 Chat Mode / Terminal Mode 切换按钮。

#### Scenario: 切换到 Terminal Mode
- **WHEN** 用户在 Chat Mode 下点击模式切换按钮
- **THEN** 主区域从 ChatView 切换到 TerminalView，对话状态和 WebSocket 连接保持

#### Scenario: 切换到 Chat Mode
- **WHEN** 用户在 Terminal Mode 下点击模式切换按钮
- **THEN** 主区域从 TerminalView 切换到 ChatView，对话历史完整保留

### Requirement: 主题系统
系统 SHALL 提供 5 个内置主题（default/dark/minimal/cyberpunk/solarized），通过 CSS 变量实现主题切换。

#### Scenario: 切换主题
- **WHEN** 用户在设置面板选择新主题
- **THEN** 全局 CSS 变量立即更新，所有组件（Chat/Terminal/侧栏）同步变色

#### Scenario: 主题偏好持久化
- **WHEN** 用户选择主题后刷新页面
- **THEN** 主题偏好从 localStorage 恢复，保持上次选择

### Requirement: 健康状态展示
系统 SHALL 在顶栏显示服务健康状态徽章，定期轮询 `/healthz` 和 `/readyz`。

#### Scenario: 服务正常
- **WHEN** `/healthz` 返回 200
- **THEN** 健康徽章显示绿色圆点

#### Scenario: 服务异常
- **WHEN** `/healthz` 连续 3 次请求失败
- **THEN** 健康徽章显示红色圆点，顶栏出现警告横幅

### Requirement: 底部状态栏
系统 SHALL 在应用底部显示状态栏，包含 WebSocket 连接状态、当前会话状态、轮次计数和权限策略。

#### Scenario: 连接状态实时显示
- **WHEN** WebSocket 连接状态变化
- **THEN** 状态栏连接指示器更新（绿色=已连接，黄色=重连中，红色=断开）

#### Scenario: 轮次计数更新
- **WHEN** 对话轮次完成
- **THEN** 状态栏轮次计数递增

### Requirement: 全局错误横幅
系统 SHALL 在顶栏下方显示可关闭的错误横幅，用于展示分级错误信息。

#### Scenario: 显示限流警告
- **WHEN** 收到 429 响应
- **THEN** 顶栏下方出现黄色横幅"请求过于频繁，请稍后再试"，可手动关闭

#### Scenario: 显示配额耗尽
- **WHEN** 收到 403 响应
- **THEN** 顶栏下方出现红色横幅"今日会话配额已用完"，不可关闭（需等待次日重置）
