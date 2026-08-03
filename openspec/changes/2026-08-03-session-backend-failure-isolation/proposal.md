# 会话后端故障隔离（session-backend-failure-isolation）

> 状态：**DRAFT（仅提案，未实现代码）** · 日期：2026-08-03

## Why

同一起故障（会话 `c25fb15b-…`，2026-08-03 00:38–00:39）暴露出：**后端拉起失败没有被隔离**，一次 spawn 失败演化成了服务端未捕获异常 + 断言崩溃 + 前端无信息可用。

已确认事实：

1. `_spawn` 在 `await self._await_ready(live)` 失败时进入 except，把 `live.state` 置为 `FAILED` 后 `raise`，但**未清理 `live.adapter` / `live.process`，也未把 `live` 从 `self._sessions` 移除**（`supervisor.py:364-423`）。异常沿 `create_session_from_existing`（`supervisor.py:360`）→ `ws.py:274` 冒泡。
2. `ws.py` 的再武装分支只捕获 `CapacityFullError | PoolAdmissionError | TenantStoreError`（`ws.py:273-279`），`BackendProcessError` 不在其列 ⇒ **ASGI 未捕获异常**，容器日志出现完整 traceback，WS 以协议异常方式断开，客户端拿不到结构化 `error` 帧与语义化 close code。
3. 半初始化的 live 残留后，下一步 `stream_turn` 在 `supervisor.py:759` 以 `assert live.adapter is not None` 崩溃——**用 `assert` 承担运行时校验**（同类断言另见 `supervisor.py:442 / 932 / 1031`）。生产环境若以 `python -O` 运行，断言会被剥离，退化为 `AttributeError`。
4. 这次失败被记为一条真实 turn（`conversation_turns`：`turn_index=0, status=failed`，耗时 30 ms），并把 `conversations.turn_count` 抬到 1。**基础设施级恢复失败污染了业务 turn 计数**，进而影响一切以 `turn_count` 为判据的逻辑。

## What Changes

- **状态一致性**：spawn 失败后 MUST NOT 留下半初始化 live；要么完全回滚（从注册表移除、槽位归还、`adapter/process` 置空），要么以显式 `FAILED` 终态存在且任何取用 adapter 的入口都拒绝服务。
- **消灭运行时断言**：`stream_turn` 等对外入口用显式检查 + 领域异常替代 `assert`。
- **结构化错误出口**：后端拉起失败 → WS 先发 `error` 帧（含可区分 `code` 与安全的 `detail`），再以语义化 close code 关闭；REST 侧返回对应状态码。
- **错误分类**：至少区分「容量/准入失败」「租户存储不可用」「后端启动失败」「恢复失败（无快照但有上下文，来自 `session-snapshot-storage-contract` 的 `RECOVERY_FAILED`）」。
- **不污染业务计数**：恢复/启动失败 MUST NOT 创建 `conversation_turns` 行，MUST NOT 递增 `turn_count`。
- **诊断信息**：把后端 stderr 尾部（脱敏、限长）纳入服务端日志与错误 `detail`，避免只剩 `exit=1`。
- **止损**：同一会话连续恢复失败 MUST 收敛到终态并让 `resumable=false`，防止前端重连风暴反复触发崩溃。

## Capabilities

### New Capabilities
- `session-backend-failure-isolation`：后端拉起/恢复失败的状态回滚、错误分类、WS/REST 出口与计数保护。

### Modified Capabilities（落地时需同步）
- `session-ws-protocol`：新增/明确恢复失败与后端启动失败的 close code 与 `error` 帧字段。
- `interactive-session`：失败 turn 与恢复失败的区分。

## Impact

- **代码**：`session-service/app/session/supervisor.py`（`_spawn`、`stream_turn`、断言点）、`app/routers/ws.py`（异常捕获集合与关闭码）、错误码常量表。
- **协议**：WS **不引入自定义 close code**，后端启动失败与恢复失败统一以 `1011`（server error）关闭连接，错误分类通过 `error` 帧的 `code` 字段（如 `BACKEND_START_FAILED` / `RECOVERY_FAILED`）承载；REST 侧恢复失败返回 **409 Conflict**（用户 2026-08-03 决策，不采用 422）。前端在 `design-frontend-ws-bfcache-reconnect` 中据此 `code` 区分并展示。
- **依赖顺序**：本 change 的“恢复失败”语义**依赖** `session-snapshot-storage-contract` 定义的决策结果；两者可并行设计，实现建议先 1 后 2。
- **测试**：既有镜像 + stub 栈内执行；stub 后端需支持“启动即失败”的确定性注入。

## Non-goals

- 不定义快照存在性判据与恢复语义矩阵（属 change 1）。
- 不做自动重试/自愈（失败即终态，重试策略另议）。
- 不改前端重连触发时机（属 change 3）。
