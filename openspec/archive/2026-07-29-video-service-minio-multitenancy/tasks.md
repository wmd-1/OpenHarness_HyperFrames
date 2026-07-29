# Tasks: video-service-minio-multitenancy

> 实施顺序 = 计划 P1→P4；每阶段收尾必须在**已有镜像容器内**跑测试（`test-on-existing-images.md`）：
> `docker compose run --rm --entrypoint bash api -c "cd /opt/oh-service && python -m pytest tests/ -x"`。
> 回归底线：local + 开放模式下存量测试零改动全绿。

## 1. P1 / WS-A 多 key 租户认证

- [x] 1.1 新增 `service/alembic/versions/xxx_api_keys.py` 幂等 migration：inspector 探测 `api_keys` 已存在即跳过，否则建表（`id/key_hash/tenant_id/label/active/created_at`）+ `key_hash` 唯一索引；downgrade 仅删自建的表
- [x] 1.2 `config.py` 新增 `OH_APIKEY_CACHE_TTL`（默认 60）；`models.py` 新增 `ApiKey` ORM 模型（映射共用表，不改 session 侧定义）
- [x] 1.3 新增租户解析函数（`security.py`）：三段式（开放模式→`default`；命中 `settings.api_key` 常数时间比对→`default`；`sha256` 查表 `active=true`→行 `tenant_id`；未命中→401），带进程内 TTL 缓存
- [x] 1.4 改造 `main.py` 鉴权中间件：调用解析函数，将 `tenant_id` 挂 `request.state`；`/healthz`、`/readyz` 豁免不变；`require_auth=true` 且无任何 key 源时启动仍抛 `RuntimeError`
- [x] 1.5 `/file`、`/events` 两端点支持 `?api_key=` 查询参数回退（走同一解析函数）
- [x] 1.6 新增 key 管理脚本 `service/scripts/manage_api_keys.py`（create/list/deactivate；tenant_id 白名单正则校验）
- [x] 1.7 测试：`tests/test_tenant_auth.py`（开放模式/单 key/多 key/401/active=false/查询参数回退/TTL 缓存）；容器内全量 pytest 通过

## 2. P2 / WS-B 数据模型与 API 租户隔离

- [x] 2.1 migration `005_tenant_id`：`video_tasks.tenant_id String(128) NOT NULL DEFAULT 'default'` + backfill + 索引 `(tenant_id, created_at)`；`idempotency_key` 全局 unique → `UNIQUE (tenant_id, idempotency_key)`；downgrade 完整可逆
- [x] 2.2 `models.py` 补 `tenant_id` 列；`routers/videos.py` 新增 `_get_owned_task_or_404(task_id, tenant_id, db)` 并在 GET/{id}、/file、/events、DELETE 全部套用（跨租户统一 404）
- [x] 2.3 create 端点：落 `tenant_id`、幂等 SELECT 加租户过滤；新增 `tenant_max_active` 配置（默认 4）与 QUEUED+RUNNING 计数检查（超出 429）
- [x] 2.4 `ratelimit.py`：令牌桶键改 `tenant_id`，`default` 租户回退 IP 键；fail-open 行为不变
- [x] 2.5 测试：`tests/test_tenant_isolation.py`（跨租户 404×4 端点、幂等键租户内唯一、配额 429 与释放、租户限流独立/default 回退 IP）；存量 ratelimit/idempotency 测试零改动通过

## 3. P3 / WS-C MinIO 权威存储

- [x] 3.1 新增 `app/storage/keys.py::video_object_key(tenant_id, task_id)`：白名单正则 `^[A-Za-z0-9._-]{1,128}$` 校验 + 单点生成 `tenants/{tid}/videos/{task_id}.mp4`
- [x] 3.2 `VideoStorage.save(task_id, src)` → `save(key, src)`：`LocalVideoStorage` 按相对 key 落 `{video_dir}/…`（mkdir parents，兼容存量平铺 key）；`S3VideoStorage` 以 key 为对象名；调用方同步更新
- [x] 3.3 修 bug：`workers/tasks.py` 保存改 `storage_for_kind(settings.storage_kind)` 并写行 `storage_kind`；`cleanup_expired_tasks` 与 DELETE 端点按任务行 `storage_kind` 解析后端删除
- [x] 3.4 `config.py` 新增 `OH_S3_PUBLIC_ENDPOINT`；`s3.py` presigned 配置公网地址时用独立 client 签发、未配置时返回 `None`（下载端点自动流式兜底，不发容器内网 302）
- [x] 3.5 lifespan 幂等 `ensure_bucket`（不可达仅告警）；`readyz` 在 `storage_kind=s3` 时追加短超时 S3 探活
- [x] 3.6 测试：`tests/test_tenant_storage.py`（key 生成/恶意 tenant_id 拒绝、local 新旧 key 兼容、worker 按配置保存/按行删除、presigned 公网地址与 None 兜底、ensure_bucket 幂等）；容器内全量 pytest 通过

## 4. P4 / WS-D 部署、运维与文档

- [x] 4.1 `docker-compose.yml`：新增 `minio` 服务（`minio/minio` 官方镜像 + `oh-minio` 卷 + healthcheck + 宿主 9000/9001）；`api` 追加 `OH_STORAGE_KIND=s3`、`OH_S3_ENDPOINT=http://minio:9000`、`OH_S3_BUCKET=oh-tenants`、`${MINIO_ROOT_USER/PASSWORD}` 凭据、`OH_S3_PUBLIC_ENDPOINT=${OH_S3_PUBLIC_ENDPOINT:-}` 与 `depends_on: minio: service_healthy`
- [x] 4.2 `.env.example` 增补 `MINIO_ROOT_USER/MINIO_ROOT_PASSWORD/OH_S3_PUBLIC_ENDPOINT` 占位与注释（公网地址由运维部署期提供，未配置时 stream 兜底）
- [x] 4.3 新增 `service/scripts/purge_tenant.py`：删 `tenants/{tid}/videos/` 前缀对象 + 该租户 `video_tasks` 行；不越界 session 子前缀；干跑（--dry-run）支持
- [x] 4.4 新增 `e2e/run-video-minio-smoke.sh`：基于已有镜像 `docker compose up` 后仅用 curl 验证（双 key 建任务→跨租户 404→下载 stream 兜底→purge 后 404），不构建新镜像
- [x] 4.5 文档转正：`service/API_DOCUMENTATION.md` §7 由「规划中」改为实际行为并入 §1.1/§2.x；计划文件标记完成
- [x] 4.6 最终回归：容器内全量 pytest + e2e 冒烟全绿；`openspec status` 确认工件齐备后走 sync/archive 流程
