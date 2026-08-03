# 任务清单：会话快照存储契约

> DRAFT · 未开工。所有测试在既有镜像内执行（`docker-compose.yml + docker-compose.stub.yml` 起 stub 后端栈），
> 禁止宿主机直跑测试、禁止从零重建基础镜像。

## 1. 判据收紧
- [ ] 1.1 `tenant_store` 新增 `has_valid_snapshot(tenant_id, oh_session_id) -> bool`（**抽象快照标记，不绑定文件名**）：本地 staging 存在非空快照 marker 文件，或远端非空 marker 对象即真；空目录/零字节占位为 false。
- [ ] 1.2 远端（`_has_remote_snapshot_sync`）同样按 marker 语义过滤零字节对象与纯前缀命中。
- [ ] 1.3 单测：空目录 / 仅零字节对象 / 有 marker 文件 / 多文件但无 marker 四类输入的判定矩阵（不写死文件名）。

## 2. 上下文判据
- [ ] 2.1 新增 `completed_turn_count(conv)`（`conversation_turns.status='completed'` 计数）。
- [ ] 2.2 `completed_turn_count(conv)` 直接以 `COUNT(conversation_turns.status='completed')` 实现（见 design.md 决策：短期不落冗余列，无 migration 任务）。
- [ ] 2.3 单测：`turn_count=1 / completed=0` 必须判为“无上下文”。

## 3. 决策入口收敛
- [ ] 3.1 新增独立 recovery 模块（建议 `app/session/recovery.py`）：纯函数 `resolve_resume_decision(*, completed_turns, has_valid_snapshot) -> FRESH|RESUME|RECOVERY_FAILED`；服务函数 `resolve_for_conversation(conv, tenant_store)` 组合 `COUNT(completed)` 与 `tenant_store.has_valid_snapshot`。**不放 supervisor**。
- [ ] 3.2 `supervisor.rehydrate`：移除内联 `turn_count == 0` 分支（`supervisor.py:684-694`），改调 `recovery.resolve_for_conversation`。
- [ ] 3.3 `supervisor.create_session_from_existing`：移除硬编码 `resume=True`（`supervisor.py:360`），改调 `recovery.resolve_for_conversation`；`RECOVERY_FAILED` 时不 spawn 并抛出可区分的领域异常（出口语义由 change 2 定义）。
- [ ] 3.4 历史切换路径同步接入。
- [ ] 3.5 单测：两条路径对同一 fixture 得到相同决策。

## 4. `resumable` 同源
- [ ] 4.1 `routers/sessions.py::_business_fields`（`sessions.py:100-119`）改为调用决策函数派生 `resumable`，覆盖陈旧 `live`。
- [ ] 4.2 单测：陈旧 `live` + `RECOVERY_FAILED` ⇒ `resumable=false`；`closed/expired` 维持 `read_only=true`。

## 5. 可观测性
- [ ] 5.1 决策处输出结构化日志（`decision` / `completed_turns` / `has_snapshot` / `snapshot_source`）。
- [ ] 5.2 指标：`session_resume_decision_total{decision=...}`。

## 6.（可选）oh 侧契约澄清
- [ ] 6.1 评估将 `get_project_session_dir()`（`session_storage.py:54-60`）拆为 `resolve_project_session_dir()`（纯解析）+ `ensure_project_session_dir()`（带 mkdir），消除“解析即建目录”的副作用。
- [ ] 6.2 若拆分，回归 oh 侧快照读写与 `/resume` 命令。

## 7. 验收（既有镜像内）
- [ ] 7.1 stub 栈复现 S1：0 完成 turn 的会话在网关重启后重连 ⇒ fresh spawn 成功，无 `--resume`。
- [ ] 7.2 stub 栈复现 S4：有完成 turn 且删除快照对象 ⇒ 不 spawn、`resumable=false`、返回可区分错误（错误码细节由 `session-backend-failure-isolation` 定义）。
- [ ] 7.3 复现 S3：快照存在 ⇒ `--resume` 恢复且 `turn_index` 连续。
- [ ] 7.4 回归既有 `e2e/run-session-live-acceptance.sh` 全绿。
