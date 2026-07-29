# Proposal: session-container-pool-multitenancy

## Why

session-service 的数据模型/配额/归属校验已多租户就绪，但认证仍是单 key（所有调用方 → `"default"` 租户），且所有 `oh` 子进程同容器共享一份 `~/.openharness` —— OpenHarness 的 user-scope agent 记忆（`data/agent-memory/{agent_type}`）与 settings/凭据/cron 按此路径全局共享，一旦启用多租户，租户间记忆必然互相泄漏；同容器子进程模式也缺乏文件系统/资源隔离（噪声邻居可拖垮网关）。设计源见 `plans/Container_Pool_Multi-Tenancy_Plan_2026-07-29.md`（方向已确认：变体 B——按需 `docker run` + 挂载即隔离 + 池化调度，预留变体 A 预热池演进；**rev2 已确认**：租户数据权威源 = MinIO 对象存储，按用户 id（=tenant_id）前缀切换，stage-in/stage-out 同步；`tenant_max_concurrent` 默认 1，单用户单活跃会话）。

## What Changes

- **WS-A 多 key 租户认证**：新增 `api_keys` 表（`key_hash` sha256 / `tenant_id` / `active`，alembic `002`）；REST 中间件与 WS 握手改为「单 key 兼容比对 → 哈希查表」的统一解析（TTL 缓存，默认 60s）；开放模式与现有单 key 部署行为不变；key 管理走 `scripts/manage_api_keys.py`（不做管理 API）。
- **WS-B 租户数据隔离（rev2：MinIO 权威源）**：租户数据唯一权威源为 MinIO bucket 前缀 `tenants/{tenant_id}/{openharness,rules}/`；节点本地 `/tenants/{tid}/`（`oh-tenants` 卷）降级为可丢弃暂存——create/resume 时 **stage-in**（MinIO 不可达 → 503 fail-fast），turn 完成/驱逐/销毁/孤儿回收四钩子 **stage-out**（丢失窗口 SLO = 至多一个进行中 turn）；首见租户在同步锁内种子化 settings 模板；`tenant_max_concurrent` 默认降为 **1** + per-tenant 同步锁序列化全部 stage-in/out，并发写冲突整体消除（无 LWW/合并）；process 模式下向 `oh` 子进程注入 per-tenant `OPENHARNESS_DATA_DIR`/`OPENHARNESS_CONFIG_DIR`（指向暂存）——**不依赖容器化即可先行止血记忆混淆**；`rules/` 随暂存在建会话时拷入 workspace；DELETE 追加 final stage-out 后清理暂存与 bucket 内该会话痕迹（本地路径前缀校验防穿越）；workspace/产物不进同步流程。
- **WS-C 容器运行时**：抽出 `BackendRuntime` Protocol（即 `OhBackendProcess` 现有 duck-type 接口，adapter/协议层零改动）；新增 `OhBackendContainer`（aiodocker：create + attach 双向流 + start，行分帧 JSON 协议不变）；每会话一个**一次性**容器（用完 `rm -f`，绝不跨租户/会话复用），run 时挂载租户数据/共享 workspace/videos 卷；资源限制（mem/cpu/pids）与安全基线（cap_drop、no-new-privileges、不发布端口）；`OH_SESSION_RUNTIME=process|container` 开关，**默认 `process` 完全向后兼容**；orphan_scan 扩展按 `oh.node` 标签回收孤儿容器。
- **WS-D 池化调度**：准入顺序 = 租户配额 → 节点容量 → LRU 驱逐最老 IDLE → 有界 FIFO 等待队列（超时/队满 503 + `Retry-After`；单租户占位上限防刷满）；新增池指标（live/queue depth/wait histogram/evictions/rejections）。
- **部署**：compose 新增 `minio` 服务（官方镜像 + 持久卷）及 `OH_MINIO_*` env；session 服务追加 `docker.sock` 与 `oh-tenants` 暂存卷挂载及新 env；主镜像不重建（`aiodocker`/`minio` SDK 依赖经源码卷 + `Dockerfile.fix` 补丁层）；预留 `OH_DOCKER_HOST` 指向 docker-socket-proxy 的加固选项。

## Capabilities

### New Capabilities

- `session-tenant-isolation`：MinIO bucket 按租户前缀存放权威数据、stage-in/stage-out 同步协议（四钩子 + 丢失窗口 SLO）、首见租户种子化、双 runtime 指向暂存目录、user-scope 记忆的租户级隔离语义（租户内跨会话连续/租户间不可见）、单租户单活跃会话 + 租户同步锁、rules 注入、会话删除时暂存与 bucket 痕迹清理、租户注销即删 bucket 前缀。
- `session-container-runtime`：`BackendRuntime` 抽象与 runtime 开关、容器化 `oh --backend-only`（attach 流桥接、EOF/die 事件哨兵）、一次性容器复用策略、挂载/资源/安全基线、跨 runtime 的 COLD→resume 一致性（cwd 哈希不变）、孤儿容器回收。
- `session-pool-scheduling`：容量准入次序、驱逐联动、有界等待队列与公平性、池可观测指标。

### Modified Capabilities

- `interactive-session`：(1)「Requests MUST be authenticated and scoped to a tenant」——落实哈希查表多 key 解析（tenant_id = 用户 id），并明确单 key 兼容与开放模式的租户解析次序；(2)「Resource limits MUST bound sessions, turns, and lifetime」——`tenant_max_concurrent` 默认降为 1（单用户单活跃会话，第二个 create → 429）；容量满时由「直接 503」升级为「驱逐 → 有界排队 → 超时 503 + Retry-After」，container 模式下 `max_live_sessions` 语义 = 节点容器数上限；(3)「DELETE MUST clean resources...」——清理范围扩展到暂存目录与 MinIO bucket 内该会话的 memory/快照痕迹（含 final stage-out）；(4)「Subprocess crash MUST be isolated...」——crash 隔离语义扩展覆盖 container 运行时（attach 断流/die 事件按既有 crash 路径处理）。

## Impact

- **代码**：`session-service/app/`（main/ws 中间件、config、deps、supervisor、新增 `session/runtime.py`、`session/container.py`、`session/pool.py`、`session/tenant_store.py`）、`alembic/versions/002_api_keys.py`、`scripts/manage_api_keys.py`、`pyproject.toml`（+aiodocker、+minio）。
- **部署**：`docker-compose.yml`（新增 minio 服务与卷；session 服务挂载/ env / `oh-tenants` 暂存卷）、`.env.example`（`OH_MINIO_*`）；主镜像不重建，如需容器内装新依赖用 `Dockerfile.fix` 补丁层。
- **不动**：`ProtocolAdapter`/`protocol.py` 协议层、`OpenHarness/` 源码（零修改约束不变）、`service/` 视频服务、前端（503/429 语义已存在）。
- **风险**：docker.sock 暴露（root 等价，缓解：仅网关可达 + socket-proxy 选项）；MinIO 不可用（stage-in 503 fail-fast；stage-out 退避重试 + 告警指标）；崩溃丢失窗口（每 turn 回写，SLO = 单个进行中 turn）；attach 流稳定性（EOF 哨兵 + die 事件双保险）；Chrome 最小 cap 集（e2e 实测定，settings 兜底开关）；冷启动延迟（埋点观测，超阈值再立项变体 A——rev2 后变体 A 不再依赖挂载，可行性提升）。
- **测试**：遵循 `test-on-existing-images` 规则——pytest 在主镜像容器内跑（同步单测用 compose 内官方 minio 镜像实例或 fake S3 client；容器运行时单测用 fake docker client）；container 模式 e2e 新增脚本挂载宿主 docker.sock、`OH_SESSION_IMAGE` 指向既有镜像 tag；`process` 默认模式全量既有测试必须保持绿。
