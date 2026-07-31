<!-- 最后更新：2026-07-31 -->

# OpenHarness 交互式会话服务

一个有状态、多轮次的交互式会话服务，将原生 `oh --backend-only` 行协议桥接为
WebSocket/REST 网关。与现有的 `service/`（视频任务）后端互为兄弟服务——两者
并列运行在同一个 nginx 之后，按路径路由。

## 功能概览

- 为每个会话派生一个 `oh --backend-only` 子进程（独立进程组，因此崩溃/超时
  只影响该会话自身）。
- 通过 WebSocket 实时向客户端流式推送 `assistant_delta` / `tool_*` /
  `turn_complete` 事件。
- 保留多轮上下文（每个会话一个长生命周期进程），并通过 `oh --resume` 在空闲
  驱逐/重连后恢复（LIVE ⇄ IDLE → COLD → resume → LIVE）。
- 按轮次登记产物（视频/文件），并以 HTTP Range 方式提供下载。
- 将会话工作目录增量归档到 MinIO（turn-complete / evict / close 时机），并
  暴露只读的工作目录文件列表 + 下载端点
  （`/v1/sessions/{sid}/workspace/files`，支持 live 或 archive 数据源）。
- 多节点亲和：Redis 路由表 + 透明反向代理转发，使会话始终固定在其所属节点上。

## 架构（协议桥）

```
client ──WS──▶ gateway ──stdin (bare JSON)──▶ oh --backend-only
        ◀──WS──        ◀──stdout (OHJSON: lines)──
```

适配器剥离 `OHJSON:` 前缀，将事件解析为宽松的 Pydantic 模型（未知类型原样
转发，绝不丢弃），并把客户端操作编码为裸 JSON 的 `FrontendRequest` 行。
详见 `app/session/`。

## 目录结构

```
session-service/
├── app/
│   ├── config.py            # OH_ 前缀环境变量配置
│   ├── db.py                # 异步 engine + session 工厂（可重新配置）
│   ├── models.py            # conversations / conversation_turns / turn_artifacts
│   ├── security.py          # extra_oh_args 白名单 + 取值校验
│   ├── ratelimit.py         # 令牌桶限流（fail-open）
│   ├── main.py              # FastAPI 应用 + 鉴权中间件
│   ├── routers/             # sessions（REST）、ws（流式）、health、metrics
│   ├── session/             # process / adapter / supervisor / lifecycle / registry / proxy / logs
│   ├── storage/             # 本地 + S3 产物存储
│   └── observability/       # structlog + prometheus + otel
├── alembic/                 # 独立迁移链（alembic_version_session）
├── scripts/
│   ├── oh_backend_stub.py   # 离线 OHJSON 桩（无需 LLM key）
│   └── contract_smoke.py    # 针对真实 oh --backend-only 的契约检查
├── tests/                   # 协议、生命周期、WS、Range、安全、租户存储、归档……
└── pyproject.toml
```

## 双后端部署

视频服务（`service/`）与本会话服务作为独立进程运行，共享同一套
Postgres + Redis + workspaces 卷：

| 路径 | 后端 | 端口 |
|------|---------|------|
| `/v1/videos/**`、`/healthz` | `service/`（api） | 8000 |
| `/v1/sessions/**`（REST + WS） | `session-service/`（session） | 8001 |

nginx（`web/nginx.conf.template`）按路径路由，并为
`/v1/sessions/{sid}/ws` 升级 WS 握手。会话服务的 Redis 使用 **db=1**，以避免
与视频服务的键空间（db=0）冲突。迁移使用独立的版本表
（`alembic_version_session`），因此绝不会触碰 `video_tasks` 或视频服务的迁移
head。

## 运行方式

```bash
# 构建测试镜像（基于 oh-e2e-test:latest —— 内置 oh CLI、chrome、ffmpeg）
docker build -t oh-session-test:latest -f Dockerfile.session-test .

# 运行完整测试套件（离线，使用 oh 后端桩）
docker run --rm oh-session-test:latest

# 针对真实 oh --backend-only 的契约冒烟（启动需要 API key）
docker run --rm --entrypoint /root/.openharness-venv/bin/python \
  -e ANTHROPIC_API_KEY=sk-... oh-session-test:latest \
  /opt/oh-session-service/scripts/contract_smoke.py

# 完整栈（视频 + 会话 + web）
docker compose up
```

## 关键设计决策

- **不使用 `lease_token`**：会话是有状态且不可重放的（不同于视频服务的
  无状态重放机制）。
- **`oh_session_id` 在派生前由 `cwd` 推导**（`{cwd.name}-{sha1(resolve(cwd))[:12]}`），
  因此即使没有收到 `state_snapshot` 事件，resume 也能正常工作。
- **单写者**：每个会话最多同时一个轮次；并发 `submit` 会得到 `busy` 帧
  （WS）或 `409`（REST）。
- **服务端固定 CLI 参数**：`--permission-mode`/`--cwd`/`--api-key`/`--resume`/
  `--backend-only` 始终由服务端注入；调用方提供的 `extra_oh_args` 需通过
  白名单和取值校验（违规返回 422）。

## 生产部署注意事项（安全）

- **生产环境必须启用鉴权**：服务默认处于*开放模式*（无鉴权），仅供本地开发。
  在将服务暴露到 localhost 之外前，请设置 `OH_API_KEY=<随机密钥>` 和
  `OH_REQUIRE_AUTH=true`（两者均由 `docker-compose.yml` 透传）。启用鉴权后，
  仅 GET 下载端点（轮次产物 + 工作目录文件）接受 `?api_key=` 作为
  `<a>`/`<video>` 元素的降级方案；其余所有端点仅接受请求头
  （`X-API-Key`）。
- **每进程始终只允许单 worker**：`SessionSupervisor` /
  `ContainerPool` / `SessionRegistry` 是进程内单例，持有存活的子进程句柄、
  准入队列和审批 future。若 `OH_API_WORKERS != 1`，服务会在启动时快速失败。
  水平扩容只能通过运行更多*节点*（`OH_NODE_ID` + Redis 路由表），绝不能
  增加 uvicorn worker 数量。
- **多节点代理走的是明文 `ws://`**：网关节点之间的透明 WS 反向代理
  （`app/session/proxy.py`）会将客户端的 `X-API-Key` 通过未加密的 `ws://`
  转发到所属节点。节点间流量必须保持在可信/加密的内部网络中（compose
  网络、VPC、WireGuard/mTLS mesh）——绝不能跨公网传输。
- **端口绑定**：compose 仅将网关发布为 `127.0.0.1:8001`；外部客户端经由
  nginx 前端（`web/`）访问，nginx 同时负责 TLS 终结和 WS 握手升级。

## 多租户鉴权与数据隔离（WS-A / WS-B）

- **多 key 鉴权（WS-A）**：除遗留的单一 `OH_API_KEY`（租户 `default`）外，
  key 以哈希形式存放在 `api_keys` 表中并映射到 `tenant_id`
  （`scripts/manage_api_keys.py create/revoke/list`）。解析结果在进程内做
  TTL 缓存（`OH_APIKEY_CACHE_TTL`，默认 60s——这也是吊销生效的时间上界）。
  会话按租户隔离：他人租户的会话与不存在的会话不可区分（均返回 404）。
- **MinIO 作为权威租户存储（WS-B）**：当设置了 `OH_MINIO_ENDPOINT` 时，
  租户的记忆/会话数据存放在桶前缀 `tenants/{tid}/` 下（`OH_MINIO_BUCKET`，
  默认 `oh-tenants`）。节点是无状态的：create/rehydrate 时 **stage-in** 到
  本地暂存树 `OH_TENANTS_ROOT`（`/tenants`），turn-complete / evict / close /
  orphan-reap 时 **stage-out** 回桶（带退避重试，之后计入
  `oh_tenant_sync_failures_total`）。MinIO 不可达 ⇒ `503` 快速失败，没有
  权威数据就不启动任何会话。暂存的 `rules/` 会在 create 时快照到
  `{cwd}/.claude/rules`。
- **丢失窗口 SLO**：节点崩溃最多丢失自上次 stage-out（即最后一个已完成
  轮次）以来的记忆增量。
- **每租户单活跃会话**：`OH_TENANT_MAX_CONCURRENT` 默认为 `1`，配合每租户
  同步锁可消除租户前缀上的并发写者；调大该值则意味着接受租户数据上的
  last-writer-wins。

## 池化准入（WS-D）

每次 create/rehydrate 都要向 `ContainerPool` 申请一个槽位（所有
check-and-claim 步骤都是事件循环原子的）：

1. 租户并发配额（`OH_TENANT_MAX_CONCURRENT`）→ `429`；
2. 节点容量 `OH_MAX_LIVE_SESSIONS`（默认 16）——未满则准入；
3. 已满 ⇒ 将空闲最久的 IDLE 会话驱逐为 COLD 以释放槽位；
4. 无可驱逐 ⇒ 有界 FIFO 等待队列（`OH_POOL_QUEUE_SIZE`，默认 32；
   `OH_POOL_QUEUE_TIMEOUT`，默认 15s）。队列已满或等待超时 ⇒ `503` +
   `Retry-After`；`OH_POOL_QUEUE_SIZE=0` 退化为旧的快速失败 `503`。
   每租户的队列占用同样受该配额限制。

释放的槽位（退出/销毁/驱逐/派生失败）会唤醒队首。指标：
`oh_pool_backends_live`、`oh_pool_queue_depth`、`oh_pool_queue_wait_seconds`、
`oh_pool_evictions_total`、`oh_pool_admission_rejected_total{reason}`、
`oh_session_create_duration_seconds`。

## 容器运行时与 docker.sock（WS-C）

设置 `OH_SESSION_RUNTIME=container` 后，每个会话运行在一个**一次性**
docker 容器中（镜像 = `OH_SESSION_IMAGE`，即现有主镜像 tag——绝不重建），
通过 docker attach 流桥接。容器带有
`oh.sid`/`oh.tenant`/`oh.node` 标签，以 `cap_drop=ALL`（开关：
`OH_CONTAINER_CAP_DROP`）、`no-new-privileges`、`pids_limit`、内存/CPU 限制
运行且不发布任何端口，用完即强制删除——绝不复用。

> **⚠ docker.sock 等同于 root 权限。** compose 文件仅将
> `/var/run/docker.sock` 挂载进会话网关；任何能访问该 socket 的人都能
> 控制宿主机。请确保网关容器自身不可被不受信任的网络访问，并且为了
> 纵深防御，可将 `OH_DOCKER_HOST` 指向一个仅放行
> `create/start/attach/kill/delete/events/ping` 的
> [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
> ——网关不需要其他任何权限。默认的 `process` 运行时完全不使用该 socket。

兄弟容器的挂载来自 `OH_CONTAINER_BINDS`（逗号分隔的
`source:dest[:mode]`，默认为 compose 具名卷对应的
`/workspaces`、`/tenants`、videos 和 `~/.openharness`）。如果部署时将
OpenHarness 源码挂载进网关，必须在此追加等价的*宿主机路径*绑定——
具名卷是在宿主机 dockerd 上解析的，而不是在网关内部。
