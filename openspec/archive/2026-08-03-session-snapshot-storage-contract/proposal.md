# 会话快照存储契约（session-snapshot-storage-contract）

> 状态：**DRAFT（仅提案，未实现代码）** · 日期：2026-08-03

## Why

线上会话 `c25fb15b-7c25-4620-911b-1f3dd1f3988e`（tenant `test_02`）在 WS 重连时后端崩溃。取证结论：

**触发链（已确认事实）**

1. 网关进程于 `2026-08-03T00:37:14Z` 重启，内存态 live 表清空，但 DB 里该会话 `status` 仍为 `live`（陈旧状态）。
2. `00:38:02` 前端 WS 接入 → `ws.py` 走 “非 COLD、非 live” 的**再武装（re-arm）分支** → `supervisor.create_session_from_existing`。
3. 该函数在 `supervisor.py:360` **无条件** `await self._spawn(live, resume=True)`——它**完全不做快照预检，也不看 `turn_count`**（`rehydrate` 里的 `turn_count == 0` 回退逻辑在 `supervisor.py:684-694`，只服务 COLD 路径，本次未被执行）。
4. 该会话自 `2026-08-02 17:07` 建立以来 **从未完成过任何一个 turn**（`conversation_turns` 仅有 1 行，`turn_index=0, status=failed`，且发生在 `00:39:10`，即崩溃之后）。因此 oh 从未调用过 `save_session_snapshot`，`latest.json` 从来不存在，MinIO `tenants/test_02/openharness/data/sessions/**` 至今为空。
5. `oh --resume <id>` 找不到快照 → 退出码 1 → `BackendProcessError` → `_spawn` 抛出 → `live.adapter` 为 `None` → 下一步 `stream_turn` 在 `supervisor.py:759` `assert live.adapter is not None` 崩溃 → turn 记为 `failed`，`conversations.turn_count` 被抬到 1。

**由此暴露的结构性缺陷**

- **恢复决策没有单一入口**：`rehydrate`（有预检+回退）与 `create_session_from_existing`（无预检、硬编码 `resume=True`）语义分叉，同一个“恢复”动作走哪条分支取决于 DB 状态是否为 COLD。
- **快照存在性判据不可靠**：`tenant_store._has_local_snapshot`（`tenant_store.py:344-349`）为 `any(base.glob(oh_session_id + "*"))`，即**目录存在即算有快照**；而 oh 侧 `get_project_session_dir`（`session_storage.py:54-60`）在解析路径时就 `mkdir(parents=True, exist_ok=True)`，快照文件却只在 `save_session_snapshot`（`session_storage.py:63-100`，写 `latest.json` / `session-{id}.json`）时才落盘。空目录 ⇒ 假阳性“可恢复”。
- **`turn_count` 不是“有上下文”的可靠代理**：本例 `conversations.turn_count = 1` 而 completed turn 数为 0（失败 turn 也会占用序号）。用 `turn_count > 0` 判定“有上下文不可丢”，会把“从未成功过、本可安全 fresh spawn”的会话误判为“恢复失败”。
- **`resumable` 业务字段与真实恢复能力不同源**：`sessions.py:100-119` 仅在 `status ∈ {COLD, FAILED}` 且 `turn_count > 0` 时才查快照；本例 `status=live`（陈旧）直接返回 `resumable=true`，前端因此被引导去发起一次必然崩溃的连接。

**已排除的假设（H3 撤销）**：oh 后端写入路径与 tenant staging 路径**并不错位**，见 design.md「H3 取证」。此前报告中的 `/root/.openharness/data/sessions/c25fb15b-...` 空目录，`stat` 显示 `Birth: 2026-08-03 01:58:40`，是排障探针自身创建的产物，不是后端行为。

## What Changes

- 定义**会话快照存储契约**：谁写、何时写、写到哪、以什么判据认定“可恢复”，以及本地 staging 与 MinIO 权威源的一致性要求。
- 把“是否 `--resume`”收敛为**唯一决策函数**，所有拉起后端的路径（COLD rehydrate、re-arm、历史切换、gateway 重启对账）共用；该函数 MUST 置于**独立的 recovery policy/service 模块**（不在 `supervisor` 内），避免 REST/WS/gateway 各自复制判定。
- 明确**恢复语义矩阵**（本 change 的核心产品决策，不采用“快照缺失就静默 fresh spawn”）：
  - **无成功 turn**（completed turns = 0）→ 允许 fresh spawn（无上下文可丢，等价于新会话）；
  - **有成功 turn 且快照缺失** → 进入**恢复失败**终态，返回明确错误，**不自动降级、不静默丢上下文**；
  - **快照存在** → `--resume`。
- 用 **completed turn 计数**（`conversation_turns.status='completed'`）替代 `conversations.turn_count` 作为“有上下文”的判据。
- `resumable` 字段与恢复决策同源，覆盖陈旧 `live` 状态。
- 快照决策全链路可观测（决策值、原因、命中来源 local/remote）。

## Capabilities

### New Capabilities
- `session-snapshot-storage-contract`：快照写入/判定/恢复决策的统一契约。

### Modified Capabilities（本 change 落地时需同步的既有主规格）
- `session-tenant-isolation`：`has_session_snapshot` 的判据由“前缀存在”收紧为“快照文件存在”。
- `session-history-switch`：`resumable` 派生规则改为与恢复决策同源。

## Impact

- **代码**：`session-service/app/session/{supervisor,tenant_store}.py`、`app/routers/{sessions,ws}.py`；oh 侧仅需澄清契约（`get_project_session_dir` 的 mkdir 副作用是否保留），不强制改动。
- **数据**：短期**不新增**冗余列，`completed_turns` 直接以 `SELECT COUNT(*) FROM conversation_turns WHERE conversation_id=? AND status='completed'` 作为 source of truth（用户 2026-08-03 决策；见 design.md「决策：恢复判据来源」）。仅在压测证明热点路径成为瓶颈时，再评估物化 `completed_turn_count` / `last_snapshot_at` 并补 migration 回填。
- **兼容性**：判据收紧后，历史上“空目录假阳性”的会话会从 `resumable=true` 变为 `false`，属**修正**而非回归。
- **测试**：全部在既有镜像内执行（stub 后端栈 `docker-compose.yml + docker-compose.stub.yml`），禁止宿主机直跑、禁止重建基础镜像。

## Non-goals

- 不在本 change 内实现后端崩溃的错误隔离与 WS 错误码（→ `session-backend-failure-isolation`）。
- 不实现“无快照但想续接上下文”的重建方案（如从 `conversation_turns` 回放构造快照）——仅在 design.md 记为开放问题。
- 不改前端重连行为（→ `design-frontend-ws-bfcache-reconnect`）。
