## Context

`service/`（`/v1/videos`）经过 `harden-hyperframes-video-service` → `scale-multi-instance` → `phase3-multitenancy-temporal-lease` → `harden-video-service-impl-fixes` 多轮加固，其权威规范是 `openspec/specs/video-service-hardening.md`（R7–R20 + 实现修复不变量）。它是一套**无状态渲染农场**：任务短命、可互换、可被任意节点任意 worker 通过严格租约 + 栅栏令牌（R20 `lease_token`）安全重投，DB 终态写与对象存储产物写都被令牌栅栏保护。

OpenHarness 原生多轮对话（`oh` 交互式 REPL / React TUI 所对接的 backend-host）则是**长生命周期、有状态、单写者**：`QueryEngine` 内存态跨轮累积、绑定单一进程、快照落盘（`{cwd.name}-{sha1(resolve(cwd))[:12]}`）、支持 `--resume` 水化、compaction、工具流、交互式审批。

**关键洞察**：这两者的冲突不是成熟度问题，恰恰相反——`service/` 把「无状态可重投」做到极致，而这正与有状态会话对立。冲突点精确落在 `service/` 最引以为傲的 `lease_token` 栅栏上：栅栏只能保证「重投不产生有效*产物/终态*」，却**无法**栅住「不重复推进会话内存态」——会话推进本身是不可栅栏的副作用。因此不能把会话塞进 `service/`，需要第二套后端。

现有 openspec 变更 `add-multi-turn-conversation` 走的是改造上游 `run_print_mode`、把「多轮」降维成「多次一次性渲染」的路线——侵入上游、丢失实时流式/中断/审批。本设计以**零改动 OpenHarness** 取而代之。

事实来源：`openspec/specs/video-service-hardening.md`、`plans/Backend_Hardening_Fix_Plan_V3_2026-07-21.md`、`plans/Interactive_Session_Service_原生REPL多轮对话_2026-07-23.md`。⚠️ `plans/FastAPI_Hyperframes_Video_Service_3217f912.md` 仅为初版构想，勿参考。

## Goals / Non-Goals

**Goals:**
- 零改动 OpenHarness，直接作为原生 `oh --backend-only` backend-host 的客户端，提供有状态多轮对话。
- 真实时流式（delta/工具/todo/轮结束）、中断、交互式审批（interactive）、`full_auto` 默认无人值守。
- 会话生命周期与冷态水化（`--resume`）：空闲逐出、断线重连、崩溃隔离。
- 多节点会话亲和路由 + 单写锁；单写者轮串行（对齐原生 `_busy`）。
- 每轮 artifact 登记 + Range 下载，复用 `service/` 的 storage/parser。
- 安全/运维对齐 `video-service-hardening` 现状（allowlist、API-key→tenant、限流、隔离、健康探针、可观测、日志有界）。

**Non-Goals:**
- 不修改 `service/` 的 `/v1/videos` 语义、测试或 `video_tasks` schema。
- 不给会话引入 `lease_token` 式的重投/栅栏机制（有状态会话不可重投）。
- 不实现会话在节点间的进程热迁移（迁移 = 逐出到 COLD 再在目标节点 `--resume`）。
- 不改 OpenHarness 上游；`add-multi-turn-conversation` 的上游改造路径被取代。

## Decisions

### D1: 每会话 spawn `oh --backend-only` 子进程并桥接原生协议（方案 A）

**选择**：网关进程内 `SessionSupervisor` 为每个活跃会话持有一个 `oh --backend-only` 子进程；`ProtocolAdapter` 读 stdout 行、解析 `OHJSON:` 前缀事件、写 bare-JSON `FrontendRequest` 到 stdin。

**备选与否决**：
- **方案 B（改造上游 run_print_mode 成多轮）**：即 `add-multi-turn-conversation`。否决——侵入上游、需持续同步、丢失流式/中断/审批、把有状态硬塞进无状态请求。
- **方案 C（进程内直接 import QueryEngine 常驻）**：否决——把 OpenHarness 深度耦合进网关，崩溃不隔离、GIL/阻塞风险、随上游 API 漂移，且仍要自己复刻 backend-host 的协议编排。

**理由**：方案 A 复用官方已维护的 backend-host 协议（React TUI 同款），OpenHarness 视角零改动；子进程天然崩溃隔离；`--resume` 免费获得无损水化；协议是稳定的进程边界契约。代价是进程开销与协议解析，均可控。

### D2: 协议桥接细节

- **输出**：逐行读 stdout；`OHJSON:` 前缀行 → 去前缀 → `BackendEvent` 宽松解析（未知 `type` 透传/忽略）→ 映射为 WS 帧；非前缀行 → 追加会话日志流。
- **输入**：向 stdin 写单行 bare JSON `FrontendRequest`（`submit_line`/`interrupt`/`permission_response`/`question_response`/`shutdown`），无前缀。
- **事件映射**：`ready→session_ready`、`assistant_delta→delta`、`tool_call/tool_result→tool_start/tool_end`、`todo_update→todo`、`line_complete→turn_complete`、`modal_request→approval_request`、`error→turn_error`。
- **健壮性**：Adapter 对畸形行不崩，记日志继续；对真实 `oh` 跑契约冒烟测试（`scripts/`）兜底协议漂移。

### D3: 会话生命周期状态机

`CREATING → LIVE ⇄ IDLE → COLD → (--resume) → LIVE`，终态 `CLOSED/EXPIRED/FAILED`。
- `LIVE`：有子进程 + ≥1 WS。`IDLE`：有子进程无 WS，进入 `idle_grace_seconds` 倒计时。
- 逐出：超时或容量满 → `shutdown` 优雅退出 → `COLD`（快照留盘，`oh_session_id`/`workspace_path` 持久化）。
- 水化：重连 `COLD` → 抢 `session:lock:<sid>` → `oh --resume <sid> --backend-only`（原 `cwd`）→ `LIVE`。
- 崩溃：非我方发起的 stdout EOF → 当前轮 `FAILED` + `turn_error` → `COLD`，可重连水化（丢失至多一轮未快照的在途轮）。
- 超时：轮超 `turn_timeout_seconds` → 杀进程组（`start_new_session=True`，SIGTERM→SIGKILL）。

### D4: 多节点会话亲和路由（透明反向代理转发）

Redis `session:route:<sid>={node_id,pid,epoch}` 带心跳 TTL。连接时：本节点拥有→本地服务；**他节点拥有→在网关内做透明反向代理转发（transparent reverse proxy）到 owner 节点**；`COLD`→抢 `session:lock:<sid>` 再本地水化。单写锁保证同一 `cwd` 不被两节点并发 `--resume`。轮串行对齐原生 `_busy`：进行中再 `submit` → `busy`/`409`。

**已定**：跨节点一律采用**反向代理转发**，**不采用 `307` 重定向 + 客户端重连**。原则是对客户端保持透明——客户端始终连接统一的 `/v1/sessions/**`（含 WS），不感知也不需要知道 owner 节点。理由：路由/水化/逐出是纯服务端职责，重定向会把 owner 拓扑泄露给客户端并要求其实现重连/重放逻辑，增大客户端复杂度与竞态面。代价是网关需承担长连接代理成本；若未来该成本成为瓶颈，再单独评估客户端重定向方案，本设计不引入。

### D5: 数据模型与迁移隔离

`conversations`（`id`、`tenant_id` not null、`actor_key_id`、`oh_session_id`、`workspace_path`、`status`、`permission_policy`、`created_at`、`last_active_at`、计数/上限）、`conversation_turns`（`(conversation_id, turn_index)` 唯一、状态、usage、时间戳）、`turn_artifacts`（storage key + 探测元数据）。独立 Alembic 链（`alembic_version_session`），不碰 `video_tasks`/`service/` 迁移头。`(tenant_id, created_at)` 建索引。会话**无** `lease_token`（那是无状态重投机制）。

### D6: 安全/运维对齐现状（非初版）

复用 `service/`：`security.py`（allowlist + 取值校验，服务端固定注入 `--permission-mode/--cwd/--output-format/--api-key/--resume/--backend-only`）、`X-API-Key`→哈希查表→`tenant_id`（WS 握手 accept 前校验，401）、`ratelimit.py`（令牌桶 fail-open，429）、租户隔离（403/404）、`/healthz`+`/readyz`（异步 Redis 探针，503）、structlog/Prometheus/OTel、Redis Stream `MAXLEN~ approximate` + `XREVRANGE` 尾读。`Settings.api_key: SecretStr`；响应不泄露内部 storage key/path。

### D7: 部署形态

独立容器 `session-service`，与 `service/` 共享 Postgres/Redis（不同 db 号）/OpenHarness 基础镜像/快照共享卷（`OPENHARNESS_DATA_DIR`）。nginx 分流：`/v1/videos/**`→`service/`，`/v1/sessions/**` + WS→`session-service/`。多副本时会话亲和路由生效（跨节点由网关透明反向代理，见 D4）。

### D8: `oh_session_id` 以 `cwd` 推导为权威来源

**已定**：会话标识/快照目录**以 `cwd` 推导为权威来源**——由持久化工作区 `cwd` 直接算出 `{cwd.name}-{sha1(str(resolve(cwd)))[:12]}`，在 spawn `oh --backend-only` **之前**即可确定 `oh_session_id` 与快照目录，无需等待任何运行时事件。`state_snapshot`（或对应事件）仅用作**一致性校验**（回填时比对推导值，不一致则告警/以推导值为准），**不作为**首次建立会话标识的来源。

**理由**：`--resume` 依赖 `cwd`↔快照目录的确定性映射；以 `cwd` 推导可让 `oh_session_id` 在建会话时就落库，冷态水化与崩溃恢复不依赖「首个事件是否已到达」，消除了「进程崩溃在首个 `state_snapshot` 之前 → 无标识可 resume」的竞态。事件仅作校验，避免双来源不一致。

### D9: `add-multi-turn-conversation` 直接 archive-as-superseded

**已定**：本设计确定采用「原生 backend-host + `session-service`、零改动 OpenHarness」路线，故 `add-multi-turn-conversation`（改造上游 `run_print_mode` 把多轮降维成多次一次性渲染）**直接 archive-as-superseded**，不再维护两条实现同一能力的技术路线。若未来仍需要「多次独立调用组成的轻量交互」能力，应作为 **`/v1/videos` 之上的上层编排能力**另行设计，而**不是**继续维护对 OpenHarness 上游的改造。

## Risks / Trade-offs

- **原生 backend-only 协议漂移** → 事件字段/`type` 变化导致解析错位。缓解：宽松解析（未知字段/类型不崩）、对真实 `oh` 的契约冒烟测试、协议映射集中在单一 Adapter 便于修补。
- **在途轮丢失** → 崩溃/逐出时未快照的当前轮无法恢复。缓解：明确契约「至多丢一轮」，`turn_complete` 才落终态；重连按 `last_turn_index` 重放已完成轮。
- **进程资源膨胀** → 每会话一进程，高并发耗内存/FD。缓解：`max_live_sessions` + 最久空闲逐出、per-tenant 配额、TTL、`max_turns_per_session` 限快照增长。
- **僵尸进程/句柄泄漏** → 崩溃或超时残留。缓解：`start_new_session=True` 进程组整组 kill、DELETE 全量清理（进程/工作区/快照/Redis 路由锁日志）、启动时孤儿快照回收扫描。
- **单写锁竞争/脑裂** → 两节点争 `COLD` 水化。缓解：`session:lock:<sid>` 独占 + epoch 单调、心跳 TTL 过期回收、水化前校验路由。
- **共享卷一致性** → 多节点读写同一快照目录。缓解：会话与其 `cwd` 亲和到单节点，跨节点只经「逐出→他处 resume」串行切换，锁保护。
- **与 `add-multi-turn-conversation` 重叠** → 两条实现同一能力的技术路线并存造成困惑与维护负担。缓解：本变更取代其上游改造路径，`add-multi-turn-conversation` **archive-as-superseded**（见 D9），不再维护双路线。

## Migration Plan

1. **并行落地**：`session-service/` 独立目录、独立迁移链，不触碰 `service/`；`/v1/videos` 全程零回归（以其现有测试为门禁）。
2. **分阶段**（见 tasks.md）：Phase 0 骨架 + 单会话单轮直连 →  Phase 1 生命周期/水化/崩溃隔离 → Phase 2 审批/中断/artifact → Phase 3 多节点路由 → Phase 4 安全/多租户/可观测对齐 → Phase 5 部署/契约测试。
3. **上线**：先单副本（不需路由）验证协议与生命周期；再多副本开启亲和路由。
4. **回滚**：`session-service` 可独立下线，不影响 `service/`；nginx 撤除 `/v1/sessions/**` 分流即回退。数据表独立，回滚只需停用其迁移链（不 drop 亦无副作用）。

## Open Questions

（无。原三项跨节点 WS / `oh_session_id` 来源 / `add-multi-turn-conversation` 处置均已在 D4、D8、D9 中定稿。）
