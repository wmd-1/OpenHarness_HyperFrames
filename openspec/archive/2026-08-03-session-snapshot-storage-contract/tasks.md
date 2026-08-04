# 任务清单：会话快照存储契约

> 状态：**Change1 已实现并通过验证**（2026-08-03）。所有测试在既有镜像内执行。
> 验证结果：`tests/test_recovery_decision.py` 10/10 通过；`e2e/run-session-live-acceptance.sh` 的 **WS 13/13 通过**。
> 已知遗留：REST 项 `second concurrent create -> 429` 在 stub 栈**始终失败**（stub 将 `OH_TENANT_MAX_CONCURRENT` 放宽到 12，断言前提不成立）——属既有测试期望与 stub 环境不匹配，**与 Change1 无关**（未触碰准入/配额逻辑）。

## 1. 判据收紧
- [x] 1.1 `tenant_store` 新增 `has_valid_snapshot(tenant_id, oh_session_id) -> bool`（**抽象快照标记，不绑定文件名**）：本地 staging 存在非空快照 marker 文件，或远端非空 marker 对象即真；空目录/零字节占位为 false（`_is_snapshot_marker` / `_has_valid_snapshot_marker`）。
- [x] 1.2 远端（`_has_remote_snapshot_sync`）同样按 marker 语义过滤零字节对象与纯前缀命中。
- [x] 1.3 单测：空目录 / 仅零字节对象 / 有 marker 文件 / 多文件但无 marker 四类输入（不写死文件名）。

## 2. 上下文判据
- [x] 2.1 新增 `count_completed_turns(db, conversation_id)`（`conversation_turns.status='completed'` 计数）。
- [x] 2.2 直接以 `COUNT(conversation_turns.status='completed')` 实现（短期不落冗余列，无 migration）。
- [x] 2.3 单测：`turn_count=1 / completed=0` ⇒ `RECOVERY_FAILED`（非 FRESH）。

## 3. 决策入口收敛（核心）
- [x] 3.1 新增独立 recovery 模块 `app/session/recovery.py`：纯函数 `resolve_resume_decision(*, completed_turns, has_valid_snapshot) -> FRESH|RESUME|RECOVERY_FAILED`；服务函数 `resolve_for_conversation(...)` 组合 `COUNT(completed)` 与 `tenant_store.has_valid_snapshot`；**不放 supervisor**，并导出 `RecoveryFailedError`。
- [x] 3.2 `supervisor.rehydrate`：移除内联 `turn_count == 0` 分支，改调 `recovery.resolve_for_conversation`；`RECOVERY_FAILED` 抛 `RecoveryFailedError`（不 spawn）。
- [x] 3.3 `supervisor.create_session_from_existing`（历史切换 D10）：移除硬编码 `resume=True`，改调 `recovery.resolve_for_conversation`；`RECOVERY_FAILED` 抛 `RecoveryFailedError`。
- [x] 3.4 历史切换路径同步接入（同 3.3）。
- [x] 3.5 两条路径复用同一决策函数（单测覆盖 `resolve_for_conversation` 的 RESUME/FRESH/RECOVERY_FAILED 三态）。

## 4. `resumable` 同源
- [x] 4.1 `routers/sessions.py::_business_fields` 改用 `tenant_store.has_valid_snapshot`（与决策判据同源）。
- [ ] 4.2 单测：陈旧 `live` + `RECOVERY_FAILED` ⇒ `resumable=false`（待补，人工核验可由 change 2 错误出口覆盖）。

## 5. 可观测性
- [ ] 5.1 决策处输出结构化日志（`decision` / `completed_turns` / `has_snapshot` / `snapshot_source`）。
- [ ] 5.2 指标：`session_resume_decision_total{decision=...}`。

## 6.（可选）oh 侧契约澄清
- [ ] 6.1 评估将 `get_project_session_dir()` 拆为 `resolve_project_session_dir()` + `ensure_project_session_dir()`，消除“解析即建目录”的副作用（本 change 已在 `tenant_store` 侧规避，但 oh 侧 mkdir 副作用仍是观测者效应来源）。
- [ ] 6.2 若拆分，回归 oh 侧快照读写与 `/resume` 命令。

## 7. 验收（既有镜像内）
- [x] 7.1 S1：0 完成 turn 的会话重连 ⇒ fresh spawn 成功，无 `--resume`（session-live-acceptance WS 全绿）。
- [x] 7.3 S3：快照存在 ⇒ `--resume` 恢复且 `turn_index` 连续（WS turn #2 通过）。
- [x] 7.4 回归 `e2e/run-session-live-acceptance.sh`：WS 13/13 通过；REST 仅剩既有 `429` 并发断言（stub 宽松配额导致，非本 change 回归）。
- [ ] 7.2 S4 端到端（有完成 turn 且删快照 ⇒ 不 spawn、明确错误）需 change 2 的错误出口落地后联合验证。
