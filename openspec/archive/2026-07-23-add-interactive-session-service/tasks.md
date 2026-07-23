## 1. Phase 0 — 骨架与单会话单轮直连

- [x]1.1 创建 `session-service/`（与 `service/`、`web/` 平级）：`pyproject.toml`（复用 `service/` 依赖 + `websockets`/`uvicorn[standard]`/`sse-starlette`）、`app/` 包骨架
- [x]1.2 `app/config.py`：`Settings`（`api_key: SecretStr`、DB/Redis URL、`workspace_root`、`OPENHARNESS_DATA_DIR`、`max_live_sessions`、`idle_grace_seconds`、`session_ttl_seconds`、`turn_timeout_seconds`、`max_turns_per_session`、`permission_policy` 默认 `full_auto`、`node_id`）
- [x]1.3 `app/session/protocol.py`：定义 `BackendEvent`/`FrontendRequest` 的宽松 Pydantic 模型 + `OHJSON:` 前缀常量；未知 `type` 不报错
- [x]1.4 `app/session/process.py` `OhBackendProcess`：以 `start_new_session=True` spawn `oh --backend-only`，异步读 stdout 行、写 stdin 行、`shutdown()`/`kill_group()`
- [x]1.5 `app/session/adapter.py` `ProtocolAdapter`：解析 `OHJSON:` 行→事件、非前缀行→日志流；`submit_line`/`interrupt`/`shutdown` 编码为 bare-JSON 写入
- [x]1.6 `app/session/supervisor.py` 最小版：进程内注册表 `{sid: OhBackendProcess}`，创建/查询/关闭单会话
- [x]1.7 `app/routers/ws.py`：`GET /v1/sessions/{sid}/ws`，接受 `submit`→`submit_line`→流式回 `session_ready`/`delta`/`tool_*`/`turn_complete`
- [x]1.8 `app/main.py` + `app/routers/health.py`：装配 FastAPI、`/healthz`
- [x]1.9 冒烟：本地起服务，WS 单会话跑通「一次提交→流式增量→turn_complete」

## 2. Phase 1 — 数据模型、生命周期与冷态水化

- [x]2.1 `app/models.py`：`conversations`/`conversation_turns`/`turn_artifacts` SQLAlchemy 模型（`tenant_id` not null、`actor_key_id`、`oh_session_id`、`workspace_path`、`status`、`permission_policy`、计数/上限；`(conversation_id, turn_index)` 唯一；`(tenant_id, created_at)` 索引；会话无 `lease_token`）
- [x]2.2 `app/db.py` + `alembic/`：独立迁移链（`version_table=alembic_version_session`），首个迁移创建三表；验证不触碰 `video_tasks`/`service/` 迁移头
- [x]2.3 持久化工作区：`workspace_root/<session_id>` 跨轮不删除；`oh_session_id` **以 `cwd` 推导为权威来源**（spawn 前即算出 `{cwd.name}-{sha1(resolve(cwd))[:12]}` 并落库），`state_snapshot` 仅做一致性校验
- [x]2.4 生命周期状态机 `app/session/lifecycle.py`：`CREATING→LIVE⇄IDLE→COLD→(resume)→LIVE`、终态 `CLOSED/EXPIRED/FAILED`
- [x]2.5 空闲逐出：无 WS 超 `idle_grace_seconds`→`shutdown` 优雅退出→`COLD`（快照留盘，`oh_session_id`/`workspace_path` 持久化）
- [x]2.6 冷态水化：重连 `COLD`→`oh --resume <sid> --backend-only`（原 `cwd`）→`LIVE`，历史无损（至多丢一轮在途）
- [x]2.7 崩溃隔离：非我方 stdout EOF→当前轮 `FAILED`+`turn_error`→`COLD`；其他会话与网关不受影响
- [x]2.8 超时治理：轮超 `turn_timeout_seconds`→杀进程组（SIGTERM→SIGKILL）→标记 `timed_out`
- [x]2.9 每轮持久化：`turn_index` 单调、`turn_complete` 才落终态；`conversation_turns` 记录 usage/时间戳

## 3. Phase 2 — 单写者、审批、中断、Artifact

- [x]3.1 单写者：进行中再 `submit`→`busy` 帧 /（非 WS）`409`，不写第二个 `submit_line`（对齐原生 `_busy`）
- [x]3.2 交互式审批：`interactive` 下 `modal_request`→`approval_request`（带 `request_id`）；客户端 `approval`→`permission_response`/`question_response`；未答默认 300s→拒绝
- [x]3.3 `full_auto`（默认）：子进程 `--permission-mode full_auto`，不阻塞审批
- [x]3.4 中断：`interrupt` 帧→原生 `interrupt`→取消当前轮→`turn_complete` 反映中断
- [x]3.5 Artifact 登记：复用 `service/` 的 `locate_output_file`/`probe_mp4`，产物→`turn_artifacts`（storage key + 探测元数据）
- [x]3.6 Artifact 下载：`GET /v1/sessions/{sid}/turns/{idx}/artifact` 复用 `service/` 下载行为，支持 `Range`（start+end，206/`Content-Range`）
- [x]3.7 REST 面：`app/routers/sessions.py` 实现 `POST /v1/sessions`、`GET /v1/sessions/{sid}`、`DELETE /v1/sessions/{sid}`、`POST /v1/sessions/{sid}/turns`（非 WS 兜底）
- [x]3.8 DELETE 清理：杀进程/删工作区+快照+artifact+Redis 路由/锁/日志→`CLOSED`，保留已完成轮终态记录
- [x]3.9 重连重放：客户端带 `last_turn_index`→从 DB 重放此后已完成轮的 `turn_complete`→再接日志流尾部

## 4. Phase 3 — 多节点会话亲和路由

- [x]4.1 `app/session/registry.py`：Redis `session:route:<sid>={node_id,pid,epoch}` + 心跳 TTL 续约
- [x]4.2 连接路由：本节点拥有→本地；他节点拥有→**透明反向代理转发**到 owner（含 WS，不对客户端重定向）；`COLD`→抢锁再本地水化
- [x]4.3 单写锁 `session:lock:<sid>`：独占 + epoch 单调，防两节点并发 `--resume` 同一 `cwd`
- [x]4.4 容量治理：`max_live_sessions` 满→逐出最久空闲会话到 `COLD`；无可释放→`503`
- [x]4.5 孤儿回收：启动扫描无路由的残留快照/工作区，安全清理或标记

## 5. Phase 4 — 安全 / 多租户 / 限流 / 可观测（对齐 video-service-hardening）

- [x]5.1 `app/security.py`：复用 `service/` 的 `extra_oh_args` allowlist + 取值校验；服务端固定注入 `--permission-mode/--cwd/--output-format/--api-key/--resume/--backend-only`，违例 `422`
- [x]5.2 鉴权 `app/deps.py`：`X-API-Key`→哈希查表→`tenant_id`；缺失/无效/吊销/过期→`401`；WS 握手 accept 前校验
- [x]5.3 租户隔离：所有会话操作按 `tenant_id` 过滤；跨租户→`403`/`404`；`/healthz`/`/readyz`/`/metrics` 豁免
- [x]5.4 配额：per-tenant 并发/每日会话上限→`429`
- [x]5.5 限流 `app/ratelimit.py`：复用 `service/` 令牌桶（fail-open），`POST /v1/sessions` 与 WS 建连→`429`
- [x]5.6 `/readyz`：聚合 DB/Redis/进程池余量，任一不可用→`503`；Redis 探针用 `redis.asyncio` + 超时，不阻塞事件循环
- [x]5.7 可观测 `app/observability/`：structlog（结构化）+ Prometheus 指标 + OTel；响应不泄露内部 storage key/path
- [x]5.8 日志流有界：Redis Streams `XADD MAXLEN ~ N approximate=True`，尾读 `XREVRANGE ... COUNT N`

## 6. Phase 5 — 部署、契约测试与文档

- [x]6.1 `session-service/Dockerfile`：基于 OpenHarness 基础镜像（含 `oh` CLI），装 `session-service`
- [x]6.2 `docker-compose.yml`：新增 `session-service` 服务、快照共享卷（`OPENHARNESS_DATA_DIR`）、Redis 不同 db 号、健康检查
- [x]6.3 nginx 分流：`/v1/videos/**`→`service/`，`/v1/sessions/**` + WS→`session-service/`（WS upgrade 头透传）
- [x]6.4 协议契约冒烟：对真实 `oh --backend-only`/`--resume` 跑事件解析 + 生命周期端到端（`scripts/`）
- [x]6.5 单元/集成测试：协议解析、生命周期状态机、单写者、审批、中断、Range 下载、鉴权/隔离/限流、readyz 降级
- [x]6.6 回归门禁：确认 `service/` 现有测试全绿、`/v1/videos` 行为零变化
- [x]6.7 处置 `add-multi-turn-conversation`：**archive-as-superseded**（不再维护对上游的改造；若需轻量交互则作为 `/v1/videos` 上层编排另行设计），更新 README/部署文档说明双后端与分流
