## ADDED Requirements

### Requirement: 后端拉起失败 MUST NOT 留下半初始化会话
当后端进程启动失败（退出码非 0、ready 握手超时、运行时工厂异常）时，系统 MUST 保证会话对象状态一致：要么完整回滚（从内存注册表移除、归还池槽位、`adapter` 与 `process` 置空），要么置为显式失败终态且所有取用后端句柄的入口一律拒绝服务。MUST NOT 存在“注册表里存在但 `adapter` 为空”的会话对象。

#### Scenario: 启动失败后注册表不残留可用会话
- **WHEN** 后端进程以非 0 退出码结束导致 spawn 失败
- **THEN** 该会话 MUST NOT 以 `adapter` 为空的形式保留在可服务集合中
- **AND** 池槽位 MUST 被释放

#### Scenario: 失败后再次提交不得触发崩溃
- **WHEN** 客户端在一次 spawn 失败后立即提交输入
- **THEN** 服务端返回结构化错误
- **AND** MUST NOT 产生未捕获异常或断言错误

### Requirement: 运行时校验 MUST NOT 依赖 assert
对外可达的入口（提交输入、中断、审批回执等）在使用后端句柄前 MUST 进行显式空值检查并抛出领域异常，MUST NOT 使用 `assert` 作为运行时校验手段。

#### Scenario: 优化模式下行为一致
- **WHEN** 服务以剥离断言的方式运行（如 `python -O`）
- **THEN** 后端句柄缺失时仍返回同一领域错误
- **AND** MUST NOT 退化为 `AttributeError` 或 `TypeError`

### Requirement: 后端故障 MUST 以分类错误码暴露给客户端
后端拉起失败与恢复失败 MUST 先经 WebSocket 发送结构化 `error` 帧（含可区分的 `code` 与安全的 `detail`），再以 **1011（server error）** 关闭连接；REST 侧 MUST 返回与之一致的分类状态码（恢复失败为 **409 Conflict**，后端启动失败为 503）。错误分类 MUST 至少区分：准入/容量失败、租户存储不可用、后端启动失败、恢复失败。失败分类 MUST 由 `error.code` 字段（如 `BACKEND_START_FAILED` / `RECOVERY_FAILED`）承载，MUST NOT 通过自定义 close code 编码。内部分类编号（C1–C4）仅用于服务端指标/日志，MUST NOT 出现在对客户端暴露的 `error.code` 中。

#### Scenario: 后端启动失败
- **WHEN** 会话恢复过程中后端进程启动失败
- **THEN** 客户端先收到 `type=error` 且 `code=BACKEND_START_FAILED` 的帧
- **AND** 连接以 **1011** 关闭（不得复用 4400–4503 既有语义码）
- **AND** 服务端日志包含后端 stderr 尾部（限长、脱敏）

#### Scenario: 恢复失败（有上下文且无快照）
- **WHEN** 恢复决策为 `RECOVERY_FAILED`
- **THEN** 服务端 MUST NOT 拉起后端
- **AND** 客户端收到 `code=RECOVERY_FAILED` 的 `error` 帧，并以 **1011** 关闭
- **AND** 该错误（凭 `error.code`）可与容量、鉴权、限流类错误明确区分

#### Scenario: 分类错误不得以未捕获异常形式暴露
- **WHEN** 上述任一失败发生在 WebSocket 处理路径中
- **THEN** 该异常 MUST 被路由层捕获并转换为 `error` 帧 + close code
- **AND** MUST NOT 出现 ASGI 未捕获异常 traceback

### Requirement: 基础设施级失败 MUST NOT 污染业务 turn 计数
租户存储不可用、后端启动失败、恢复失败等基础设施级失败 MUST NOT 写入 `conversation_turns` 行，MUST NOT 递增 `conversations.turn_count`。仅当用户输入已被后端接收并进入执行时才可占用 turn 序号。

#### Scenario: 恢复失败不产生 turn 记录
- **WHEN** 会话因恢复失败被拒绝服务
- **THEN** `conversation_turns` 不新增行
- **AND** `conversations.turn_count` 保持不变

#### Scenario: 失败留痕走独立通道
- **WHEN** 产品需要记录该次失败
- **THEN** 记录 MUST 通过日志/审计/指标通道完成，而非业务 turn 表

### Requirement: 失败会话 MUST 收敛为终态以避免重连风暴
会话进入后端启动失败或恢复失败终态后，REST 的 `resumable` MUST 为 false，且服务端对后续连接 MUST 幂等返回同一分类错误，MUST NOT 重复尝试拉起后端。

#### Scenario: 重复连接幂等
- **WHEN** 客户端对同一失败会话连续发起多次 WebSocket 连接
- **THEN** 每次均立即返回同一 `error` 帧并关闭
- **AND** 服务端 MUST NOT 重复 spawn 后端进程

#### Scenario: 失败可观测
- **WHEN** 任一分类失败发生
- **THEN** 指标按分类计数，且结构化日志包含 `session_id`、`tenant_id`、失败分类与原因摘要
