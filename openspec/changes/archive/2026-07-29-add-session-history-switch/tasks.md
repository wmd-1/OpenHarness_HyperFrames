# Tasks: add-session-history-switch

> 实现依据：`design.md`（D1–D10）与 `plans/Session_History_Switch_Plan_2026-07-29.md`（rev4）。测试一律在已有镜像容器内跑：`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`。

## 1. 驱逐路径加固（supervisor.py）

- [x] 1.1 `LiveSession` 新增 `evicting: bool = False` 字段
- [x] 1.2 `_evict()` 改造：签名改 `-> bool`；入口（首个 await 前）检查 `evicting` 重入即 `return False`、置 True；驱逐体包 `try/finally`，`finally` 清 `evicting = False`
- [x] 1.3 `_evict()` 失败语义：teardown 段异常不阻断 `COLD` 转移与 `pool.release`（同一受保护段，进程已杀则槽必释放）；stage-out 维持 best-effort；正常完成 `return True`
- [x] 1.4 `_evict_longest_idle` 候选过滤加 `not s.evicting`，并改为 `return await self._evict(candidate)`（透传真实结果，去掉无条件 `return True`）
- [x] 1.5 `create_session_from_existing` 改为 `await self._spawn(live, resume=True)`

## 2. 同租户 IDLE 让位（supervisor.py + pool.py）

- [x] 2.1 supervisor 新增 `_tenant_evict_locks: dict[str, asyncio.Lock]`（仿 `_registration_locks`，setdefault 惰性创建）
- [x] 2.2 实现 `_evict_tenant_idle(tenant_id) -> bool`：租户锁内重新扫描候选（五条件：同租户 / `is_live()` / 无 WS / 非 busy / 非 evicting），选最久 idle 者调 `_evict`；捕获内部异常 log 后 `return False`
- [x] 2.3 `ContainerPool` 构造注入 `evict_tenant_idle` hook；`acquire` 在 `_try_claim` 抛 `TenantQuotaExceeded` 时先调 hook、`True` 才重试 claim（复用 `_EVICT_ATTEMPTS` 上限），`False` 走既有拒绝/队列路径；hook 调用保持在无 await 的 critical section 之外
- [x] 2.4 supervisor `__init__` 接线：`ContainerPool(evict_one=..., evict_tenant_idle=self._evict_tenant_idle)`

## 3. 快照存在性与 rehydrate 回退（tenant_store.py + supervisor.py）

- [x] 3.1 `tenant_store` 新增 `has_session_snapshot(tenant_id, oh_session_id) -> bool`：本地 staging `sessions/{oh_session_id}/` fs 检查优先，缺失回退 bucket 前缀查；staging 未启用跳过 bucket 查
- [x] 3.2 rehydrate：快照不存在且 `turn_count == 0` 时回退 fresh spawn（`_spawn(live, resume=False)`）

## 4. REST 接口（schemas.py + routers/sessions.py）

- [x] 4.1 schemas 新增 `SessionSummary`（含 `title`/`turn_count`/`resumable`/`read_only`）、`SessionListResponse`、`TurnListResponse`（items 复用 `TurnResponse`）
- [x] 4.2 业务字段映射集中一个辅助函数：`read_only = status in (closed, expired)`；`resumable = not read_only` 且（COLD/FAILED）`has_session_snapshot` 通过；0-turn 无快照 COLD → `resumable=true`
- [x] 4.3 实现 `GET /v1/sessions`：租户过滤 + `created_at` 倒序 + `limit(≤100)/offset` + status 过滤 + `total`；`title` 页内一次批量查询 `turn_index==0` 的 prompt 截 80 字符；路由注册在 `/{sid}` 之前
- [x] 4.4 实现 `GET /v1/sessions/{sid}/turns`：`after_index`（默认-1）/`limit`（默认50，上限200）游标分页，`has_artifact` 批量查询，closed/expired 可读，跨租户 404

## 5. WS 准入失败语义（routers/ws.py）

- [x] 5.1 定义 reason 常量 `TENANT_QUOTA_EXCEEDED` / `CAPACITY_FULL` / `SESSION_UNAVAILABLE` 与 close code 映射（4430/4503/4500）
- [x] 5.2 拆分三处宽泛 `except (CapacityFullError, PoolAdmissionError, RuntimeError)`：先捕获 `TenantQuotaExceeded` 子类 → 4430；`CapacityFullError`/`QueueFullError`/`QueueTimeoutError` → 4503；其余 → 4500
- [x] 5.3 close 前发结构化错误帧 `{"type":"error","code":"<常量>","message":"<人类可读>"}`（发送失败不影响 close）

## 6. 测试（容器内执行）

- [x] 6.1 `tests/test_pool.py`：quota 超限触发 hook → 驱逐后 claim 成功；hook 返回 False → `TenantQuotaExceeded`；驱逐重试受 `_EVICT_ATTEMPTS` 上限；hook 与队列 FIFO 不互相插队
- [x] 6.2 `tests/test_supervisor.py`：候选五条件筛选；evicting 重入守卫（并发两次 `_evict` → teardown/release/stage-out 各一次，重入次返回 False）
- [x] 6.3 `tests/test_supervisor.py` 驱逐中途失败：mock teardown / stage_out 抛异常 → `evicting` 恢复 False、slot 不泄漏（`live_count()` 回落、后续 acquire 可拿槽）、stage_out 失败仍进 COLD 且 DB 持久化、经 `_evict_tenant_idle` 触发时返回 False 且 acquire 抛 `TenantQuotaExceeded`
- [x] 6.4 `tests/test_supervisor.py`：resumable 快照检查（无快照 COLD → false；有快照 → true；0-turn 无快照 COLD → true 且 rehydrate 不含 `--resume`）；`create_session_from_existing` 断言 build_command 含 `--resume`
- [x] 6.5 `tests/test_sessions_api.py`（或既有 REST 测试文件扩展）：列表分页/排序/status 过滤/title 截断/跨租户不可见；turns 游标分页/closed 可读/跨租户 404
- [x] 6.6 `tests/test_ws.py`：切换端到端（A idle → 连 B → A COLD、B `session_ready`）；无候选时 4430 + `TENANT_QUOTA_EXCEEDED` 错误帧；容量满 4503
- [x] 6.7 `tests/test_ws.py` 并发切换：quota=1、A idle，`asyncio.gather` 同连 B/C → A 恰好驱逐一次、恰一个 `session_ready` 一个 4430、无 IllegalTransition、租户槽计数=1
- [x] 6.8 容器内全量回归：`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`

## 7. 文档

- [x] 7.1 `API_DOCUMENTATION.md`：补两个新接口、`resumable`/`read_only` 字段语义、WS close code/reason 常量表、切换流程说明（列表 → turns 回显 → 连目标 WS → `session_ready`）
