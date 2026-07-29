# Design: video-service-minio-multitenancy

> 设计源（已确认 rev1）：`plans/Service_MinIO_Multi-Tenancy_Plan_2026-07-29.md`。本文按 OpenSpec 结构收敛该计划中的 DECISION，实施时以本文与 delta specs 为准。

## Context

- 视频服务 `service/` 现状（计划 §0 VERIFIED）：可选单全局 key 认证、`video_tasks` 无租户列、五端点无归属校验、限流仅按 IP；存储抽象（`VideoStorage` + local/s3 双后端、逐任务 `storage_kind` 列、presigned 302 下载）已就绪，但 worker/cleanup 硬编码 `LocalVideoStorage()`（`tasks.py:334/462`），`storage_kind=s3` 实际不可用。
- 主 spec `openspec/specs/video-service-hardening.md` 中 phase3 已落成 R14–R18（租户隔离/认证/配额/审计/限流）需求条文，但对应实现从未落地；本变更兑现其中 R14/R15/R16/R18 并按当下裁决修订其条文（R17 审计、R19 Temporal 不动）。
- 姊妹变更 `session-container-pool-multitenancy` 已确立：MinIO 权威源、bucket `oh-tenants`、租户根前缀 `tenants/{tid}/`、`api_keys` 表设计。两服务同库同 MinIO。
- 用户裁决（rev1）：①service/session 两后端**不会同时运行**；②`OH_S3_PUBLIC_ENDPOINT` 部署期由运维经 `.env` 提供，未配置时 stream 兜底；③存量对象不搬迁；④前端多租户另立计划（`service/API_DOCUMENTATION.md` §7 已附预告）。
- 约束：测试必须在已有镜像容器内执行（`test-on-existing-images.md`）；主镜像不重建；boto3 已在镜像内，无新增依赖。

## Goals / Non-Goals

**Goals:**

- tenant_id = 用户 id，由 API key 解析得出；换 key 即切换租户，全链路（任务可见性、限流、配额、对象前缀）自动切换。
- MinIO 成为视频产物权威存储，对象 key `tenants/{tenant_id}/videos/{task_id}.mp4`，与 session 侧共用租户根前缀，注销一把删净。
- 跨租户零可见（404）；开放/单 key 部署与全部存量测试零改动全绿。
- 修复 worker/cleanup 存储选择 bug。

**Non-Goals:**

- 租户管理 API、用户注册/OAuth、计费；R17 审计日志、R19 Temporal；存量对象搬迁；web 前端多租户改造（另立计划）；RLS（行级安全）——用查询级 scoping 实现 R14。

## Decisions

### D1 租户身份：api_keys 表哈希查表，三段式解析

- 解析次序（中间件 + `?api_key=` 回退共用同一函数）：开放模式（未配 key 且表空）→ `default`；命中 `settings.api_key`（常数时间比对）→ `default`；`sha256(key)` 查 `api_keys`（`active=true`）→ 行 `tenant_id`；均未命中 → 401。结果挂 `request.state.tenant_id`，进程内 TTL 缓存（`OH_APIKEY_CACHE_TTL`，默认 60s）。
- **为什么不用 `X-User-Id` 自报头**：租户来源必须绑定认证凭据，否则隔离形同虚设。
- **D1.3 表共用**：与 session-service 同库共用一张 `api_keys` 表（`id/key_hash/tenant_id/label/active/created_at`）。Q1 已裁决两后端不同时运行 → 无并发迁移/访问竞态；migration 仍写幂等（inspector 探测已存在即跳过），任一侧先落地均成立。
- `/file`、`/events` 支持 `?api_key=` 查询参数（浏览器 EventSource/下载无法自定义头），对齐 session-service A2 约定；`API_DOCUMENTATION.md` §1.1 的「仅支持请求头」届时对这两个端点失效（§7 已预告）。

### D2 数据模型与 API scoping：查询级过滤，跨租户 404

- Migration `005_tenant_id`：`tenant_id String(128) NOT NULL DEFAULT 'default'` + 索引 `(tenant_id, created_at)`；存量 backfill `'default'`；`idempotency_key` 全局 unique → `UNIQUE (tenant_id, idempotency_key)`（全局 unique 本就无重复，(default, key) 复合不会引入冲突）。
- `_get_owned_task_or_404(task_id, tenant_id, db)`：`WHERE id=? AND tenant_id=?`，跨租户统一 404（不泄露存在性；修订 R14 原「403 或 404」为定死 404）。五端点全套用；create 落 `tenant_id`、幂等 SELECT 加租户过滤。
- **为什么不用 RLS**：单应用单角色连接池下 RLS 需 `SET LOCAL` 贯穿含 Celery 的所有路径，复杂度远超收益；查询级 scoping + 单点 helper + 测试覆盖足够（R14 条文同步修订）。
- 限流：令牌桶键 = `tenant_id`；`default` 租户回退 IP 键（保持现状语义，存量 ratelimit 测试不动）。配额：`tenant_max_active`（默认 4，QUEUED+RUNNING count 查询，非强一致——瞬时超卖一两个可接受，避免引入锁）。
- Redis 键（`oh:logs:*`、`oh:abort:*`）保持 task_id 维度：task_id 必须先过归属校验才可达。

### D3 存储：key 单点生成 + 双后端统一语义 + 按行解析后端

- `app/storage/keys.py::video_object_key(tenant_id, task_id)` 单点生成 `tenants/{tid}/videos/{task_id}.mp4`；tenant_id 白名单 `^[A-Za-z0-9._-]{1,128}$`（key 管理脚本与中间件共同保证），防前缀注入/路径穿越。
- `VideoStorage.save(task_id, src)` → `save(key, src)`；`LocalVideoStorage` 按相对 key 落 `{video_dir}/tenants/…`（需 `mkdir parents`）。`output_path` 列 = 完整 key，**下载/删除端点零改动**（现有逻辑已按 key 操作）。存量平铺 key（`{id}.mp4`）是合法相对路径，天然兼容。
- **修 bug**：`generate_video_task` 保存改用 `storage_for_kind(settings.storage_kind)`；`cleanup_expired_tasks` 与 DELETE 端点删除按**任务行** `task.storage_kind`（行自描述，混合存量安全）。
- presigned：`OH_S3_PUBLIC_ENDPOINT` 配置时用独立 client（公网地址）生成；未配置时 `presigned_url` 返回 None → 现有代码自动落入流式路径（`?mode=stream` 或直接 stream），无功能缺失（Q2 裁决）。
- `ensure_bucket`：lifespan 内幂等（head → create），不可达仅告警不阻断（local 拓扑必须能起）；`readyz` 在 `storage_kind=s3` 时追加 S3 探活（复用 s3.py 3s/5s 短超时）。

### D4 部署：compose minio 服务，s3 为多租户默认

- `minio/minio` 官方镜像 + `oh-minio` 卷 + healthcheck；宿主端口 9000/9001（现有分配无冲突；可按需不发布）。`api` 追加 `OH_STORAGE_KIND=s3`、`OH_S3_ENDPOINT=http://minio:9000`、`OH_S3_BUCKET=oh-tenants`、凭据取 `${MINIO_ROOT_USER/PASSWORD}`、`OH_S3_PUBLIC_ENDPOINT=${OH_S3_PUBLIC_ENDPOINT:-}`，`depends_on: minio: service_healthy`。
- 不配 minio + `OH_STORAGE_KIND=local` 仍为合法拓扑：整体退化为 `default` 单租户 + 本地存储。
- 租户注销 = `scripts/purge_tenant.py`（删 `tenants/{tid}/videos/` 前缀 + 该租户任务行；只动本服务子前缀，不越界 session 数据）。

## Risks / Trade-offs

- [api_keys 双侧 migration 落地顺序] → Q1 裁决无并发；双方幂等迁移，谁先落地谁建表。
- [Local 布局改动破坏存量下载] → `output_path` 行自描述 + 平铺旧 key 是合法相对路径；单测覆盖新旧 key。
- [presigned 容器内地址不可达] → `OH_S3_PUBLIC_ENDPOINT` 运维提供；未配置时 stream 兜底（性能代价：API 代理对象体，接受）。
- [tenant_id 注入对象 key] → 白名单正则 + key 生成单点 + 恶意 id 单测。
- [MinIO 宕机] → 短超时 + readyz 降级 + 上传失败走既有 FAILED 路径；不影响 local 拓扑启动。
- [tenant_max_active 非强一致] → 有意取舍：瞬时超卖 1–2 个换取无锁；条文按此措辞（R16 修订）。
- [限流键改租户后单租户内多用户互相挤兑] → 本模型租户=用户，不存在该场景；default 租户回退 IP 键保护开放模式。

## Migration Plan

1. P1（WS-A）：api_keys 幂等 migration → 中间件三段式解析 + `?api_key=` → TTL 缓存 → key 管理脚本 → 测试。
2. P2（WS-B）：migration 005（backfill → 复合 unique → 索引）→ 五端点 scoping → 限流/配额 → 测试。
3. P3（WS-C）：keys.py → 存储签名调整与 local 布局 → worker/cleanup 修复 → ensure_bucket/readyz → public endpoint → 测试。
4. P4（WS-D）：compose/env → purge 脚本 → e2e 冒烟（`e2e/run-video-minio-smoke.sh`，仅 curl，不建新镜像）→ 文档转正。
- **回滚**：P1/P2 各自 alembic downgrade（005 down 恢复全局 unique 前需确认无跨租户重复幂等键）；P3 回滚 = `OH_STORAGE_KIND=local` 回切（行自描述，已入 MinIO 的对象仍可按行读取）；P4 纯部署层，compose 回退即可。
- **测试**：全程在既有镜像容器内（`docker compose run --rm --entrypoint bash api -c "cd /opt/oh-service && python -m pytest tests/ -x"`）；回归底线 = local+开放模式下存量测试零改动全绿。

## Open Questions

无——Q1–Q4 已全部裁决（见计划 §10）。
