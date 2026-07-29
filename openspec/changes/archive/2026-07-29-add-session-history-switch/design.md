# Design: add-session-history-switch

> 完整推演（含 9 个容器存在性场景矩阵 A–I）见 `plans/Session_History_Switch_Plan_2026-07-29.md`（rev4，已确认）。本文为其收敛后的技术决策。

## Context

- session-service 会话状态机：`CREATING → LIVE ⇄ IDLE → COLD →(--resume)→ LIVE`，终态 `CLOSED/EXPIRED`；COLD 复活链路（WS 重连 → Redis 单写者锁 → stage-in → `oh --resume <oh_session_id>`）已存在且验证可用。
- 容器池四阶段准入（`ContainerPool.acquire`）：①租户配额（默认 `tenant_max_concurrent=1`）②节点容量 ③驱逐最久 idle（`_EVICT_ATTEMPTS=3`）④有界 FIFO 队列。critical section 无 await，靠事件循环保证原子。
- **核心死锁（场景 F）**：默认配额 1 时，旧会话 IDLE 仍占租户唯一槽（`idle_grace_seconds=300` 后才被动驱逐），连目标会话 WS 立即 `TenantQuotaExceeded` → 切换在默认配置下不可用。
- 数据层无缺口：`Conversation`（`oh_session_id`、`ix_conversations_tenant_created` 索引）与 `ConversationTurn`（prompt/assistant_text 持久化、`uq_turns_conv_idx` 唯一约束）已满足列表与历史回显。
- 已知实现事实：`_evict()` 内 `await _teardown_process()` 期间 `live.state` 仍停留在 LIVE/IDLE（COLD 转移在 teardown 完成后），光看 state 无法识别"驱逐进行中"。

## Goals / Non-Goals

**Goals:**
- 租户可列出历史会话、读取历史轮次（closed/expired 只读可查）。
- 切换到 COLD 历史会话在默认配额下可用：同租户 IDLE 让位，旧会话降级 COLD（快照保留、可再切回）。
- 并发切换安全：不重复驱逐、无状态竞争、slot 不泄漏。
- 前端可编程的失败语义：机器可解析 close reason + 结构化错误帧 + `resumable`/`read_only` 业务字段。

**Non-Goals:**
- 不改 OpenHarness 本体（继续零修改桥接）。
- 不恢复 closed/expired 会话；不做跨租户任何可见性。
- 无 DB 迁移；不新增 activate 类 REST 接口；本 change 不含前端实现。

## Decisions

### D1. 切换走 WS 单一准入路径，不新增 `POST /{sid}/activate`

连接目标会话 WS 即触发 rehydrate。备选是显式 activate 接口，但会产生两条准入路径（activate 与 WS 重连都要过池准入），配额/驱逐/单写者锁逻辑重复且可能互相竞争。前端流程：列表 → turns 回显 → 连目标 WS → 收 `session_ready`。

### D2. 同租户 IDLE 让位（quota 触发的定向驱逐）

`pool.acquire` 抛 `TenantQuotaExceeded` 前，先调新 hook `evict_tenant_idle(tenant_id)`（supervisor 注入 `_evict_tenant_idle`），成功则重试 claim（复用 `_EVICT_ATTEMPTS` 上限）。候选五条件：同租户、`is_live()`、无 WS 连接、非 busy、**非 evicting**。备选是要求前端先 DELETE 旧会话——被否：DELETE 是终态不可逆，让位降级 COLD 保留快照仍可切回。

### D3. `evicting` 防重入标志 + `_evict() -> bool`

`LiveSession.evicting`：`_evict()` 入口（首个 await 前）置 True、重入直接 `return False`；**清理必须在 `try/finally`**——teardown/stage-out 异常不能让会话永久卡在 evicting（否则永远被候选过滤跳过）。`_evict()` 返回 bool（True=槽已释放），`_evict_longest_idle`/`_evict_tenant_idle` 透传该值（现状无条件 `return True`），避免重入跳过时调用方误认成功去 retry claim。现有全局 hook `_evict_longest_idle` 同款隐患一并修。备选 asyncio.Lock per-session——比布尔标志重，且重入期望语义是"跳过"而非"排队等"。

### D4. 租户级 eviction lock 串行化并发切换

`_tenant_evict_locks: dict[str, asyncio.Lock]`（仿 `_registration_locks`，setdefault 惰性创建）。两请求同时切换时，锁内先重新扫描候选（拿锁期间对手可能已完成驱逐），避免对同一 IDLE 会话双重驱逐。三层保护叠加：per-sid 注册锁（防同会话并发 rehydrate）、Redis 单写者锁（防跨节点双活）、租户 eviction lock（防重复驱逐）。

### D5. 驱逐失败语义：三条不变量

1. `evicting` 必恢复（try/finally）。
2. slot 不泄漏：teardown 失败升级 `kill_group` 后继续；`state → COLD` 与 `pool.release` 在同一受保护段完成，进程已杀则无论 stage-out 成败槽位必释放（release 幂等）。stage-out 维持 best-effort。
3. 调用方拿到可预期错误：`_evict_tenant_idle` 捕获 `_evict()` 异常 → log + return False → acquire 按既有路径抛 `TenantQuotaExceeded` → WS 4430，不泄内部异常。

### D6. WS 关闭码细化 + 机器可解析 reason

| close code | reason 常量 | 触发 |
|---|---|---|
| 4430 | `TENANT_QUOTA_EXCEEDED` | 让位后仍配额超限（如候选全 busy） |
| 4503 | `CAPACITY_FULL` | 节点容量满/队列满/队列超时 |
| 4500 | `SESSION_UNAVAILABLE` | rehydrate 失败等其他准入错误 |

4429 已被握手限流占用，故租户配额用 4430。close 前先发结构化错误帧 `{"type":"error","code":"...","message":"..."}`（浏览器 WS API 拿 reason 不便）。捕获顺序：先子类 `TenantQuotaExceeded` 后基类 `PoolAdmissionError`。reason 只放常量（123 字节上限安全），人类可读信息放错误帧 message。

### D7. 业务字段与内部枚举解耦

前端判断只依赖 `resumable`/`read_only`，不绑 `status` 枚举。映射集中后端一处：`read_only = status in (closed, expired)`；`resumable = not read_only` 且（COLD/FAILED 时）快照存在性检查通过。内部状态机后续加态不破坏前端契约。

### D8. `resumable` 快照存在性检查（防"标记可恢复但 resume 失败"）

新增 `tenant_store.has_session_snapshot(tenant_id, oh_session_id)`：先查本地 staging（fs stat，廉价），本地缺失回退 MinIO bucket 前缀查（仅当页 COLD 会话，数量有限；staging 未启用时跳过）。stage-out 失败进 COLD 可接受（本地快照仍在，同节点可恢复）。顺带修 edge case：0-turn COLD 会话无快照，rehydrate 回退 fresh spawn（`resume=False`，无上下文可丢），此类 `resumable=true`。

### D9. 列表/turns 接口形态

`GET /v1/sessions`：`limit(≤100)/offset` + status 过滤 + `title`（首轮 prompt 截 80 字符，页内一次批量查询防 N+1）。`GET /v1/sessions/{sid}/turns`：`after_index`（默认 -1）/`limit`（默认 50，上限 200），`has_artifact` 批量查询。列表路由注册在 `/{sid}` 之前（`sid: uuid.UUID` 类型约束天然不冲突，仍显式排序）。

### D10. Bug fix：`create_session_from_existing` 传 `resume=True`

现状 `resume=False` 导致"从已有会话新建"丢上下文，与该接口语义相悖，顺带修复。

## Risks / Trade-offs

- [让位驱逐误伤后台任务] → 候选条件含 `not busy`，正在跑 turn 的会话不被驱逐。
- [配额 >1 部署让位退化] → 行为不变：仍先尝试驱逐候选，无候选则按现状抛 4430。
- [WS 关闭码变更兼容] → 旧客户端把未知码视为异常断开，不会误判为业务成功；文档记录常量表。
- [bucket 前缀查拖慢列表] → 仅本地缺失时回退，且限当页 COLD 会话；staging 未启用直接跳过。
- [重入 False 与失败 False 不可区分] → 对 acquire 调用方语义一致（本轮无槽释放，走既有失败路径），无需区分。

## Migration Plan

无 DB 迁移。纯代码变更，源码 volume 挂载进容器即生效；回滚即回退代码。测试按项目规则在已有镜像容器内跑（`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`）。

## Open Questions

无——rev2（5 条约束）/rev3（try/finally + 失败测试）/rev4（返回值 + resumable 语义）均已与需求方确认。
