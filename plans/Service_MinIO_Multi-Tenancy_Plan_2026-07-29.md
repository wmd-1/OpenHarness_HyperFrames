# Video Service（service/）多租户：MinIO 对象存储 + 用户 id 切换 —— 实现计划

> **立项记录（2026-07-29）** —— 本文件为 `service/`（FastAPI 视频服务）多租户改造的统一设计源，对应单一 OpenSpec 变更 `video-service-minio-multitenancy`。
>
> ✅ **实施完成（2026-07-29）**：P1–P4 全部交付（WS-A 多 key 租户认证、WS-B 数据模型与 API 租户隔离、WS-C MinIO 权威存储、WS-D 部署运维文档），验收情况见 §7 成功标准勾选状态；`API_DOCUMENTATION.md` 多租户章节已由「规划中」转正。
>
> - 核心方向（用户已确认）：**租户经 MinIO 云存储实现，按用户 id 切换**——`tenant_id` = 用户 id，视频产物的权威存储从本地卷迁移到 MinIO，对象 key 按租户前缀隔离。
> - 与姊妹计划《Container_Pool_Multi-Tenancy_Plan_2026-07-29.md》（session-service）**共用**：MinIO 实例、bucket 租户前缀约定（`tenants/{tid}/…`）、`api_keys` 认证设计（D1 同构）。
> - **rev1（2026-07-29，已确认）**：Q1–Q4 已全部裁决（见 §10）——①service 与 session 两后端**不会同时运行**，api_keys 并发落地风险消除（迁移仍保持幂等）；②`OH_S3_PUBLIC_ENDPOINT` 部署期由运维经 `.env` 提供，未配置时 stream 兜底；③存量对象不搬迁；④前端多租户另立计划，本期仅在 `API_DOCUMENTATION.md` 落补充说明（已随本计划完成）。
> - 全文区分 **已验证事实（VERIFIED）** 与 **设计决策（DECISION）**；推断性内容标注 `[INFERRED]`。

---

## 0. 代码核实结论（VERIFIED）

以下为对当前 `service/` 源码的实读结论，是本设计的前提。

| #    | 事实 | 证据位置 |
| ---- | ---- | -------- |
| 0.1  | 认证为**可选单全局 key**：`OH_API_KEY` + `OH_REQUIRE_AUTH`，中间件仅做常数时间比对，**无任何租户概念**（全库 grep `tenant` 在 `service/app` 下零命中） | `app/main.py` api_key_middleware、`app/config.py` |
| 0.2  | `video_tasks` 表无租户列；`idempotency_key` 为**全局 unique** | `app/models.py:48-50` |
| 0.3  | 存储抽象已就绪：`VideoStorage` 协议 + `LocalVideoStorage` / `S3VideoStorage`（boto3，`endpoint_url` 可配 → **天然兼容 MinIO**）；按 `OH_STORAGE_KIND` 选择，逐任务记录 `storage_kind` 列；下载端点已支持 S3 presigned URL 302 重定向 | `app/storage/s3.py`、`app/deps.py:storage_for_kind`、`app/routers/videos.py:238-241` |
| 0.4  | **既有 bug**：worker 与清理任务**硬编码 `LocalVideoStorage()`**——`OH_STORAGE_KIND=s3` 时任务行记 `storage_kind='s3'`（`videos.py:127`）但产物实际存本地 → 下载必坏。本改造必须顺带修复 | `app/workers/tasks.py:334`、`tasks.py:462` |
| 0.5  | S3 对象 key = `{task_id}.mp4`，**无任何前缀** | `app/storage/s3.py:48` |
| 0.6  | 五个端点（POST、GET /{id}、GET file、GET events、DELETE）**均无归属校验**：持全局 key（或开放模式）者拿到 uuid 即可读/删任意任务 | `app/routers/videos.py:_get_task_or_404` |
| 0.7  | 速率限制仅按**客户端 IP**（POST /v1/videos 令牌桶） | `app/ratelimit.py`、`videos.py:104-106` |
| 0.8  | compose：`api` 服务 = uvicorn + celery worker/beat 同容器（`oh-serve`）；**尚无 minio 服务**；产物存 `oh-videos` 本地卷；源码 volume 挂载，改代码免重建镜像 | `docker-compose.yml:124-171` |
| 0.9  | workspace 为临时目录（`/workspaces/{task_id}`），任务终态后 eager 清理，不长期承载租户数据 | `app/workers/tasks.py:_cleanup_workspace` |
| 0.10 | session-service 计划 rev2 已确立：MinIO 为租户数据权威源、bucket 前缀 `tenants/{tid}/`、`api_keys` 表（key_hash→tenant_id）认证设计；两服务**共用同一 Postgres 库 `oh`**（各自独立 alembic version table） | `plans/Container_Pool_Multi-Tenancy_Plan_2026-07-29.md` §3.1/§4、`docker-compose.yml` |
| 0.11 | alembic 迁移当前至 `004_task_list_index`，`api` 服务启动时自动 `alembic upgrade head` | `alembic/versions/`、`docker-compose.yml:129` |

---

## 1. 问题陈述（Problem Statement）

1. **无租户边界**：所有调用方共享同一 key、同一任务空间，任意任务对任意持 key 者可见/可删（事实 0.1/0.6）。
2. **产物无归属**：视频对象以裸 `{task_id}.mp4` 平铺（事实 0.5），无法按用户隔离、审计或注销清除；且产物在本地卷，多节点/换机即丢。
3. **s3 路径实际不可用**：worker 硬编码本地存储（事实 0.4），`storage_kind=s3` 配置形同虚设。
4. **配额与限流不分租户**：仅 per-IP 限流（事实 0.7），NAT 后多用户互相误伤、单用户换 IP 即可刷爆。

---

## 2. 目标与范围概览

四个可独立交付的工作流（WS），依赖 WS-A → WS-B → WS-C → WS-D：

- **WS-A 多 key 租户认证**：`api_keys` 表（与 session-service D1 同构、同库共用）+ key→tenant_id（=用户 id）解析中间件；兼容现有单 key / 开放模式。
- **WS-B 数据模型与 API 租户隔离**：`video_tasks.tenant_id` 列 + 全端点归属校验（跨租户 → 404）+ 幂等键改租户内唯一 + per-tenant 限流/配额。
- **WS-C MinIO 权威存储**：修复 worker 存储选择 bug；对象 key 改为 `tenants/{tid}/videos/{task_id}.mp4`；compose 增设 minio 服务；`OH_STORAGE_KIND=s3` 成为多租户部署默认。
- **WS-D 部署、运维与文档**：.env / compose env、租户注销脚本、API_DOCUMENTATION 增补、e2e 冒烟。

**非目标（明确排除）**：租户管理 API（key 增删走脚本，复用/对齐 session-service 的 `manage_api_keys.py`）；用户注册/OAuth；跨服务统一网关；历史存量对象迁移工具（见 §7 兼容策略——存量行靠 `storage_kind`+`output_path` 自描述，无需搬迁）；web 前端多租户改造（另立计划）。

---

## 3. 目标架构（DECISION）

```
 client ──X-API-Key──▶ ┌──────────────────────────────────────────┐
                       │  api（FastAPI + celery，现有容器不变）        │
                       │  auth: api_keys 表 → tenant_id (=用户 id)  │
                       │  所有 DB 查询 / 限流 / 配额 按 tenant 隔离    │
                       └───────┬──────────────────────┬───────────┘
                               │ boto3 (S3 API)       │ SQL
                               ▼                      ▼
                       ┌───────────────────┐   ┌──────────────┐
                       │ MinIO (bucket:    │   │ Postgres     │
                       │  oh-tenants)      │   │ video_tasks  │
                       │ tenants/{tid}/    │   │  + tenant_id │
                       │   videos/{id}.mp4 │   │ api_keys(共用)│
                       └───────────────────┘   └──────────────┘
   下载：GET /file → 302 presigned URL（API 不代理对象体，现有能力直接复用）
```

### 3.1 租户身份与切换（DECISION D1）

- **tenant_id = 用户 id**，唯一来源是请求认证结果；「切换用户 id」= 换一把 API key，服务端全链路自动切换到该租户的任务空间与对象前缀。**不信任任何客户端自报头**（如 `X-User-Id`）作为租户来源——否则隔离形同虚设。
- 解析顺序（与 session-service 计划 §4 逐字对齐，两边行为一致）：
  1. 开放模式（未配 key 且 `api_keys` 表空）→ tenant=`default`（现状兼容，单机自用）；
  2. 命中 `settings.api_key`（常数时间比对）→ tenant=`default`（单 key 向后兼容）；
  3. `sha256(key)` 查 `api_keys`（`active=true`）→ 命中取 `tenant_id`；未命中 → 401。
- 解析结果挂 `request.state.tenant_id`；新增依赖 `get_tenant_id(request)` 供路由注入。查表结果进程内 TTL 缓存（默认 60s，`OH_APIKEY_CACHE_TTL`）。
- **D1.3 api_keys 表共用**：service 与 session-service 同库（事实 0.10），**共用同一张 `api_keys` 表**——一把 key 同时决定两个服务里的用户身份。**Q1 已裁决：两后端不会同时运行**，不存在并发迁移/并发访问竞态；两侧 migration 仍写成幂等（先查 inspector，表已存在即跳过）以保证任一侧先落地都成立。表结构以 session 计划 D1 为准：`id / key_hash / tenant_id / label / active / created_at`。
- SSE（`/events`）与文件下载（`/file`）浏览器场景无法自定义头：支持 `?api_key=` 查询参数回退，复用同一解析函数（对齐 session-service A2 约束）。

### 3.2 数据模型与 API 隔离（DECISION D2）

- **Migration `005_tenant_id`**：
  - `video_tasks.tenant_id`：`String(128) NOT NULL DEFAULT 'default'`，建索引 `ix_video_tasks_tenant_created (tenant_id, created_at)`；存量行 backfill 为 `'default'`。
  - `idempotency_key`：删全局 unique，改为 `UNIQUE (tenant_id, idempotency_key)`——不同用户可用相同幂等键互不干扰。
- **端点归属校验**：`_get_task_or_404(task_id, db)` → `_get_owned_task_or_404(task_id, tenant_id, db)`，`WHERE id=? AND tenant_id=?`，跨租户一律 **404**（不泄露存在性）。五个端点全部套用；create 时任务行写入 `tenant_id`；create 的幂等 SELECT 加 `tenant_id` 过滤。
- **限流与配额**：
  - 令牌桶键从 IP 改为 `tenant_id`（开放/单 key 模式即 `default`，退化为现状全局桶+IP 键，行为不变）；
  - 新增 `tenant_max_active`（默认 4）：单租户 QUEUED+RUNNING 任务数上限，超出 → 429（防单用户囤积队列，实现为 create 时 count 查询，无需锁——超卖一两个可接受，非强一致配额）。
- SSE 日志流 / abort 标志等 Redis 键保持 task_id 维度不变——task_id 已经过归属校验才可达，无需再加租户前缀。

### 3.3 MinIO 权威存储（DECISION D3）

- **对象布局**：bucket 复用 session 计划的 `oh-tenants`（同一实例、同一租户根前缀，注销时一把删干净）：

  ```
  tenants/{tenant_id}/
  ├── openharness/…      # session-service 计划管辖（不动）
  ├── rules/…            # session-service 计划管辖（不动）
  └── videos/{task_id}.mp4   # ← 本计划新增，视频产物权威存储
  ```
- **D3.1 key 生成收敛在一处**：新增 `app/storage/keys.py :: video_object_key(tenant_id, task_id) -> "tenants/{tid}/videos/{task_id}.mp4"`；`tenant_id` 入库前经白名单校验（`^[A-Za-z0-9._-]{1,128}$`，key 创建脚本与中间件共同保证），杜绝前缀注入/路径穿越。
- **D3.2 存储协议签名调整**：`VideoStorage.save(task_id, src)` → `save(key, src)`（key 由调用方用 D3.1 生成）；`LocalVideoStorage` 同步改为按相对 key 存 `{video_dir}/tenants/{tid}/videos/…`（本地/**s3 两后端 key 语义统一**，`output_path` 列即完整 key）。`open/delete/exists/presigned_url` 本就以 key 为参，签名不动。
- **D3.3 修复 worker 存储选择（事实 0.4 的 bug）**：`generate_video_task` 与 `cleanup_expired_tasks` 改用 `storage_for_kind(...)` —— 保存走 `settings.storage_kind`，删除走**任务行记录的** `task.storage_kind`（行自描述，混合存量安全）。
- **D3.4 下载路径零改动**：`GET /file` 现有逻辑（s3 → presigned 302，否则流式）原样工作，因 `output_path` 已是完整对象 key。
- **D3.5 bucket 初始化**：api 启动 lifespan 内幂等 `ensure_bucket`（`head_bucket` 失败则 `create_bucket`），MinIO 不可达仅告警不阻断启动（本地模式无 S3 也要能起）；`/readyz` 在 `storage_kind=s3` 时追加 S3 探活（3s 超时，复用 s3.py 既有短超时配置）。
- **D3.6 租户注销** = 运维脚本 `scripts/purge_tenant.py`：删 `tenants/{tid}/videos/` 对象前缀 + DB 内该租户任务行（或仅置删除标记，脚本参数化）；与 session 计划 D2.9 的前缀删除各管各的子前缀，互不越界。
- **D3.7 workspace 不入 MinIO**：渲染中间产物量大且短命（事实 0.9），维持本地卷；与 session 计划 D2.10 口径一致。

### 3.4 配置与部署（DECISION D4）

- **复用现有 `OH_S3_*` settings**（`s3_endpoint/bucket/access_key/secret_key/region`，事实 0.3），不另造 `MINIO_*` 命名；`.env` 中同一组 MinIO 凭据即可同时喂 service（`OH_S3_*`）与 session-service（其计划中的 env 名）。
- compose 新增 `minio` 服务：官方 `minio/minio` 镜像（与 postgres/redis 同类的外部基础镜像拉取，**不违反禁止重建规则**），`oh-minio` named volume 持久化，healthcheck `mc ready local` 或 `curl /minio/health/live`；宿主端口发布 `9000/9001`（3000-3003 归 session、8000/8001/5173/5174 已占，9000 段无冲突；若部署机冲突可仅内网互通不发布）。
- **presigned 公网地址（Q2 已裁决）**：`OH_S3_PUBLIC_ENDPOINT` 由运维在部署期经 `.env` 提供（如 `http://<宿主IP>:9000`）；未配置时不生成 presigned 302，客户端走 `/file?mode=stream` 流式兜底（现有能力，无功能缺失）。
- `api` 服务 env 追加：`OH_STORAGE_KIND=s3`、`OH_S3_ENDPOINT=http://minio:9000`、`OH_S3_BUCKET=oh-tenants`、`OH_S3_ACCESS_KEY/SECRET_KEY=${MINIO_ROOT_USER/PASSWORD}`；`depends_on: minio: service_healthy`。
- 单机自用（不配 minio、`OH_STORAGE_KIND=local`）仍为合法拓扑：租户功能整体退化为 `default` 单租户 + 本地存储，**全部现状行为不变**。

---

## 4. 兼容与迁移策略（DECISION D5）

| 场景 | 行为 |
| ---- | ---- |
| 存量任务行（`tenant_id='default'`、`output_path='{id}.mp4'`、`storage_kind='local'`） | 行自描述：下载/删除按行内 `storage_kind`+`output_path` 解析，无需搬迁对象 |
| 旧客户端 + 单全局 key | 命中 D1 步骤 2 → `default` 租户，所见 = 全部存量任务，体验不变 |
| 开放模式（无任何 key） | 同上，全部现状测试应零改动全绿 |
| 切换 `OH_STORAGE_KIND=s3` 后回切 local | 各任务按行内 `storage_kind` 各读各的后端，混存安全 |
| web 前端（5173）| 开放/单 key 模式下不受影响；多 key 生产部署需前端带 key（Q4 已裁决：另立前端计划；本期已在 `service/API_DOCUMENTATION.md` 附「多租户演进补充说明」供前端计划引用） |

---

## 5. 影响分析（Impact Analysis）

| 组件 | WS-A 认证 | WS-B 隔离 | WS-C MinIO | WS-D 部署 |
| ---- | --------- | --------- | ---------- | --------- |
| DB/Migration | Yes（api_keys，幂等共用） | Yes（005_tenant_id） | No | No |
| main.py 中间件 | Yes（key→tenant 解析 + `?api_key=`） | No | 小（lifespan ensure_bucket） | No |
| config.py | 小（cache TTL） | 小（tenant_max_active） | No（OH_S3_* 已有） | No |
| routers/videos.py | 小（依赖注入 tenant） | Yes（归属校验/幂等/限流键） | No（下载零改动，D3.4） | No |
| workers/tasks.py | No | No | Yes（D3.3 修 bug + key 生成） | No |
| storage/* | No | No | Yes（D3.1/D3.2 签名与本地布局） | No |
| ratelimit.py | No | Yes（键改 tenant） | No | No |
| compose/.env | No | No | No | Yes（minio 服务 + env） |
| 依赖 | No | No | No（boto3 已有） | No |
| 前端 | No | No | No | No（文档标注） |

## 6. 风险与缓解（Risks & Mitigations）

| 风险 | 概率 | 影响 | 缓解 |
| ---- | ---- | ---- | ---- |
| 两个服务的 `api_keys` migration 并发落地冲突（同库） | Low | Med | Q1 已裁决两后端不同时运行，并发竞态消除；D1.3 双方 migration 仍保持幂等（inspector 探测已存在即跳过），任一侧先落地均成立 |
| `LocalVideoStorage` 布局改动破坏存量本地文件下载 | Med | High | 存量行 `output_path` 不变，`open()` 按 key 相对 `video_dir` 解析即兼容平铺旧 key（`{id}.mp4` 也是合法相对路径）；单测覆盖新旧两种 key |
| presigned URL 的 endpoint 为容器内地址（`http://minio:9000`），宿主/公网客户端不可达 | High | Med | Q2 已裁决：`OH_S3_PUBLIC_ENDPOINT` 部署期由运维经 `.env` 提供，生成 presigned 用公网/宿主可达地址的独立 client；未配置时 `/file?mode=stream` 流式兜底（现有能力） |
| 幂等键 unique 约束变更时存量重复数据阻塞 migration | Low | Med | 005 先 backfill tenant='default' 再建复合 unique；全局 unique 本就保证无重复，(default, key) 复合不会新增冲突 |
| MinIO 宕机拖垮 API | Low | Med | s3.py 既有 3s/5s 短超时（事实 0.3 代码注释 R8/R11）；readyz 反映降级；上传失败任务按现有 FAILED 路径落库 |
| tenant_id 注入对象 key（路径穿越/前缀逃逸） | Low | High | D3.1 白名单正则集中校验 + key 生成单点收敛 + 单测覆盖恶意 id |
| per-tenant 限流键改动影响开放模式行为 | Low | Low | default 租户回退 IP 键，现状语义保留；既有 ratelimit 测试不动应全绿 |

## 7. 成功标准（Success Criteria）

- [x] **WS-A**：两把不同 key 各自 POST 的任务互相 GET/DELETE/file/events → 404；无效 key → 401；单 key 旧配置与开放模式行为不变；`?api_key=` 在 file/events 可用。（容器内 pytest 验证）
- [x] **WS-B**：租户 A 列不到/摸不到租户 B 的任务；相同 `idempotency_key` 在两租户各自生效；租户 A 达到 `tenant_max_active` 时 429 而租户 B 不受影响。（容器内 pytest 验证）
- [x] **WS-C**：`OH_STORAGE_KIND=s3` 下全链路（POST → 渲染 → 对象落 `tenants/{tid}/videos/{id}.mp4` → GET /file 302 presigned → DELETE 后对象消失）打通；`storage_kind=local` 回归全绿；混合存量行（local 旧 key）下载正常。（容器内 pytest 180 通过；真 MinIO 链路见 WS-D 冒烟）
- [x] **WS-D**：`docker compose up -d api minio` 一键可用；`purge_tenant.py` 清空指定租户对象前缀与任务行；API_DOCUMENTATION 完成增补。（`e2e/run-video-minio-smoke.sh` 冒烟全绿；真 MinIO 下 healthz `s3:ok`、readyz 200）
- [x] 全量 `service/` pytest 在既有镜像容器内保持绿。（180 passed）

## 8. 实施阶段（Phases）

| Phase | 内容 | 交付物 | 依赖 |
| ----- | ---- | ------ | ---- |
| P1 | WS-A：api_keys 幂等 migration、key→tenant 中间件（含 `?api_key=`）、TTL 缓存、key 管理脚本（与 session 侧复用/对齐）、测试 | 多 key 认证可用 | — |
| P2 | WS-B：migration 005（tenant_id + 复合幂等 unique + 索引）、全端点归属校验、per-tenant 限流/`tenant_max_active`、测试 | API 层租户隔离闭环 | P1 |
| P3 | WS-C：keys.py、存储协议签名调整、worker/cleanup 存储选择修复（事实 0.4）、ensure_bucket + readyz 探活、`OH_S3_PUBLIC_ENDPOINT`、测试 | MinIO 权威存储打通 | P2 |
| P4 | WS-D：compose minio 服务 + env + .env.example（含 `OH_S3_PUBLIC_ENDPOINT` 占位）、`purge_tenant.py`、e2e 冒烟、API_DOCUMENTATION 多租户章节由「规划中」转正 | 可部署、可运维、有文档 | P3 |

## 9. 测试计划（遵循 test-on-existing-images 规则）

- **单元/集成（pytest）**：全部在主镜像容器内跑：
  `docker compose run --rm --entrypoint bash api -c "cd /opt/oh-service && python -m pytest tests/ -x"`；
  依赖 postgres/redis 时用 compose 既有服务。S3 单测沿用 `test_s3_storage.py` 的 fake client 注入模式（不触真 MinIO），新增用例：租户前缀 key、恶意 tenant_id、presigned public endpoint、worker 按 storage_kind 选后端、cleanup 混合后端删除。
- **迁移测试**：`test_migrations.py` 增补 005 往返（含幂等 unique 变更与存量 backfill）。
- **e2e 冒烟（真 MinIO）**：新增 `e2e/run-video-minio-smoke.sh`——`docker compose up -d api minio` 后宿主机仅用 `curl` 打通 §7 WS-C 全链路（双 key 隔离 + presigned 下载 + 删除）；不构建任何新镜像。
- **回归**：`OH_STORAGE_KIND=local` + 开放模式下，全部既有测试不改动且全绿。

## 10. 已决问题（Resolved，2026-07-29 用户裁决）

| # | 问题 | 裁决结论 | 落点 |
| - | ---- | -------- | ---- |
| Q1 | `api_keys` 表落地顺序协调 | **service 与 session 两后端不会同时运行**，无并发竞态；迁移保持幂等，谁先落地谁建表 | D1.3、风险表第 1 条 |
| Q2 | presigned URL 公网地址取值 | **部署期由运维经 `.env` 提供 `OH_S3_PUBLIC_ENDPOINT`**；未配置时 `/file?mode=stream` 兜底 | D4、风险表第 3 条 |
| Q3 | 存量本地视频是否搬迁入 MinIO | **不搬**（D5 行自描述兼容）；如需归档另写一次性脚本 | §4 兼容表 |
| Q4 | web 前端多 key 接入方式 | **本期不做，另立前端计划**；已在 `service/API_DOCUMENTATION.md` 追加「多租户演进补充说明（规划中）」章节供后续前端计划引用 | §4 兼容表末行、P4 |
