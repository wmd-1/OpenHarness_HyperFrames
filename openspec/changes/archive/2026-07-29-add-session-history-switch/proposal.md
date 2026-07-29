# Proposal: add-session-history-switch

## Why

session-service 目前没有任何面向用户的"历史会话"入口：无法列出租户的历史会话、无法读取历史轮次，而内部虽已具备 COLD → `oh --resume` 复活链路，但在默认 `tenant_max_concurrent=1` 的容器池下，切换目标会话的 WS 连接会被旧会话（IDLE 占槽）直接以 `TenantQuotaExceeded` 拒绝——切换功能在默认配置下事实上不可用（死锁场景）。前端即将实现会话切换 UI，需要后端先补齐列表/历史接口与池准入的让位语义。

## What Changes

- 新增 `GET /v1/sessions`（租户会话列表，分页 + status 过滤 + title + `resumable`/`read_only` 业务字段）与 `GET /v1/sessions/{sid}/turns`（历史轮次，游标分页，closed 会话仍可读）两个 REST 接口。
- 切换**不新增** activate 类接口：连接目标会话 WS 即触发既有 rehydrate（单一准入路径）。
- 池准入新增**同租户 IDLE 让位**：`TenantQuotaExceeded` 时驱逐本租户最久 idle 且无 WS、非 busy、非 evicting 的会话到 COLD（快照保留、仍可恢复），再重试 claim；由租户级 eviction lock 串行化并发切换。
- 驱逐路径加固：`LiveSession.evicting` 防重入标志（try/finally 清理）、`_evict() -> bool` 显式返回值、teardown/stage-out 失败时 slot 不泄漏。
- WS 准入失败 close code 细化：4430 `TENANT_QUOTA_EXCEEDED`、4503 `CAPACITY_FULL`、4500 `SESSION_UNAVAILABLE`，reason 为机器可解析常量，close 前发结构化错误帧。
- `resumable` 判定增强：COLD/FAILED 会话要求快照存在性检查（`has_session_snapshot`，本地 staging 优先、回退 bucket），避免列表标记可恢复但实际 resume 失败；0-turn 无快照 COLD 会话 rehydrate 回退 fresh spawn。
- Bug fix：`create_session_from_existing` 改为 `resume=True`（现状丢失上下文）。

不改 OpenHarness 本体；无 DB 迁移；不恢复 closed/expired 会话（只读）。

## Capabilities

### New Capabilities

- `session-history-switch`: 历史会话的列出、历史轮次读取、经 WS 单一准入路径的切换恢复语义，及面向前端的 `resumable`/`read_only` 业务字段契约与机器可解析 WS 关闭原因。

### Modified Capabilities

- `interactive-session`: "Idle sessions MUST be evicted and cold sessions MUST rehydrate via native resume" 要求扩展——驱逐操作防重入（evicting 标志 + try/finally）、显式返回结果、失败时 slot 不泄漏；rehydrate 对无快照 0-turn 会话回退 fresh spawn；`create_session_from_existing` 必须以 resume 语义启动。
- `session-pool-scheduling`: 准入新增同租户 IDLE 让位阶段（tenant quota 超限 → 租户级 eviction lock 下驱逐候选 → 重试 claim），驱逐重试受 `_EVICT_ATTEMPTS` 上限约束。
- `session-tenant-isolation`: 新增快照存在性查询要求（本地 staging fs 检查优先、回退 bucket 前缀查询），作为 `resumable` 判定依据。

## Impact

- **代码**：仅 `session-service/`——`app/schemas.py`、`app/routers/sessions.py`、`app/routers/ws.py`、`app/session/pool.py`、`app/session/supervisor.py`、`app/session/tenant_store.py`、`API_DOCUMENTATION.md`。
- **API**：两个新 GET 接口（向后兼容）；WS 关闭码从统一 4500 细化为 4430/4503/4500（旧客户端把未知码当异常断开处理，兼容风险低，记录在案）。
- **数据**：无迁移——`Conversation`/`ConversationTurn` 现有列与索引已满足。
- **前端（后续 change）**：session-frontend 将依赖列表/turns 接口与 `resumable`/`read_only` 字段、4430/4503 关闭码常量。
