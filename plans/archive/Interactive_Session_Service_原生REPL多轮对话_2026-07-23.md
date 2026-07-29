# 交互式会话后端（Interactive Session Service）设计计划 — 原生 OpenHarness 多轮对话

> **创建日期**：2026-07-23
> **状态**：设计草案（Design Draft）
> **定位**：本项目的**第二套后端架构**，与现有 `service/`（无状态视频渲染服务）并存、按需使用。
> **核心目标**：在**不修改 OpenHarness** 的前提下，原生支持 `oh` 的交互式 REPL 多轮对话（有状态、可续接、可流式、可中断、可审批）。
> **新建目录**：`session-service/`（与 `service/`、`web/` 平级）。
> **事实来源（OpenHarness 原生协议）**：`src/openharness/ui/backend_host.py`、`ui/app.py`、`ui/runtime.py`、`cli.py`、`services/session_storage.py`。
> **事实来源（现有 `service/` 当前架构，非初版草案）**：`openspec/specs/video-service-hardening.md`（R7–R20 + 实现修复不变量的权威来源）、`plans/Backend_Hardening_Fix_Plan_V3_2026-07-21.md`、已归档变更 `scale-multi-instance` / `phase3-multitenancy-temporal-lease` / `harden-video-service-impl-fixes`，以及实际代码 `service/app/{security.py, ratelimit.py, config.py, models.py}`、`service/app/workers/{scheduler.py, tasks.py, beat.py, runner.py}`、`service/app/storage/`、`service/app/observability/`。
> **⚠️ 勿参考初版**：`plans/FastAPI_Hyperframes_Video_Service_3217f912.md` 仅为**初版设计构想**，其后经 `scale-multi-instance` → `phase3-multitenancy-temporal-lease` → `harden-video-service-impl-fixes`（V3 加固）多轮演进，许多早期假设已失效。本计划所有关于 `service/` 的复用/对齐均以**当前代码 + video-service-hardening.md** 为准。

---

## 0. 为什么需要第二套后端（问题陈述）

### 0.0 现有 `service/` 的当前架构（已多轮加固，非初版）

现有 `service/` 经 `scale-multi-instance` → `phase3-multitenancy-temporal-lease` → `harden-video-service-impl-fixes`(V3) 多轮演进，**已是一套成熟的、可横向扩展的多租户无状态渲染农场**（权威定义见 `openspec/specs/video-service-hardening.md`）。当前已落地的关键能力（本计划据此对齐，勿按初版草案理解）：

- **多实例安全**：原子 `claim()`（R7 ownership）、心跳租约（R8）、幂等 reclaim（R9）、终态 CAS 守卫（`WHERE status='RUNNING' AND worker_id=:wid`）。
- **严格租约 + 栅栏令牌（R20）**：`lease_token BIGINT` 随 claim/reclaim 单调自增，DB 终态写与**对象存储产物写**双双被令牌栅栏，被抢占的旧 owner「无有效副作用」。
- **多租户（R14/R15/R16/R17/R18）**：`tenant_id` 列 + RLS/集中查询过滤、`X-API-Key`→（哈希查表）→`tenant_id`（`401`）、每租户配额（`max_concurrent`/`daily_submit_limit`→`429`）、`audit_log` 审计、每租户限流 + 全局令牌桶底线（`app/ratelimit.py`）。
- **可插拔调度器（R19）**：`OH_SCHEDULER_BACKEND`（`CeleryScheduler` 默认 / `TemporalScheduler`），入队走 `get_scheduler().enqueue(task_id, priority=...)`（**非** `delay()`）。
- **对象存储（R10）**：`VideoStorage` 抽象含 `presigned_url`，`S3VideoStorage` 流式 `upload_fileobj`/`StreamingBody`（不整对象入内存），下载默认 `302` 预签名。
- **可观测（R11）**：structlog(JSON, 绑定 `task_id`/`worker_id`)、Prometheus、OTel（可选）、`/healthz`(liveness) + `/readyz`(依赖 503)。
- **硬化细节**：`api_key: SecretStr`、响应隐藏 `output_path`、日志 Stream `MAXLEN` + `XREVRANGE` 尾读、SSE 用 `redis.asyncio` + 校验存在性、runner `start_new_session=True` + stdout 上限 + `timed_out`、`(created_at,status)` 复合索引（迁移 004）、瞬时错误→`TransientError` 触发重试。

### 0.1 为何仍与原生多轮对话冲突（架构性，而非成熟度问题）

**关键：冲突不是因为 `service/` 不够完善，恰恰相反——它已针对「无状态、可互换、可随意重投」这一模型做到极致，而这正与有状态会话对立。** `service/` 的核心不变量是：

- 每个 `VideoTask` 独立、无会话关联；`POST /v1/videos` 只接受一个 `prompt`。
- Celery worker「一次渲染一个子进程」：`oh -p <prompt>` 在**全新的 per-task workspace** 里跑完即退出，成功后**立即删除 workspace**（V3 的即时清理不变量）。
- 为横向扩展设计了 `claim()` 抢占 + `lease_token` 栅栏 + 崩溃 reclaim/重投——整套模型的正确性**建立在「任务短命、无状态、可互换、可在任意节点被任意 worker 重投而不产生有效副作用」之上**。

而 OpenHarness 的原生多轮对话（交互式 REPL）恰恰相反——它是**长生命周期、有状态、单写者、绑定单一进程**的会话：`QueryEngine` 把会话历史保存在**进程内存**里，一轮接一轮地累积上下文。把它塞进上述模型里是**根本性冲突**，且冲突点恰好落在 `service/` 最引以为傲的加固机制上：

- Celery 任务无法保持一个跨多轮存活的进程；`acks_late` + reclaim 重投会**重复执行有状态会话**——而 `lease_token` 栅栏只能保证「重投不产生有效*产物/终态*」，却**无法**保证「不重复推进会话内存态」（会话推进本身就是副作用，不是可栅栏的幂等写）。
- per-task workspace + 立即清理，会毁掉原生会话赖以续接的 `cwd` 与快照。
- 多副本抢占假设任务可在任意节点执行，但有状态会话必须**固定**在持有其内存态的那个进程/节点（亲和，而非可互换）。

**结论**：不能、也不应把有状态 REPL 硬塞进 `service/` 的无状态租约模型；应新建一套**为亲和长会话优化**的后端，但**沿用 `service/` 已验证的加固基线**（租户隔离/鉴权/配额/审计/限流/可观测/进程组治理），见 §11/§12。

### 0.2 已有 openspec 方案 `add-multi-turn-conversation` 的局限

已有的 openspec 变更 `add-multi-turn-conversation` 选择了**改造 OpenHarness**：让 `run_print_mode` 支持 `--resume/--continue`（恢复快照→跑一轮→存快照→打印 `session_id`），并改 `cli.py` 的路由。它把「多轮」降维成「多个共享 workspace + `oh_session_id` 的独立一次性渲染」，以贴合现有 Celery 模型。

它能工作，但有两处代价：

1. **必须修改 OpenHarness**（`ui/app.py` + `cli.py` + 新增 `session` 事件），侵入上游、增加与上游同步的维护负担。
2. 它并**不是**真正的交互式 REPL——没有实时流式增量、没有工具执行可视化、没有中断、没有交互式权限审批；每轮仍是「离线跑完再返回」。

本计划走另一条路：**用 OpenHarness 已有的原生 `--backend-only` 协议**，做一套有状态会话网关，**零改动上游**，且提供**完整的交互式 REPL 能力**。

---

## 1. 关键洞察（来自源码核对）

以下均已在 OpenHarness 源码中核实，是本设计成立的基石：

1. **`oh --backend-only` 就是原生 REPL 的后端**（`ui/app.py::run_repl(backend_only=True)` → `ui/backend_host.py::ReactBackendHost.run()`）。React TUI 本身也只是这个后端的一个前端（`react_launcher.py` spawn 出 `python -m openharness --backend-only` 再套一层 Ink UI）。**我们直接对接这个后端，等价于「自己写了一个前端」，行为与官方 TUI 完全一致。**

2. **它是长生命周期、有状态进程**：`ReactBackendHost` 内部持有一个 `RuntimeBundle`（含 `QueryEngine`），在一个 `while self._running` 循环里逐条读 stdin、逐条写 stdout，跨轮保留内存态。`_busy` 标志保证**单轮串行**（并发提交返回 "Session is busy"）。

3. **协议是「行分隔 JSON」**，已核实帧格式：
   - **输出（后端→前端）**：每个 `BackendEvent` 写成一行：`"OHJSON:" + event.model_dump_json() + "\n"`（`backend_host.py::_emit`，L844-854）。非 `OHJSON:` 前缀的行是诊断/日志噪声。
   - **输入（前端→后端）**：每行一个纯 JSON 的 `FrontendRequest`（**无前缀**），`FrontendRequest.model_validate_json(payload)`（`_read_requests`，L190-222）。

4. **`--resume <sid> --backend-only` 原生可用，无需改上游**：`cli.py` 的 `--continue/--resume` 分支会 `load_session_by_id/load_session_snapshot`，再调用 `run_repl(..., backend_only=backend_only, restore_messages=..., restore_tool_metadata=...)`（L2437-2496）。也就是说 `oh --resume <sid> --backend-only` 会恢复历史并进入 backend-host。**这正是我们做「进程逐出后重新水化（rehydrate）」所需的一切。**

5. **会话快照由 OpenHarness 自己持久化**：每轮结束 `handle_line` 调 `session_backend.save_snapshot(...)`（`runtime.py` L689-772），写到 `~/.openharness/data/sessions/<basename>-<sha1(cwd)[:12]>/{latest.json, session-<sid>.json}`，key 是 **cwd**。快照含 messages、usage、tool_metadata。**只要固定一个会话的 cwd，就能用 `--resume` 无损续接。**

6. **协议事件表（已核实）**：`ready` / `state_snapshot` / `transcript_item` / `assistant_delta` / `assistant_complete` / `tool_started` / `tool_completed` / `line_complete` / `compact_progress` / `todo_update` / `plan_mode_change` / `modal_request`（权限/编辑审批/提问）/ `select_request` / `error` / `shutdown`。
   请求事件：`submit_line` / `interrupt` / `permission_response` / `question_response` / `list_sessions` / `select_command` / `apply_select_command` / `shutdown`。

7. **交互式审批是原生能力**：非 `full_auto` 时，工具会触发 `modal_request`（`kind=permission|edit_diff|question`，带 `request_id`），后端 `await` 前端的 `permission_response/question_response`（`_ask_permission/_ask_edit_approval/_ask_question`，L762-842，300s 超时）。这是无状态渲染服务给不了的能力。

8. **也存在纯 Python API**（`build_runtime` + `handle_line` + `QueryEngine.submit_message`），可在进程内直接驱动。但见 §3 选型，我们**不选**进程内嵌入。

---

## 2. 目标与非目标

### 2.1 目标（In Scope）
- 新建 `session-service/`，提供**有状态、可续接**的多轮对话后端，行为对齐原生 `oh` REPL。
- **零改动 OpenHarness**：只作为 `oh --backend-only` 的一个客户端/前端。
- WebSocket 实时流式：增量文本、工具开始/结束、todo、错误、轮结束。
- 交互能力：中断（interrupt）、交互式权限审批（可选）、`full_auto` 自动模式（默认）。
- 会话生命周期：创建 / 续轮 / 列表 / 详情 / 删除；空闲逐出 + 断线重连自动水化（`--resume`）。
- 产物处理：每轮若产出视频/文件，登记为该轮 artifact，复用 `service/` 的解析与存储抽象。
- 与 `service/` 并存共用基础设施（同一 OpenHarness 基础镜像、Postgres、Redis、共享卷）。
- 资源与安全：会话数上限、空闲/总 TTL、轮超时、`extra_oh_args` 白名单 + 取值校验、**API-key 鉴权 + `tenant_id` 租户隔离（与 `service/` R14/R15 同语义，一等而非预留）**、限流。

### 2.2 非目标（Out of Scope，本期）
- 不改造 `service/` 的 `/v1/videos` 无状态语义（保持不变）。
- 不实现 openspec `add-multi-turn-conversation` 的 `run_print_mode` 上游改造（本方案取而代之）。
- 不做同一会话的并发多轮（原生就是单写者，串行）。
- 不做跨节点「热迁移」进行中的活会话（只在「冷」态经 `--resume` 于新节点水化）。
- 多租户**配额与审计（R16/R17）**：本期复用 `service/` 已有的 `quotas`/`audit_log` 同表与钩子（不重建）；若那些表尚未建立，则配额/审计的**完整落地**可随 `phase3` 能力到位后接入（但 `tenant_id` 隔离 + API-key 鉴权本期必须到位）。

---

## 3. 架构选型（三方案对比）

| 方案 | 做法 | 是否改上游 | 是否原生 REPL 保真 | 隔离/健壮 | 结论 |
|---|---|---|---|---|---|
| **A. 子进程 + 原生 backend-only 协议** | 每个活跃会话 spawn 一个 `oh --backend-only`，网关做协议桥接与 WS | **否** | **是**（就是官方 TUI 的后端） | **强**（进程级隔离，崩溃不影响网关） | **✅ 采用** |
| B. 进程内嵌入 | 网关进程内 `build_runtime()` 持有 `RuntimeBundle`，直接 `handle_line` | 否 | 是 | 弱（MCP/hooks/sandbox/浏览器工具都跑在网关进程内，一崩全崩；多会话共享 GIL/事件循环；强耦合上游内部 API） | ❌ 拒绝 |
| C. openspec 的 headless-resume 改造 | 改 `run_print_mode` + `cli.py`，多轮=多次一次性渲染 | **是** | 否（无实时流/中断/审批） | 中 | ❌ 拒绝（侵入上游、非真 REPL） |

**决策：方案 A。** 理由：

- **保真**：直接复用官方 TUI 所用的 `ReactBackendHost` 协议，多轮行为、会话快照、compaction、工具流、审批全部**与官方 REPL 一致**，不需要我们自己重实现会话语义。
- **零侵入**：不动 OpenHarness 一行代码，随上游升级几乎无缝（协议是稳定的 pydantic 模型）。
- **隔离**：每会话独立 OS 进程/进程组，一个会话的浏览器/ffmpeg/模型循环崩溃、超时、OOM 都可被网关捕获并单独回收，不波及其它会话与网关本体（延续 `service/` 已验证的进程组 SIGTERM/SIGKILL 治理思路）。
- **可续接**：进程逐出后靠原生 `--resume` 无损水化，快照由 OpenHarness 自己维护，我们只存 `oh_session_id` + 复用 `cwd`。

---

## 4. 总体架构

```
                         ┌────────────────────────────────────────────┐
   WebSocket / REST      │             session-service (新)            │
  ────────────────────▶ │                                              │
  Web 前端 / API 客户端   │  ┌───────────────┐   ┌────────────────────┐ │
                         │  │ Session Gateway│   │  Session Supervisor │ │
                         │  │ FastAPI + WS   │◀─▶│  (进程池/生命周期)   │ │
                         │  └───────┬───────┘   └─────────┬──────────┘ │
                         │          │  in-proc 事件总线      │ spawn/kill │
                         │          │                      ▼            │
                         │          │            ┌────────────────────┐ │
                         │          │            │ Backend-Host Adapter│ │  stdin/stdout
                         │          │            │ (OHJSON 协议桥接)    │◀┼──JSON行──┐
                         │          │            └────────────────────┘ │          │
                         │          ▼                                    │          ▼
                         │   ┌──────────────┐                      ┌─────────────────────────┐
                         │   │Session Registry│                    │ oh --backend-only        │
                         │   │(Postgres+Redis)│                    │  (每会话一个子进程/进程组) │
                         │   └──────┬────────┘                     │  QueryEngine 内存态       │
                         └──────────┼──────────────────────────────┤  cwd=workspace/<sid>     │
                                    │                               └───────────┬─────────────┘
                                    ▼                                           │ 每轮 save_snapshot
                    ┌──────────────────────────────┐              ┌────────────▼──────────────┐
                    │ Postgres (会话/轮/产物元数据)   │              │ 共享卷:                    │
                    │ Redis (路由表/心跳/事件流/锁)   │              │  workspaces/<sid>/         │
                    └──────────────────────────────┘              │  ~/.openharness/data/      │
                                    ▲                              │     sessions/<..>/         │
                                    │                              │  videos/ (产物, 存储抽象)   │
   ┌────────────────────────────┐  │                              └───────────────────────────┘
   │ service/ (现有无状态渲染)     │  │  共用 Postgres / Redis / 共享卷 / OpenHarness 基础镜像
   │  /v1/videos  Celery worker  │──┘
   └────────────────────────────┘
```

### 4.1 组件职责

1. **Session Gateway（FastAPI + WebSocket）**
   - REST：会话增删查（`/v1/sessions`）。
   - WebSocket：`/v1/sessions/{sid}/ws` 承载交互式一轮流（增量、工具、审批、中断、轮结束）。WS 是 REPL 的天然载体（双向、流式、长连接）。
   - 鉴权、CORS、限流中间件（复用 `service/` 的实现风格）。

2. **Session Supervisor（进程池 / 生命周期）**
   - 维护 `session_id → 活进程` 映射；负责 spawn / 健康检查 / 空闲逐出 / 优雅关闭 / 崩溃回收。
   - 全节点活会话数上限（`max_live_sessions`）；超限时 LRU 逐出最久空闲的冷会话（其快照已落盘，可随时水化）。
   - 每子进程用 `start_new_session=True` 自成进程组，逐出/超时用 `SIGTERM→SIGKILL` 打进程组（沿用 `runner.py` 的治理）。

3. **Backend-Host Adapter（协议桥接）**
   - 把网关内部的「意图」翻译成原生 `FrontendRequest`（写 stdin），把子进程 stdout 的 `OHJSON:` 行解析成 `BackendEvent`，再翻译成 WS 帧。
   - 逐行读 stdout：`OHJSON:` 前缀行→解析派发；无前缀行→当作诊断日志写入会话日志流（Redis）。
   - 处理 `modal_request`（审批/提问）：按策略自动应答或转发给 WS 客户端等待 `permission_response`。
   - 处理 EOF（子进程退出）：判定本轮失败并触发冷态/水化。

4. **Session Registry（Postgres + Redis）**
   - Postgres：会话/轮/产物的权威元数据（见 §7）。
   - Redis：`session:route:<sid> → {node_id, pid, epoch}`（带 TTL 心跳，做亲和路由与孤儿检测）、会话日志流（Redis Stream，复用 `service/` 的 `XADD/XREVRANGE` 模式）、单写锁。

5. **Storage / Parser（复用 `service/`）**
   - 复用 `VideoStorage` 抽象（local / S3）与 `parser.locate_output_file/probe_mp4`，把每轮产出的 mp4 登记为 artifact。

### 4.2 与 `service/` 的关系（并存 + 复用当前加固基线）

- 两套后端**独立进程/独立镜像入口**，共用：OpenHarness 基础镜像、Postgres、Redis、`workspaces`/`videos` 共享卷。
- **复用当前 `service/` 的实现（非初版）**：`app/storage/`（含 `presigned_url` + S3 流式）、`app/workers/parser.py`（`locate_output_file`/`probe_mp4`，含 fps 精度/temp-dir 排除修正）、`app/security.py`（`extra_oh_args` 白名单 **+ 取值类型/长度/元字符校验**）、`app/ratelimit.py`（Redis 令牌桶，fail-open）、`app/observability/`（structlog/metrics/tracing）、`app/config.py` 风格（`pydantic-settings`、`api_key: SecretStr`、`require_auth`）。多租户（`tenant_id`/API-key→租户/配额/审计）与 `service/` **共用同一套语义**（见 §11）。
- 前置 nginx/traefik 按路径分流：`/v1/videos/**` → `service/`；`/v1/sessions/**` + WS → `session-service/`。
- 数据库：**同一个 Postgres 实例，逻辑上独立的表**（`conversations`/`conversation_turns`/`turn_artifacts`），不改 `video_tasks`。用**独立 Alembic 迁移链**（独立 `version_table`，见 §7.3）。多租户表（`api_keys`/`quotas`/`audit_log`）若已由 `phase3-multitenancy-temporal-lease` 建立，则**共享复用**，不重复建表。

---

## 5. 目录结构（新建 `session-service/`）

沿用 `service/` 的布局风格；独立容器运行，包名用 `app`（与 `service/app` 无冲突，因不在同一 PYTHONPATH/容器）。

```
session-service/
  app/
    __init__.py
    main.py                  # FastAPI 入口 + 中间件 + 路由注册 + lifespan(启动 Supervisor)
    config.py                # pydantic-settings：DB/Redis/卷/进程池上限/TTL/权限策略/oh_bin
    db.py                    # async SQLAlchemy engine/session
    models.py                # Conversation / ConversationTurn / TurnArtifact ORM
    schemas.py               # REST + WS 帧的 Pydantic 模型
    deps.py                  # 依赖注入：DB、storage、supervisor、鉴权
    routers/
      sessions.py            # /v1/sessions/* REST
      ws.py                  # /v1/sessions/{sid}/ws WebSocket
      health.py              # /healthz (DB+Redis+进程池)
    session/
      supervisor.py          # SessionSupervisor：进程池、spawn/evict/reclaim、LRU、上限
      process.py             # OhBackendProcess：包装一个 oh --backend-only 子进程(读写/进程组/超时)
      adapter.py             # ProtocolAdapter：OHJSON<->内部事件、modal 审批、artifact 探测
      protocol.py            # 原生帧的类型别名/常量(OHJSON 前缀, 事件名) —— 只读镜像，不 import 上游
      registry.py            # Redis 路由表 + 心跳 + 孤儿检测
      lifecycle.py           # 空闲逐出/水化(resume)/冷热态状态机
    storage/                 # 直接复用/软链 service 的 storage 抽象(或以依赖方式引入)
    observability/           # 复用 service 的 logging/metrics/tracing 风格
    security.py              # extra_oh_args 白名单(复用 service 逻辑)
  alembic/                   # 会话相关表迁移
  alembic.ini
  pyproject.toml             # 复用 service 的依赖 + websockets
  README.md
```

> **代码复用策略**：`storage/`（当前含 `presigned_url` + S3 流式）、`parser`、`security.py`（当前含取值校验）、`ratelimit.py`、`observability/`、多租户中间件/鉴权与 `service/` 高度同构。落地时二选一：(a) 抽出一个共享内部包 `oh_common/`（推荐，长期干净，可同时被 `service/app` 与 `session-service/app` import）；(b) 短期直接拷贝并保持同步。本计划推荐先拷贝、Phase 后期再抽公共包，避免一开始就大改 `service/`。**务必拷贝当前版本而非初版**——尤其 `security.py` 的取值校验、`storage` 的 presigned/流式、`config` 的 `SecretStr`。

---

## 6. 会话生命周期（状态机 + 时序）

### 6.1 会话状态

`CREATING → LIVE → IDLE(有活进程但无 WS) → COLD(无活进程, 快照在盘) → (LIVE 经水化) → CLOSED/EXPIRED`

- **LIVE**：有活的 `oh --backend-only` 子进程 + 至少一个 WS 连接。
- **IDLE**：进程仍在，但无 WS 连接；超 `idle_grace_seconds` 后被逐出转 COLD。
- **COLD**：进程已回收，`oh_session_id` + `cwd` 快照仍在盘；下次连接经 `--resume` 水化。
- **EXPIRED**：超总 TTL 或被显式删除，清理 workspace/快照/产物。

### 6.2 创建首轮（`POST /v1/sessions`）
1. 生成 `session_id`；建 `workspace_root/<session_id>`（**持久**，不随轮删除）。
2. 在 DB 插入 `Conversation(status=CREATING)`。
3. 返回 `{session_id, ws_url, links}`（此时**不一定**立刻 spawn；可懒启动到首个 WS 连接或首轮）。

### 6.3 一轮对话（WebSocket）
1. 客户端连 `/v1/sessions/{sid}/ws`；网关经 Registry 做**亲和路由**（见 §8）。若无活进程 → Supervisor spawn `oh --backend-only`（或 `--resume` 水化）。
2. 等待子进程 `ready` 事件 → WS 回 `session_ready`。
3. 客户端发 `{"op":"submit","text":"..."}`。
4. Adapter 写 `{"type":"submit_line","line":"..."}` 到 stdin。
5. 子进程流式吐 `assistant_delta/tool_started/tool_completed/...` → Adapter 逐条转 WS 帧。
6. 轮结束 `line_complete` → Adapter：探测本轮 artifact（mp4）→ 登记 `TurnArtifact` → WS 发 `turn_complete{turn_index, artifacts, usage}`。
7. **单写者**：期间再发 `submit` → 网关直接 `409/`busy` 帧（对齐原生 `_busy`）。
8. `oh` 每轮自动 `save_snapshot`，`oh_session_id` 在首轮由 `ready`/`state_snapshot` 或首个快照落盘后捕获并持久化到 `Conversation`。

### 6.4 中断
- 客户端 `{"op":"interrupt"}` → Adapter 写 `{"type":"interrupt"}` → 子进程 cancel 当前轮 → 回 `line_complete` + 「Interrupted by user」transcript。

### 6.5 空闲逐出 & 水化（Cold rehydrate）
- WS 全断 + 超 `idle_grace_seconds` → Supervisor 向子进程写 `{"type":"shutdown"}`，优雅退出（快照已在盘），转 COLD，清 Registry 路由。
- 再次连接 COLD 会话：Supervisor spawn `oh --resume <oh_session_id> --backend-only --cwd <workspace/<sid>>`；原生恢复历史 → 继续。**至多丢失一个「进程被杀时正在进行、尚未存快照」的轮**，与官方 REPL 语义一致。

### 6.6 崩溃回收
- **子进程崩溃**：Adapter 读到 stdout EOF 且非我方 shutdown → 标记当前轮 `FAILED`、会话转 COLD、通知 WS `turn_error` 并允许重连水化。
- **节点崩溃**：Registry 心跳 TTL 到期 → 该节点所有会话在 Redis 路由中失效；下次任意网关收到该 `sid` 的连接时，在**本节点**水化（快照在共享卷，任何节点可读）。
- **单写锁**：水化前用 Redis 锁 `session:lock:<sid>` 确保全局只有一个活进程持有该会话，避免两个节点同时 `--resume` 同一 cwd 造成快照写竞争。

### 6.7 删除（`DELETE /v1/sessions/{sid}`）
- 杀活进程（若有）→ 删 `workspace/<sid>`、`~/.openharness/data/sessions/<..>`、所有轮 artifact、Redis 日志流/路由/锁 → DB 置 `CLOSED`，**保留**每轮终态记录（对齐 `service/` DELETE 语义）。

---

## 7. 数据模型（Postgres）

### 7.1 表：`conversations`
| 列 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | 会话 id（= session_id） |
| `title` / `summary` | text null | 首个用户消息摘要（可回填） |
| `status` | enum | creating/live/idle/cold/closed/expired |
| `workspace_path` | text null | `workspace_root/<id>`（COLD 仍保留） |
| `oh_session_id` | varchar null | 原生快照 id，用于 `--resume` |
| `model` / `permission_policy` | varchar | 使用的模型 / 权限策略(full_auto\|interactive\|plan) |
| `turn_count` | int | 已完成轮数 |
| `node_id` | varchar null | 当前活进程所在节点（COLD 时为 null） |
| `extra_oh_args` | text null | JSON 列表（受白名单 + 取值校验约束） |
| `tenant_id` | varchar **not null** | 多租户隔离键（对齐 R14）；所有会话查询/变更均按此 scope，跨租户访问 `403`/`404` |
| `actor_key_id` | varchar null | 创建该会话的 API key id（对齐 R15/R17 审计） |
| `created_at`/`updated_at`/`last_active_at`/`expires_at` | timestamptz | 生命周期 |

> **多租户不是「预留位」而是一等约束**：与当前 `service/`（R14）一致，`tenant_id` 由 `X-API-Key`→哈希查表解析注入（REST 中间件 + WS 握手），并加索引 `(tenant_id, created_at)` 支撑分租户列表。会话无 `lease_token`（那是无状态重投模型的机制）；会话的「单写」由亲和路由 + Redis `session:lock:<sid>` 保证（见 §8.2）。

### 7.2 表：`conversation_turns`
| 列 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | 轮 id |
| `conversation_id` | UUID FK → conversations | |
| `turn_index` | int | 从 0 单调递增 |
| `prompt` | text | 该轮用户输入 |
| `status` | enum | queued/running/succeeded/failed/canceled |
| `assistant_text` | text null | 该轮汇总回复（由 `assistant_complete` 累积） |
| `usage_json` | jsonb null | token/用量 |
| `error_message` | text null | |
| `started_at`/`finished_at` | timestamptz | |

索引：`(conversation_id, turn_index)` 唯一。

### 7.3 表：`turn_artifacts`
| 列 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | |
| `turn_id` | UUID FK → conversation_turns | |
| `kind` | varchar | video/file/image |
| `storage_key` | text | 存储抽象 key |
| `file_size_bytes`/`duration_seconds`/`resolution`/`fps` | | 视频 metadata（`probe_mp4`） |
| `created_at` | timestamptz | |

**迁移**：`session-service` 用**独立 Alembic 链**（独立 `version_table`，如 `alembic_version_session`），避免与 `service/` 的迁移头互相干扰；三张表全新、不触碰 `video_tasks`。首个 revision 前用 `alembic heads` 确认。

---

## 8. 并发、会话亲和与横向扩展

### 8.1 单写者（会话内）
原生 `ReactBackendHost._busy` 已保证一个会话同一时刻只跑一轮。网关在 WS 层再加一道：一轮进行中收到新 `submit` → 立即回 `busy` 帧，不透传。

### 8.2 会话亲和（跨节点）
有状态会话的内存态在**某个子进程**里，因此该会话的 WS 必须落到**持有该进程的节点**：

- **路由表**：Redis `session:route:<sid> = {node_id, pid, epoch, heartbeat_at}`（TTL 心跳）。
- **接入**：任一网关收到 `/v1/sessions/{sid}/ws`：
  - 查路由表：命中且节点存活 → 若是本节点，直接服务；若是他节点 → **反向代理/307 重定向**到该节点（内部地址）。
  - 未命中（COLD）→ 抢 `session:lock:<sid>` → 在本节点水化 → 写路由表。
- **单节点部署**：路由退化为「永远本地」，零额外成本。多节点时才启用代理/重定向。

### 8.3 容量与逐出
- `max_live_sessions`（每节点）；到达上限：优先逐出 IDLE 最久者转 COLD；仍无空间则新建 WS 排队或返回 `503`。
- 逐出仅回收进程，不丢数据（快照在盘）。

### 8.4 与 `service/` 扩展模型的分工
`service/` 保持「无状态 worker 随意扩缩」；`session-service` 用「亲和 + 冷态水化」。两者互不干扰，各自独立扩缩。

---

## 9. 原生协议桥接细节（Adapter 规格）

### 9.1 输出解析（子进程 stdout → WS）
- 逐行读取（`asyncio` 子进程 `stdout` reader）。
- 行以 `OHJSON:` 开头 → 去前缀 → `json.loads` → 得 `BackendEvent`；否则 → 视为诊断日志，`XADD` 到 `session:logs:<sid>`（不推给 WS，除非 debug 订阅）。

### 9.2 事件映射表（BackendEvent → WS 帧）
| 原生 `type` | WS `op` | 备注 |
|---|---|---|
| `ready` | `session_ready` | 携带初始 state/commands |
| `assistant_delta` | `delta` | 增量文本，逐条转发 |
| `assistant_complete` | `assistant` | 汇总文本，累积进 `turn.assistant_text` |
| `tool_started` | `tool_start` | tool_name + input |
| `tool_completed` | `tool_end` | output + is_error；触发 artifact 探测 |
| `todo_update` | `todo` | markdown |
| `plan_mode_change` | `plan_mode` | |
| `compact_progress` | `compact` | 压缩进度 |
| `state_snapshot`/`tasks_snapshot` | `state`（可选） | 前端状态，可按需转发 |
| `modal_request` | `approval_request` | 见 §9.4；或自动应答 |
| `error` | `error` | |
| `line_complete` | `turn_complete` | 轮结束；补 artifacts/usage |
| `shutdown` | `session_closed` | |

### 9.3 输入映射（WS → 子进程 stdin）
| WS `op` | 原生 `FrontendRequest` |
|---|---|
| `submit` | `{"type":"submit_line","line":text}` |
| `interrupt` | `{"type":"interrupt"}` |
| `approval` | `{"type":"permission_response","request_id":id,"allowed":bool}` / `{"...","permission_reply":str}`（edit_diff）/ `{"type":"question_response","request_id":id,"answer":str}` |
| `close` | `{"type":"shutdown"}` |

### 9.4 权限策略（`permission_policy`）
- **`full_auto`（默认，面向自动化）**：启动即 `--permission-mode full_auto`；`_ask_edit_approval` 直接返回 `always`，几乎不产生 `modal_request`。适合「一句话出视频」的无人值守场景。
- **`interactive`**：默认权限模式，`modal_request` 转成 WS `approval_request`，等客户端 `approval` 帧回填 `request_id`（300s 超时→拒绝）。这是相对 `service/` 的**新增能力**。
- **`plan`**：只读规划模式。

### 9.5 `oh_session_id` 捕获
首轮结束后读取共享卷 `~/.openharness/data/sessions/<basename>-<sha1(cwd)[:12]>/latest.json` 的 `session_id`（cwd 已知，可确定路径），或从 `state_snapshot`/首个 `session-*.json` 文件名解析，持久化到 `conversations.oh_session_id`。此后水化用 `--resume <oh_session_id>`。

> **注**：无需上游新增「session 事件」。快照文件是权威来源，路径可由 cwd 反推（`session_storage.get_project_session_dir` 的算法：`{cwd.name}-{sha1(str(resolve(cwd)))[:12]}`）。Adapter 内置同款纯函数做路径推导（只读镜像，不 import 上游）。

---

## 10. API 设计

### 10.1 REST
| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/v1/sessions` | 建会话（首轮可选内联）。Body: `{prompt?, model?, permission_policy?, extra_oh_args?, idempotency_key?}`。返回 `{session_id, ws_url, links}` |
| GET | `/v1/sessions/{sid}` | 会话详情 + 轮列表（按 `turn_index` 升序，每轮含 status/artifacts 下载链） |
| GET | `/v1/sessions` | 分页列表 |
| POST | `/v1/sessions/{sid}/turns` | **非 WS 的一轮**（同步/轮询式）：入队一轮，返回 `turn_index`；供不想用 WS 的客户端。busy 时 `409` |
| GET | `/v1/sessions/{sid}/turns/{idx}` | 轮详情/状态/产物 |
| GET | `/v1/sessions/{sid}/turns/{idx}/artifact` | 下载该轮产物（复用 `service/` 的 Range/206 流式下载） |
| GET | `/v1/sessions/{sid}/events` | SSE：非 WS 客户端的只读事件流（复用 Redis Stream 尾随） |
| DELETE | `/v1/sessions/{sid}` | 关闭并清理 |
| GET | `/healthz` | DB+Redis+进程池 |

### 10.2 WebSocket `/v1/sessions/{sid}/ws`
- 客户端→服务：`submit` / `interrupt` / `approval` / `close`。
- 服务→客户端：`session_ready` / `delta` / `assistant` / `tool_start` / `tool_end` / `todo` / `approval_request` / `error` / `turn_complete` / `session_closed` / `busy`。
- 断线重连：客户端带 `last_turn_index`，服务回放缺失的 `turn_complete`（从 DB）+ 从 Redis Stream 尾随继续。

---

## 11. 安全与资源限制（对齐 `service/` 当前加固基线，非初版）

> 本节要求全部**对齐 `openspec/specs/video-service-hardening.md` 的 R14–R18 与实现修复不变量**，把「无状态渲染」已验证的安全底线原样带到「有状态会话」。这些**不是预留**，是与 `service/` 同级的一等要求。

- **`extra_oh_args` 白名单 + 取值校验**：复用**当前** `service/security.py`——不仅校验 flag 名（`--permission-mode`/`--cwd`/`--output-format`/`--api-key` 等安全关键 flag 服务端固定/注入、客户端不可覆盖），还校验取值的类型/长度/shell 元字符（对齐 impl-fix 的「value-validation」不变量）；违规 `422`。
- **鉴权（R15）**：`X-API-Key` 中间件，哈希查表解析 `tenant_id`；缺失/无效/吊销/过期 → `401`。WS 握手同样校验（在 `accept` 前）。`/healthz`、`/readyz`、`/metrics` 豁免。`api_key` 全程 `SecretStr`，响应不泄漏内部路径/存储 key（对齐「responses MUST NOT leak internal paths」）。
- **租户隔离（R14）**：所有会话操作（list/get/create/turn/delete/download/ws）按 `tenant_id` scope；跨租户 `403`/`404`。worker/adapter 异步路径若直连 DB，参照 R14 的 `SET LOCAL app.current_tenant = :conversation.tenant_id` 绑定（tenant 取自会话行本身，非全局），保持 RLS 有效。
- **配额（R16）**：每租户 `max_live_sessions_per_tenant`（并发活/冷会话数）、`daily_session_limit`；超限 `429`。与节点级 `max_live_sessions`（容量保护）正交。
- **限流（R18 + 全局底线）**：复用 `app/ratelimit.py` 令牌桶（fail-open）：`POST /v1/sessions` 与每租户 WS 建连速率限流，`429`。
- **审计（R17）**：create/delete/turn 提交/轮终态转换 → 异步写 `audit_log`（`tenant_id`/`actor_key_id`/`action`/`target_id`/`ts`/`meta_json`），与 `service/` 共用同表。
- **进程沙箱**：可选启用 OpenHarness 自带 docker sandbox（`settings.sandbox`）或以受限用户/cgroup 运行子进程；每会话独立 workspace，避免越权访问。
- **资源上限**：`max_live_sessions`（节点级）、`idle_grace_seconds`、`session_ttl_seconds`、`turn_timeout_seconds`（超时打进程组，沿用 `runner.py` 的 `start_new_session=True` + `SIGTERM→SIGKILL` 治理）、`max_turns_per_session`（界定快照增长）。
- **WS 防护**：消息大小上限、每连接速率、背压（子进程流过快时对 WS 应用有界队列 + 丢弃/合并 delta 策略）。

---

## 12. 可观测性（复用 `service/observability` 当前实现）

- 复用 `service/app/observability`：structlog(JSON, 绑定 `session_id/turn_index/node_id/tenant_id`)、Prometheus metrics、OTel tracing（可选）。
- **健康探针对齐 R11 + impl-fix**：`/healthz` 恒为 liveness `200`；`/readyz` 汇总依赖（DB + Redis + 进程池水位），任一不可用 → `503`；Redis 探针用 `redis.asyncio`（带超时，勿阻塞事件循环）。
- 关键指标：`live_sessions{node}`、`turns_inflight`、`turn_duration_seconds`、`spawn_latency_seconds`、`rehydrate_total`、`eviction_total`、`subprocess_crash_total`、`ws_connections`、`approval_pending`。
- 每子进程的非 `OHJSON:` stderr/stdout 落 Redis Stream `session:logs:<sid>`（复用 `service/` 的 `XADD maxlen~10000 approximate` + `XREVRANGE` 尾读模式，防无界增长），供调试与审计。

---

## 13. Docker / 部署

**推荐：独立容器，共享基础设施（同一 compose）。**

- **镜像**：基于现有 OpenHarness 基础镜像（含 `oh`、chrome-headless-shell、hyperframes）再叠加 session-service 依赖（`fastapi`、`uvicorn[standard]`、`websockets`、`sqlalchemy[asyncio]`、`asyncpg`、`redis`、`pydantic-settings`、`sse-starlette`）。可与 `service/` 共用同一 Dockerfile 的不同 `entrypoint`。
- **进程模型**：不需要 Celery/beat。`session-service` 就是一个（或多个）`uvicorn` 进程 + 进程内 `SessionSupervisor`（在 FastAPI `lifespan` 启动）。它 spawn 的是 `oh --backend-only` 子进程，与 uvicorn 同容器同卷。
- **compose 增量**（在现有 `docker-compose.yml` 上）：

```yaml
services:
  session-service:
    image: openharness-base           # 复用同一镜像
    entrypoint: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
    working_dir: /opt/session-service
    depends_on: [postgres, redis]
    ports: ["8100:8100"]
    environment:
      - OHS_DB_URL=postgresql+asyncpg://oh:oh@postgres:5432/oh
      - OHS_BROKER_URL=redis://redis:6379/1        # 与 service 用不同 db 号
      - OHS_WORKSPACE_ROOT=/workspaces
      - OHS_VIDEO_DIR=/var/openharness/videos
      - OHS_MAX_LIVE_SESSIONS=32
      - OHS_IDLE_GRACE_SECONDS=600
      - OHS_PERMISSION_POLICY=full_auto
      - OPENHARNESS_DATA_DIR=/var/openharness/oh-data   # 会话快照共享卷
      - OH_BIN=/root/.local/bin/oh
    volumes:
      - ./session-service:/opt/session-service
      - oh-videos:/var/openharness/videos
      - oh-workspaces:/workspaces
      - oh-data:/var/openharness/oh-data      # 关键：快照卷跨节点/重启共享
      - openharness-config:/root/.openharness

  gateway:                                     # 可选：nginx 分流
    image: nginx:alpine
    depends_on: [session-service]              # 以及 service/ 的 api
    ports: ["80:80"]
    # /v1/videos/** -> api:8000 ; /v1/sessions/** + WS(Upgrade) -> session-service:8100
volumes:
  oh-data:
```

- **按需使用**：用 compose profile（`--profile render` / `--profile session` / 全开）选择起哪套后端；单机也可只起一个。
- **为何独立容器**：两套后端的扩缩模型、失败语义、资源画像相反（无状态 worker vs 亲和长会话）；隔离部署可避免一套抖动拖垮另一套，同时通过共享卷/DB/Redis 复用一切可复用的东西。

---

## 14. 测试策略（TDD）

- **单元**：
  - `adapter`：`OHJSON:` 行解析、事件映射、非前缀行归类；`FrontendRequest` 序列化。
  - `supervisor`：用**假 backend-host**（一个吐固定 `OHJSON:` 行的小脚本）验证 spawn/busy/interrupt/evict/rehydrate/EOF 崩溃回收、`max_live_sessions` LRU。
  - `registry`：路由写入/心跳过期/锁互斥。
  - `security`：`extra_oh_args` 白名单 `422`。
- **集成**：spawn **真实** `oh --backend-only`（mock provider 或极小 prompt），驱动一轮，断言 `ready→delta→line_complete`；再 `--resume` 水化断言历史续接；`interrupt` 生效。
- **端到端**：WS 两轮对话——第二轮 follow-up（如「把刚才的视频改短一点」）只有在续接了第一轮上下文时才成立；断言两轮各自 artifact + 第二轮确实 `--resume` 了同一 `oh_session_id`；断线重连回放。
- **回归**：确认 `service/` 全绿、`/v1/videos` 行为不变。

---

## 15. 分阶段实施计划

- **Phase 0 — 骨架 & 协议桥接（可跑通一轮）**
  - 建 `session-service/` 骨架、`config`、`OhBackendProcess`（asyncio 子进程 + 进程组）、`ProtocolAdapter`（OHJSON 解析/事件映射）。
  - `SessionSupervisor` 最小版（单节点、无逐出）。
  - WS `/v1/sessions/{sid}/ws`：create → spawn → submit → 流式 → turn_complete。
  - Gate：本地对真实 `oh --backend-only` 完成一轮流式对话。

- **Phase 1 — 数据模型 & REST & 多轮续接**
  - `conversations/conversation_turns/turn_artifacts` + 独立 Alembic。
  - REST 增删查 + 非 WS `/turns` + SSE。
  - `oh_session_id` 捕获、`workspace/<sid>` 持久化、每轮登记 turn/artifact。
  - Gate：同一活进程内连续多轮上下文正确；单写者 `409`。

- **Phase 2 — 生命周期：空闲逐出 + 冷态水化**
  - IDLE 逐出、COLD `--resume` 水化、崩溃 EOF 回收、`max_live_sessions` LRU、TTL/turn cap。
  - Gate：逐出后重连经 `--resume` 无损续接；子进程崩溃不影响网关与其它会话。

- **Phase 3 — 亲和路由 & 多节点**
  - Redis 路由表 + 心跳 + 单写锁 + 跨节点反代/重定向。
  - Gate：两副本下会话正确固定；节点故障后于新节点水化。

- **Phase 4 — 交互增强 & 安全 & 可观测**
  - 交互式 `approval_request`（permission/edit/question）、中断、背压。
  - 白名单 + 取值校验、**API-key 鉴权 + `tenant_id` 租户隔离（R14/R15）**、限流（R18）、metrics/tracing/日志流。
  - Gate：`interactive` 审批闭环；跨租户隔离生效（`403`/`404`）；限流/鉴权/指标齐备。

- **Phase 5 — 部署 & 文档 & 公共包抽取（可选）**
  - compose profile、nginx 分流、镜像 entrypoint。
  - 视情况抽 `oh_common/`（storage/parser/security/observability）供两套后端共用。
  - Gate：一条命令按需起任一/两套后端；`service/` 与 `session-service` 端到端并存。

---

## 16. 与 `openspec/changes/add-multi-turn-conversation` 的关系

- 本方案**取代**该 openspec 变更中「改造 OpenHarness `run_print_mode`/`cli.py`」的部分——因为原生 `oh --backend-only [--resume]` 已经满足全部需求，**无需动上游**。
- 若仍希望保留一个「无状态、多轮=多次一次性渲染」的轻量能力（贴合 `service/` 现有 Celery 模型、不引入长连接），可作为**备选并存**；但交互式 REPL 的完整体验由本 `session-service` 提供。
- 建议：将该 openspec 变更**改写**为面向 `session-service` 的新 capability（如 `interactive-session`），或标注 superseded；具体在实现启动前用 openspec 工具确认（本计划不改 openspec 文件）。

---

## 17. 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| 上游协议变更 | `BackendEvent/FrontendRequest` 若上游改字段 | 协议是稳定 pydantic 模型；Adapter 做宽松解析（忽略未知字段）+ 契约测试对真实 `oh` 跑冒烟 |
| 长连接/内存 | 活会话占内存（每进程一份 runtime） | `max_live_sessions` + LRU 逐出 + 冷态水化；容量按内存规划 |
| 亲和复杂度 | 跨节点路由/重定向增加复杂度 | 单节点部署可完全跳过；多节点才启用；用成熟的 Redis 路由 + 锁 |
| 水化丢失在进行中的一轮 | 进程被杀时未存快照的轮丢失 | 与官方 REPL 语义一致；`turn_error` 通知客户端可重发；关键轮可加「轮开始即落 DB」 |
| 与 `service/` 代码重复 | storage/parser/security 重复 | Phase 5 抽 `oh_common/`；短期拷贝并加同步测试 |
| WS 背压 | delta 过快压垮慢客户端 | 有界队列 + delta 合并 + 慢客户端断开保护 |

---

## 18. 成功标准

- [ ] 一条 WS 连接可与 `oh --backend-only` 完成**实时流式**多轮对话（增量文本 + 工具事件 + 轮结束），行为对齐官方 TUI。
- [ ] 第二轮 follow-up 明确复用第一轮上下文（同一活进程 or `--resume` 同一 `oh_session_id`）。
- [ ] 会话空闲被逐出后，重连经 `--resume` **无损续接**；子进程崩溃不影响网关与其它会话。
- [ ] 每轮产出的视频被登记为该轮 artifact 并可经 Range 流式下载。
- [ ] 单写者：一轮进行中的并发 `submit` 被拒（`busy`/`409`）。
- [ ] `interactive` 策略下权限/编辑/提问审批可经 WS 闭环；`full_auto` 默认无人值守可用。
- [ ] **OpenHarness 源码零改动**；`service/` 与其测试全绿、`/v1/videos` 行为不变。
- [ ] 两套后端可经 compose profile 按需/同时启动，共用 Postgres/Redis/共享卷/基础镜像。

---

## 附录 A：原生协议帧速查（已核对源码）

- 输出帧：`OHJSON:` + `BackendEvent.model_dump_json()` + `\n`（`backend_host.py::_emit`）。
- 输入帧：纯 JSON 一行 `FrontendRequest`（无前缀）。
- 关键请求：`submit_line{line}` / `interrupt` / `permission_response{request_id, allowed|permission_reply}` / `question_response{request_id, answer}` / `shutdown`。
- 关键事件：`ready` / `assistant_delta{message}` / `assistant_complete{message}` / `tool_started{tool_name, tool_input}` / `tool_completed{tool_name, output, is_error}` / `modal_request{modal:{kind, request_id, ...}}` / `line_complete` / `error{message}` / `shutdown`。
- 启动命令：`python -m openharness --backend-only --cwd <ws> [--model .. --permission-mode full_auto --resume <sid> ...]`（等价于 `oh --backend-only ...`）。
- 快照路径：`OPENHARNESS_DATA_DIR/sessions/{cwd.name}-{sha1(str(resolve(cwd)))[:12]}/{latest.json, session-<sid>.json}`。
