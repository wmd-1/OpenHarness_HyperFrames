# 切换历史会话（Session History Switch）实现计划

日期：2026-07-29
范围：`session-service/`（后端 API 层 + 容器池调度层），前端后续单独实施
前置事实：本计划基于当前代码调查结论 —— resume 内部链路（COLD → WS 重连 → `oh --resume`）已打通，缺的是"发现历史会话"和"读取历史消息"的接口，以及**租户配额下切换会话的准入死锁**处理。

### 已确认的决策（rev2）
1. **切换不新增 `POST /{sid}/activate`**，继续通过 WS 连接触发恢复：保持单一准入路径，避免 REST activate 和 WS resume 两套状态流转。前端流程：列表查询 → turns 回显 → 连接目标 WS → 后端负责 rehydrate。
2. **同租户 IDLE 让位策略**，而非要求前端显式 DELETE：用户切换历史会话不等价于放弃旧会话，旧会话降级到 COLD 并保留 snapshot，后续仍可恢复；DELETE 不作为切换流程的一部分。

---

## 1. 目标与非目标

### 目标
1. 用户可以列出自己（租户）名下的历史会话，看到摘要/状态/是否可恢复。
2. 用户可以读取任一历史会话的完整轮次记录（prompt / assistant_text / artifact 标记），包括已 closed/expired 的只读会话。
3. 用户选中某个未终结的历史会话后可以"切换过去"继续对话——复用现有 WS 连接触发的 rehydrate 链路，但必须解决**切换场景下的容器池准入问题**（见 §3）。
4. 所有失败路径给前端可区分的结构化错误（配额满 / 无空余容器 / 排队超时 / 会话已终结）。

### 非目标
- 不恢复 closed/expired 会话（workspace 与 OpenHarness 快照已销毁，只读）。
- 不改 OpenHarness 侧 resume 机制（`--resume` 按 oh_session_id 加载快照，已满足需求）。
- 不新增 DB 表/列（`conversations` + `conversation_turns` 已有全部所需数据，无迁移）。
- 前端实现（本计划只保证 API 契约对前端友好）。

---

## 2. 切换时后端（进程/容器）存在性矩阵

前端"切换到历史会话"= 断开当前会话 WS → 连接目标会话 `GET /v1/sessions/{sid}/ws`。连接时目标会话的后端可能处于以下状态：

| # | 目标会话状态 | 后端进程/容器 | 现有行为 | 本计划动作 |
|---|---|---|---|---|
| A | LIVE/IDLE，本节点 | 存在 | 直接 attach，正常 | 不变 |
| B | LIVE，其他节点 | 存在于对端 | `proxy_ws` 反向代理到 owner 节点 | 不变 |
| C | COLD，节点有空槽 | 不存在 | `pool.acquire` 立即拿槽 → `--resume` 拉起 | 不变 |
| D | COLD，节点满、有全局可驱逐 IDLE | 不存在 | 驱逐最久 idle 会话腾槽 → resume | 不变 |
| E | COLD，节点满、无可驱逐 | 不存在 | 进 FIFO 队列等 ≤ `pool_queue_timeout`(15s)，超时/队满 → WS close 4500 | close code 细化（§4.4） |
| F | **COLD，但本租户配额已被旧会话占满**（`tenant_max_concurrent=1` 默认值下的典型切换场景） | 旧会话后端存在，目标后端不存在 | `TenantQuotaExceeded` → WS close 4500，**切换死锁**：旧会话要等 `idle_grace_seconds`(300s) 才被驱逐 | **核心修改**：同租户 IDLE 会话优先驱逐（§3） |
| G | FAILED | 不存在 | FAILED → COLD → resume 可恢复（状态机已允许） | 不变 |
| H | CLOSED/EXPIRED | 已销毁 | WS close 4403 | 不变；列表/turns 接口标记只读 |
| I | 网关重启后状态失真（DB=LIVE 但本地无进程） | 不存在 | `create_session_from_existing` 重拉（不带 resume）| 修正：带上 `oh_session_id` resume（§4.5，小 bug 顺带修） |

> 场景 F 是用户特别点名的问题：默认 `tenant_max_concurrent=1`，用户从会话 A 切到会话 B 时，A 的后端仍占着租户唯一的槽位（前端断开 WS 后 A 只是进入 IDLE，要等 300s 空闲宽限才驱逐到 COLD）。不处理的话"切换"功能在默认配置下基本不可用。

---

## 3. 核心修改：租户配额触发的同租户 IDLE 驱逐

### 语义
当 `pool.acquire` 因**租户配额**（而非节点容量）拒绝时：
- 若该租户存在 IDLE（无 WS 连接、非 busy）的 live 会话 → 驱逐其中最久 idle 的一个到 COLD（快照保留，之后仍可切回来），释放槽位后重试 claim。
- 若该租户所有占槽会话都仍有 WS 连接或正在跑 turn → 维持现状，抛 `TenantQuotaExceeded`（REST 429 / WS 4430，见 §4.4）。前端提示"请先关闭其他活跃对话"。

这保持了 `tenant_max_concurrent` 的原始语义（同租户同一时刻只有一个**活跃**后端，stage-in/out 无并发写），只是把"哪一个会话占槽"的选择权交给用户最新动作。

### 候选条件（rev2 确认）

驱逐候选必须同时满足：

1. same tenant（`tenant_id` 匹配）
2. live（`is_live()`）
3. no ws connection（`not ws_connections`）
4. not busy（`not busy`，正在跑 turn 的不驱逐）
5. **not transitioning**（`not evicting`，新增标志，见下）

> 实现事实：`_evict()` 内 `await _teardown_process()` 期间 `live.state` 仍停留在 LIVE/IDLE（COLD 转移在 teardown **完成后**才发生），所以光看 state 无法排除"正在 stage_out / teardown 中"的会话。需在 `LiveSession` 上新增 `evicting: bool` 标志：`_evict()` 入口（首个 await 之前）置 True + 重入时直接 return，**清理必须放在 `try/finally`**（rev3 确认）——teardown / stage_out 任一环节抛异常都不能让会话永久卡在 evicting 状态（否则它既不能被再次驱逐、也会被候选过滤永远跳过）。**现有全局驱逐 hook `_evict_longest_idle` 同款隐患，候选过滤一并加上 `not evicting`。**

### 驱逐中途失败的语义（rev3 确认）

`_evict()` 内部失败必须保证三点不变量：

1. **`evicting` 必恢复**：整个驱逐体包在 `try/finally` 里，`finally` 清 `evicting = False`。
2. **slot 不泄漏**：teardown 失败（graceful shutdown 抛异常）升级为 `kill_group` 后继续往下走（`_teardown_process` 已有此兜底，但 `adapter.stop`/`_cancel_helpers` 等残余异常需确认不阻断后续）；`state → COLD` 转移与 `pool.release` 必须在同一受保护段内完成——只要进程已被杀，无论后续 stage-out 是否失败，槽位都要释放（release 幂等，重复调用安全）。stage-out 维持现有 best-effort（try/except + warning）。
3. **调用方拿到可预期的错误**：`_evict_tenant_idle` 对 `_evict()` 异常做 try/except，log 后返回 False → `pool.acquire` 按既有路径抛 `TenantQuotaExceeded`（或落入队列）→ WS 侧 4430/4503，不会把驱逐内部异常直接泄给客户端。

### `_evict()` 显式返回值（rev4 确认）

`_evict(live) -> bool`：True = 本次调用真正完成了驱逐（槽位已释放）；False = 未执行（`evicting` 重入跳过、或 state 不在 LIVE/IDLE）。调用方适配：
- `_evict_longest_idle` / `_evict_tenant_idle` 改为 `return await self._evict(candidate)`（现在是无条件 `return True`）——避免重入跳过时调用方误认驱逐成功而继续 retry claim（槽其实没释放，claim 必失败，白耗一次 `_EVICT_ATTEMPTS`）。
- `_idle_evict`（定时器路径）忽略返回值，行为不变。

### stage_out 失败后的 resumable 语义（rev4 确认）

- **有有效快照时**：evict 中 stage_out 失败，会话仍进入 COLD 可接受——本地 staging 目录的快照仍在，同节点 resume 可用（仅跨节点时 bucket 可能缺最新快照）。
- **resumable 判定增强**：对 COLD/FAILED 会话，`resumable` 额外要求快照存在性检查——新增 `tenant_store.has_session_snapshot(tenant_id, oh_session_id) -> bool`：先查本地 staging（`local_data_dir/sessions/{oh_session_id}/` 下是否有 `session-*.json`/`latest.json`，fs stat 廉价），本地缺失再查 MinIO bucket 前缀（仅对当页 cold 会话，数量有限；tenant staging 未启用时跳过 bucket 查）。检查不通过 → `resumable=false`、`read_only` 维持 false（前端可展示"暂不可恢复"），避免列表展示可恢复但实际 resume 失败。LIVE/IDLE 会话进程存活，无需检查。
- **顺带覆盖现存 edge case**：`turn_count == 0` 的 COLD 会话本就没有快照（OpenHarness 每轮后才写快照），现状下 rehydrate 带 `--resume` 会在 CLI 层 `Session not found` 退出。修复：rehydrate 时若快照不存在且 `turn_count == 0`，回退为 fresh spawn（`resume=False`，没有上下文可丢）；此类会话 `resumable=true`。

### 并发切换保护：租户级 eviction lock（rev2 确认）

场景：`tenant_max_concurrent=1`，A 处于 IDLE，两个客户端同时切到 B、C → 两个 `pool.acquire` 同时命中 `TenantQuotaExceeded` → 同时调同租户驱逐。无保护时两个请求会对同一个 A 重复驱逐（重复 teardown / 重复 release / 重复 stage-out）。

- supervisor 新增 `_tenant_evict_locks: dict[str, asyncio.Lock]`（per-tenant，setdefault 惰性创建，与 `_registration_locks` 同款写法）。
- `_evict_tenant_idle(tenant_id)` 全体在该锁内执行：**锁内重新扫描候选**（不复用锁外的快照），无候选返回 False。时序：请求 1 持锁驱逐 A → 释锁 → retry claim 拿槽；请求 2 持锁后扫描无候选 → False → `TenantQuotaExceeded` → WS 4430。B/C 恰好只有一个胜出，符合 `tenant_max_concurrent=1` 语义。
- `evicting` 标志与租户锁双重保护：租户锁防"同租户并发驱逐同一 idle 会话"；`evicting` 标志防"租户驱逐与全局容量驱逐（`_evict_longest_idle`）/ idle 定时器驱逐（`_idle_evict`）跨路径撞同一会话"。

### 代码落点

1. **`app/session/pool.py`**
   - `ContainerPool.__init__` 增加第二个 hook：`evict_tenant_idle: Callable[[str], Awaitable[bool]] | None`。
   - `acquire()` 的 stage 1-3 循环里：`_try_claim` 抛 `TenantQuotaExceeded` 时不再直接冒泡，先 `await self._evict_tenant_idle(tenant_id)`；返回 True 则重试 claim（复用 `_EVICT_ATTEMPTS` 上限），返回 False 才抛出。
   - 注意保持"critical section 内无 await"的原子性约定：驱逐 await 放在两次 `_try_claim` 之间，与现有全局驱逐写法一致。驱逐释放的槽仍先经 `_grant_from_queue` 给队列头（FIFO 不插队），重试失败则继续循环直到 `_EVICT_ATTEMPTS` 耗尽。
   - 队列入队前的 `_tenant_queue_count` 配额检查逻辑不变（防单租户刷满队列）。

2. **`app/session/supervisor.py`**
   - `LiveSession` 新增 `evicting: bool = False` 标志。
   - 新增 `_tenant_evict_locks: dict[str, asyncio.Lock]` + `_evict_tenant_idle(tenant_id: str) -> bool`：持租户锁 → 扫描候选（五条件见上） → 取 `idle_since` 最久者调 `_evict()`（复用现有驱逐路径：teardown → COLD → release slot → 持久化状态 → stage-out）。
   - `_evict()` 增加 `evicting` 重入守卫；`_evict_longest_idle` 候选过滤加 `not evicting`。
   - pool 构造处（`__init__` 的 `ContainerPool(evict_one=...)`）把新 hook 接上。

3. **驱逐后的 stage-out / stage-in 顺序**：切换场景下 A 驱逐（stage-out 租户数据）与 B rehydrate（stage-in）由 `rehydrate()` 现有顺序保证——`pool.acquire` 成功（含驱逐+stage-out）后才 `stage_in`，同租户串行无并发写，符合 WS-B 约定。`register_live_session` 的 per-sid 锁与 Redis 单写者锁均不受影响。

---

## 4. API 变更

### 4.1 `GET /v1/sessions` — 历史会话列表（新增）

- 查询参数：
  - `status`（可选，枚举过滤，如 `?status=cold`；不传 = 全部）
  - `limit`（默认 20，上限 100）、`offset`（默认 0）——简单分页即可，`ix_conversations_tenant_created` 复合索引已覆盖 `tenant_id + created_at DESC` 排序。
- 租户隔离：只返回 `tenant_id == tenant_from_request(request)` 的行（与 `_load_owned` 同一原则）。
- 响应 `SessionListResponse`：
  ```json
  {
    "items": [
      {
        "session_id": "...",
        "status": "cold",                     // 保留，供调试/观测；前端不应依赖
        "title": "帮我做一个产品发布视频…",   // 第一条 turn 的 prompt 截断 80 字符；无 turn 则 null
        "turn_count": 6,
        "resumable": true,                    // 业务字段：可连 WS 继续对话
        "read_only": false,                   // 业务字段：仅可查看历史（closed/expired）
        "permission_policy": "full_auto",
        "created_at": "...",
        "last_active_at": "...",
        "ws_url": "/v1/sessions/{sid}/ws"     // resumable=false 时为 null（沿用 _to_response 规则）
      }
    ],
    "total": 37, "limit": 20, "offset": 0
  }
  ```
- **业务字段与内部枚举解耦（rev2 确认）**：前端对"能不能切回去 / 只能看"的判断一律走 `resumable` / `read_only`，不强绑 `status` 枚举——后续内部状态机加态（如 warm、draining）不破坏前端契约。映射规则集中在后端一处：`read_only = status in (closed, expired)`；`resumable = not read_only` 且（对 COLD/FAILED）快照存在性检查通过（rev4，见 §3）；FAILED 可经 COLD 恢复，计入 resumable。
- `title` 实现：对页内 sid 集合一次 `ConversationTurn` 查询取 `turn_index == 0` 的 prompt（`uq_turns_conv_idx` 唯一约束保证每会话一行），内存拼装；不做 N+1，不加列。

### 4.2 `GET /v1/sessions/{sid}/turns` — 历史轮次记录（新增）

- 前端切换会话后用它回显聊天记录（不区分会话是否已终结——closed/expired 也可读，满足只读历史需求；turn 行在 DELETE 时明确保留）。
- 查询参数：`after_index`（默认 -1，返回 `turn_index > after_index`）、`limit`（默认 50，上限 200）。
- 响应 `TurnListResponse`：`items` 为现有 `TurnResponse` 结构 + `has_artifact`（对页内 turn_index 集合批量查 `TurnArtifact`，与 `_replay_missed_turns` 同款做法），另带 `total`。
- 鉴权：`_load_owned` 租户校验，404 语义不变。

### 4.3 切换动作本身 — 不新增 REST 接口

沿用"连 WS 即恢复"的单一准入路径（创建/恢复都走 `pool.acquire`，不引入第二个恢复入口导致双写风险）。前端切换流程：

1. 断开当前会话 WS（当前会话 → IDLE）。
2. `GET /v1/sessions` 选目标 → 校验 `resumable`。
3. `GET /v1/sessions/{sid}/turns` 回显历史。
4. 连 `ws_url`（带 `?last_turn_index=<已有最大 index>` 防补发重复）→ COLD 自动 rehydrate（§3 保证同租户旧会话被让位）。

### 4.4 WS 关闭码细化（修改 `app/routers/ws.py`）

现在三类准入失败统一 `4500 "session unavailable"`，前端无法区分。改为：

| 失败原因 | close code | reason（机器可解析标识，rev2 确认） |
|---|---|---|
| `TenantQuotaExceeded`（旧会话仍有活跃 WS，不可让位） | 4430 | `TENANT_QUOTA_EXCEEDED` |
| `QueueFullError` / `QueueTimeoutError` / `CapacityFullError`（无空余容器） | 4503 | `CAPACITY_FULL` |
| `TenantStoreError` / 其他 `RuntimeError`（rehydrate 竞争锁等） | 4500 | `SESSION_UNAVAILABLE` |

- **reason 只放机器标识常量**（大写下划线，前端据此做逻辑判断和 i18n 文案映射），不放自然语言；WS close reason 有 123 字节上限，常量形式天然安全。常量集中定义在 ws.py 模块顶部（或 schemas），避免散落字符串。
- 这三类失败均发生在 `accept()` 之后，关闭前额外发一帧结构化错误 `{"type":"error","code":"TENANT_QUOTA_EXCEEDED","message":"..."}`（message 供调试，code 供逻辑），再 close——部分 WS 客户端库拿不到 close reason，有这帧更稳。
- 握手前（accept 之前）的既有码 4401/4403/4404/4429(rate limit)/4400 保持不变，不在本次范围。
- 改动点：ws.py 三处 `except (CapacityFullError, PoolAdmissionError, RuntimeError)` 拆分捕获（`TenantQuotaExceeded` 是 `PoolAdmissionError` 子类，注意捕获顺序：先子类后基类）。

### 4.5 顺带修复：`create_session_from_existing` 不带 resume

场景 I（网关重启后 DB=LIVE/IDLE 但进程丢失）目前 `_spawn(live, resume=False)` 重拉，**丢失全部上下文**。改为 `resume=True`（`oh_session_id` 已从 conv 行恢复），与 COLD rehydrate 行为一致。属一行改动 + 一条测试。

---

## 5. 文件改动清单

| 文件 | 改动 |
|---|---|
| `session-service/app/schemas.py` | 新增 `SessionSummary`（含 `resumable`/`read_only` 业务字段）、`SessionListResponse`、`TurnListResponse`（items 复用 `TurnResponse`，已有 `has_artifact`） |
| `session-service/app/routers/sessions.py` | 新增 `GET ""`（列表）、`GET "/{sid}/turns"`（历史轮次）两个 handler；`resumable`/`read_only` 映射集中在一个辅助函数；注意列表路由要放在 `/{sid}` 之前或依赖 FastAPI 的路径类型区分（`sid: uuid.UUID` 已天然不与空路径冲突） |
| `session-service/app/session/pool.py` | `evict_tenant_idle` hook + `acquire` 配额驱逐重试逻辑 |
| `session-service/app/session/supervisor.py` | `LiveSession.evicting` 标志；`_tenant_evict_locks` + `_evict_tenant_idle()` 实现并接线；`_evict() -> bool` 显式返回值 + try/finally 重入守卫；`_evict_longest_idle` 候选过滤加 `not evicting` 且透传 `_evict` 返回值；rehydrate 无快照且 0 turn 时回退 fresh spawn；`create_session_from_existing` 改 `resume=True` |
| `session-service/app/session/tenant_store.py` | 新增 `has_session_snapshot(tenant_id, oh_session_id)`（本地 staging fs 检查优先，回退 bucket 前缀查） |
| `session-service/app/routers/ws.py` | 准入失败 close code 细化（4430/4503/4500）+ 机器可解析 reason 常量 + close 前结构化错误帧 |
| `session-service/API_DOCUMENTATION.md` | 补两个新接口、WS close code/reason 常量表、切换流程说明 |

无 DB 迁移、无镜像重建（源码 volume 挂载即生效）。

---

## 6. 测试计划

按项目规则，全部在已有镜像容器内跑，不在宿主机执行：

```bash
docker compose run --rm --entrypoint bash openharness \
  -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"
```

（依赖 compose 内既有 `postgres:16-alpine` / `redis:7-alpine`。）

### 新增/修改用例

1. **`tests/test_sessions_api.py`（扩展）**
   - `GET /v1/sessions`：分页、按 status 过滤、`title` 取第一轮 prompt、`resumable`/`read_only` 业务字段映射（含 FAILED → resumable=true、closed → read_only=true）、**租户 A 看不到租户 B 的会话**、closed 会话 `ws_url=null`。
   - `GET /v1/sessions/{sid}/turns`：`after_index` 增量、`has_artifact` 标记、closed 会话仍可读、跨租户 404。
2. **`tests/test_pool.py`（扩展）**
   - 租户配额满 + 存在同租户 idle 会话 → hook 被调用、驱逐后 claim 成功。
   - 租户配额满 + hook 返回 False（无可驱逐）→ 仍抛 `TenantQuotaExceeded`。
   - hook 驱逐与队列 FIFO 不互相插队（驱逐释放的槽先给队列头，重试走 `_EVICT_ATTEMPTS` 上限）。
3. **`tests/test_supervisor.py`（扩展）**
   - `_evict_tenant_idle` 只选本租户、无 WS、非 busy、非 evicting、最久 idle 的会话。
   - `evicting` 重入守卫：对同一 live 并发调两次 `_evict` → teardown/release/stage-out 只发生一次；**重入的那次返回 False**（rev4：调用方不会误认驱逐成功去 retry claim）。
   - **resumable 快照检查（rev4）**：COLD 会话无快照 → 列表 `resumable=false`；有快照 → true；`turn_count==0` 无快照的 COLD 会话 → `resumable=true` 且 rehydrate 走 fresh spawn（断言 build_command 不含 `--resume`）。
   - **驱逐中途失败（rev3 确认）**：分别 mock `_teardown_process`（或 `process.shutdown`）和 `tenant_store.stage_out` 抛异常：
     - `live.evicting` 恢复为 False（finally 生效，会话后续仍可被驱逐/恢复）；
     - slot 不泄漏：`pool.release` 被调用、`pool.live_count()` 正确回落，后续 acquire 可拿到槽；
     - stage_out 失败时会话仍正常进入 COLD（best-effort 语义），DB 状态已持久化为 cold；
     - 经 `_evict_tenant_idle` 路径触发时返回 False，`pool.acquire` 抛 `TenantQuotaExceeded`（错误符合预期，不泄内部异常）。
   - `create_session_from_existing` 传 `resume=True`（断言 build_command 含 `--resume <oh_session_id>`）。
4. **`tests/test_ws.py`（扩展）**
   - 切换场景端到端（stub 后端）：租户唯一槽被会话 A（IDLE）占用 → 连 B 的 WS → A 被驱逐到 COLD、B rehydrate 成功、收到 `session_ready`。
   - A 仍有活跃 WS 时连 B → close 4430，reason=`TENANT_QUOTA_EXCEEDED`，close 前收到结构化 error 帧。
   - 容量满且不可驱逐 → close 4503，reason=`CAPACITY_FULL`。
   - **并发切换测试（rev2 确认）**：`tenant_max_concurrent=1`，会话 A idle，两个客户端**同时**分别连 B、C 的 WS（`asyncio.gather` 发起）：
     - 断言 A 只被驱逐一次（teardown/stage-out/pool.release 各一次，可用 mock 计数）；
     - 恰好一个胜出（收到 `session_ready`）、另一个收到 4430；
     - 无非法状态转移（无 `IllegalTransition`）、pool 槽计数最终 = 1。
5. **E2E（可选，后续前端联调时）**：在 `e2e/run-session-container-pool-tests.sh` 增加"创建 A → 断开 → 创建/恢复 B → 切回 A"用例，验证 container runtime（`OH_SESSION_RUNTIME=container`）下同样成立。

---

## 7. 风险与决策记录

1. **同租户驱逐会打断"后台任务"吗？** 不会——候选条件含 `not busy`，正在跑 turn 的会话不会被驱逐；此时切换得到 4430，前端提示等待或中断。
2. **`tenant_max_concurrent > 1` 的部署**：逻辑退化正确——只有配额满时才驱逐自家 idle，行为与全局驱逐一致；last-writer-wins 风险维持既有文档口径。租户锁粒度为 per-tenant，不影响跨租户并发。
3. **驱逐→resume 的窗口竞争**：三层保护——`register_live_session` per-sid 锁（同一会话并发重连）、Redis 单写者锁（多节点）、租户 eviction lock + `evicting` 标志（同租户并发驱逐 / 跨驱逐路径重入）；本计划不新增写路径。
4. **列表接口性能**：`ix_conversations_tenant_created` 已存在；title 子查询按页内 sid 批量，一页两条 SQL。
5. **close code 兼容性**：现有前端（web/session-frontend）对 4500 的处理不受影响（新增码只在原 4500 的子集场景出现）；reason 换成机器常量后，若现有前端有展示 raw reason 的地方需在前端切换功能开发时一并映射文案。
6. **业务字段 vs 内部枚举**：`status` 保留在响应里仅供调试/观测；API 文档明确标注前端应依赖 `resumable`/`read_only`，`status` 枚举值不承诺稳定。
