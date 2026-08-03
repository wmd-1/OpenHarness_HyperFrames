## ADDED Requirements

### Requirement: 快照可恢复性判据 MUST 以快照文件为准
系统判定一个会话“存在可恢复快照”时，MUST 以 tenant staging 或 MinIO 权威源中存在**非空的 `latest.json` 或 `session-*.json`** 为准。会话目录（`openharness/data/sessions/{oh_session_id}/`）自身的存在、或 bucket 中该前缀下仅有零字节占位对象，MUST NOT 判定为可恢复。

#### Scenario: 空会话目录不构成快照
- **WHEN** `openharness/data/sessions/{oh_session_id}/` 存在但目录内无 `latest.json` 且无 `session-*.json`
- **THEN** 快照判定返回 false
- **AND** 系统 MUST NOT 以 `--resume` 拉起后端

#### Scenario: 本地未命中时回落权威源
- **WHEN** 本地 staging 无快照文件
- **THEN** 系统 MUST 查询 MinIO `tenants/{tenant_id}/openharness/data/sessions/{oh_session_id}/` 下的快照对象后再判定
- **AND** 探测异常时判定 MUST 降级为 false（绝不承诺无法兑现的恢复）

#### Scenario: 判定发生在 stage-in 之后
- **WHEN** 一次恢复请求触发 tenant stage-in
- **THEN** 快照判定 MUST 在 stage-in 完成之后执行
- **AND** MUST NOT 因 staging 被回收而误判为不可恢复

### Requirement: “有上下文”判据 MUST 使用成功完成的 turn 计数
判断会话是否携带不可丢弃的上下文时，MUST 使用 `conversation_turns` 中 `status='completed'` 的行数，MUST NOT 使用 `conversations.turn_count`（该计数在 turn 失败时同样递增）。

#### Scenario: 失败 turn 不构成上下文
- **WHEN** 会话 `conversations.turn_count = 1` 且其唯一 turn 记录 `status='failed'`
- **THEN** `completed_turns` 判定为 0
- **AND** 该会话按“无上下文”处理

#### Scenario: 成功 turn 构成上下文
- **WHEN** 会话存在至少一条 `status='completed'` 的 turn
- **THEN** `completed_turns > 0`
- **AND** 该会话在快照缺失时 MUST NOT 被静默 fresh spawn

### Requirement: 恢复决策 MUST 收敛为唯一入口并遵循恢复语义矩阵
所有拉起后端的路径（COLD rehydrate、非 COLD 会话再武装、历史切换及后续新增路径）MUST 调用同一决策函数得到 `RESUME | FRESH | RECOVERY_FAILED`，MUST NOT 内联各自的 resume 判断或硬编码 `resume=True`。

#### Scenario: 无上下文且无快照 → 允许 fresh spawn
- **WHEN** `completed_turns = 0` 且快照判定为 false
- **THEN** 决策为 `FRESH`
- **AND** 后端以不带 `--resume` 的方式拉起，会话正常可用

#### Scenario: 有上下文但快照缺失 → 恢复失败，不降级
- **WHEN** `completed_turns > 0` 且快照判定为 false
- **THEN** 决策为 `RECOVERY_FAILED`
- **AND** 系统 MUST NOT 拉起后端，MUST NOT 以 fresh spawn 静默丢弃上下文
- **AND** 会话状态置为恢复失败终态，向调用方返回明确的、可区分于容量/鉴权/限流的错误

#### Scenario: 快照存在 → 恢复
- **WHEN** 快照判定为 true
- **THEN** 决策为 `RESUME`
- **AND** 后端以 `--resume {oh_session_id}` 拉起

#### Scenario: 再武装路径与 COLD 路径决策一致
- **WHEN** 同一会话分别经 COLD rehydrate 路径与非 COLD 再武装路径进入恢复
- **THEN** 两条路径对同一状态 MUST 得到相同决策

### Requirement: `resumable` 业务字段 MUST 与恢复决策同源
REST 返回给前端的 `resumable` MUST 由同一决策函数派生，覆盖包含陈旧 `live` 在内的所有非只读状态，MUST NOT 仅在 `COLD`/`FAILED` 状态下才校验快照。

#### Scenario: 陈旧 live 会话不得谎报可恢复
- **WHEN** DB 状态为 `live` 但网关内存中已无该会话（进程重启后残留状态），且决策为 `RECOVERY_FAILED`
- **THEN** `GET /v1/sessions/{sid}` 返回 `resumable=false`
- **AND** 前端据此不发起注定失败的 WS 连接

#### Scenario: 只读终态维持既有语义
- **WHEN** 会话为 `closed` 或 `expired`
- **THEN** `read_only=true` 且 `resumable=false`

### Requirement: 快照写入与同步契约 MUST 明确且可观测
快照 MUST 由 oh 后端在**成功完成一个 turn** 后写入 `OPENHARNESS_DATA_DIR/sessions/{oh_session_id}/`，并由网关在既有 stage-out 钩子同步至 MinIO；路径解析本身 MUST NOT 被当作“快照已存在”的信号。恢复决策 MUST 产生结构化日志。

#### Scenario: 零成功 turn 的会话不产生快照文件
- **WHEN** 会话建立后未完成任何 turn 即被驱逐或关闭
- **THEN** 权威源中不存在该会话的 `latest.json`
- **AND** 后续恢复判定为无快照

#### Scenario: 决策可观测
- **WHEN** 任一恢复决策产生
- **THEN** 日志 MUST 包含 `session_id`、`tenant_id`、`decision`、`completed_turns`、`has_snapshot`、快照命中来源（`local` / `remote` / `none`）
