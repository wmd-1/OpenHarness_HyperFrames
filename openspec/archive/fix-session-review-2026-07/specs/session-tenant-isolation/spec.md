## ADDED Requirements

### Requirement: 多节点透明代理 MUST 透传客户端原始凭证
当网关节点将 WS 连接透明代理到会话所属节点时，系统 SHALL 转发客户端提供的原始 API Key，使目标节点经同一鉴权链（open → 单 key → 多 key 表）解析出与原始请求一致的租户；SHALL NOT 用服务端遗留单 key 替换客户端凭证（否则多 key 部署下租户身份丢失或被误判）。开放模式（无凭证）下 SHALL NOT 附加凭证头。

#### Scenario: 多 key 部署下代理保持租户身份
- **WHEN** 客户端以多 key 表中某租户的 key 连接非所属节点并被代理
- **THEN** 目标节点收到该客户端原始 key，解析出同一租户并授权

#### Scenario: 开放模式代理不附加凭证
- **WHEN** 部署为开放模式（未配置任何 key）且发生代理
- **THEN** 转发不附加 `X-API-Key` 头

### Requirement: Rehydrate 单写者所依赖的 epoch MUST 严格单调
系统 SHALL 保证会话 epoch 严格单调递增，不受节点本地时钟回拨（如 NTP 校正）影响，以维持多节点 rehydrate 的单写者判定正确。存量以时间戳生成的 epoch SHALL 被兼容（新方案首次取值不低于既有值，其后严格递增）。

#### Scenario: 连续生成的 epoch 严格递增
- **WHEN** 同一会话连续多次请求 epoch
- **THEN** 每次返回值严格大于上一次

#### Scenario: 时钟回拨不产生倒退 epoch
- **WHEN** 节点本地时钟发生回拨后再次请求 epoch
- **THEN** 返回值仍严格大于此前任一已发放的 epoch
