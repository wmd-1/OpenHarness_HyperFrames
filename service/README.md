<!-- 最后更新：2026-07-30 -->

# service — OpenHarness 视频生成服务

FastAPI + Celery 的异步视频生成后端：接收 prompt，调度 `oh` CLI 在隔离
workspace 中产出视频，经 SSE 推送进度、以 MinIO（或本地卷）持久化产物。
与交互会话服务 `session-service/` 平级共存（共享 Postgres/Redis/MinIO，
按路径路由：`/v1/videos/**` → 本服务 :8000）。

## 目录结构

```
service/
├── app/
│   ├── main.py              # FastAPI app + 中间件（鉴权/CORS/限流）
│   ├── config.py            # OH_ 前缀环境变量配置（pydantic-settings）
│   ├── db.py                # async engine + session factory
│   ├── models.py            # video_tasks 等 ORM 模型
│   ├── schemas.py           # 请求/响应 Pydantic 模型
│   ├── security.py          # extra_oh_args 白名单 + 值校验
│   ├── ratelimit.py         # 令牌桶限流（fail-open）
│   ├── deps.py              # FastAPI 依赖注入
│   ├── routers/             # videos（任务 CRUD/file/events）、health
│   ├── workers/             # celery_app / tasks / runner（oh 子进程）/
│   │                        #   parser / scheduler / beat / identity
│   ├── storage/             # 产物存储抽象：local / s3(MinIO)，keys 带租户前缀
│   └── observability/       # structlog + prometheus + otel
├── alembic/                 # 数据库迁移（与 session-service 独立 version table）
├── scripts/
│   ├── manage_api_keys.py   # 多租户 API Key 管理（create/revoke/list）
│   └── purge_tenant.py      # 清理租户数据
├── tests/                   # pytest 套件（容器内执行）
├── API_DOCUMENTATION.md     # 完整 API 文档
└── pyproject.toml
```

## 运行方式

由仓库根 `docker-compose.yml` 编排，**不在宿主机直接运行**：

```bash
docker compose up -d api        # 自动拉起 postgres/redis/minio 依赖
docker compose logs -f api
```

- 容器入口：`alembic upgrade head && exec oh-serve`（幂等迁移，失败 fail-fast）。
- 镜像内进程拓扑（`docker/supervisord.conf`）：uvicorn（:8000, 2 workers）
  + celery worker（队列 `high,normal,low`，并发 `OH_CELERY_CONCURRENCY`，默认 4）
  + celery beat。
- 源码经 volume 挂载到 `/opt/oh-service`，改代码无需重建镜像。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` · `/readyz` | 健康 / 就绪检查 |
| POST | `/v1/videos` | 创建任务（201），支持 `idempotency_key` 幂等 |
| GET | `/v1/videos/{id}` | 查询任务（`queued/running/succeeded/failed/canceled`） |
| GET | `/v1/videos/{id}/file` | 视频产物：配置 `OH_S3_PUBLIC_ENDPOINT` 时 302 presigned URL，否则 HTTP Range 流式 |
| GET | `/v1/videos/{id}/events` | SSE 事件流（`log`/`done`/`error`） |
| DELETE | `/v1/videos/{id}` | 取消/删除任务 |

请求/响应 schema、错误码、鉴权细节见 [API_DOCUMENTATION.md](API_DOCUMENTATION.md)。

## 关键配置（环境变量前缀 `OH_`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OH_DB_URL` / `OH_DB_SYNC_URL` / `OH_DB_MIGRATION_URL` | — | Postgres 连接（async / sync / 迁移） |
| `OH_BROKER_URL` | — | Celery broker（compose 内 redis db=0） |
| `OH_STORAGE_KIND` | `s3` | 产物存储：`s3`（MinIO 权威源，key = `tenants/{tid}/videos/{task_id}.mp4`）或 `local`（共享卷旧拓扑） |
| `OH_S3_ENDPOINT` / `OH_S3_BUCKET` / `OH_S3_ACCESS_KEY` / `OH_S3_SECRET_KEY` | compose 注入 | MinIO 坐标，与 session 侧共用 `oh-tenants` bucket |
| `OH_S3_PUBLIC_ENDPOINT` | 空 | 公网可达的 MinIO 地址；未配置时下载端点自动流式兜底，不向客户端发内网 302 |
| `OH_API_KEY` / `OH_REQUIRE_AUTH` | 空 / `false` | `X-API-Key` 鉴权；多租户 key 存 `api_keys` 表（`scripts/manage_api_keys.py`） |
| `OH_CORS_ORIGINS` | 空 | 允许跨域的来源（逗号分隔）；为空不允许跨域 |
| `OH_VIDEO_DIR` / `OH_WORKSPACE_ROOT` | compose 注入 | 产物目录 / 任务 workspace 根 |
| `OH_WORKER_QUEUES` / `OH_CELERY_CONCURRENCY` | `high,normal,low` / `4` | worker 队列与并发（supervisord env-fallback） |

完整清单见 [app/config.py](app/config.py) 与仓库根 [.env.example](../.env.example)。

## 测试

按仓库规范，测试**只在已有镜像内执行**（宿主机仅用 docker/curl）：

```bash
# 单测/集成（主镜像容器内 pytest；依赖 postgres/redis 时用 compose 内置服务）
docker compose run --rm --entrypoint bash openharness \
  -c "cd /opt/oh-service && python -m pytest tests/ -x -q"

# 多实例 E2E（api x2 / worker x2 + beat + postgres/redis/minio）
bash e2e/run_e2e.sh

# MinIO 多租户冒烟
bash e2e/run-video-minio-smoke.sh
```

> 注：主镜像未装 pytest 时改用 `oh-e2e-test` 系列叠层镜像（见 `Dockerfile.e2e` / `Dockerfile.test`）。

## 相关文档

- 完整 API 契约：[API_DOCUMENTATION.md](API_DOCUMENTATION.md)
- 代码审查记录：`CODE_REVIEW_REPORT*.md`
- 规格：`openspec/specs/video-service-hardening.md`、`video-tenant-storage.md`
