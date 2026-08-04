# 设计说明：会话后端故障隔离

> DRAFT · 2026-08-03 · 未实现代码

## 1. 当前失效链（证据锚点）

```
ws.py:274   create_session_from_existing(conv3, ...)
   └─ supervisor.py:360   _spawn(live, resume=True)
        └─ supervisor.py:417  _await_ready(live)      ← 后端 exit=1
             └─ BackendProcessError
                  ├─ except: live.state = FAILED，但 adapter/process/_sessions 未清理
                  └─ raise → ws.py:273-279 未捕获该异常类型 → ASGI 未捕获异常 traceback
                       └─ 后续 stream_turn → supervisor.py:759  assert live.adapter is not None  💥
                            └─ conversation_turns 落一行 status=failed；conversations.turn_count 0→1
```

同类裸断言：`supervisor.py:442`、`759`、`932`、`1031`。

## 2. 失败分类与出口

| 分类 | 触发 | 会话终态 | WS 出口 | REST 出口 |
|---|---|---|---|---|
| C1 准入/容量 | `CapacityFullError` / `PoolAdmissionError` | 保持原状态 | 既有 4429 / 4503 策略 | 429 / 503 |
| C2 租户存储不可用 | `TenantStoreError`（stage-in 失败） | 保持原状态 | 既有 4500 SESSION_UNAVAILABLE | 503 |
| C3 后端启动失败 | `BackendProcessError`（含 exit≠0、ready 超时） | `FAILED` | `error` 帧（`code=BACKEND_START_FAILED`）+ 以 **1011** 关闭 | 503（backend unavailable） |
| C4 恢复失败 | change 1 的 `RECOVERY_FAILED`（有上下文、无快照） | `FAILED` | `error` 帧（`code=RECOVERY_FAILED`）+ 以 **1011** 关闭 | （保留）REST **409 留给未来显式 resume/conflict API**；本变更恢复失败经 WS 暴露，不强行使用 409 |

关闭策略（用户 2026-08-03 决策）：**不新增自定义 close code**，C3/C4 统一以 **1011（server error）** 关闭连接；具体失败分类由 `error` 帧的 `code` 字段承载（`BACKEND_START_FAILED` / `RECOVERY_FAILED`）。约束：
- 后端 MUST NOT 复用既有语义化的 4400–4503 区间码承载 C3/C4，避免与前端的「可重连/限流/配额」策略冲突；
- 前端 MUST 依据 `error.code` 而非 close code 区分 C3/C4，并将两者归入「不自动重连」类（重试只会复现同一失败）；
- **内部分类编号（C1–C4）仅用于服务端指标/日志，MUST NOT 出现在对客户端暴露的 `error.code` 中**（用户 2026-08-03 约束 5）；对外一律是业务枚举（`BACKEND_START_FAILED` / `RECOVERY_FAILED` / `CAPACITY_FULL` 等）。

### 错误边界契约（验收口径，2026-08-03 最终决策）

1. **WS backend / recovery failure** → 以 **1011（server error）** 关闭连接，并先发送 `error` 帧（`code=BACKEND_START_FAILED` 或 `RECOVERY_FAILED`）；前端依据 `error.code` 区分，归入「不自动重连」类（重试只会复现同一失败）。
2. **REST backend unavailable（C3）** → **503**，响应体沿用本路由既有 `detail={code,message}` 信封（与 403 quota 错误一致），`code=backend_start_failed`。
3. **409** 状态码**保留给未来的显式 resume / conflict API**，**本变更不强行使用 409**：当前恢复失败（C4）统一经 WebSocket 以 1011 + `error.code=RECOVERY_FAILED` 暴露；REST 侧不因恢复失败返回 409。若后续引入 `POST /v1/sessions/{sid}/recover` 等显式入口，再启用 409 表达「资源存在但不可恢复 / 冲突」。

## 3. 状态一致性策略（二选一，倾向 A）

- **方案 A：失败即回滚（推荐）**。`_spawn` 的 except 分支中：释放池槽位 → `live.adapter = None` / `live.process = None` → `self._sessions.pop(live.sid, None)` → 更新 DB 状态与失败原因 → 抛出领域异常。优点：不存在“看起来 live 实则不可用”的对象；`stream_turn` 只需处理 `SessionNotFound`。

**FAILED 会话保留策略（用户 2026-08-03 约束 4）**：失败会话 MUST 同时满足三点——① **DB 行保留** `status=FAILED`（含 `failure_class` / `failure_reason`，不删除）；② **清理 runtime live instance**（从 `self._sessions` 移除、`adapter` / `process` 置空）；③ **不进入自动删除/孤儿回收**（现有孤儿回收按 `CLOSED/EXPIRED` 判定，`FAILED` 明确排除）。仅显式运维或保留期到期（待定）后才清理。
- **方案 B：保留 FAILED 对象**。保留 live 便于查询失败原因，但所有取用 adapter 的入口都必须前置守卫。缺点：守卫点分散（至少 4 处断言），易漏。

无论哪种，**`stream_turn` 及其它入口 MUST 以显式检查 + 领域异常替代 `assert`**（`python -O` 下 assert 会被剥离）。

## 4. turn 计数保护

现状：恢复失败被记为 `conversation_turns(turn_index=0, status='failed')` 且 `turn_count += 1`。

目标：基础设施级失败（C2/C3/C4）**不写 turn 行、不递增计数**；只有真正被后端接收并执行的用户输入才计入。若产品上仍希望留痕，MUST 使用独立的事件/审计通道，而非 `conversation_txurns`。

> 与 change 1 的耦合点：change 1 已将“有上下文”判据改为 completed turn 计数，本条进一步消除污染源，两者互为补强。

## 5. 止损与幂等

- 同一会话进入 C3/C4 终态后，REST `resumable=false`（由 change 1 的同源派生保证），前端不再发起连接；
- 若前端仍连接，服务端 MUST 直接返回同一 `error` 帧并关闭，MUST NOT 重复 spawn；
- 记录 `session_backend_failure_total{class=C1..C4}` 指标与结构化日志（含后端 stderr 尾部，限长且脱敏 API key）。

## 6. 开放问题（已决策项已标注）

1. ~~C4 的 REST 状态码取 409 还是 422~~ → **已决策：409 保留给未来显式 resume/conflict API，本变更不强行使用**（用户 2026-08-03 最终口径）。当前 C4 恢复失败经 WS 以 1011 + `error.code=RECOVERY_FAILED` 暴露；REST 侧 C3 返回 503。
2. 是否需要 `POST /v1/sessions/{sid}/recover` 显式重试入口，还是仅允许“新建会话”；若仅允许新建，S4 用户出口是否复用「历史只读新建会话」（见 `2026-08-03-session-lifecycle-convergence`）。
3. `FAILED` 会话的保留期与清理策略（已决策：**不进入自动删除/孤儿回收**，仅显式运维或保留期到期清理；DB 行保留、runtime 清理，见 §3）。
4. 后端 stderr 尾部长度上限与脱敏规则（避免把凭据写进错误帧）。
5. ~~WS close code 取值~~ → **已决策：不引入自定义 close code，统一 1011，分类靠 `error.code`**。
