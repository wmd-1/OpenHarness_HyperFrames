# Session Approval Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-service-frontend` (2026-07-27)

工具调用审批流：审批弹窗展示与响应提交、超时处理、full_auto 模式跳过、可访问性。

---

## Requirements

### Requirement: 审批弹窗展示
系统 SHALL 在 `interactive` 权限策略下，当收到 `approval_request` 帧时弹出模态框，展示审批请求详情。

#### Scenario: 权限确认弹窗
- **WHEN** 服务端发送 `approval_request` 帧，modal 类型为权限确认
- **THEN** 系统弹出模态框，显示请求详情和三个选项按钮：允许一次、始终允许、拒绝

#### Scenario: edit_diff 审批弹窗
- **WHEN** 服务端发送 `approval_request` 帧，modal 类型为 edit_diff
- **THEN** 系统弹出模态框，显示代码差异对比（diff 视图）和审批选项

#### Scenario: question 回答弹窗
- **WHEN** 服务端发送 `approval_request` 帧，modal 类型为 question
- **THEN** 系统弹出模态框，显示问题文本和文本输入框

### Requirement: 审批响应提交
系统 SHALL 将用户的审批决策通过 WebSocket `approval` 帧提交给服务端。

#### Scenario: 允许一次
- **WHEN** 用户点击"允许一次"
- **THEN** 系统发送 `{"op": "approval", "request_id": "...", "allowed": true, "reply": "once"}` 帧，关闭弹窗

#### Scenario: 始终允许
- **WHEN** 用户点击"始终允许"
- **THEN** 系统发送 `{"op": "approval", "request_id": "...", "allowed": true, "reply": "always"}` 帧，关闭弹窗

#### Scenario: 拒绝
- **WHEN** 用户点击"拒绝"
- **THEN** 系统发送 `{"op": "approval", "request_id": "...", "allowed": false, "reply": "reject"}` 帧，关闭弹窗

#### Scenario: 带回答的审批
- **WHEN** 用户在 question 弹窗中输入回答并提交
- **THEN** 系统发送 `approval` 帧，包含 `answer` 字段

### Requirement: 审批超时处理
系统 SHALL 处理审批请求超时的情况（后端默认 300 秒超时视为拒绝）。

#### Scenario: 审批超时提示
- **WHEN** 审批弹窗显示超过 250 秒未响应
- **THEN** 弹窗显示倒计时警告"审批将在 50 秒后自动拒绝"

#### Scenario: 审批超时自动关闭
- **WHEN** 收到 `turn_error` 帧提示审批超时
- **THEN** 系统自动关闭审批弹窗，在对话中显示"审批已超时，视为拒绝"

### Requirement: full_auto 模式不展示审批
系统 SHALL 在 `full_auto` 权限策略下不挂载审批弹窗组件。

#### Scenario: full_auto 模式忽略审批请求
- **WHEN** 会话策略为 `full_auto` 且收到 `approval_request` 帧
- **THEN** 系统不弹出审批弹窗，忽略该帧（后端自动处理）

### Requirement: 审批弹窗可访问性
系统 SHALL 确保审批弹窗支持键盘操作和焦点管理。

#### Scenario: 键盘操作
- **WHEN** 审批弹窗打开
- **THEN** 用户可通过 Tab 键在选项按钮间切换，Enter 键确认选择，Escape 键关闭弹窗（视为拒绝）

#### Scenario: 焦点捕获
- **WHEN** 审批弹窗打开
- **THEN** 焦点自动移到弹窗内第一个可操作按钮，弹窗关闭后焦点返回触发按钮
