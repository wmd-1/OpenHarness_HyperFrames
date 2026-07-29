# Proposal: video-service-minio-multitenancy

## Why

视频服务（`service/`）当前无租户边界：认证是可选单全局 key，五个 `/v1/videos` 端点无归属校验（持 key 者拿到 uuid 即可读/删任意任务），产物以裸 `{task_id}.mp4` 平铺且权威存储在本地卷；主 spec 中 phase3 落成的 R14–R18（租户隔离/多 key 认证/配额/限流）至今未在代码中兑现。同时存在既有 bug：worker 与清理任务硬编码 `LocalVideoStorage()`，`OH_STORAGE_KIND=s3` 配置形同虚设。设计源见 `plans/Service_MinIO_Multi-Tenancy_Plan_2026-07-29.md`（**rev1 已确认**：tenant_id = 用户 id，经 API key 解析切换；MinIO 为产物权威存储，对象 key 按 `tenants/{tid}/videos/` 前缀隔离；Q1–Q4 已裁决——两后端不同时运行、`OH_S3_PUBLIC_ENDPOINT` 由运维经 `.env` 提供、存量不搬迁、前端另立计划）。

## What Changes

- **WS-A 多 key 租户认证**：新增 `api_keys` 表（与 session-service 计划 D1 同构、同库共用，migration 幂等——Q1 已裁决两后端不同时运行，无并发竞态）；中间件按「开放模式 → 单 key 兼容 → 哈希查表」次序解析 tenant_id（TTL 缓存默认 60s）；`GET /file`、`GET /events` 新增 `?api_key=` 查询参数回退；现有单 key / 开放部署行为不变。
- **WS-B 数据模型与 API 租户隔离**：migration `005`——`video_tasks.tenant_id`（NOT NULL DEFAULT 'default'，索引 `(tenant_id, created_at)`，存量 backfill）；`idempotency_key` 由全局 unique 改为 **`UNIQUE (tenant_id, idempotency_key)`**（**BREAKING**：DB 约束变更，语义为租户内唯一）；五端点全部归属校验（跨租户一律 404，不泄露存在性）；限流令牌桶键从 IP 改为租户（`default` 租户回退 IP 键，现状语义保留）；新增 `tenant_max_active`（默认 4，QUEUED+RUNNING 上限，超出 429）。
- **WS-C MinIO 权威存储**：对象 key 收敛单点生成 `tenants/{tenant_id}/videos/{task_id}.mp4`（tenant_id 白名单正则防前缀注入）；`VideoStorage.save(task_id, src)` → `save(key, src)`，本地后端按相对 key 落 `{video_dir}/…`（两后端 key 语义统一，兼容存量平铺 key）；**修复 worker/cleanup 硬编码本地存储的 bug**（保存按 `settings.storage_kind`、删除按任务行 `storage_kind`）；lifespan 幂等 `ensure_bucket`；`readyz` 在 s3 模式追加探活；新增 `OH_S3_PUBLIC_ENDPOINT`（运维经 `.env` 提供，presigned 用公网可达地址；未配置时不发 302，`?mode=stream` 兜底）。
- **WS-D 部署与运维**：compose 新增 `minio` 服务（官方镜像 + `oh-minio` 卷 + healthcheck，宿主端口 9000/9001）；`api` 服务追加 `OH_STORAGE_KIND=s3` 等 env 与 `depends_on: minio`；`.env.example` 增补；租户注销脚本 `scripts/purge_tenant.py`（删对象前缀 + 任务行）；e2e 冒烟 `e2e/run-video-minio-smoke.sh`；`API_DOCUMENTATION.md` §7 多租户章节由「规划中」转正。
- **明确不做**：租户管理 API、用户注册/OAuth、存量对象搬迁（行自描述兼容）、web 前端多租户（另立计划）、R17 审计与 R19 Temporal（本变更不触碰）。

## Capabilities

### New Capabilities

- `video-tenant-storage`：MinIO 作为视频产物的按租户权威存储——bucket/前缀布局（与 session 侧共用 `oh-tenants` bucket 的 `tenants/{tid}/` 租户根前缀，视频归 `videos/` 子前缀）、对象 key 单点生成与 tenant_id 白名单校验、本地/S3 双后端统一 key 语义与存量平铺 key 兼容、worker 按配置选后端且删除按任务行后端（修 bug）、bucket 幂等初始化与就绪探活、presigned 公网地址（`OH_S3_PUBLIC_ENDPOINT`）与 stream 兜底、租户注销即删对象前缀。

### Modified Capabilities

- `video-service-hardening`：
  1. **R15（API key 认证）**——由「单一 key 语义」落实为三段式解析（开放模式/单 key 兼容 → `default`；`api_keys` 哈希查表 → 对应 `tenant_id`）；`api_keys` 表与 session-service 同库共用、migration 幂等；`/file`、`/events` 新增 `?api_key=` 回退。
  2. **R14（租户隔离）**——跨租户响应统一定为 **404**（原 403/404 二选一）；范围明确为现有五端点（当前无 list 端点，list scoping 场景保留待该端点落地）；新增「幂等键租户内唯一」语义；实现路径定为查询级 scoping（`WHERE tenant_id=?`），不引入 RLS。
  3. **R16（per-tenant 配额）**——并发配额落实为 `tenant_max_active`（QUEUED+RUNNING，默认 4，非强一致计数可接受）；`daily_submit_limit` 本期从需求中移除（未实现且不在本变更范围，后续需要时再立项恢复）。
  4. **R18（per-tenant 限流）**——落实为令牌桶键 = `tenant_id`；`default` 租户（开放/单 key 模式）回退 IP 键以保持现状语义。
  5. **R10（对象存储抽象）**——存储接口按完整对象 key 操作（`save(key, src)`），产物 key 必须带租户前缀；下载/删除按任务行记录的 `storage_kind` 解析后端。

## Impact

- **代码**：`service/app/`（main.py 中间件与 lifespan、config.py、deps.py、routers/videos.py、ratelimit.py、storage/{base,local,s3,keys}.py、workers/tasks.py）、`alembic/versions/`（api_keys 幂等 + 005_tenant_id）、`scripts/purge_tenant.py`、`tests/`（新增租户/存储用例，存量用例零改动全绿）。
- **DB**：`api_keys` 新表（同库共用）；`video_tasks` 加 `tenant_id` 列与索引、幂等键约束改复合（**BREAKING** 约束变更，backfill 后无数据冲突）。
- **部署**：`docker-compose.yml`（minio 服务 + `oh-minio` 卷 + api env）、`.env.example`（`MINIO_ROOT_USER/PASSWORD`、`OH_S3_PUBLIC_ENDPOINT` 占位）；主镜像不重建（boto3 已有，无新依赖）。
- **API 兼容**：接口形状不变；开放/单 key 部署行为不变；多 key 模式下跨租户 404、限流/配额 429 语义生效（前端影响已在 `service/API_DOCUMENTATION.md` §7 预告）。
