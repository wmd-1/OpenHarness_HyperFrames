# Design: session-container-pool-multitenancy

> 设计源：`plans/Container_Pool_Multi-Tenancy_Plan_2026-07-29.md`（含 §0 代码核实结论表，本文不重复罗列证据，仅引用编号，如「事实 0.6」）。

## Context

- session-service 网关与 `oh --backend-only` 子进程同容器运行（事实 0.4），所有会话共享一份 `~/.openharness`（compose 卷 `openharness-config`，事实 0.8）。
- OpenHarness 项目记忆/会话快照按 cwd 哈希天然会话级隔离（事实 0.5/0.6），但 **user-scope agent 记忆（`data/agent-memory/{agent_type}`）与 settings/凭据/cron 全局共享** —— 多租户下的记忆泄漏点（事实 0.6）。
- OpenHarness 支持 `OPENHARNESS_CONFIG_DIR` / `OPENHARNESS_DATA_DIR` 环境变量覆盖路径（事实 0.7），是隔离钩子。
- 认证为单 key → `"default"` 租户（事实 0.1）；数据模型/配额/归属校验已多租户就绪（事实 0.2/0.3）。
- 生命周期 LIVE⇄IDLE→COLD→resume、orphan_scan、多节点路由均已实现（事实 0.9/0.10）。
- **rev2（已确认）**：租户数据权威源 = MinIO 对象存储（按用户 id = tenant_id 前缀切换）；`tenant_max_concurrent` 默认 1（单用户单活跃会话）。
- 约束：OpenHarness 源码零修改（既有 spec 要求）；测试必须在已有镜像内跑、不重建主镜像（项目规则 `test-on-existing-images`）。

## Goals / Non-Goals

**Goals:**
- 多把 API key 映射多租户（tenant_id = 用户 id），兼容现有单 key / 开放模式部署。
- 租户级数据隔离：权威源入 MinIO，user-scope 记忆租户内跨会话连续、租户间不可见；先在 process 模式止血，再由容器挂载强化；节点无状态化（暂存可丢弃重建）。
- 容器级运行时：每会话一次性容器，文件系统/资源/进程全隔离；`ProtocolAdapter` 及行分帧协议零改动。
- 池化调度：容量准入、驱逐联动、有界排队、公平性、可观测。

**Non-Goals:**
- 变体 A 预热池/shim（仅以 `BackendRuntime`/`ContainerPool.acquire` 接口预留）。
- 租户管理 API、计费、K8s 编排、跨节点选址调度。

## Decisions

### D1 多 key 认证：`api_keys` 表 + 三段式解析（WS-A）
`sha256(key)` 查 `api_keys(key_hash unique, tenant_id, active)`；解析顺序：开放模式（无 key 配置且表空）→ `settings.api_key` 常数时间比对（单 key 兼容 → `default`）→ 哈希查表。进程内 TTL 缓存（60s，吊销延迟 ≤ TTL）。REST 中间件与 WS `_ws_authed`、artifact-GET `?api_key=` 共用同一解析函数。
*备选*：JWT / 外部 IdP —— 超纲；env JSON 映射 —— 无吊销/审计，弃。

### D2 租户数据：MinIO 权威源 + 本地暂存 stage-in/stage-out（rev2 重写）
- 唯一权威源 = MinIO bucket（默认 `oh-tenants`）前缀 `tenants/{tid}/{openharness,rules}/`；节点本地 `/tenants/{tid}/`（`oh-tenants` 卷）仅为可丢弃暂存，清空后可从 MinIO 完整重建（节点无状态化，多节点扩展无需共享文件系统）。
- **stage-in**：create/resume 时在租户同步锁内镜像前缀→暂存（几 MB 文本，<1s）；MinIO 不可达 → 503 fail-fast。**stage-out**：①turn 完成 ②IDLE→COLD 驱逐 ③close/DELETE ④orphan 回收 四钩子镜像回 bucket（含删除传播）；**丢失窗口 SLO = 至多一个进行中 turn 的记忆增量**。
- 首见租户：bucket 无前缀 → 锁内幂等种子化 `openharness/settings.json` 模板；凭据不入 bucket/暂存，仍由网关 env 注入。
- `rules/` 随 stage-in 落地后在 create_session 时拷入会话 workspace（per-session 快照语义；目标路径实施期按 OpenHarness 规则发现逻辑定死）。
- destroy：final stage-out 后删暂存及 bucket 内 `data/memory/{oh_session_id}*`、`data/sessions/{oh_session_id}*` 对象前缀；本地清理路径必须 `resolve()` 后校验在 `/tenants/{tid}/` 前缀内。租户注销 = 删 bucket 前缀。
- 实现：`minio` Python SDK（S3 兼容）经 threadpool；stage-out 失败指数退避重试 + 保留暂存 + `tenant_sync_failures_total` 告警。workspace/产物不进同步流程（体积大，维持本地卷）。
- process 模式：`OhBackendProcess._build_env()` 注入 `OPENHARNESS_{DATA,CONFIG}_DIR` 指向暂存（WS-B 独立可交付）；container 模式：run 时挂载暂存目录（WS-C）。
*备选*：宿主机目录树为权威源 —— 单机卷绑定、多节点需共享存储、无版本化，弃（rev2）；s3fs/JuiceFS FUSE 挂载 —— 高频小文件读写延迟差、需 `/dev/fuse` 特权与安全基线冲突，弃；per-session 数据目录 —— 丢失租户内记忆连续性，弃；共享父目录挂进所有容器 —— 全租户数据在任意代码执行容器内可见，弃。

### D3 运行时抽象：`BackendRuntime` Protocol，默认 `process`
即 `OhBackendProcess` 现有 duck-type 接口（`start/write_line/stdout_lines/wait/shutdown/kill_group/exited/shutting_down`）。`OH_SESSION_RUNTIME=process|container` 经工厂选择；默认 `process`，既有部署与全部既有测试零感知。cwd 在两种 runtime 下同卷同路径（`/workspaces/{sid}`），`derive_oh_session_id` 哈希一致 → COLD→resume 可跨 runtime。

### D4 容器桥接：aiodocker attach 双向流，一次性容器
- create（stdin_open、挂载、资源、标签 `oh.sid/oh.tenant/oh.node`）→ attach（docker stream 帧解复用，stdout/stderr 合并按行入既有队列）→ start。
- EOF 语义 = attach 流关闭或 container die 事件 → 队列压 `None` 哨兵，复用既有 crash 检测路径。
- `kill_group()` = SIGTERM → 5s → `delete(force=True)`；容器即进程组，覆盖 Chrome/ffmpeg 子孙。
- **一次性**：用完 `rm -f`，绝不复用——免除跨租户残留清理的正确性证明。
- 安全基线：`cap_drop=ALL`（Chrome 所需 cap e2e 实测回加，settings 开关兜底）、`no-new-privileges`、`pids_limit`、不发布端口；资源 `mem_limit`（默认 2g）/`nano_cpus`/`pids_limit` 入 settings。
*备选*：shim 暴露 WS/TCP —— 多一跳、变体 A 才需要，弃；docker exec —— 无 attach 的 EOF 语义，弃。

### D5 调度：准入四段式 + 有界 FIFO 队列（WS-D）
持 `quota_lock` 全程：租户配额（429，现状）→ 节点容量（`max_live_sessions`，container 模式语义 = 容器数上限）→ 驱逐 `idle_since` 最老的 IDLE（复用既有 idle-eviction，提前触发）→ 有界队列（`OH_POOL_QUEUE_SIZE`=32、`OH_POOL_QUEUE_TIMEOUT`=15s；队满/超时 503 + `Retry-After`）。公平性：单租户在队中占位 ≤ `tenant_max_concurrent`。容器退出/销毁事件唤醒队头。收敛入口：`ContainerPool.acquire(tenant_id, sid) -> BackendRuntime` / `release(sid)`（变体 A 未来只换 acquire 取材）。
*备选*：租户优先级分层 —— 后续可选，本期不做。

### D6 孤儿回收扩展
container 模式启动时 `docker ps -a --filter label=oh.node={node_id}` 对照 DB，无 LIVE/IDLE 会话行的容器 `rm -f`；`oh.node` 过滤避免误杀他节点容器。既有 workspace orphan_scan 不变。

### D7 部署与 docker.sock 风险
compose 新增 `minio` 服务（官方镜像 + `minio-data` 卷，`OH_MINIO_*` env，凭据经 env/secret 注入）；session 服务追加 `/var/run/docker.sock` 与 `oh-tenants:/tenants`（暂存）挂载。sock 为 root 等价 → 仅网关容器可达 + 文档告警 + 预留 `OH_DOCKER_HOST` 指向 docker-socket-proxy（只放行 create/start/attach/kill/delete/events/ping；本期 env 可配即可，不默认启用）。`aiodocker`/`minio` SDK 依赖经源码卷安装或 `Dockerfile.fix` 补丁层，主镜像不重建。

### D8 单租户单活跃会话（rev2 新增）
`tenant_max_concurrent` 默认由 8 改为 **1**：一个用户（=租户）同时只有一个活跃会话，第二个 create → 429（前端提示先关旧会话）。收益：同租户并发写 MEMORY/agent-memory 的冲突面整体消失，stage-in/out 退化为「进场拉、离场推」，无需 LWW/ETag/合并。即使单会话，新旧会话交接仍有重叠窗口（旧会话 final stage-out 未完、新会话已 stage-in）→ per-tenant `asyncio.Lock` 序列化同一租户全部 stage-in/stage-out 兜底。配额仍可配（部署可调回 >1，但本期不承诺并发写合并语义，文档明示 LWW 风险）。
*备选*：保留 8 并发 + LWW —— 冗余复杂度与测试面，业务无需求，弃；顶掉旧会话（preempt） —— 交互体验项，后续可选。

## Risks / Trade-offs

- [attach 流断流/帧解复用 bug] → EOF 哨兵 + die 事件双保险；e2e 覆盖 `docker kill -9` 场景。
- [MinIO 不可用] → stage-in 失败 503 fail-fast 不建会话；stage-out 失败退避重试 + 保留暂存 + `tenant_sync_failures_total` 告警。
- [stage-out 前崩溃丢记忆增量] → 每 turn 完成即回写，SLO = 至多一个进行中 turn（该 turn 本就失败）。
- [Chrome 在 cap_drop 容器内起不来] → e2e 实测最小 cap 集；settings 提供关闭 cap_drop 兜底。
- [docker.sock root 等价] → D7 缓解链；该节点视为可信控制面。
- [冷启动延迟（docker run + stage-in + oh 启动）] → 接受并埋点 `session_create_duration`/`tenant_sync_duration`；P95 > 8s 且业务不可接受再立项变体 A（rev2 后变体 A 不依赖挂载，可行性提升）。
- [单 key → 多 key 迁移破坏现有部署] → D1 解析顺序显式兼容；默认 runtime=process；既有测试不动保持绿。
- [D2 清理误删] → 本地路径 resolve + 前缀校验；bucket 删除限定会话对象前缀；路径穿越单测。
- [新旧会话交接窗口覆盖] → D8：单会话 + 租户同步锁序列化；种子化幂等。

## Migration Plan

按 P1(WS-A)→P2(WS-B)→P3(WS-C)→P4(WS-D) 顺序合入，每阶段独立可交付/可回滚：
- P1 上线后旧单 key 继续有效；回滚 = 不建 api_keys 行。
- P2 上线即止血记忆混淆（process 模式 + MinIO 权威源）；回滚 = 去掉 env 注入与同步钩子（bucket 数据保留无害）；`tenant_max_concurrent` 回调即恢复多会话。
- P3 默认 `process` 不启用；灰度 = 单节点设 `OH_SESSION_RUNTIME=container`；回滚 = 改回 env（COLD 会话可跨 runtime resume，见 D3）。
- P4 随 P3 生效；队列参数可调为 0 退化回「满即 503」现状语义。
- alembic `002` 仅新增表，幂等、可 downgrade。

## Open Questions

- Q1 `drddopmd` 具体含义（暂按「租户自定义 md 规则/文档」归入 bucket `tenants/{tid}/rules/` 前缀，仅影响 D2 拷贝目标路径）。
- Q2 Chrome 最小 cap 集（实施期 e2e 实测定）。
- Q3 租户 settings.json 模板开放自定义的字段范围（本期只读模板，不开放自助修改）。
