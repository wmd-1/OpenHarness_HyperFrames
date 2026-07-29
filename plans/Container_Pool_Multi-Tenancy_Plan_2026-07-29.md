# Session Service 多租户容器池：实现计划（OpenSpec 提案结构）

> **立项记录（2026-07-29）** —— 本文件承接 session-service 多租户讨论的结论，作为「容器池 + 租户数据挂载 + 调度」的统一设计源，对应单一 OpenSpec 变更 `session-container-pool-multitenancy`。
>
> - 方向已确认：**变体 B 先行**（按需 `docker run`、挂载即隔离、池 = 容量闸门 + 等待队列 + LRU 驱逐），**预留变体 A**（预热空白容器 + shim 数据注入）演进路径。
> - **rev2（2026-07-29，已确认）**：租户数据**权威源改为 MinIO 对象存储**（stage-in/stage-out 同步，节点本地目录降级为可丢弃暂存缓存）；`tenant_max_concurrent` 默认改为 **1**（一个用户同时只有一个活跃会话），并发写冲突随之整体消除；变体 A 因数据注入不再依赖挂载而重新可选。
> - 全文区分 **已验证事实（VERIFIED）** 与 **设计决策（DECISION）**；推断性内容标注 `[INFERRED]`。

---

## 0. 代码核实结论（VERIFIED）

以下为对当前 `session-service/` 与 `OpenHarness/src/` 源码的实读结论，是本设计的前提。

| #    | 事实                                                                                                                                                                                                                     | 证据位置                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 0.1  | 认证为**单 key 模式**：`X-API-Key` 校验通过后硬编码 `request.state.tenant_id = "default"`；无 key→tenant 映射                                                                                                 | `app/main.py` auth middleware、`app/security.py:api_key_matches`                      |
| 0.2  | 数据模型已多租户就绪：`conversations.tenant_id` NOT NULL + 索引；`_load_owned()` / WS 握手均做租户归属校验（404）                                                                                                    | `app/models.py`、`app/routers/sessions.py`、`app/routers/ws.py`                     |
| 0.3  | 租户配额已存在：`tenant_max_concurrent`（默认 8）+ `tenant_max_daily`（默认 200），经 `count_live_for_tenant()` + `quota_lock` 消 TOCTOU                                                                         | `app/config.py`、`app/session/supervisor.py`、`app/routers/sessions.py`             |
| 0.4  | `oh --backend-only` 以**同容器子进程**运行：`create_subprocess_exec` + stdin/stdout 管道 + `start_new_session=True` 进程组隔离；行分帧 bare-JSON 协议                                                        | `app/session/process.py:OhBackendProcess`                                               |
| 0.5  | 每会话独立 workspace：`{workspace_root}/{session_uuid}`；`oh_session_id = {cwd.name}-{sha1(cwd)[:12]}` 由 cwd 派生，用于 `--resume`                                                                                | `supervisor.py:create_session`、`process.py:derive_oh_session_id`                     |
| 0.6  | OpenHarness 项目记忆/会话快照按**cwd 哈希**隔离（天然按会话隔离）；但 **user-scope agent 记忆**（`~/.openharness/data/agent-memory/{agent_type}`）与 settings/凭据/cron **全局共享** → 跨租户泄漏点 | `OpenHarness/src/openharness/memory/paths.py`、`memory/agent.py`、`config/paths.py` |
| 0.7  | OpenHarness 路径解析支持`OPENHARNESS_CONFIG_DIR` / `OPENHARNESS_DATA_DIR` / `OPENHARNESS_LOGS_DIR` 环境变量覆盖 `~/.openharness`                                                                                 | `OpenHarness/src/openharness/config/paths.py`                                           |
| 0.8  | compose 中 session 服务共享挂载：`oh-workspaces:/workspaces`、`openharness-config:/root/.openharness`（**所有会话共用一个 config 卷**）、`oh-videos:/var/openharness/videos`                                 | `docker-compose.yml` session 服务                                                       |
| 0.9  | 生命周期 LIVE ⇄ IDLE → COLD →(`--resume`)→ LIVE 已实现：idle 驱逐、`orphan_scan()` 回收无主 workspace、`destroy` 清 workspace/快照/Redis 路由                                                                  | `app/session/lifecycle.py`、`supervisor.py`                                           |
| 0.10 | 多节点亲和路由（Redis 路由表 + 反代转发 + epoch fencing）已就位                                                                                                                                                          | `app/session/registry.py`、`app/session/proxy.py`                                     |
| 0.11 | 主镜像`openharness_hyperframes_qwen-tts_pptx:*` 同时承载网关与 `oh` 运行时；源码经 volume 挂载进容器，改代码无需重建镜像                                                                                             | `docker-compose.yml`、项目规则 `test-on-existing-images.md`                           |

---

## 1. 问题陈述（Problem Statement）

1. **记忆混淆**：user-scope agent 记忆、settings、凭据、cron 在所有会话（未来所有租户）间共享同一 `~/.openharness`（事实 0.6/0.8）。启用多租户后，租户 A 的 agent 记忆会被租户 B 的会话读到。
2. **隔离强度不足**：`oh` 子进程与网关同容器、同文件系统、同 OS 用户。恶意/失控的会话进程可读其他会话 workspace、耗尽网关容器资源（噪声邻居），甚至影响网关本身。
3. **认证无法区分租户**：单 key 模式下所有调用方都是 `"default"` 租户（事实 0.1），已有的租户隔离/配额逻辑形同虚设。
4. **容量模型粗糙**：`max_live_sessions` 只是进程数上限，无资源维度（内存/CPU）约束，满载时直接 503，无等待队列与驱逐联动的准入策略。

---

## 2. 目标与范围概览

四个可独立交付的工作流（WS），依赖关系 WS-A → WS-B → WS-C → WS-D（可流水线并行开发，按序合入）：

- **WS-A 多 key 租户认证**：`api_keys` 表 + key→tenant 解析中间件；兼容现有单 key / 开放模式。
- **WS-B 租户数据隔离（rev2：MinIO）**：MinIO bucket 按租户前缀存放权威数据 + 节点本地暂存 stage-in/stage-out + per-tenant `OPENHARNESS_DATA_DIR`/`OPENHARNESS_CONFIG_DIR` 注入（先在现有**进程模式**下止血记忆混淆，独立可交付）；`tenant_max_concurrent` 默认降为 1，单会话 + 租户同步锁消除并发写冲突。
- **WS-C 容器运行时**：`OhBackendContainer` 抽象（与 `OhBackendProcess` 同接口），每会话一个独立容器，租户数据挂载即隔离；`OH_SESSION_RUNTIME=process|container` 开关，默认 `process` 保持向后兼容。
- **WS-D 池化调度**：节点容器容量闸门、LRU IDLE 驱逐联动、有界等待队列、容器孤儿回收、调度指标。

**非目标（明确排除）**：变体 A 预热池/shim（仅预留接口，见 §7）；租户管理 API（key 增删走脚本/SQL）；K8s 编排（单节点 Docker 先行，调度层不与 Docker API 耦死）；计费。

---

## 3. 目标架构（DECISION）

```
                    ┌────────────────────────────────────────────┐
 client ──REST/WS──▶│  session-service gateway（现有容器，不变）      │
                    │  auth: api_keys 表 → tenant_id (=用户 id)    │
                    │  Supervisor + ContainerPool(容量/队列/驱逐)    │
                    │  TenantStore(stage-in/stage-out ⇄ MinIO)     │
                    └──────┬──────────────────────────┬──────────┘
                           │ aiodocker                │ S3 API
          ┌────────────────┼──────────┐               ▼
          ▼                ▼          ▼       ┌────────────────┐
 ┌─────────────────┐ ┌─────────────┐  ...     │     MinIO      │
 │ session 容器 s1  │ │ session 容器 │         │ tenants/{tid}/ │ ← 租户数据唯一权威源
 │ tenant=acme     │ │ tenant=beta │         │  openharness/  │   （bucket 前缀按租户隔离，
 │ oh --backend-only│ │ ...        │         │  rules/        │    节点无状态化）
 └─────────────────┘ └─────────────┘         └────────────────┘
   挂载（run 时指定，天然不可能混；每租户同时至多 1 个会话容器）：
   /tenants/{tid}/openharness（本地暂存，stage-in 自 MinIO）→ /root/.openharness
   oh-workspaces → /workspaces        (会话工作区+产物，网关同卷可读；不进 MinIO 同步)
   oh-videos     → /var/openharness/videos
```

### 3.1 租户数据：MinIO 权威源 + 节点本地暂存（DECISION D2，rev2 重写）

租户数据的**唯一权威源是 MinIO**（bucket 默认 `oh-tenants`，S3 兼容），按租户前缀隔离；节点上的 `/tenants/{tid}/`（named volume `oh-tenants`，仅作缓存）是**可丢弃的本地暂存**，由网关在会话生命周期内 stage-in/stage-out 同步。租户切换即用户 id 切换：`api_keys.tenant_id` = 用户 id = bucket 前缀键。

**Bucket 布局**：

```
tenants/{tenant_id}/
├── openharness/settings.json          # 首次接入时由网关从模板种子化
├── openharness/data/memory/...        # 项目记忆（cwd 哈希子目录，会话级）
├── openharness/data/agent-memory/...  # user-scope agent 记忆（本方案后 = 租户级）
├── openharness/data/sessions/...      # 会话快照（--resume 依据）
└── rules/*.md                         # 租户自定义规则/文档（drddopmd 等均归此前缀）
```

**同步协议与决策项**：

- D2.1 **stage-in**：`create_session` / COLD→LIVE resume 时，在租户同步锁内将 `tenants/{tid}/` 前缀整体镜像到本地 `/tenants/{tid}/`（几 MB 文本文件，<1s）；MinIO 不可达 → 503 fail-fast，不创建会话。
- D2.2 **stage-out 钩子**：①turn 完成、②IDLE→COLD 驱逐、③close/DELETE、④orphan 回收 四个钩子将本地暂存镜像回 bucket（含删除传播）。**丢失窗口 SLO = 至多正在进行中的一个 turn 的记忆增量**（崩溃时该 turn 本就失败，可接受）。
- D2.3 `rules/` 随 stage-in 落地本地暂存后，在 create_session 时由网关拷贝到会话 workspace（目标路径实施期按 OpenHarness local-rules 发现逻辑核实后定死），per-session 快照语义：事后改 bucket 不影响已建会话。`drddopmd` 无论具体含义，都只是此前缀下多一类对象（Q1 影响面收敛至拷贝目标路径）。
- D2.4 **单会话序列化**：`tenant_max_concurrent` 默认改为 **1**（一个用户同时只有一个活跃会话，第二个 create → 429）；配合 per-tenant `asyncio.Lock` 序列化同一租户全部 stage-in/stage-out，覆盖新旧会话交接窗口（旧会话 final stage-out 未完、新会话已 stage-in 的覆盖风险）→ 并发写冲突整体消除，无需 LWW/合并策略。
- D2.5 destroy：final stage-out 后，删除本地暂存及 bucket 内该会话痕迹（`data/memory/{oh_session_id}*`、`data/sessions/{oh_session_id}*` 对象前缀；事实 0.5 命名规则一致，可精确定位）；本地清理路径必须经 `Path.resolve()` 校验在 `/tenants/{tid}/` 前缀内。
- D2.6 首次见租户：bucket 内无该前缀 → 网关在同步锁内种子化 `openharness/settings.json`（幂等）；租户不能影响模板内容。
- D2.7 凭据（`ANTHROPIC_API_KEY` 等）**不入 bucket、不入暂存**，继续由网关经容器 env 统一注入（server-managed）。
- D2.8 客户端：`minio` Python SDK（S3 兼容，新增依赖），调用经 threadpool（文件少且小）；stage-out 失败指数退避重试、保留暂存、计入 `tenant_sync_failures_total` 并告警。
- D2.9 租户注销 = 删除 bucket 前缀 `tenants/{tid}/`（运维脚本，不做 API）；本地暂存随卷清理。
- D2.10 workspace/产物**不进**此同步流程（视频可达百 MB 级，会拖垮会话创建），维持现有本地卷；产物归档 MinIO 为 P4 之后可选项。

### 3.2 会话容器规格（DECISION D3）

| 项           | 值                                                                                                   | 说明                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 镜像         | 与网关同主镜像（`OH_SESSION_IMAGE`，默认取 compose 主镜像 tag）                                    | 遵循「复用已有镜像」规则，不新建镜像                                                              |
| 入口         | 直接`exec` 现有 `build_command()` 产出的 `oh --backend-only ...` 命令                          | 不引入 shim（变体 B）                                                                             |
| stdin/stdout | `stdin_open=true`、`tty=false`，经 docker attach 双向流                                          | 行分帧 JSON 协议不变                                                                              |
| 网络         | 加入 compose 网络（出站访问 LLM API），**不发布任何端口**                                      | 入站只有 attach 流                                                                                |
| 挂载         | §3 图示三项 +`OpenHarness/src`、`ohmo` 源码挂载（与现有 compose 一致，改代码免重建）            | run 时指定，杜绝热挂载问题                                                                        |
| 资源         | `mem_limit`（默认 2g）、`nano_cpus`（默认 1.0）、`pids_limit`（默认 512）——均为新增 settings | oh+Chrome 的噪声邻居治理                                                                          |
| 安全         | `cap_drop=ALL`（按需加回 Chrome 所需 cap，实测定）、`security_opt=no-new-privileges`             | [INFERRED] Chrome headless-shell 通常需要`SYS_ADMIN` 或 `--no-sandbox`，实施时以 e2e 实测为准 |
| 标签         | `oh.sid={sid}`、`oh.tenant={tid}`、`oh.node={node_id}`                                         | 孤儿回收与运维定位                                                                                |
| 复用策略     | **一次性：容器用完即 `rm -f`，绝不跨租户/跨会话复用**                                        | 免除残留清理的正确性证明负担                                                                      |

### 3.3 通信通道与运行时抽象（DECISION D4）

- 新增 `app/session/runtime.py`：`BackendRuntime` Protocol，含 `start() / write_line() / stdout_lines / wait() / shutdown() / kill_group() / pid|container_id / exited / shutting_down` —— 即现有 `OhBackendProcess` 的既有 duck-type 接口，**`ProtocolAdapter` / `Supervisor` 零语义改动**。
- `OhBackendContainer`（`app/session/container.py`）：基于 `aiodocker`（新增依赖，仅此一处）实现该接口：
  - `start()` = create container（含挂载/资源/标签）+ attach（`stdin/stdout/stderr` 多路复用流，docker stream 帧解复用后仍按行入 `stdout_lines` 队列）+ start；
  - `kill_group()` = `container.kill(SIGTERM)` → 5s 超时 → `container.delete(force=True)`（容器即进程组，天然覆盖 Chrome/ffmpeg 子孙）；
  - EOF 语义 = attach 流关闭或 container die 事件 → 队列压入 `None` 哨兵（与现有崩溃检测路径一致）。
- 运行时选择：`settings.session_runtime: "process" | "container"`（env `OH_SESSION_RUNTIME`），`supervisor` 经工厂函数取得实例。**默认 `process`**：现有部署、全部既有测试零感知。
- `--cwd` 传给容器内路径（同卷同路径 `/workspaces/{sid}`，故 `derive_oh_session_id` 的 cwd 哈希在两种 runtime 下一致，COLD→resume 可跨 runtime 切换）。

### 3.4 生命周期映射（DECISION D5）

| 状态         | process 模式（现状）    | container 模式（新增）                             |
| ------------ | ----------------------- | -------------------------------------------------- |
| LIVE / IDLE  | 子进程存活              | 容器 running                                       |
| → COLD      | 杀进程组，stage-out 回 MinIO      | `rm -f` 容器，stage-out 回 MinIO（暂存保留）                  |
| COLD → LIVE | 新子进程`--resume`（先 stage-in）    | **新容器** `--resume`（先 stage-in，一次性原则）        |
| destroy      | 杀进程组 + 清 workspace + final stage-out | `rm -f` + 清 workspace + final stage-out + D2.5 清暂存与 bucket 会话痕迹 |

`orphan_scan()` 扩展：container 模式下启动时额外 `docker ps -a --filter label=oh.node={node_id}`，对照 DB——无对应 LIVE/IDLE 会话行的容器一律 `rm -f`（网关崩溃重启后的容器孤儿）；回收同时对存活暂存目录执行 final stage-out（D2.2 钩子④）。

---

## 4. 多 key 租户认证（WS-A，DECISION D1）

- 新表 `api_keys`：`id (uuid PK) / key_hash (sha256, unique, not null) / tenant_id (str, not null, index) / label / active (bool) / created_at`。alembic migration `002_api_keys`（独立于 001，幂等）。
- 中间件解析顺序（替换现有单 key 分支，`app/main.py` + `app/routers/ws.py` 的 `_ws_authed` 同步改）：
  1. `require_auth=False` 且未配 `api_key` 且 `api_keys` 表为空 → 开放模式，tenant=`default`（现状不变）；
  2. 提供的 key 先与 `settings.api_key` 常数时间比对（**单 key 向后兼容**，命中 → tenant=`default`）；
  3. 否则 `sha256(key)` 查 `api_keys`（`active=true`）→ 命中：`request.state.tenant_id / actor_key_id = 行.tenant_id / 行.id`；未命中 → 401。
- 查表结果进程内 TTL 缓存（默认 60s，`OH_APIKEY_CACHE_TTL`），吊销延迟 ≤ TTL，可接受。
- key 管理：`scripts/manage_api_keys.py`（create/revoke/list，直连 DB），不做管理 API。
- WS/artifact-GET 的 `?api_key=` 路径复用同一解析函数（现有 A2 约束不变）。

---

## 5. 池化调度（WS-D，DECISION D6）

**准入顺序**（`POST /v1/sessions` 与 COLD→LIVE resume 共用，全程持 `quota_lock` 消 TOCTOU，与现状一致）：

1. 租户级：`count_live_for_tenant(tid) >= tenant_max_concurrent` → 429（现状保留）；
2. 节点级：live 容器数 < `max_live_sessions`（container 模式下语义 = 容器数上限，按节点内存预算配置，例：32g 节点 / 2g limit ≈ 14）→ 直接分配；
3. 满则**驱逐**：选 `idle_since` 最老的 IDLE 会话提前转 COLD（复用现有 idle-eviction 代码路径，仅提前触发）；有可驱逐者驱逐后分配；
4. 无可驱逐（全 LIVE 且 busy）→ 进入**有界等待队列**（`asyncio` 条件变量实现；容量 `OH_POOL_QUEUE_SIZE` 默认 32，等待超时 `OH_POOL_QUEUE_TIMEOUT` 默认 15s）；队满或超时 → 503 + `Retry-After`（保持现有 `CapacityFullError` → 503 语义）；
5. 任何容器退出/销毁事件唤醒队列头。

- 公平性：队列 FIFO；**同一租户在队列中最多占 `tenant_max_concurrent` 个位置**，防单租户刷满队列。租户优先级分层为后续可选项，本期不做。
- 指标（Prometheus，现有 `observability/metrics.py` 追加）：`pool_containers_live`、`pool_queue_depth`、`pool_queue_wait_seconds`（histogram）、`pool_evictions_total`、`pool_admission_rejected_total{reason}`。
- 多节点：不新增逻辑——现有 Redis 路由表 + 反代（事实 0.10）已保证会话粘住节点；跨节点选址仍由上游 LB 决定，超纲不做。

---

## 6. 部署与安全（WS-C/D 附属，DECISION D8）

- compose 变更：**新增 `minio` 服务**（官方 `minio/minio` 镜像 + `minio-data` 卷，端口按项目约定分配；符合规则：标准镜像非重建）；session 服务追加挂载 `/var/run/docker.sock:/var/run/docker.sock` 与 `oh-tenants:/tenants`（暂存缓存，可丢弃重建）；新增 env：`OH_SESSION_RUNTIME`、`OH_SESSION_IMAGE`、`OH_TENANTS_ROOT=/tenants`、`OH_MINIO_ENDPOINT` / `OH_MINIO_ACCESS_KEY` / `OH_MINIO_SECRET_KEY` / `OH_MINIO_BUCKET`（默认 `oh-tenants`）/ `OH_MINIO_SECURE`、资源限制项、队列参数。MinIO 凭据经 env/secret 注入，不入库不入代码。
- **docker.sock 风险**（root 等价）与缓解：仅 session 网关容器挂载；文档明示该节点视为可信控制面；预留 `OH_DOCKER_HOST` 指向 [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)（只放行 containers create/start/attach/kill/delete + events + ping）作为加固选项，本期实现 env 可配即可，proxy 容器不默认启用。
- 会话容器安全基线见 §3.2（no-new-privileges / cap_drop / pids_limit / 不发布端口）。
- 主镜像不变更、不重建（规则约束）；`aiodocker` 依赖经 `session-service/pyproject.toml` 添加，源码卷挂载 + 容器内 `pip install -e` 或 `Dockerfile.fix` 补丁层安装。

---

## 7. 变体 A 演进预留（本期不实现）

- `BackendRuntime` Protocol 即预留点：未来 `WarmPoolRuntime` 实现同接口——池内预热空白容器跑 shim（预 import openharness），分配时 shim 直接从 MinIO stage-in 租户数据入容器本地目录 → 设 `OPENHARNESS_DATA_DIR` → fork/exec `oh`；释放时 stage-out 回 MinIO 后销毁。**rev2 后变体 A 不再依赖任何挂载动作**（数据经对象存储进出），可行性显著提升，但仍按原触发条件立项。
- 本期把「分配容器」收敛在 `ContainerPool.acquire(tenant_id, sid) -> BackendRuntime` / `release(sid)` 两个方法内，变体 A 只替换 acquire 的取材来源，调度/生命周期/协议层全部复用。
- 触发条件：变体 B 上线后实测 P95 会话创建延迟 > 8s 且业务不可接受时立项。

---

## 8. 影响分析（Impact Analysis）

| 组件                    | WS-A 认证       | WS-B 数据隔离                       | WS-C 容器运行时                     | WS-D 调度                 |
| ----------------------- | --------------- | ----------------------------------- | ----------------------------------- | ------------------------- |
| DB/Migration            | Yes（api_keys） | No                                  | No                                  | No                        |
| main.py / ws.py 中间件  | Yes             | No                                  | No                                  | No                        |
| config.py               | 小（cache TTL） | Yes（tenants_root、MinIO 连接项、单会话默认值） | Yes（runtime/image/资源）           | Yes（队列参数）           |
| process.py / 新 runtime | No              | 小（env 注入）                      | Yes（新 container.py + runtime.py） | No                        |
| supervisor.py           | No              | Yes（stage-in/out 钩子、租户同步锁、destroy 清理） | Yes（工厂替换、orphan_scan 扩展）   | Yes（准入/队列/驱逐联动） |
| adapter/protocol        | No              | No                                  | **No（接口不变）**            | No                        |
| compose/部署            | No              | Yes（minio 服务 + oh-tenants 暂存卷）                | Yes（docker.sock、env）             | No                        |
| 依赖                    | No              | Yes（minio SDK）                                  | Yes（aiodocker）                    | No                        |
| 前端                    | No              | No                                  | No                                  | No（503/429 语义已存在）  |

## 9. 风险与缓解（Risks & Mitigations）

| 风险                                               | 概率 | 影响 | 缓解                                                                                                   |
| -------------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------ |
| docker attach 流稳定性（长连接断流、帧解复用 bug） | Med  | High | attach 断流按「进程崩溃」既有路径处理（EOF 哨兵）；container die 事件双保险；e2e 覆盖 kill -9 容器场景 |
| Chrome 在受限容器内起不来（cap_drop/沙箱）         | Med  | Med  | 实施期以 e2e 实测确定最小 cap 集；兜底允许 per-deployment 关闭 cap_drop（settings 开关）               |
| docker.sock 暴露面                                 | Med  | High | §6：仅网关可达 + socket-proxy 加固选项 + 文档告警                                                     |
| 会话创建冷启动延迟（docker run + stage-in + oh 启动）         | High | Med  | 本期接受并埋点（`session_create_duration` histogram + `tenant_sync_duration`）；超阈值再启动变体 A（§7）                     |
| MinIO 不可用                             | Med  | High | stage-in 失败 → 503 fail-fast 不建会话；stage-out 失败 → 退避重试 + 保留暂存 + `tenant_sync_failures_total` 告警；MinIO 单实例挂卷持久化          |
| stage-out 前崩溃丢记忆增量                           | Med  | Low  | 钩子密度（每 turn 完成即回写）把窗口压到单个进行中 turn（D2.2 SLO）                                     |
| 新旧会话交接窗口覆盖（旧 stage-out 未完、新 stage-in 已拉） | Low  | Med  | 单会话（tenant_max_concurrent=1）+ 租户同步锁序列化全部 stage-in/out（D2.4）；首建种子化幂等                                    |
| 单 key → 多 key 迁移破坏现有部署                  | Low  | High | 解析顺序显式兼容单 key（§4 步骤 2）；`process` 为默认 runtime；全部既有测试不动应保持绿             |
| 容器孤儿泄漏（网关崩溃）                           | Med  | Med  | 标签化 + 启动 orphan_scan 扩展 +`oh.node` 过滤避免误杀他节点容器；回收时补 final stage-out                                     |
| destroy 清理误删（D2.5 路径/对象前缀拼接错误）          | Low  | High | 本地路径必须经`Path.resolve()` 校验在 `/tenants/{tid}/` 前缀内；bucket 删除限定 `tenants/{tid}/...{oh_session_id}` 前缀；单测覆盖路径穿越                   |

## 10. 成功标准（Success Criteria）

- [ ] **WS-A**：两把不同 key 创建的会话互相 GET/DELETE/WS → 404；无效 key → 401；单 key 旧配置行为不变；开放模式行为不变。
- [ ] **WS-B**：租户 A 会话内写入的 user-scope agent 记忆（`data/agent-memory/`），租户 B 的会话读不到；同一租户**先后**两个会话，后一个能读到前一个写入的 user-scope 记忆（经 MinIO 往返）；清空本地暂存卷后仅凭 MinIO 可完整恢复租户记忆与 resume 上下文；同租户并发第二个 create → 429；`destroy` 后该会话的 memory/快照痕迹从暂存与 bucket 双双消失。
- [ ] **WS-C**：`OH_SESSION_RUNTIME=container` 下完整会话链路（create → 多轮 turn → 产物下载 → IDLE → COLD → resume → destroy）全绿；`docker kill -9` 会话容器 → 网关按 crash 路径恢复，网关自身无恙；`process` 模式回归全绿。
- [ ] **WS-D**：容量满时先驱逐最老 IDLE 再分配；无可驱逐时排队，超时 503 + Retry-After；单租户不能占满队列；网关重启后孤儿容器被回收；池指标可在 `/metrics` 观测。
- [ ] 全量 `session-service` pytest 保持绿（在既有镜像容器内运行）。

## 11. 实施阶段（Phases）

| Phase | 内容                                                                                                                                        | 交付物                                         | 依赖 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---- |
| P1    | WS-A：migration 002、key 解析中间件（REST+WS）、TTL 缓存、管理脚本、测试                                                                    | 多 key 认证可用                                | —   |
| P2    | WS-B：compose 新增 minio 服务 + bucket 布局、`TenantStore` stage-in/stage-out（turn 完成/驱逐/销毁/孤儿四钩子）、`tenant_max_concurrent` 默认 1 + 租户同步锁、process 模式下 per-tenant `OPENHARNESS_{DATA,CONFIG}_DIR` env 注入、settings 种子化、destroy 清理、测试 | **记忆混淆止血**（不依赖容器化即可上线） | P1   |
| P3    | WS-C：`runtime.py` Protocol、`container.py`（aiodocker attach 桥）、supervisor 工厂化、orphan_scan 扩展、compose 变更、测试             | container 运行时可切换                         | P2   |
| P4    | WS-D：ContainerPool 准入（驱逐联动 + 有界队列 + 公平性）、指标、e2e、文档（README/API_DOCUMENTATION 增补）                                  | 池化调度完备                                   | P3   |

## 12. 测试计划（遵循 test-on-existing-images 规则）

- **单元/集成（pytest）**：全部在主镜像容器内跑（`docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest ..."`）。WS-B 的同步单测用 compose 内官方 `minio/minio` 镜像实例（标准镜像，符合规则）或 fake S3 client；WS-C 的容器运行时单测用 fake docker client（注入 `OhBackendContainer` 的 aiodocker 客户端依赖），不触真 daemon。
- **e2e（container 模式真实链路）**：基于 `oh-e2e` 系列镜像新增脚本 `e2e/run-session-container-pool-tests.sh`，测试容器**挂载宿主 `/var/run/docker.sock`**，`OH_SESSION_IMAGE` 指向既有主镜像 tag——不构建任何新镜像；覆盖：双租户记忆隔离（经 MinIO 往返）、暂存卷清空后仅凭 MinIO 恢复 resume、容器 crash 恢复、驱逐/排队、孤儿回收。
- **回归**：`OH_SESSION_RUNTIME=process`（默认）下全量既有测试必须不改动且全绿。

## 13. 未决问题（Open Questions）

| #  | 问题                                          | 当前假设                                            | 影响面               |
| -- | --------------------------------------------- | --------------------------------------------------- | -------------------- |
| Q1 | `drddopmd` 具体指什么                       | 按「租户自定义 md 规则/文档」归入 bucket `tenants/{tid}/rules/` 前缀（D2.3） | 仅 D2.3 拷贝目标路径 |
| Q2 | Chrome 在 cap_drop 容器内的最小权限集         | 实施期 e2e 实测确定，settings 提供开关兜底          | §3.2 安全行         |
| Q3 | 租户 settings.json 模板允许租户自定义哪些字段 | 本期只读模板初始化，不开放租户自助修改              | D2.6                 |

### 13.1 实施期结论回填（2026-07-29，任务 5.2）

- **Q1（已定案）**：按假设落地——租户自定义 md 规则归入 bucket 前缀 `tenants/{tid}/rules/`，stage-in 镜像到暂存 `rules/` 目录后，create_session 时快照拷贝到 `{cwd}/.claude/rules/`（`tenant_store.copy_rules_into_workspace`）。拷贝目标已对照 OpenHarness 规则发现逻辑核实（`prompts/claudemd.py::discover_claude_md_files` 自 cwd 向上收集 `.claude/rules/*.md`），任务 2.3 实施并有测试覆盖。
- **Q2（已实测）**：e2e Q2 探针（`run-session-container-pool-tests.sh`）证实 `CapDrop=ALL` + `no-new-privileges` 下 chrome-headless-shell（`--no-sandbox`）在会话容器内正常工作，**最小额外 capability 集 = 空**。3.3 的默认安全参数（cap_drop=ALL）维持不变，`OH_CONTAINER_CAP_DROP` 开关保留作兜底。
- **Q3（维持假设）**：本期保持只读模板初始化——首见租户时幂等种子化 `settings.json`，不开放租户自助修改任何字段；如后续需要开放白名单字段，另起 change 处理。

