## ADDED Requirements

### Requirement: WS submit 文本 MUST 有服务端长度上限
系统 SHALL 在 WebSocket `submit` 帧处理路径对文本长度做服务端校验，上限与 REST 兜底提交一致（32000 字符，单一常量来源）。超限时 SHALL 回一条结构化 `error` 帧且 SHALL NOT 断开连接或将超长文本写入子进程 stdin。

#### Scenario: 等于上限的文本被接受
- **WHEN** 客户端经 WS 发送长度恰为 32000 字符的 `submit`
- **THEN** 服务端正常受理并开始流式该轮次

#### Scenario: 超过上限的文本被拒
- **WHEN** 客户端经 WS 发送长度超过 32000 字符的 `submit`
- **THEN** 服务端回一条 `error` 帧（如 `code=text_too_long`），不启动该轮次，连接保持打开
