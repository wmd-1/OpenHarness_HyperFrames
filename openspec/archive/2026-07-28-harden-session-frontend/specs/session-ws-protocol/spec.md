# Spec Delta: session-ws-protocol (harden-session-frontend)

**Baseline:** `openspec/specs/session-ws-protocol.md`（由 `session-service-frontend` 建立，2026-07-27）
**Change ID:** `harden-session-frontend`
**Affects:** `session-frontend/src/ws/**`、`session-frontend/src/types/ws.ts`、`session-service/app/session/supervisor.py`、`session-service/app/schemas.py`

> 本 delta 为 `turn_complete` 帧新增 `has_artifact` 产物标记（A1）、为 `turn_error` 帧新增结构化 `code` 字段（A4），并把 4429 限流重连从「一次」修订为「有界重试」（A3）。来源：`session-frontend/CODE_REVIEW_REPORT.md`、`plans/Session_Frontend_Fix_Plan_2026-07-28.md`。其余要求（连接建立、客户端消息、断线重连、心跳保活）不变。

---

## MODIFIED Requirements

### Requirement: 服务端帧分发处理
系统 SHALL 对接收到的服务端帧按类型分发到对应的状态更新和 UI 渲染逻辑。`turn_complete` 帧 SHALL 携带可选的 `has_artifact: bool` 字段标记该轮次是否注册了产物（由后端在产物注册成功后置 `true`），前端 SHALL 将其透传到消息状态以驱动产物预览/下载组件渲染，字段缺失时按 `false` 处理。`turn_error` 帧 SHALL 携带可选的结构化 `code` 字段（首个取值 `approval_timeout`），前端 SHALL 优先按 `code` 分发处理逻辑；`code` 缺失时允许按错误文案匹配作为过渡期回退。

#### Scenario: 处理 delta 帧
- **WHEN** 收到 `{"type": "delta", "text": "...", "turn_index": N}` 帧
- **THEN** 将文本追加到当前轮次的助手消息缓冲区，更新流式渲染

#### Scenario: 处理 turn_complete 帧
- **WHEN** 收到 `{"type": "turn_complete", "turn_index": N, "has_artifact": true/false}` 帧
- **THEN** 标记当前轮次为完成状态，flush 剩余缓冲区，启用输入栏，并把 `has_artifact` 写入该轮次助手消息；`has_artifact` 为 `true` 时消息气泡渲染视频预览与下载入口

#### Scenario: turn_complete 帧缺失 has_artifact 字段（旧后端兼容）
- **WHEN** 收到不含 `has_artifact` 字段的 `turn_complete` 帧
- **THEN** 前端按 `has_artifact = false` 处理，正常完成轮次，不渲染产物组件，不报错

#### Scenario: 处理 approval_request 帧
- **WHEN** 收到 `{"type": "approval_request", ...}` 帧且会话策略为 interactive
- **THEN** 弹出审批模态框，等待用户响应

#### Scenario: 处理带结构化 code 的 turn_error 帧（审批超时）
- **WHEN** 收到 `{"type": "turn_error", "code": "approval_timeout", "message": "..."}` 帧
- **THEN** 前端按 `code` 判定为审批超时，自动关闭审批弹窗并在对话区域显示超时提示，不依赖 `message` 文案内容

#### Scenario: turn_error 帧缺失 code 时的文案回退
- **WHEN** 收到不含 `code` 字段的 `turn_error` 帧且 `message` 含审批相关文案
- **THEN** 前端按过渡期回退逻辑关闭审批弹窗（该回退在后端 `code` 字段全量上线后移除）

#### Scenario: 处理 busy 帧
- **WHEN** 收到 `{"type": "busy"}` 帧
- **THEN** 显示提示"当前有轮次正在执行，请等待完成"

#### Scenario: 处理 error 帧
- **WHEN** 收到 `{"type": "error", "message": "..."}` 帧
- **THEN** 在对话区域显示错误消息

### Requirement: 特殊关闭码处理
系统 SHALL 根据 WebSocket 关闭码执行差异化处理逻辑。4429 限流关闭码 SHALL 使用独立于指数退避主路径的有界重试计数：每次等待 60 秒后重试，最多重试 2 次；超限后转入 failed 状态交由用户手动重试，手动重试与连接成功建立时 SHALL 重置该计数。

#### Scenario: 会话已关闭 (4403)
- **WHEN** WebSocket 返回关闭码 4403
- **THEN** 标记会话状态为 closed，禁用输入栏，不尝试重连

#### Scenario: 会话不存在 (4404)
- **WHEN** WebSocket 返回关闭码 4404
- **THEN** 显示错误提示，从会话列表移除该会话，不尝试重连

#### Scenario: 限流 (4429) 有界重试
- **WHEN** WebSocket 返回关闭码 4429
- **THEN** 等待 60s 后尝试重连，UI 显示限流提示（含等待时间与剩余重试次数语义）

#### Scenario: 限流重试超限转 failed
- **WHEN** 因 4429 触发的重连已连续失败 2 次后再次收到 4429
- **THEN** 停止自动重连，连接状态置为 failed，UI 显示"连接失败，请手动重试"按钮；用户手动重试时限流计数清零

#### Scenario: 限流后成功建连清零计数
- **WHEN** 4429 后的某次重连成功建立连接
- **THEN** 限流重试计数清零，后续再次限流时重新拥有完整重试预算
