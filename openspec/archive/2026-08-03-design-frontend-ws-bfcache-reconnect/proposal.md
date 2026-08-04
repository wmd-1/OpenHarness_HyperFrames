# 设计前端：WS 页面唤醒（BFCache）重连（design-frontend-ws-bfcache-reconnect）

> 状态：**已归档（验收通过）** · 日期：2026-08-03 · 归档：2026-08-04
> 本 change 与后端 `session-snapshot-storage-contract` / `session-backend-failure-isolation` **相互独立**，可单独实施。

## Why

已确认事实（前端源码，`design-agent-frontend/src/ws/`）：

1. `WebSocketClient.ts` 已具备心跳（`WebSocketClient.ts:234-243`，30s `ping`，连续 3 次无 `pong` 判死）与差异化关闭码重连策略（`WebSocketClient.ts:4-6`：指数退避 1s→30s 最多 10 次；4429 每 60s 重试 2 次；4503 固定 15s；4401/4403/4404 不重连）。
2. **但整个 `src/ws/` 没有任何 `pageshow` / `visibilitychange` / `online` 监听器**（全目录 grep 为空）。

由此产生的问题：页面进入 BFCache（前进/后退、切走标签页后系统挂起、移动端切后台）时，浏览器冻结定时器且**不一定投递 `close` 事件**。恢复（`pageshow` 且 `event.persisted === true`）后：

- `readyState` 可能仍为 `OPEN`，实则已是死连接；
- 心跳定时器从冻结点恢复，需要最多 3 个周期（约 90 秒）才判死并触发重连；
- 这段窗口内用户提交的输入会静默丢失或长时间无响应，表现为“会话卡死”。

这与本次后端故障是**两个独立缺陷**：后端问题会让连接明确失败，而本问题是连接“看起来还活着”。

## What Changes

- 页面从 BFCache 恢复（`pageshow` 且 `persisted`）或从隐藏切回可见（`visibilitychange` → `visible`）时，**立即执行一次探活**（发送 `ping` 并设置短超时，如 3–5s），而非等待常规心跳周期。
- 探活失败或 `readyState !== OPEN` ⇒ 立即走**手动重连语义**（重置退避计数，等价 `retry()`），并把 UI 状态置为 `reconnecting`。
- 唤醒重连 MUST 复用既有关闭码策略：属于“不自动重连”的类别（4401/4403/4404，以及后端以 `1011` + `error.code=RECOVERY_FAILED` / `BACKEND_START_FAILED` 表达的恢复失败/启动失败类）**不得**因唤醒而被绕过。
- 唤醒重连期间 UI 给出明确的“连接恢复中”反馈；重连成功后**不得**重复渲染既有 turn，也不得清空会话列表。
- 若重连被服务端以 `error.code=RECOVERY_FAILED`（伴随 `1011` 关闭，来自 `session-backend-failure-isolation`）拒绝，展示明确文案并提供“新建会话”出口（该出口的产品形态见 `2026-08-03-session-lifecycle-convergence`），**不得**静默丢弃或伪装成正常空会话。
- 补充 `online`/`offline` 事件：离线时暂停退避重连，恢复联网时立刻探活。

## Capabilities

### New Capabilities
- `design-frontend-ws-bfcache-reconnect`：页面生命周期驱动的 WS 探活与重连契约。

### Modified Capabilities（落地时需同步）
- `design-agent-video`（WS 重连 close code 策略）：追加唤醒探活触发条件，不改既有码位策略。

## Impact

- **代码**：`design-agent-frontend/src/ws/WebSocketClient.ts`（探活 API、生命周期监听注册/注销）、`src/ws/useWebSocket.ts`（状态与 UI 反馈）；可能新增 `src/ws/lifecycle.ts`。
- **风险**：监听器必须在组件卸载/客户端销毁时移除，避免多会话切换后重复注册导致重连风暴。
- **测试**：单测（vitest，既有 `openharness-design-frontend:test` 镜像）+ Playwright 真实栈用例（既有 `openharness-design-frontend:e2e` 镜像 + `docker-compose.stub.yml` 栈），禁止宿主机直跑。

## Non-goals

- 不改后端恢复语义与错误码定义（分别属另外两个 change，本 change 只消费）。
- 不引入 Service Worker 或离线消息队列。
- 不改心跳周期与既有退避参数。
