## ADDED Requirements

### Requirement: 页面唤醒 MUST 立即触发 WebSocket 探活
WebSocket 客户端 MUST 监听页面生命周期事件（`pageshow` 且 `event.persisted` 为真、`visibilitychange` 切换为 `visible`、`online`），并在事件发生时立即执行一次探活，而非等待常规心跳周期。

#### Scenario: 从 BFCache 恢复
- **WHEN** 页面由前进/后退从 BFCache 恢复且 `event.persisted` 为真
- **THEN** 客户端立即执行探活
- **AND** MUST NOT 等待完整的心跳周期才判定连接状态

#### Scenario: 标签页切回可见
- **WHEN** 页面从隐藏切换为可见
- **THEN** 客户端执行探活（同一唤醒窗口内多个事件 MUST 去抖为一次）

#### Scenario: 网络恢复
- **WHEN** 浏览器触发 `online`
- **THEN** 客户端立即执行探活并允许重连

### Requirement: 探活失败 MUST 按手动重连语义立即重连
探活 MUST 在发送 `ping` 后设置短超时；超时未收到 `pong`，或 `readyState` 不为 `OPEN`，MUST 判定为死连接并立即重连，且重置指数退避计数（等价于用户手动重试），同时把状态置为 `reconnecting`。

#### Scenario: 假活连接被识别
- **WHEN** 唤醒后 `readyState` 仍为 `OPEN` 但探活超时未收到 `pong`
- **THEN** 客户端主动关闭本地连接并立即重连
- **AND** 界面状态显示为“连接恢复中”

#### Scenario: 连接健康时不误重连
- **WHEN** 唤醒后探活在超时窗口内收到 `pong`
- **THEN** 维持现有连接
- **AND** MUST NOT 产生额外的重连或状态抖动

### Requirement: 唤醒重连 MUST 遵守既有关闭码策略
唤醒探活只作为触发器，MUST NOT 绕过既有的重连策略：属于“不自动重连”的类别（鉴权失败、无权限、会话不存在，以及服务端以 `1011` 关闭并携带 `error.code=RECOVERY_FAILED` / `BACKEND_START_FAILED` 的恢复失败/后端启动失败类）在唤醒后仍 MUST NOT 自动重连；限流与容量类关闭码 MUST 沿用各自的等待与次数上限，唤醒 MUST NOT 重置其专用计数。前端 MUST 依据 `error.code` 区分失败类别，MUST NOT 依赖自定义 close code 识别恢复失败。

#### Scenario: 终态关闭码不因唤醒而重连
- **WHEN** 上一次连接以鉴权失败或会话不存在类关闭码结束，随后页面被唤醒
- **THEN** 客户端 MUST NOT 自动重连
- **AND** 维持既有的终态提示

#### Scenario: 限流计数不被唤醒重置
- **WHEN** 上一次连接以限流类关闭码结束且已消耗部分重试次数，随后页面被唤醒
- **THEN** 该关闭码的专用重试计数与等待间隔保持不变

### Requirement: 重连后 UI 状态 MUST 保持一致
重连成功后 MUST NOT 重复渲染已完成的 turn，MUST NOT 清空会话列表或本地密钥（仅鉴权失败场景沿用既有的清 key 回 Welcome 规则）。

#### Scenario: 不重复渲染历史
- **WHEN** 唤醒重连成功并重新订阅会话
- **THEN** 已渲染的 turn 不重复出现
- **AND** 正在进行的 turn 恢复流式或给出明确的中断提示

#### Scenario: 服务端拒绝恢复
- **WHEN** 重连被服务端以 `1011` 关闭且 `error.code=RECOVERY_FAILED` 拒绝
- **THEN** 界面展示明确原因文案并提供“新建会话”出口（产品形态见 `2026-08-03-session-lifecycle-convergence`）
- **AND** MUST NOT 静默清空当前会话内容或伪装为空白新会话

### Requirement: 生命周期监听器 MUST 随客户端生命周期注册与注销
监听器 MUST 在客户端连接时注册、销毁/关闭时移除；会话切换时旧客户端 MUST 被销毁，避免重复注册导致的重连风暴；在缺少 `window`/`document` 的环境中注册 MUST 安全降级。

#### Scenario: 会话切换不残留监听
- **WHEN** 用户从会话 A 切换到会话 B
- **THEN** 会话 A 的生命周期监听器被移除
- **AND** 一次唤醒事件只触发一次探活

#### Scenario: 无 DOM 环境安全降级
- **WHEN** 客户端在缺少 `window`/`document` 的环境中被构造
- **THEN** 不抛出异常，探活能力静默禁用
