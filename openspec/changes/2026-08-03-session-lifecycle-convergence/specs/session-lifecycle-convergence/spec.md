## ADDED Requirements

### Requirement: 陈旧 live 会话 MUST 在网关启动时收敛为 COLD
网关进程启动并完成注册表初始化后，MUST 对 `status='live'` 且在内存注册表中无存活实例的会话执行对账，将其状态收敛为 `COLD` 并记录原因 `gateway_restart`，使其后续统一走恢复决策入口。MUST NOT 因该对账误伤仍在运行（内存中存在实例）的会话。

#### Scenario: 重启后无实例的 live 收敛
- **WHEN** 网关重启，存在 `status='live'` 但内存注册表无对应实例的会话
- **THEN** 该会话状态变为 `COLD`，原因 `gateway_restart`
- **AND** 后续恢复请求经唯一决策入口 `resolve_resume_decision` 处理

#### Scenario: 运行中 live 不被误伤
- **WHEN** 网关启动，存在 `status='live'` 且内存注册表中确有存活实例的会话
- **THEN** 该会话状态保持不变
- **AND** 对账 MUST NOT 将其置为 `COLD`

### Requirement: MUST 提供历史只读新建会话出口
系统 MUST 提供从既有会话历史创建只读新会话的能力：新会话以源会话的 turns 投影为只读视图，`read_only=true`、`resumable=false`，且 MUST NOT 触发 oh `--resume`（因源会话可能无可恢复快照）。

#### Scenario: 从 S4 会话创建只读新会话
- **WHEN** 用户针对一个 `completed>0` 且无快照（S4）的会话请求「只读新建」
- **THEN** 创建 `read_only=true`、`resumable=false` 的新会话
- **AND** 新会话展示源会话历史且 MUST NOT 拉起可恢复后端

#### Scenario: 只读会话不可恢复
- **WHEN** 只读会话被请求恢复
- **THEN** 系统返回 `resumable=false`，不尝试 `--resume`
