## Why

现有 `service/`（经 `scale-multi-instance` → `phase3-multitenancy-temporal-lease` → `harden-video-service-impl-fixes` 多轮加固的多租户无状态渲染农场）已把「任务短命、无状态、可互换、可在任意节点被任意 worker 重投而无有效副作用」这一模型做到极致，而这恰与 OpenHarness 原生多轮对话（交互式 REPL：长生命周期、有状态、单写者、绑定单一进程、`QueryEngine` 内存态跨轮累积）根本对立。已有的 openspec 变更 `add-multi-turn-conversation` 选择改造 OpenHarness 上游把「多轮」降维成「多次一次性渲染」，既侵入上游、增加同步负担，又给不出真正的实时流式 / 中断 / 交互式审批体验。

本变更新建**第二套后端** `session-service/`，在**零改动 OpenHarness** 的前提下直接对接其原生 `oh --backend-only` 协议，提供有状态、可续接、可流式、可中断、可审批的多轮对话，并**沿用 `service/` 已验证的加固基线**（租户隔离 / API-key 鉴权 / 限流 / 可观测 / 进程组治理），与 `service/` 并存、按需使用。

## What Changes

- 新建 `session-service/`（与 `service/`、`web/` 平级）：FastAPI + WebSocket 网关 + 进程内 `SessionSupervisor`，为每个活跃会话 spawn 一个 `oh --backend-only` 子进程并桥接原生 `OHJSON:` 行分隔协议。
- **零改动 OpenHarness**：只作为原生 backend-host 的一个客户端/前端（等价于官方 React TUI 所对接的后端），多轮语义、会话快照、compaction、工具流、审批全部由上游提供。
- 会话生命周期状态机：`CREATING → LIVE → IDLE → COLD(快照在盘) → 经 --resume 水化 → CLOSED/EXPIRED`；空闲逐出 + 断线重连自动水化（原生 `oh --resume <sid> --backend-only`）。
- WebSocket 实时流式（增量文本、工具开始/结束、todo、错误、轮结束）+ 中断 + 交互式权限审批（`permission/edit_diff/question`）+ `full_auto` 默认无人值守。
- 单写者语义（对齐原生 `_busy`）；会话亲和路由（Redis 路由表 + 心跳 + 单写锁）支持多节点。
- 每轮产出的视频/文件登记为该轮 artifact，复用 `service/` 的 storage 抽象与 parser。
- 新建 Postgres 表 `conversations` / `conversation_turns` / `turn_artifacts`（独立 Alembic 迁移链，不触碰 `video_tasks`）。
- 安全与运维**对齐 `video-service-hardening` 现状**：`extra_oh_args` 白名单 + 取值校验、`X-API-Key`→`tenant_id` 鉴权、`tenant_id` 租户隔离、令牌桶限流、`/healthz` liveness + `/readyz` 依赖探针、structlog/Prometheus/OTel、日志 Stream 有界。
- 独立容器，共享 Postgres/Redis/共享卷/OpenHarness 基础镜像；nginx 按路径分流（`/v1/videos/**`→`service/`，`/v1/sessions/**`+WS→`session-service/`）。

## Capabilities

### New Capabilities
- `interactive-session`: 有状态、多轮、可续接的交互式对话后端——原生 `oh --backend-only` 协议桥接、会话生命周期与冷态水化、WebSocket 流式一轮、单写者、交互式审批、会话亲和路由、每轮 artifact 登记，以及对齐 `service/` 加固基线的鉴权/租户隔离/限流/可观测。

### Modified Capabilities
<!-- 不修改 video-service-hardening 的任何 REQUIREMENT；`service/` 的 /v1/videos 无状态语义保持不变。新后端复用其已有的多租户/审计/限流/存储实现，但不改其 spec 行为。 -->
（无）

## Impact

- **新增代码**：`session-service/`（`app/main.py`、`config.py`、`db.py`、`models.py`、`schemas.py`、`deps.py`、`routers/{sessions,ws,health}.py`、`session/{supervisor,process,adapter,protocol,registry,lifecycle}.py`、`storage/`、`observability/`、`security.py`、`alembic/`、`pyproject.toml`）。
- **零改动**：OpenHarness 源码（`src/openharness/**`）、`service/` 的 `/v1/videos` 语义与其测试。
- **数据库**：同一 Postgres 实例新增三张会话表（独立 `version_table` 迁移链）；复用已有多租户表（`api_keys`/`quotas`/`audit_log`，若存在）。
- **基础设施**：`docker-compose.yml` 增加 `session-service` 服务与快照共享卷（`OPENHARNESS_DATA_DIR`），可选 nginx 分流；Redis 用不同 db 号。
- **依赖**：复用 `service/` 依赖 + `websockets`/`uvicorn[standard]`/`sse-starlette`。
- **上游依赖**：依赖原生 `oh --backend-only [--resume]` 协议（行分隔 JSON、`OHJSON:` 前缀）稳定；Adapter 做宽松解析 + 对真实 `oh` 的契约冒烟测试兜底。
- **取代关系**：取代 `add-multi-turn-conversation` 中改造上游 `run_print_mode` 的路径；该变更将 **archive-as-superseded**（不再维护对 OpenHarness 上游的改造；若未来需「多次独立调用组成的轻量交互」，则作为 `/v1/videos` 之上的上层编排能力另行设计）。
