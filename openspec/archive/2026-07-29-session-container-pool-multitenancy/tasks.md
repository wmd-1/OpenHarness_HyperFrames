# Tasks: session-container-pool-multitenancy

> 分四个阶段（P1=WS-A 认证 → P2=WS-B 数据隔离 → P3=WS-C 容器运行时 → P4=WS-D 池化调度），每阶段独立可交付/可回滚。所有测试遵循 `test-on-existing-images` 规则：pytest 在主镜像容器内执行（`docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest ..."`），不重建主镜像。

## 1. WS-A 多 key 租户认证（P1）

- [x] 1.1 新增 alembic `002_api_keys.py`：`api_keys(id uuid PK, key_hash unique not null, tenant_id str not null index, label, active bool default true, created_at)`；可 downgrade；在容器内验证 `alembic upgrade head` / `downgrade -1` 幂等
- [x] 1.2 `app/models.py` 增加 `ApiKey` 模型（不触碰既有三表）
- [x] 1.3 `app/security.py` 新增统一解析函数 `resolve_tenant(provided) -> (tenant_id, actor_key_id) | None`：开放模式 → 单 key 常数时间比对（`default`）→ `sha256` 查表（仅 `active`）；进程内 TTL 缓存（`OH_APIKEY_CACHE_TTL` 默认 60s）
- [x] 1.4 `app/main.py` REST 中间件与 `app/routers/ws.py::_ws_authed`、artifact-GET `?api_key=` 路径改用 `resolve_tenant`；`request.state.tenant_id/actor_key_id` 按解析结果填充
- [x] 1.5 `scripts/manage_api_keys.py`（create/revoke/list，直连 DB，打印一次性明文 key，仅存 hash）
- [x] 1.6 测试（容器内）：多 key 各归各租户、跨租户 404、revoke 后 TTL 内/外行为、单 key 兼容不变、开放模式不变、WS 握手多 key；全量既有测试保持绿

## 2. WS-B 租户数据隔离（P2，rev2：MinIO 权威源 + stage-in/stage-out）

- [x] 2.1 `app/config.py` 新增 `minio_endpoint/minio_access_key/minio_secret_key/minio_bucket`（`OH_MINIO_*`，bucket 默认 `oh-tenants`）、`tenants_root: Path = /tenants`（暂存）、`apikey_cache_ttl`；`tenant_max_concurrent` 默认改为 **1**；compose 新增 `minio` 服务（官方 `minio/minio` 镜像 + named volume + healthcheck）与 `oh-tenants` 暂存卷挂到 session 服务 `/tenants`；`.env.example` 增补
- [x] 2.2 `pyproject.toml` 增加 `minio` SDK（同 3.1 方式装入容器，不重建主镜像）；新增 `app/session/tenant_store.py`：per-tenant `asyncio.Lock`、`stage_in(tenant_id)`（bucket 前缀镜像到暂存、删除传播、MinIO 不可达抛错 → 路由层 503 fail-fast）、`stage_out(tenant_id)`（暂存镜像回 bucket、删除传播、指数退避重试 + `tenant_sync_failures_total` 指标）、首见租户幂等种子化 `openharness/settings.json`、本地路径前缀校验工具（resolve 后必须位于 `/tenants/{tid}/`）；SDK 调用一律经 threadpool
- [x] 2.3 核实 OpenHarness local-rules 发现路径（`plugins/loader.py` 等）并定死 D2.3 拷贝目标；`create_session` 时将暂存内 `rules/` 拷入会话 workspace（per-session 快照语义）
- [x] 2.4 `OhBackendProcess` 支持注入 env（`OPENHARNESS_CONFIG_DIR`/`OPENHARNESS_DATA_DIR` → 租户暂存目录）；supervisor 在 create/rehydrate 路径先 stage-in（锁内）再启动后端
- [x] 2.5 stage-out 四钩子接线：turn 完成、IDLE→COLD 驱逐、close/DELETE、orphan 回收；`destroy()` = final stage-out 后清理暂存及 bucket 内 `data/memory/{oh_session_id}*`、`data/sessions/{oh_session_id}*` 对象前缀；本地清理全部经 2.2 前缀校验；rmtree threadpool 化（对齐 SS-17）
- [x] 2.6 测试（容器内，compose 起 minio 官方镜像实例）：先后会话记忆经 MinIO 往返、清空暂存后 resume 恢复、跨租户 agent-memory 不可见、MinIO 不可达 create → 503、并发第二个 create → 429、新旧会话交接（close 后立即 create）无丢失、首建幂等种子化、destroy 后暂存+bucket 痕迹清理、路径穿越拒绝、凭据不落 bucket/暂存；全量既有测试保持绿

## 3. WS-C 容器运行时（P3）

- [x] 3.1 `pyproject.toml` 增加 `aiodocker`；容器内经源码卷 `pip install -e` 或 `Dockerfile.fix` 补丁层安装（不重建主镜像）
- [x] 3.2 新增 `app/session/runtime.py`：`BackendRuntime` Protocol（对齐 `OhBackendProcess` 现有接口）+ 工厂 `make_backend(...)` 按 `OH_SESSION_RUNTIME` 选择；`config.py` 新增 `session_runtime`（默认 `process`）、`session_image`、`container_mem_limit/cpus/pids_limit`、`container_cap_drop` 开关、`docker_host`
- [x] 3.3 新增 `app/session/container.py::OhBackendContainer`：create（stdin_open、租户暂存/workspace/videos/源码挂载、资源限制、安全基线、`oh.sid/oh.tenant/oh.node` 标签）→ attach（stream 帧解复用按行入队）→ start；`write_line` 走 attach stdin；EOF/die 事件压 `None` 哨兵；`kill_group` = SIGTERM → 5s → force delete
- [x] 3.4 supervisor 全部 `OhBackendProcess(...)` 构造点改走 3.2 工厂；container 模式跳过 2.4 的 env 注入（改由挂载生效）
- [x] 3.5 `orphan_scan` 扩展：container 模式启动时按 `oh.node` 标签列容器、对照 DB 强删无主容器（不触他节点）；回收前对涉及租户执行 final stage-out（2.5 钩子④）
- [x] 3.6 compose：session 服务挂载 `/var/run/docker.sock`、新增 env（`OH_SESSION_RUNTIME`、`OH_SESSION_IMAGE` 默认既有主镜像 tag 等）；README/API_DOCUMENTATION 增补 docker.sock 风险告警与 socket-proxy 加固选项
- [x] 3.7 单测（容器内，fake docker client 注入）：build 容器 spec 断言（挂载/标签/资源/无端口）、attach 行桥接、die → crash 路径、kill_group 兜底、工厂默认 process；`process` 模式全量既有测试保持绿
- [x] 3.8 e2e：新增 `e2e/run-session-container-pool-tests.sh`（测试容器挂宿主 docker.sock、`OH_SESSION_IMAGE` 指向既有镜像）：完整链路 create→多轮→产物→IDLE→COLD→resume→destroy；`docker kill -9` 容器 → 网关 crash 路径恢复；实测并记录 Chrome 所需最小 cap 集（Q2），必要时调整 3.3 默认值

## 4. WS-D 池化调度（P4）

- [x] 4.1 新增 `app/session/pool.py::ContainerPool`：`acquire(tenant_id, sid) -> BackendRuntime` / `release(sid)`；内部实现四段式准入（租户配额 → 容量 → LRU 驱逐最老 IDLE → 有界 FIFO 队列 `OH_POOL_QUEUE_SIZE`/`OH_POOL_QUEUE_TIMEOUT`，0 退化为 fail-fast）；单租户队列占位 ≤ `tenant_max_concurrent`；释放事件唤醒队头
- [x] 4.2 supervisor / sessions router 的创建与 rehydrate 路径统一改走 `acquire/release`（替换内联容量检查，保留 `quota_lock` 语义）；队满/超时 → 503 + `Retry-After`
- [x] 4.3 `observability/metrics.py` 新增：`pool_backends_live`、`pool_queue_depth`、`pool_queue_wait_seconds`、`pool_evictions_total`、`pool_admission_rejected_total{reason}`、`session_create_duration_seconds`
- [x] 4.4 测试（容器内）：满容量先驱逐再分配、无可驱逐排队后释放唤醒、超时 503+Retry-After、队满即拒、单租户防刷满、queue_size=0 退化语义、指标计数正确
- [x] 4.5 e2e 扩展 3.8 脚本：并发压满 → 驱逐/排队/拒绝行为、网关重启孤儿容器回收、双租户记忆隔离端到端复验

## 5. 收尾

- [x] 5.1 全量回归：主镜像容器内跑 session-service 全部 pytest（默认 process 模式）+ 3.8/4.5 e2e 全绿；出报告
- [x] 5.2 文档：`session-service/README.md`、`API_DOCUMENTATION.md` 增补多租户（MinIO 权威源、`OH_MINIO_*`、单租户单活跃会话与丢失窗口 SLO）/runtime/池参数；`plans/Container_Pool_Multi-Tenancy_Plan_2026-07-29.md` 回填 Q1–Q3 结论
- [x] 5.3 `openspec` 校验通过后归档变更、delta 合入主 spec（`openspec-sync-specs` / archive 流程）
