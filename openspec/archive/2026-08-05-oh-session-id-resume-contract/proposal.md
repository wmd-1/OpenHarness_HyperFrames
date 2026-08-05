# 方案：session-service 与真实 OpenHarness runtime 的 session_id 生命周期契约对齐

- 日期：2026-08-05
- 状态：**DONE / 已归档（2026-08-05）**（方案 A 已实现、真实栈 + 真实 LLM E2E 完整验证通过，spec delta 已合入主 `openspec/specs/interactive-session.md`）
- 分类：`session-service` ↔ `OpenHarness runtime` 跨组件契约修复（属 `interactive-session` 能力域的「冷启重连 / RESUME」子域）
- 关联缺陷：会话 `410d1bc7-b531-4b74-a84d-4c24707c8e14` 报 `backend exited during startup (exit=1)`（RESUME 场景，tenant `test_01`）

---

## 0. 背景（Background）

`session-service` 通过 `oh --backend-only --resume <id>` 把多轮历史交给真实 OpenHarness runtime 承载，会话被驱逐到 `COLD` 后，客户端重连由 supervisor 以相同的 `--resume <id>` 重新派生后端，实现「无损 RESUME」。

会话身份在两套代码里各有一套生成口径：

- **session-service 侧**：以 `cwd` 派生稳定身份 `oh_session_id = "{cwd.name}-{sha1(resolve(cwd))[:12]}"`，既作为快照**目录名**，又作为 `--resume` 入参，并通过环境变量 `OH_SESSION_ID` 注入后端进程。
- **OpenHarness runtime 侧**：后端启动时 `session_id = uuid4().hex[:12]`（随机），**从不读取 `OH_SESSION_ID`**，快照以该随机 id 落盘。

两边对「session_id 是什么」理解不一致，导致真实 `oh` 的 `--resume` 永远找不到快照。本方案在动手改码前，先把「注入外部 id 对 OpenHarness runtime 契约的影响」做完整评估（§2.3 / §2.4），再据此确定最小且安全的修复面。

---

## 1. 问题描述（Problem）

RESUME 场景下，真实 `oh` 后端以退出码 1 在 `ready` 之前自尽，supervisor 报 `backend exited during startup (exit=1)`。

**根因（已实证）**：

1. session-service 派生 `oh --resume 410d1bc7-b531-4b74-a84d-4c24707c8e14-63c1c29565d3`（tenant `test_01`，cwd `/workspaces/410d1bc7-...`）。
2. 真实 `oh`（`OpenHarness/src/openharness/ui/runtime.py:377`）`session_id = uuid4().hex[:12]`，随机生成、忽略 `OH_SESSION_ID`（全仓 `OpenHarness/src` grep `OH_SESSION_ID` = 0 命中）。
3. 快照落盘为 `session-b0ddc8dabccf.json` 与 `latest.json`，二者 `session_id` 均为随机值 `b0ddc8dabccf`。
4. `oh --resume <id>` → `load_session_by_id(cwd, id)`（`OpenHarness/src/openharness/services/session_storage.py:194`）只在 `<dir>/session-<id>.json` 或 `latest.json` 的 `session_id == id` 时命中。目录名（`410d1bc7-...-63c1c29565d3`）与文件内 `session_id`（`b0ddc8dabccf`）是**两套命名空间，永不相交** → `Session not found: 410d1bc7-...-63c1c29565d3` → `sys.exit(1)`。

**实证（容器内复现）**：

```bash
docker exec openharness-session bash -c '\
export OH_SESSION_ID=410d1bc7-b531-4b74-a84d-4c24707c8e14-63c1c29565d3 \
       OPENHARNESS_CONFIG_DIR=/tenants/test_01/openharness \
       OPENHARNESS_DATA_DIR=/tenants/test_01/openharness/data; \
/root/.local/bin/oh --backend-only --cwd /workspaces/410d1bc7-b531-4b74-a84d-4c24707c8e14 \
  --resume 410d1bc7-b531-4b74-a84d-4c24707c8e14-63c1c29565d3'
# => 打印：Session not found: 410d1bc7-b531-4b74-a84d-4c24707c8e14-63c1c29565d3，exit=1
```

Redis 诊断流 `oh:session:logs:410d1bc7-...` 为空（后端瞬间退出，无诊断输出）。

**为什么 stub 栈/e2e 没暴露**：stub 后端（`session-service/scripts/oh_backend_stub.py:264-265`）的 `--resume` 是**空操作**——仅重新发射 `ready` 并等待，从不调用 `load_session_by_id` 真实加载快照；它写 `latest.json` 仅为了让 session-service 的恢复分类器看到 `resumable: True`。因此 stub 栈的 resume 是「假成功」。真实 `oh` 的 resume 是**真加载**，于是暴露了契约不一致。

> 注：`supervisor.py:566-568` 注释称「Real OpenHarness ignores the extra var; harmless to production」——该假设在 **RESUME 场景不成立**，是本次缺陷的契约误判根源。

---

## 2. 当前契约分析（Contract Analysis）

### 2.1 session-service 侧

| 项 | 规则 | 位置 |
|---|---|---|
| `oh_session_id` 生成 | `derive_oh_session_id(cwd) = "{cwd.name}-{sha1(str(cwd.resolve()))[:12]}"`，在 spawn **之前**算出，无需等待运行时事件 | `session-service/app/session/process.py:209-220` |
| 目录命名 | 快照目录 = `OPENHARNESS_DATA_DIR/sessions/{cwd.name}-{sha1(resolve(cwd))[:12]}`，**与 `oh_session_id` 完全相等**（已验证：dir name == `get_project_session_dir(cwd)` 的 `<path.name>-<sha1[:12]>`） | `OpenHarness/.../config/paths.py:get_project_session_dir` |
| `--resume` 来源 | `BackendProcess.build_command`：`if self._oh_session_id: cmd += ["--resume", self._oh_session_id]`；`_oh_session_id = live.oh_session_id`，由 supervisor `_spawn` 经 `derive_oh_session_id(cwd)` 赋值 | `session-service/app/session/process.py`（build_command）+ `app/session/supervisor.py` |
| `OH_SESSION_ID` 注入 | `_tenant_env` 中 `env["OH_SESSION_ID"] = oh_session_id`（当 `oh_session_id` 存在时），与 `OPENHARNESS_CONFIG_DIR`/`OPENHARNESS_DATA_DIR` 一同注入 | `session-service/app/session/supervisor.py:573-574` |
| DB 持久化 | `ConversationSession.oh_session_id`（`String(256)`，`models.py:101` / `schemas.py:55`），在创建时写入 cwd-based id | `session-service/app/models.py`、`alembic/versions/001_*.py:30` |

### 2.2 OpenHarness runtime 侧

| 项 | 规则 | 位置 |
|---|---|---|
| `session_id` 生成 | `session_id = uuid4().hex[:12]`（随机，**忽略 `OH_SESSION_ID`**） | `OpenHarness/src/openharness/ui/runtime.py:377` |
| snapshot 保存 | `session_backend.save_snapshot(session_id=bundle.session_id)` → `save_session_snapshot(cwd, session_id, ...)` 写两份：`session-<session_id>.json` 与 `latest.json`（**同一份 payload，每次 save 覆盖**），二者 `session_id` 字段均 = 该 id | `runtime.py:689/720/753/764`；`services/session_storage.py:63-107` |
| resume 查找 | `run_repl(resume=...)` → `load_session_by_id(cwd, resume)`：先查 `<dir>/session-<resume>.json`，缺失则查 `latest.json` 且要求 `data["session_id"] == resume`（或 `resume=="latest"`）；否则 `SystemExit("Session not found: ...")` | `cli.py`（run_repl）、`services/session_storage.py:194-207` |
| list/展示 | `list_session_snapshots` 遍历 `session-*.json`，读其内 `session_id` 作为 `select_request` 选项 `value` | `services/session_storage.py:131-159`；`ui/backend_host.py:464` |

**契约缺口（一句话）**：session-service 用「目录名 / cwd-based id」作为 `--resume` 钥匙，真实 `oh` 却用「随机内部 id」锁住快照文件——钥匙与锁不在同一命名空间。

### 2.3 `session_id` 在 OpenHarness runtime 内部的用途（全量枚举）

把 `runtime.py:377` 改为读 `OH_SESSION_ID` 后，`session_id` 这一变量会在下列位置被使用。逐一定位确认其兼容性与副作用：

| 用途分类 | 位置 | 注入外部 id 后的行为 | 结论 |
|---|---|---|---|
| **snapshot 文件名** | `session_storage.py:104` 写 `session-<session_id>.json`；`:86` 写 `latest.json["session_id"]` | 文件名 = `oh_session_id`，与 `--resume` 同一命名空间 → RESUME 命中 | ✅ 正是修复目标 |
| **event metadata** | `protocol.py:189` `bridge_sessions[].session_id`；`backend_host.py:464` `select_request` 选项 `value=session_id`；`coordinator_drain.py:154` 保存快照用 `bundle.session_id` | 事件/选项携带稳定 id，前端/网关可按 id 关联；`--list` 展示的 `session_id` 与 resume 键一致（见 §2.2 list/展示） | ✅ 更一致 |
| **logging / tracing** | `engine/query_engine.py:151,167,183`（作为 `tool_metadata["session_id"]` 传入 auto_dream / session_memory 检查点）；`commands/registry.py:870` 日志打印 `Session ID: ...` | trace 用稳定 id，跨 RESUME 可关联同一会话 | ✅ 更利于排障 |
| **websocket / session correlation** | `bridge/work_secret.py:35` `build_sdk_url` 把 `session_id` 拼入 `session_ingress/ws/{session_id}` 路径（仅 bridge 子代理 / ingress 场景） | 路径含稳定 id，ingress 关联一致 | ✅ 仅 bridge 场景，session-service 默认不触发 |
| **其它持久化引用** | `commands/registry.py:2662` `get_session_memory_path(cwd, session_id)` → `<dir>/<safe_session>.md`；`engine/query_engine.py:_prepare/_update_session_memory` 写会话记忆文件 | 会话记忆按 cwd-based id 落盘（优于随机 id，记忆路径更稳定、可跨 RESUME 复用） | ✅ 正向改善 |
| **sandbox 容器名** | `docker_backend.py:72` `容器名 = "openharness-sandbox-" + session_id`（仅当 `settings.sandbox.enabled`） | cwd-based id 较长（见 §2.4 长度约束）→ **若 sandbox 启用可能超 Docker 容器名长度限** | ⚠️ 需验证（见 §2.4） |

> 结论：`session_id` 在 runtime 内**无其它硬编码的随机性依赖**（无「必须是 12 位 hex」的假设），所有消费点都把 `session_id` 当不透明字符串使用。注入外部 id 对表内各项均安全或正向；唯一需显式验证的是 sandbox 容器名长度（且当前栈默认不启用 sandbox）。

### 2.4 外部注入 id 是否满足原有约束

| 约束 | 评估 |
|---|---|
| **长度** | cwd-based id = `<cwd.name>(≤36)-<sha1[:12]>` ≈ 最长 49 字符。<br>• 文件名 / snapshot / JSON 值：无长度限制 ✅<br>• **Docker 容器名**：`openharness-sandbox-`(20) + 49 = 69 > Docker 63 字符硬限 → ⚠️ 仅当 sandbox 启用才会触发失败（见下方「验证闸门」） |
| **字符集** | `{name}-{hex}` 仅字母数字与 `-`，可作文件名/JSON 值 ✅；`get_session_memory_path` 另做 `safe_session` 转义（非安全字符→`_`），文件落盘完全安全 ✅ |
| **唯一性** | • 原生用户无 `OH_SESSION_ID` → 走 `or uuid4()`，唯一性不变 ✅<br>• session-service：id 由 cwd 派生，每个 conversation 独立 workspace cwd（`<sid>`），不同会话 id 不同 ✅<br>• 同 cwd 并发：session-service 单 conversation 单 live backend + busy 守卫，不会两后端同 cwd 并发 → 无冲突 ✅<br>• 跨租户：各 tenant 独立 data dir，快照按 data dir 命名空间隔离，id 不需全局唯一 ✅ |
| **并发启动多个 backend** | 仅在「同一 cwd 同时跑两个 backend」时 id 相撞；session-service 已用 busy 守卫禁止同一 conversation 并发 live backend，故不会触发。原生 oh 用户不注入 id → 各自随机 ✅ |
| **不可预测性 / 安全** | 旧 id 随机不可猜；新 id 含 `<cwd.name>-<sha1(cwd)>`。cwd.name 是 conversation sid（uuid，熵足够），sha1(cwd) 仅路径哈希（路径形如 `/workspaces/<uuid>` 不可由外部猜得）；且 `oh_session_id` 已通过 `GET /v1/sessions/{sid}` 暴露、并经受信内网通道作 `--resume` 入参，安全边界是 API key 而非 id 熵 → **无实质安全回归**（低风险备注） |
| **确定性** | 同 cwd 恒得同 id → 首次运行与后续 resume 运行 `session_id` 一致，快照连续（正是 RESUME 所需）✅ |

**验证闸门（实现前置条件）**：rollout 前确认 session-service 栈**未启用 sandbox**：`docker exec openharness-session env | grep -i sandbox` 应无 `OPENHARNESS_SANDBOX_ENABLED=1`（代码侧：`settings.sandbox.enabled` 默认 `False`，session-service 未注入该 env，grep = 0 命中）。若未来启用 sandbox，须在 `docker_backend.py` 内对容器名**本地截断**（保持 runtime 内 `session_id == OH_SESSION_ID` 不变，仅截断容器名），不破坏 resume 正确性。本 change 默认不启用 sandbox，故该闸门当前为通过。

---

## 3. 修复方案对比（至少两个）

### 方案 A（推荐）：OpenHarness runtime 支持 `OH_SESSION_ID`

将 runtime 的 `session_id` 来源改为 opt-in 读取环境变量：

```python
# OpenHarness/src/openharness/ui/runtime.py:377
session_id = os.environ.get("OH_SESSION_ID") or uuid4().hex[:12]
```

- **优点**
  - 改动最小（1 行），**保持 session-service 现有模型不变**（目录命名、`--resume` 来源、`OH_SESSION_ID` 注入早已就位）。
  - 与 stub 后端既有行为对齐——stub 早已 `sid = os.environ.get("OH_SESSION_ID")`，真实 `oh` 仅补齐同一契约。
  - 原生 `oh` 用户（未设 `OH_SESSION_ID`）走 `or uuid4()` 分支，**行为完全不变**，无回归（§2.4 已逐约束论证）。
  - 表内所有 `session_id` 消费点（§2.3）均兼容或正向。
- **风险**
  - 引入 runtime 对环境变量的依赖：经 §2.4 评估，字符集/唯一性/并发/安全/确定性均安全；唯一闸门是 sandbox 容器名长度（当前栈默认关闭，见 §2.4 验证闸门）。
  - 既存「旧随机 id 快照」的会话需在部署后做一次迁移（见 §6，幂等、可 `--dry-run`）。

### 方案 B：session-service 改为记录真实 `oh` 的 `session_id`

让真实 `oh` 把内部 `session_id` 通过启动事件（如 `state_snapshot` 携带 `session_id`）回传，session-service 捕获后持久化到 `ConversationSession.oh_session_id`，并以该真实 id 作为 `--resume` 入参。

- **优点**
  - 完全顺应 OpenHarness 现有行为（runtime 不改），session-service 以「真实 id」为唯一真相。
- **风险**
  - 需新增 `state_snapshot` 事件字段 + session-service 事件捕获 + DB 映射持久化（schema 已存 `oh_session_id`，但语义从「cwd-based」变为「runtime 回传」，迁移成本高）。
  - **鸡生蛋问题**：`--resume` 必须在 spawn **之前**确定（supervisor 注释明确要求 `derive_oh_session_id` 在 spawn 前算出），而真实 `session_id` 只能在后端启动**之后**才回传，无法用于当次 `--resume`。需引入「首次 spawn 不 resume、拿到 id 后写回、下次才 resume」的状态机，复杂度显著上升。
  - 实现与验证成本远高于 A，且不解决既存会话问题。

### 方案 C（重新评估：不纳入本次，列为独立候选 change）

> 原提案曾把「`load_session_by_id` 增加目录名兜底」列为 A 的可选互补加固。经重新评估，**改变 resume 语义、可能掩盖生命周期错误**，故从本次 change 移除，改作独立候选 change。

原设想：`load_session_by_id` 在 `session-<resume>.json` 缺失时，若 `<dir>` 名 == `resume` 且 `latest.json` 存在，则直接加载 `latest.json`（不论其 `session_id`）。

- **为什么不应并入本次修复**：
  - 它改变了 `load_session_by_id` 的语义——使 `--resume <dir>` 在 `latest.json.session_id != dir` 时仍能命中，**掩盖 session_id 生命周期错误**（若 A 漏改某路径，C 会静默兜底，反而隐藏 bug）。
  - 与 `--list` / `select_request`（`backend_host.py:464`）展示的 `session_id`（来自 `latest.json` 字段）**解耦**：用户在前端看到选项 `abc...`，resume 却按目录名加载另一个快照，造成「显示 id」与「实际加载键」不一致。
  - 本次方案 A + 迁移 M1 已让**新旧快照**都自洽（新快照直接一致；旧快照经 M1 重键后一致），C 不再是必需。
- **若确有历史兼容需求**：应作为**独立 change** 提出，明确标注「legacy compat only」，建议做成显式开关（如 `--resume-by-dir`）而非默认行为，并配套 spec + 测试，避免掩盖主链路错误。不在本 change 实现范围内。

---

## 4. 推荐方案及影响范围

**推荐方案 A**（OpenHarness runtime 支持 `OH_SESSION_ID`），理由：改动最小、不动 session-service、与 stub 契约对齐、原生用户零回归、可独立验证（§2.3/§2.4 已论证契约安全）。方案 C 不纳入本次。

**影响范围**：

| 维度 | 影响 |
|---|---|
| 代码改动 | 仅 `OpenHarness/src/openharness/ui/runtime.py:377`（opt-in 1 行）；可选修正 `supervisor.py:566-568` 注释误判（不改逻辑） |
| 镜像/部署 | 后端有 `-v src:/app/src` 挂载，`docker restart openharness-session` 即生效，**不重建镜像、不 `--build`** |
| 数据库/schema | **无变更**（`oh_session_id` 列已存在，语义保持 cwd-based 不变） |
| session-service | **无代码改动**（A 方案下）；既有单测 `test_supervisor.py:345`（验证 `--resume` 携带 `oh_session_id`）仍适用 |
| 原生 `oh` 用户 | 无 `OH_SESSION_ID` 时行为不变 |
| 新增构件 | **迁移脚本** `OpenHarness/src/openharness/tools/migrate_session_snapshots.py`（standalone，挂载进容器，`--dry-run` 支持，幂等，见 §6） |
| 兼容性闸门 | rollout 前确认 sandbox 未启用（§2.4 验证闸门） |
| 兼容性 | 向后兼容；仅既存「旧随机 id 快照」会话需一次性迁移（§6 M1） |

---

## 5. 技术设计（Technical Design）

### 5.1 主修复（方案 A）

文件：`OpenHarness/src/openharness/ui/runtime.py`，`run_repl` 起始处（约 `:377`）：

```python
# Before
session_id = uuid4().hex[:12]
# After  (opt-in: honor session-service's stable identity when present)
session_id = os.environ.get("OH_SESSION_ID") or uuid4().hex[:12]
```

- session-service 已注入 `OH_SESSION_ID = oh_session_id`（cwd-based）。修复后，`save_session_snapshot` 写出的 `session-<cwd-based-id>.json` 与 `latest.json` 的 `session_id` == cwd-based id（§2.2 已确认每 save 只覆盖写这两份）。
- 下次 RESUME：`--resume <cwd-based-id>` → `load_session_by_id` 命中 `session-<cwd-based-id>.json` → 恢复成功。
- 首次运行与后续 resume 运行均使用同一 `session_id`（env 在整次进程生命周期恒定），快照连续一致。

### 5.2 注释误判修正（建议，不改逻辑）

`session-service/app/session/supervisor.py:566-568` 注释改为：「`OH_SESSION_ID` 由真实 `oh` runtime 用于稳定快照身份（opt-in），RESUME 依赖该契约；stub 后端同样读取它。」

### 5.3 迁移脚本设计（方案 M1 落地）

文件：`OpenHarness/src/openharness/tools/migrate_session_snapshots.py`（standalone，`__main__` 可运行，随源码挂载进 `openharness-session`）。

行为（伪代码）：

```python
def rekey_data_dir(data_dir: Path, *, dry_run: bool) -> Report:
    sessions_root = data_dir / "sessions"
    for dir_path in sessions_root.iterdir():            # 每个 <dir> == oh_session_id
        if not dir_path.is_dir():
            continue
        target = dir_path / f"session-{dir_path.name}.json"
        latest = dir_path / "latest.json"
        # 幂等：已一致则跳过
        if target.exists() and _session_id_of(latest) == dir_path.name:
            continue
        # 重键 latest.json
        if latest.exists():
            data = json.loads(latest.read_text())
            data["session_id"] = dir_path.name
            if not dry_run:
                atomic_write_text(latest, json.dumps(data, indent=2))
        # 重命名旧的 session-<old>.json
        for old in dir_path.glob("session-*.json"):
            if old.name == target.name:
                continue
            new = dir_path / f"session-{dir_path.name}.json"
            if new.exists():
                # 以 mtime 较新者为准（latest.json 为权威最新，优先保留其对应文件）
                if old.stat().st_mtime <= new.stat().st_mtime:
                    continue
            embedded = json.loads(old.read_text())
            embedded["session_id"] = dir_path.name
            if not dry_run:
                atomic_write_text(new, json.dumps(embedded, indent=2))
                old.unlink()
        report.mark(dir_path.name, migrated=not dry_run)
    return report
```

- **放置位置**：`OpenHarness/tools/`（OpenHarness 仓库，随 `-v src:/app/src` 挂载），不进 runtime 热路径。
- **执行方式**：人工一次性，`docker exec openharness-session python /app/tools/migrate_session_snapshots.py --data-dir /tenants/<tid>/openharness/data [--dry-run]`。**不**在 backend 启动时自动执行（避免生产环境静默改数据）。
- **幂等保证**：先判定 `session-<dir>.json` 存在且 `latest.json.session_id == dir` 则跳过；重复执行安全。
- **多 tenant**：逐 tenant 传 `--data-dir` 执行；CI/单元可指向临时 tmp data dir。
- **失败处理**：若 `latest.json` 缺失/损坏 → 记录告警、跳过该 dir，不终止整体（该会话后续走 M2 冷启 FRESH 兜底）。

### 5.4 sandbox 长度闸门（前置验证，非代码默认路径）

- rollout 前 `docker exec openharness-session env | grep -i sandbox` 确认无 `OPENHARNESS_SANDBOX_ENABLED=1`。
- 若启用 sandbox：在 `docker_backend.py:72` 对 `_container_name` 本地截断（如 `openharness-sandbox-<session_id>[:63]`），**保持 runtime 内 `session_id == OH_SESSION_ID` 不变**，仅截断容器名，不影响 resume 正确性。本 change 默认不实现该截断（闸门当前通过）。

---

## 6. 数据迁移 / 兼容策略（Migration & Compatibility）

### 6.1 新会话

部署（restart）后新建会话：首个 turn 落盘即使用 cwd-based id，RESUME 直接成功，**无需迁移**。

### 6.2 既存「旧随机 id 快照」会话（如 `410d1bc7-...`）

这些会话的快照已以随机 id 落盘（`session-<random>.json` + `latest.json` 的 `session_id=random`）。修复后 `--resume <cwd-based-id>` 仍会因 `session-<cwd-based-id>.json` 不存在而失败。**必须迁移**（仅针对修复前落盘的快照）。

**是否必须迁移？** 仅对「修复前已落盘随机 id 快照」的会话必须；其余不需要。

**策略 M1（推荐）—— 按目录名重键（re-key）**：

目录名恒等于 `oh_session_id`（cwd-based，见 §2.1）。对 `<data_dir>/sessions/<dir>/` 下每个会话（详见 §5.3 脚本）：

1. 若 `session-<dir>.json` 已存在且 `latest.json.session_id == <dir>` → 跳过（已一致）。
2. 否则：
   - `latest.json`：原子改写 `session_id = <dir>`。
   - 对每个 `session-<old>.json`（`old != <dir>`）：重命名为 `session-<dir>.json` 并原子改写其内 `session_id = <dir>`；若 `session-<dir>.json` 已存在，以 mtime 较新者为准避免覆盖丢失。
3. 幂等：重复执行安全（步骤 1 先判定一致则跳过）；批量遍历全部 tenant 数据目录。

**具体处理用户所举例（`session-xxxxxxxx.json` 但 `latest.json.session_id` 不匹配）**：

- 迁移前：`sessions/<dir>/session-xxxxxxxx.json`（内 `session_id=xxxxxxxx`）+ `latest.json`（内 `session_id=xxxxxxxx`）。
- 迁移后：`sessions/<dir>/session-<dir>.json`（内 `session_id=<dir>`）+ `latest.json`（内 `session_id=<dir>`）。
- 修复后 `load_session_by_id(cwd, <dir>)` 命中 `session-<dir>.json` / 匹配 `latest.json.session_id`，RESUME 成功，**且不丢失既有历史**。
- 注：`save_session_snapshot` 每 save 只写 `latest.json` 与一份 `session-<sid>.json`（覆盖式，见 §2.2），故每个 dir 至多一份 `session-<old>.json`，重键简单无歧义。

**策略 M2（兜底，丢历史）—— 冷启转 FRESH**：

对无法/不愿迁移的会话（如 `latest.json` 损坏），删除其 stale 快照或令恢复分类器判定为 `RECOVERY_FAILED→FRESH`，以全新 spawn 继续（牺牲已落盘历史）。**仅在 M1 不可行时使用**。

### 6.3 向后兼容

- 原生 `oh`（无 `OH_SESSION_ID`）→ `or uuid4()` 分支，**完全旧行为**，无回归。
- `session-service` 无需修改，`--resume` 与 `OH_SESSION_ID` 语义不变。
- 数据库 schema 不变。
- 迁移脚本幂等、可 `--dry-run`、可回滚（重键前不改文件名，单文件原子写）。

---

## 7. 测试计划（Test Plan）

### 7.1 单元 / 契约测试（在既有 Docker 镜像内执行，禁宿主机直跑）

- **T1 `save_session_snapshot` 取 env id**：置 `OH_SESSION_ID=test-id-abc123`，调用 `save_session_snapshot(cwd=tmp, ...)`，断言产出 `session-test-id-abc123.json` 且 `latest.json` 的 `session_id == "test-id-abc123"`。
- **T2 `load_session_by_id` 命中 env id**：在 T1 产物上 `load_session_by_id(cwd, "test-id-abc123")` 非空；`load_session_by_id(cwd, "nonexistent")` 返回 `None`（回归保护）。
- **T3 无 env 时回退随机**：清空 `OH_SESSION_ID`，`save_session_snapshot` 仍产出 `session-<12hex>.json`（确认原生行为未变）。
- **T6 迁移幂等（新增）**：构造旧格式 dir（`session-<random>.json` + `latest.json(session_id=random)`），调用 `rekey_data_dir` 两次，断言：① 两次结果一致；② 第二次为 no-op；③ 迁移后 `session-<dir>.json` 存在且 `latest.json.session_id == dir`。

### 7.2 集成 / 真实栈验收（见 §8，需 `openharness-session` 挂载生效）

- **T5** 真实栈创建会话 → 完成 ≥1 turn → `docker restart openharness-session` → 重连 RESUME → 第二轮 turn 成功，且快照 `session_id` 与 `oh_session_id`（cwd-based）一致。

### 7.3 回归保护

- 既有 `test_supervisor.py:345`（验证 `--resume` 携带 `oh_session_id`）保持通过。
- 全量 `session-service/tests` 与 `OpenHarness` 既有 snapshot 测试（如 `test_session_storage*.py`）保持通过。

### 7.4 真实 OpenHarness 集成测试（禁用 stub，验证 session_id 契约）

> 现有 e2e stub 栈**已证明不能覆盖本问题**（stub 的 `--resume` 是空操作）。必须新增针对**真实 `oh` backend** 的测试。

- **前提栈**：使用真实 oh 后端栈——`docker compose -f docker-compose.yml up -d session`（**不带** `-f docker-compose.stub.yml`），需 `OH_PROVIDER_API_KEY` 可用（已完成网关级 key 三元组配置，见项目记忆）。
- **新增 E2E spec**：`design-agent-frontend/e2e/real-resume-session-id.spec.ts`（在既有前端 e2e 镜像内运行，不宿主机直跑）：
  1. REST 创建 session（真实栈）→ 记录 `sid` 与 `oh_session_id`（来自 `GET /v1/sessions/{sid}`）。
  2. WS `submit` 一轮（真实 LLM）→ 收 `turn_complete`（`has_artifact=true`）。
  3. 重启后端：`docker restart openharness-session` → 会话冷启。
  4. 重连 WS → supervisor 派生 `oh --resume <oh_session_id> --backend-only`，断言后端 `ready`、无 `backend exited during startup (exit=1)`。
  5. 第二轮 `submit` → `turn_complete` 到达，`GET /v1/sessions/{sid}/turns` 返回 ≥2 轮。
  6. 在容器内读快照断言（关键契约验证）：
     ```bash
     docker exec openharness-session bash -c '\
     export OPENHARNESS_DATA_DIR=/tenants/<tid>/openharness/data; \
     python3 - <<PY
     import json,glob,os
     d=os.environ["OPENHARNESS_DATA_DIR"]+"/sessions/<dir>"
     latest=json.load(open(d+"/latest.json"))
     assert latest["session_id"]=="<dir>", latest["session_id"]
     assert os.path.exists(d+"/session-<dir>.json")
     print("OK session_id == resume id ==", latest["session_id"])
     PY'
     ```
     即**快照内部 `session_id` 与 `--resume` 入参（= `oh_session_id`）一致**，证明 A 生效、无命名空间错配。
- 与既有 `real-multiturn-artifact.spec.ts` 互补：后者验证多轮 artifact 一致性，本 spec 专门验证 session_id 契约（此前 stub 栈无法覆盖）。

---

## 8. 真实栈验收场景（Real-stack Acceptance）

> 全部在已有 `openharness-session` 容器内 / 经其挂载验证；不重建镜像、不宿主机直跑。

### 8.1 正常 RESUME 验收

1. **创建 session**：`POST /v1/sessions`（带 tenant key）→ 取 `sid` 与 `workspace_path`（cwd）。记录后端 `oh_session_id = "{cwd.name}-{sha1(resolve(cwd))[:12]}"`（来自 `GET /v1/sessions/{sid}` 的 `oh_session_id` 字段）。
2. **完成至少一个 turn**：WS 连接并 `submit` → 收到 `turn_complete`（`has_artifact=true`）。
3. **重启 session-service / backend**：`docker restart openharness-session`（源码挂载，刷新 runtime.py 修复）。确认该会话被驱逐到 `COLD`（快照保留在 `OPENHARNESS_DATA_DIR/sessions/<oh_session_id>/`）。
4. **RESUME 同一 session**：重新 WS 连接 → supervisor 派生 `oh --resume <oh_session_id> --backend-only`，**后端成功 `ready`，不再 `exit=1`**。
5. **验证第二轮 turn 成功**：再次 `submit` → 收到第二个 `turn_complete`，`GET /v1/sessions/{sid}/turns` 返回 ≥2 轮，`turn_index` 递增。
6. **验证 snapshot / session_id 一致**：
   ```bash
   docker exec openharness-session bash -c '\
   export OPENHARNESS_DATA_DIR=/tenants/<tid>/openharness/data; \
   python3 - <<PY
   import json,glob,os
   d=os.environ["OPENHARNESS_DATA_DIR"]+"/sessions"
   for sd in glob.glob(d+"/*"):
       name=os.path.basename(sd)
       latest=json.load(open(sd+"/latest.json"))
       sid=latest.get("session_id")
       assert sid==name, f"MISMATCH dir={name} session_id={sid}"
       print("OK", name, "->", sid)
   PY'
   ```
   断言：每个快照目录名 == 其 `latest.json` 的 `session_id`（即 == `oh_session_id`）。

**验收通过标准**：步骤 4 后端 `ready`、步骤 5 第二轮 `turn_complete` 到达、步骤 6 快照 `session_id` 与 `oh_session_id` 完全一致（无 `MISMATCH`）。

### 8.2 失败 / 兼容验收（旧格式快照 + 新 runtime）（新增）

> 验证「A 单独不覆盖历史快照，必须经 M1 迁移」以及迁移后的兼容行为。

1. **构造旧格式快照**：在 `<data_dir>/sessions/<dir>/` 手工放置 `session-<random>.json` + `latest.json(session_id=<random>)`，模拟修复前落盘（**不跑 M1**）。
2. **仅 A、未迁移下 resume**：修复后 `oh --resume <dir>` → 仍 `Session not found: <dir>`（因 `session-<dir>.json` 不存在、`latest.json.session_id != dir`）→ 断言**失败符合预期**（证明 A 不掩盖历史不一致，迁移确属必需）。
3. **执行 M1 迁移**：`docker exec openharness-session python /app/tools/migrate_session_snapshots.py --data-dir <data_dir>`。
4. **迁移后 resume**：同 §8.1 步骤 4-6 → `ready` 成功、第二轮 turn 成功；断言 `session-<dir>.json` 存在且 `latest.json.session_id == <dir>`。
5. **再跑 M1 幂等**：重复执行迁移 → 断言为 no-op（已一致），证明幂等。

**验收通过标准**：步骤 2 仍失败（预期内）；步骤 4 resume 成功且快照一致；步骤 5 重复迁移无副作用。

---

## 9. 目标（Goals，IN scope）

1. 修复 RESUME 场景真实 `oh` 后端 `exit=1`（`Session not found`）。
2. 让真实 `oh` 的快照身份与 session-service 的 `oh_session_id` 同一命名空间（opt-in 读 `OH_SESSION_ID`）。
3. 真实栈下 RESUME 第二轮 turn 成功、快照 `session_id` 一致（§8.1）。
4. 旧格式快照经幂等迁移后也可 RESUME（§8.2）。
5. 原生 `oh` 用户与既有 stub 栈行为不变。
6. 提供可 `--dry-run`、幂等的迁移脚本（§5.3 / §6）。

## 10. 非目标（Non-goals，OUT scope）

- ❌ 不改动 session-service 调度 / `--resume` 生成逻辑（A 方案下无需改）。
- ❌ 不引入「runtime 回传 session_id → session-service 持久化」状态机（方案 B 明确否决）。
- ❌ 不修改数据库 schema / 新增迁移表。
- ❌ **不将方案 C（目录名兜底）纳入本次 change**：它改变 resume 语义、可能掩盖生命周期错误、与 `--list` 展示脱钩，列为独立候选 change，仅作历史兼容长期加固（§3 方案 C）。
- ❌ 不做 `stage_out` 后台化、busy 协议、前端改动（属其它 change）。
- ❌ 不重建基础镜像（仅挂载源码 + restart）。
