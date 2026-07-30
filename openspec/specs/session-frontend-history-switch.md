# Session Frontend History & Switch Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-frontend-history-switch` (2026-07-30)
**上游契约：** `session-service` 基线规格 `session-history-switch`、`session-pool-scheduling`（本规格是其前端消费方）

前端消费后端历史/切换契约：会话列表服务端权威化、语义谓词解耦、轮次历史回显与 WS 补发串行去重、WS 准入失败差异化、创建会话容器池错误映射、关闭会话保留只读。

---

## Requirements

### Requirement: 会话列表 MUST 以服务端为权威源并采用合并数据模型

前端 MUST 通过 `GET /v1/sessions`（limit/offset 分页）获取会话列表，替换并废弃 localStorage 会话 ID 缓存（`sf.sessionIds` 启动时清除）。会话实体 MUST 采用 summary ∪ detail 合并模型：store 更新为 patch 语义（新数据字段覆盖、未返回字段保留），summary 刷新 MUST NOT 冲掉 detail 独有字段（如 `permission_policy`）。选中会话时若 `permission_policy` 缺失 MUST 补一次 `GET /v1/sessions/{sid}` 并 merge，失败不阻塞切换（审批帧过滤按 `interactive` 保守处理）。列表刷新 MUST 为事件驱动（认证成功、创建成功、关闭成功、`session_ready`、window focus ≥10s 节流），MUST NOT 默认后台轮询。

#### Scenario: 服务端列表替换本地缓存
- **WHEN** 用户在新浏览器（无 localStorage）认证成功
- **THEN** 侧栏展示 `GET /v1/sessions` 返回的分页会话列表（含 `title`/`resumable`/`read_only`），且 `sf.sessionIds` 不再被读写

#### Scenario: summary 刷新不丢 detail 字段
- **WHEN** 某会话已通过 detail GET 获得 `permission_policy`，随后列表刷新返回不含该字段的 summary
- **THEN** store 中该会话的 `permission_policy` 保持不变

#### Scenario: 旧后端降级
- **WHEN** `GET /v1/sessions` 返回 404/405（后端未部署列表接口）
- **THEN** 列表降级为空 + 「后端版本过旧」提示，不回退 localStorage 方案

### Requirement: 会话状态判断 MUST 通过语义谓词与内部枚举解耦

前端 MUST 提供三个语义谓词且各用途一一对应、互不复用：`canConnectSession`（`resumable === true`，字段缺失回退 `!isSessionTerminal(status)`）为 WS 建连门控**唯一**入口；`isReadonlySession`（`read_only === true`）驱动输入禁用/只读徽标/生命周期文案；`canResumeSession`（`resumable === true && !isReadonlySession`）驱动卡片可点击性与唤醒流程门槛。`isSessionTerminal` MUST 保持原实现与原职责，MUST NOT 新增调用点。业务逻辑 MUST NOT 在谓词之外散判 `resumable`/`read_only`/`status`。语义边界：现行契约下 `read_only=true` 必然不可恢复；若未来出现 `read_only=true && resumable=true` 并存态，MUST 重新定义 `canResumeSession` 而非在调用点打补丁（谓词处留注释标注此边界）。

#### Scenario: 建连门控唯一入口
- **WHEN** 切换编排需要判断目标会话能否建立 WS
- **THEN** 判定仅经 `canConnectSession(session)`，`resumable=false` 的会话（含快照丢失的 cold）不发起连接

#### Scenario: 快照丢失的 cold 会话不误入唤醒
- **WHEN** 会话 `status=cold` 且 `resumable=false`、`read_only=false`
- **THEN** 卡片置灰并提示不可恢复，点击仅回显历史，不进入唤醒流程

#### Scenario: 后端状态机扩展不破坏前端
- **WHEN** 后端未来新增内部状态且业务字段语义不变
- **THEN** 前端仅需调整谓词内部映射，谓词调用点零改动

### Requirement: 切换会话 MUST 回显轮次历史且与 WS 补发严格串行去重

选中会话且本地消息为空、`turn_count > 0`、未 hydrate 过时，前端 MUST 通过 `GET /v1/sessions/{sid}/turns?after_index=-1&limit=200` 拉取全量历史并整体替换该会话消息（interrupted → system warning，`error_message` → system error，`has_artifact` 保留）。切换时序 MUST 严格串行三步：① hydrate 完成（或判定无需）→ ② 写入 `last_turn_index` → ③ 才允许 WS 建连；MUST NOT 做任何并行优化（hydrate 与建连并发、先建连再补写均禁止）。`completeTurn` 同 turnIndex 幂等仅作兜底。closed/expired 只读会话 MUST 走同一 hydration 后不建连。

#### Scenario: 冷会话切换回显完整历史
- **WHEN** 用户点击一个 `turn_count=3` 的 cold 可恢复会话
- **THEN** 消息区先回显 3 轮完整历史（含产物标记），随后 WS 携带正确 `last_turn_index` 建连，服务端不补发已回显轮次，消息无重复

#### Scenario: 三步顺序不可放宽
- **WHEN** hydration 请求尚未完成
- **THEN** 目标会话的 WS 连接不会发起（`last_turn_index` 写入先于建连有显式顺序断言覆盖）

#### Scenario: 只读会话回看
- **WHEN** 用户点击 closed 会话
- **THEN** 历史完整回显、输入栏禁用、不发起任何 WS 连接

### Requirement: WS 准入失败 MUST 按后端契约差异化处理且错误归因契约优先

错误归因 MUST 只依据机器可解析契约（WS close code、error 帧 `code` 常量、REST 状态码 + `detail.code` + `Retry-After`）；`status` 仅作展示辅助，MUST NOT 用于推断错误原因或决定重连/重试策略。关闭码策略：`4430 TENANT_QUOTA_EXCEEDED` MUST NOT 自动重连（状态置 `quota_exceeded`，banner + 手动重试）；`4503 CAPACITY_FULL` 有界自动重试（15s 间隔、最多 4 次后 failed）；`4500 SESSION_UNAVAILABLE` 有界重试 2 次后 failed；default 分支网络断线退避行为保持不变。同一次准入失败的 error 帧与 close 码 MUST 去重只出一条提示（以 error 帧为准）。cold/failed 唤醒以 `canResumeSession` 为门槛，`status` 仅选择等待文案；唤醒成败由 close/error code 判定。

#### Scenario: 配额满不自动重连
- **WHEN** 连接 WS 收到 error 帧 `code=TENANT_QUOTA_EXCEEDED` 后 close 4430
- **THEN** 出现一条（且仅一条）配额提示 banner 与手动重试按钮，且不发起自动重连

#### Scenario: 容量满有界重试
- **WHEN** WS 以 4503 关闭
- **THEN** 前端按 15s 间隔自动重试，最多 4 次后转 failed 并提示稍后再试

#### Scenario: 唤醒等待态
- **WHEN** 用户切换到 `canResumeSession=true` 的 cold 会话且 WS 处于连接中
- **THEN** 显示「正在唤醒会话」等待态，收到 `session_ready` 后清除并可正常输入；超 30s 未就绪追加排队提示

#### Scenario: 让位可视化
- **WHEN** 切换目标会话收到 `session_ready`（同租户旧 IDLE 会话已让位）
- **THEN** 会话列表刷新，旧会话在侧栏更新为 cold 且仍可切回

### Requirement: 创建会话 MUST 映射容器池准入错误为可操作反馈

创建会话对话框 MUST 区分四类失败并给出可操作反馈：429 速率限制（稍后再试）、429 并发配额（提示等待/关闭当前会话）、403 `daily_quota_exceeded`（今日配额用完）、503 + `Retry-After: N`（容量满 + N 秒倒计时重试按钮，倒计时结束自动可点）。错误提取 MUST 收敛在 API 客户端层，对话框只消费语义化结果。

#### Scenario: 503 带 Retry-After 倒计时
- **WHEN** 创建会话返回 503 且 `Retry-After: 30`
- **THEN** 对话框显示容量已满提示与 30 秒倒计时的重试按钮

#### Scenario: 每日配额用完
- **WHEN** 创建会话返回 403 且 `detail.code=daily_quota_exceeded`
- **THEN** 对话框提示今日会话创建次数已用完（UTC 日重置），不提供立即重试

### Requirement: 关闭会话 MUST 保留为只读而非移除

关闭会话成功后前端 MUST 满足四不变量：① 会话保留在列表（patch 为 closed 只读态，不 removeSession）；② 历史消息不清理；③ 不再发起 WS 连接（`canConnectSession=false`）；④ 产物与 workspace 文件仍可访问。`removeSession`（连带清理对话/WS 状态）仅保留给会话已不存在（4404）场景。

#### Scenario: 关闭后四不变量
- **WHEN** 用户对 live 会话确认关闭且后端返回成功
- **THEN** 会话仍留在侧栏并带只读徽标、历史消息完整、无 WS 重连请求、产物下载与文件面板照常可用
