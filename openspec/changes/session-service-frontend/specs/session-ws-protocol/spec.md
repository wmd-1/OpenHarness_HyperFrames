## ADDED Requirements

### Requirement: WebSocket 连接建立
系统 SHALL 通过原生 WebSocket API 连接到 `/v1/sessions/{sid}/ws`，携带 `api_key` 查询参数和 `last_turn_index` 查询参数进行认证和断线补发。

#### Scenario: 成功建立连接
- **WHEN** 用户进入会话对话视图且 API Key 有效
- **THEN** 系统建立 WebSocket 连接，收到 `session_ready` 帧后标记连接状态为 ready

#### Scenario: 连接认证失败
- **WHEN** WebSocket 连接返回关闭码 4401
- **THEN** 系统标记连接状态为 auth_failed，弹出 API Key 重新输入对话框，不尝试重连

### Requirement: 客户端消息发送
系统 SHALL 支持发送四种客户端帧：`submit`（提交对话）、`interrupt`（中断轮次）、`approval`（响应审批）、`ping`（心跳）。

#### Scenario: 提交对话
- **WHEN** 用户发送消息
- **THEN** 系统发送 `{"op": "submit", "text": "<用户输入>"}` 帧

#### Scenario: 中断轮次
- **WHEN** 用户点击中断按钮或按 Ctrl+C
- **THEN** 系统发送 `{"op": "interrupt"}` 帧

#### Scenario: 响应审批
- **WHEN** 用户在审批弹窗中选择操作
- **THEN** 系统发送 `{"op": "approval", "request_id": "...", "allowed": true/false, "reply": "once/always/reject", "answer": "..."}` 帧

### Requirement: 服务端帧分发处理
系统 SHALL 对接收到的服务端帧按类型分发到对应的状态更新和 UI 渲染逻辑。

#### Scenario: 处理 delta 帧
- **WHEN** 收到 `{"type": "delta", "text": "...", "turn_index": N}` 帧
- **THEN** 将文本追加到当前轮次的助手消息缓冲区，更新流式渲染

#### Scenario: 处理 turn_complete 帧
- **WHEN** 收到 `{"type": "turn_complete", "turn_index": N}` 帧
- **THEN** 标记当前轮次为完成状态，flush 剩余缓冲区，启用输入栏

#### Scenario: 处理 approval_request 帧
- **WHEN** 收到 `{"type": "approval_request", ...}` 帧且会话策略为 interactive
- **THEN** 弹出审批模态框，等待用户响应

#### Scenario: 处理 busy 帧
- **WHEN** 收到 `{"type": "busy"}` 帧
- **THEN** 显示提示"当前有轮次正在执行，请等待完成"

#### Scenario: 处理 error 帧
- **WHEN** 收到 `{"type": "error", "message": "..."}` 帧
- **THEN** 在对话区域显示错误消息

### Requirement: 断线自动重连
系统 SHALL 在 WebSocket 连接断开时自动重连，采用指数退避策略（1s → 2s → 4s → ... → 30s 上限），最多 10 次尝试，重连时携带 `last_turn_index` 补发缺失轮次。

#### Scenario: 网络断开后重连
- **WHEN** WebSocket 连接因网络问题断开（关闭码 1006）
- **THEN** 系统在 1s 后尝试重连，失败则 2s 后重试，依次指数增长，UI 显示"连接已断开，正在重连..."

#### Scenario: 重连成功补发缺失轮次
- **WHEN** 重连成功且 `last_turn_index` 为 5
- **THEN** 服务端补发 turn_index > 5 的所有轮次，前端按序渲染

#### Scenario: 达到最大重连次数
- **WHEN** 连续重连 10 次均失败
- **THEN** 停止重连，UI 显示"连接失败，请手动重试"按钮

### Requirement: 特殊关闭码处理
系统 SHALL 根据 WebSocket 关闭码执行差异化处理逻辑。

#### Scenario: 会话已关闭 (4403)
- **WHEN** WebSocket 返回关闭码 4403
- **THEN** 标记会话状态为 closed，禁用输入栏，不尝试重连

#### Scenario: 会话不存在 (4404)
- **WHEN** WebSocket 返回关闭码 4404
- **THEN** 显示错误提示，从会话列表移除该会话，不尝试重连

#### Scenario: 限流 (4429)
- **WHEN** WebSocket 返回关闭码 4429
- **THEN** 等待 60s 后尝试一次重连，UI 显示限流提示

### Requirement: 心跳保活
系统 SHALL 每 30 秒发送 `ping` 帧维持连接活跃，期望收到 `pong` 帧应答。

#### Scenario: 心跳正常
- **WHEN** 每 30 秒定时器触发
- **THEN** 发送 `{"op": "ping"}` 帧，收到 `{"type": "pong"}` 应答

#### Scenario: 心跳超时
- **WHEN** 连续 3 次 ping 未收到 pong
- **THEN** 判定连接为死连接，主动关闭并触发重连
