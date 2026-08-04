# 设计说明：会话快照存储契约

> DRAFT · 2026-08-03 · 未实现代码

## 1. H3 取证结论：路径**未**错位（原假设撤销）

此前 H3 假设「oh 实际写 `/root/.openharness/data`，而 `tenant_store` 检查 `/tenants/{tenant}/openharness/data`」。取证后 **H3 被否定**。

### 1.1 spawn 注入的实际环境变量（直接证据）

`supervisor._tenant_env`（`supervisor.py:487-495`）无条件注入，两条 spawn 路径均使用（`supervisor.py:251` 创建路径、`supervisor.py:392` rehydrate/re-arm 路径）：

```
OPENHARNESS_CONFIG_DIR = tenant_store.local_config_dir(tenant_id)   # /tenants/{tid}/openharness
OPENHARNESS_DATA_DIR   = tenant_store.local_data_dir(tenant_id)     # /tenants/{tid}/openharness/data
```

`process.py:110-114` 以 `dict(os.environ)` 为底，再 `env.update(self._env_overrides)`，`create_subprocess_exec(..., env=self._build_env())`（`process.py:105`）——覆盖生效，无遗漏路径。

**运行时实测（容器内 `/proc/<pid>/environ`）**：

| 进程 | cwd | 实际 env |
|---|---|---|
| 存活 oh（tenant `test_01`，会话 `b35fd9b3…`） | `/workspaces/b35fd9b3-…` | `OPENHARNESS_CONFIG_DIR=/tenants/test_01/openharness`、`OPENHARNESS_DATA_DIR=/tenants/test_01/openharness/data`、`HOME=/root` |
| 受控新建会话 oh（tenant `test_02`，`c5e2c126…`，验后已删） | `/workspaces/c5e2c126-…` | `OPENHARNESS_DATA_DIR=/tenants/test_02/openharness/data` |

### 1.2 落盘位置佐证

- `/tenants/test_01/openharness/data/sessions/b35fd9b3-…-5f8e2671d0ed/latest.json`（29110 B，写于 `00:39:23`，turn 完成时刻）——oh 确实写进 **tenant staging**。
- 同一份对象已同步至 MinIO：`oh-tenants/tenants/test_01/openharness/data/sessions/b35fd9b3-…/latest.json`。
- 受控新建会话（0 turn）只生成 `/tenants/test_02/openharness/data/memory/c5e2c126-…`，**未**在 `/root/.openharness/data` 下产生任何条目。
- oh 侧解析遵循 env：`OPENHARNESS_DATA_DIR=/tmp/probe-data python -c "get_data_dir()"` 返回 `/tmp/probe-data`。

### 1.3 此前误判的来源

`/root/.openharness/data/sessions/c25fb15b-…-ebcd2fea9008`（空目录）的 inode 时间为：

```
Birth : 2026-08-03 01:58:40.495
Modify: 2026-08-03 01:58:40.495
```

而该会话唯一一次 resume spawn 发生在 `00:38:02`（容器日志 `spawning oh backend: cwd=/workspaces/c25fb15b-… resume=c25fb15b-…-ebcd2fea9008`）。相差 80 分钟，且 `01:58` 正是上一轮排障探针在容器内运行的时间窗——探针在**未注入 tenant env** 的情况下触发了 `get_project_session_dir()` 的 `mkdir` 副作用（`session_storage.py:59`）。

**结论：属于观测副作用，不是产品缺陷。**

### 1.4 定性

| 候选归因 | 判定 |
|---|---|
| session-service spawn 环境注入问题 | **否**。注入无条件、两路径一致、`/proc` 实测正确。 |
| oh backend 路径解析问题 | **否**。`get_data_dir()` 正确遵循 `OPENHARNESS_DATA_DIR`。 |
| 快照**存在性判据**与**写入时机**契约缺失 | **是**。见第 2 节，这才是本 change 的根因。 |

> 附带发现（需在实现期约束，不改变本次归因）：`get_project_session_dir()` 兼有 `mkdir` 副作用，任何"只想解析路径"的调用都会凭空造出空目录；配合 §2 的存在性判据即产生假阳性。

## 2. 根因：写入时机 vs 存在性判据

| 环节 | 现状 | 位置 |
|---|---|---|
| 快照写入 | 仅在 `save_session_snapshot` 时写 `latest.json` + `session-{id}.json`，由**成功完成的 turn** 触发 | `session_storage.py:63-100` |
| 目录创建 | `get_project_session_dir()` 解析即 `mkdir` | `session_storage.py:54-60` |
| 本地判据 | `any(base.glob(oh_session_id + "*"))`——**目录存在即为真**（假阳性根因） | `tenant_store.py:344-349` |
| 远端判据 | bucket 前缀下有任意对象（零字节占位也算命中） | `tenant_store.py:352-360` |
| 组合 | local 命中即返回 True，否则查远端 | `tenant_store.py:366-390` |

⇒ **空目录 = 假阳性"可恢复"**。本次故障中该假阳性甚至没机会发挥作用——re-arm 路径连判据都不查（`supervisor.py:360`），直接 `resume=True`。

**快照标记抽象（用户 2026-08-03 约束 3）**：判据 MUST NOT 绑定具体文件名（`latest.json` / `session-*.json`）。改为 `tenant_store.has_valid_snapshot(tenant_id, oh_session_id) -> bool`，内部自行理解"什么算一个合法快照标记"（本地 staging 存在非空的快照 marker 文件，或远端非空 marker 对象）；文件名/格式知识**只存在于 `tenant_store` 层**，recovery 决策层只消费布尔结果。⇒ **空目录/零字节占位 = 真阴性**，不再假阳性。

## 3. 恢复决策矩阵（本 change 的产品语义）

判据定义：
- `has_snapshot` := `tenant_store.has_valid_snapshot(tenant_id, oh_session_id)` 返回的布尔；该布尔内部代表“存在合法快照标记”（具体文件名/格式由 `tenant_store` 层封装，决策层不感知文件名）。
- `completed_turns` := `conversation_turns` 中 `status='completed'` 的行数（**不使用** `conversations.turn_count`，因失败 turn 也占号；本例 `turn_count=1` 而 `completed_turns=0`）。

| 编号 | `completed_turns` | `has_snapshot` | 决策 | 对外表现 |
|---|---|---|---|---|
| S1 | 0 | 否 | **fresh spawn**（不带 `--resume`） | 正常拉起；`resumable=true` |
| S2 | 0 | 是 | `--resume` | 正常恢复 |
| S3 | >0 | 是 | `--resume` | 正常恢复 |
| S4 | >0 | 否 | **恢复失败终态** | 不 spawn；会话置 `FAILED`/`recovery_failed`；REST `resumable=false`；WS 明确错误码后关闭。**禁止**自动 fresh spawn（会静默丢上下文） |
| S5 | 任意 | 是，但 spawn 仍失败 | 交由 `session-backend-failure-isolation` 处理 | 不属本 change |

本次故障会话 `c25fb15b` 落在 **S1**：`completed_turns=0` ⇒ 正确行为是 fresh spawn，而不是当前的无条件 `--resume`。若沿用 `turn_count>0` 判据则会被错误归入 S4，这正是必须改判据的原因。

## 4. 决策入口收敛

```
resolve_resume_decision(conv) -> {RESUME | FRESH | RECOVERY_FAILED}
        ▲                  ▲                    ▲
        │                  │                    │
  rehydrate()   create_session_from_existing()  history-switch / 未来路径
 (supervisor.py:666)     (supervisor.py:326)
```

约束：任何调用 `_spawn(..., resume=True)` 的地方都必须先经过该函数；`rehydrate` 内联的 `turn_count == 0` 分支（`supervisor.py:684-694`）随之删除/迁移。

**决策层归属（用户 2026-08-03 约束 2）**：`resolve_resume_decision` 及其配套服务 **MUST 抽成独立的 recovery policy/service 模块**（建议 `app/session/recovery.py` 或 `app/recovery/` 包），**不放在 `supervisor` 内**，避免 REST（`routers/sessions.py`）、WS（`routers/ws.py`）、gateway 重启对账（change 4）各自复制判定逻辑。该模块只依赖「`completed_turns` 计数」与「`tenant_store.has_valid_snapshot` 布尔」，保持无副作用、可纯单测。

## 5. 与 staging/MinIO 契约的关系

`session-tenant-isolation` 已规定 stage-in（含删除传播）先于后端启动、stage-out 在 turn 完成/驱逐/关闭/孤儿回收四个钩子执行。本 change 不改这些钩子，只补一条一致性要求：**判据必须在 stage-in 之后执行**，且 local 未命中时必须回落远端探测（现状已满足），避免 staging 被回收后误判 S4。

## 6. 开放问题

1. **恢复判据来源（已决策）**：短期**不引入冗余列**，以 `SELECT COUNT(*) FROM conversation_turns WHERE conversation_id=? AND status='completed'` 作为 `completed_turns` 的 source of truth（用户 2026-08-03 决策）。仅在压测证明热点路径成为瓶颈时，再评估物化 `completed_turn_count` / `last_snapshot_at` 并补 migration 回填。
2. **S4「以只读历史新建会话」出口（拆出为独立后续 change）**：由 `conversation_turns` 回放渲染历史、新会话不继承 oh 侧上下文的产品出口，已随「历史只读新建会话」整体移入 `2026-08-03-session-lifecycle-convergence`。
3. **`get_project_session_dir()` 的 mkdir 副作用是否拆分**为 `resolve_*`（纯）+ `ensure_*`（写）：属 oh 侧改动，可作为本 change 的可选任务。
4. **陈旧 `live` 状态收敛 + 历史只读新建会话（拆出为独立后续 change）**：`live` 会话在网关重启后收敛为 `COLD`、以及「从历史以只读方式新建会话」出口，均**不并入本 change**，已在 `2026-08-03-session-lifecycle-convergence` 单列草案。本 change 仅保证：即使仍是陈旧 `live`，决策函数也会按其真实 `completed_turns` / `snapshot` 给出正确 `FRESH/RESUME/RECOVERY_FAILED`，不依赖状态被预收敛。
