# 任务清单：会话后端故障隔离

> 状态：**已实现并验证**（失败注入单测 10/10 全绿；supervisor/recovery 回归 26/26 全绿；共 36 例）。
> 验证方式：既有镜像 `oh-session-test:latest`（`-v session-service:/opt/oh-session-service`，entrypoint `python3 -m pytest`），禁宿主机直跑、禁重建基础镜像。
> 失败分类出口遵循已拍板原则：**不引入自定义 close code**（C3/C4 统一 `1011`），分类靠 `error.code` 业务字段；REST 标准语义状态码（503/409）。C1–C4 内部编号仅入 metrics/logs，不暴露客户端。

## 1. 状态一致性
- [x] 1.1 失败终态收敛：C3/C4 在 `create_session_from_existing` 与 `register_live_session`（COLD rehydrate）的调用侧 try/except 中处理——`live.state=FAILED`、`self._sessions.pop(sid)`、池槽位在 `_spawn` 内已释放、用**全新 `app_db.async_session()`** 将 DB 行标 `FAILED` 后重抛领域异常（caller `db` 在后端异常后事务失效会被回滚，故另起 session 提交）。**失败会话不进入自动删除/孤儿回收**（`orphan_scan` 仅删 CLOSED/EXPIRED/absent）。
- [ ] 1.2 `LiveSession` 失败字段 `failure_class`/`failure_reason`：**未落地**——按既定假设本 change 不新增 DB 列/迁移，失败分类仅入 metrics/logs，DB 只存 `FAILED` 枚举。**待用户确认**（是否要后续 change 落列）。
- [x] 1.3 单测：`test_cse_backend_exit_converges_failed` 断言失败后注册表无残留、池槽位=0。

## 2. 消灭运行时断言
- [x] 2.1 `stream_turn`：`assert live.adapter is not None` → `if live.adapter is None: raise SessionNotFound(sid)`。
- [x] 2.2 同步处理 `_await_ready`（`assert`→`RuntimeError`）、`interrupt`（`assert`→`SessionNotFound`）、`_drain_logs`（`assert`→`return`）。
- [x] 2.3 单测：`test_stream_turn_adapter_none_is_session_not_found`（adapter=None 转 `turn_error` 帧、非 raise）、`test_interrupt_adapter_none_is_session_not_found`。

## 3. 错误分类与出口
- [x] 3.1 错误码常量：`process.BACKEND_START_FAILED_CODE`、`recovery.RECOVERY_FAILED_CODE`；指标 `obs_metrics.SESSION_BACKEND_FAILURES{code}`。未另建 C1–C4 枚举——业务码直接用于 metrics（内部编号仅日志）。
- [x] 3.2 **不引入自定义 close code**：WS 失败统一 `close(1011)`；`error` 帧 `code`=业务枚举（`BACKEND_START_FAILED`/`RECOVERY_FAILED`）；C1–C4 不暴露客户端。
- [x] 3.3 `routers/ws.py`：`_close_backend_failure(ws, exc)` 选 code + inc 指标 + 发 `error` 帧 + `close(1011)`；三处 except（`register_live_session` rehydrate / COLD-create / `create_session_from_existing` re-arm）catch `(BackendProcessError, RecoveryFailedError)` → `_close_backend_failure` → `await session.commit()`（抵消 `async with db` 退出回滚）→ return。
- [x] 3.4 REST 映射：C3 `BACKEND_START_FAILED` → **503**（`sessions.py` POST handler，`detail={code,message}`，形态与同文件 403 quota 错误一致）；C4 `RECOVERY_FAILED` → 恢复走 WS（`create_session_from_existing`/`rehydrate`），已映射为 `RECOVERY_FAILED` 错误帧 + `1011`。当前**无独立 REST resume 端点直接抛 409**（恢复为 WS 驱动）——若需 REST 侧 409 需新增 resume 入口，待澄清。
- [ ] 3.5 后端 stderr 尾部采集（限长/脱敏 `*_API_KEY`、`X-API-Key`）：**未实现**，留待后续。

## 4. 计数保护
- [x] 4.1 失败路径不创建 `conversation_turns` 行、不递增 `turn_count`（C3 抛于 spawn 前/中，无任何 turn 落库）。
- [x] 4.2 单测：`test_cse_backend_exit_converges_failed`（断言无 turn 行）、`test_cse_recovery_failed_converges_failed`（completed turns 保留、不新增、`turn_count` 不变）。

## 5. 止损与幂等
- [x] 5.1 失败终态重复连接幂等：`test_ws_reconnect_idempotent_failure`（连续重连同一错误、后端进程创建次数 0）。
- [x] 5.2 指标 `SESSION_BACKEND_FAILURES{code}`；结构化日志字段补齐。
- [x] 5.3 孤儿回收排除 `FAILED`：`test_failed_session_not_auto_recycled`（`orphan_scan` 后 FAILED 行存活+目录保留，CLOSED 目录被删）。

## 6. 验收（既有镜像内）
- [x] 6.1 stub 注入“启动即失败”后端 ⇒ WS 收到 `error` 帧（`BACKEND_START_FAILED`/`RECOVERY_FAILED`）+ `close(1011)`；无 `AssertionError` traceback（`test_ws_backend_start_failed_closes_1011` / `test_ws_recovery_failed_closes_1011`）。
- [x] 6.2 复现原始故障（网关重启 + 无快照 + 有上下文）⇒ `RECOVERY_FAILED`，无 `AssertionError`，`turn_count` 不变（`test_cse_recovery_failed_converges_failed`）。
- [x] 6.3 连续 3 次重连 ⇒ 幂等同一错误、后端进程创建 0 次（`test_ws_reconnect_idempotent_failure`）。
- [ ] 6.4 回归 `e2e/run-session-live-acceptance.sh`：本会话未重跑（Change1 验收时已绿）；Change2 改动未触及其覆盖路径，建议归档前跑一次。

## 备注（本次连带修复）
- 回归发现 `test_rehydrate_resume_decision` / `test_create_session_from_existing_spawns_with_resume` 仍按 **Change1 之前**的 `turn_count`/`has_session_snapshot` 语义编写，Change1 改走 `resolve_for_conversation`（`has_valid_snapshot` + 已完成 turn 计数）后该二测一直红（Change1 验收未跑 `test_supervisor.py`）。本次将其对齐新语义：`(无快照, completed>0)` 现正确抛 `RecoveryFailedError`；resume 断言改为 mock `has_valid_snapshot` + 插入 `status=COMPLETED` 的 `ConversationTurn`。属测试对齐，非业务回归。
