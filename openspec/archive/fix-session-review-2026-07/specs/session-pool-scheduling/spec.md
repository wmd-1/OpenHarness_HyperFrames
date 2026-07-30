## ADDED Requirements

### Requirement: 进程内单例调度 MUST 由单 worker 承载
由于 `SessionSupervisor`、`ContainerPool`、`SessionRegistry` 为进程内单例（内存态 live 会话、准入队列、审批 future），系统 SHALL 在启动期强制 `api_workers == 1`，配置为其它值时 SHALL fail-fast 并提示应通过多节点亲和（`OH_NODE_ID` + Redis 路由表）水平扩展，而非多 worker。

#### Scenario: 单 worker 正常启动
- **WHEN** `api_workers == 1`（默认）
- **THEN** 应用正常启动

#### Scenario: 多 worker 配置被拒
- **WHEN** 配置 `api_workers > 1`（如 `OH_API_WORKERS=2`）
- **THEN** 应用启动期抛出错误并终止，错误信息指向多节点水平扩展路径
