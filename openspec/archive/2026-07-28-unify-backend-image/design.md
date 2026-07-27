# unify-backend-image Design

## Context

主镜像 `openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.42_v1.3_v2.0` 由两层构建：

- `Dockerfile`（全量，慢）：Python 3.11-slim + UV + openharness-ai + Node/Chrome/FFmpeg
  + Kokoro/whisper 模型预下载 + `COPY service /opt/oh-service`；venv pip 列表是
  早期视频服务的子集（fastapi/uvicorn/sqlalchemy/asyncpg/psycopg/alembic/
  celery/redis/pydantic-settings/sse-starlette/python-multipart）。
- `Dockerfile.fix`（增量，快）：`FROM ${BASE_IMAGE}` 叠加 skills 同步、pptx 依赖、
  wrapper 脚本重写等。日常迭代主要走这条路径。

compose 中 `api`（oh-serve → uvicorn+celery，`/opt/oh-service`，运行时挂载
`./service:/opt/oh-service`）、`session`（uvicorn `app.main:app` :8001，挂载
`./session-service:/opt/oh-session-service`）、`openharness`/`shell` 均 `extends`
同一镜像。

现状问题（联调实测）：
1. session 容器缺 `structlog` 等依赖 → import 即崩（`ModuleNotFoundError`）。
2. `working_dir` 缺失曾导致 uvicorn 从默认 workdir `/opt/oh-service` 导入烧录的
   旧视频服务代码（已在 compose 中用 `working_dir: /opt/oh-session-service` 修复）。
3. 主镜像 pip 列表落后 `service/pyproject.toml`（缺 boto3/structlog/otel/psutil/
   prometheus-client）；api 服务因运行时挂载 + 烧录旧代码的偶然组合未暴露。

已验证：向 venv 补装 session-service 依赖后（`oh-session-test:latest` 临时容器），
session `/healthz` 直连与经 session-frontend nginx 反代均 200。

## Goals / Non-Goals

**Goals:**

- api + session + openharness CLI 的全部运行依赖收敛进同一主镜像 venv。
- `session-service/` 代码烧录进镜像（`/opt/oh-session-service`），与 `service/` 对称；
  无挂载也能独立运行（standalone），有挂载则热更新（dev）。
- 提供增量构建路径（`Dockerfile.fix`）：在现有镜像上补齐，不触发模型重新下载。
- `docker compose up -d api session session-frontend` 一条命令后端全绿。

**Non-Goals:**

- 不为 session-service 建独立运行镜像（用户明确否决）。
- 不改动 `service/`、`session-service/` 任何应用代码与行为需求。
- 不重构 `oh-session-test:latest` / `oh-e2e-test:latest` 测试镜像体系。
- 不处理 alembic 自动迁移编排（session-service 启动时自迁移已有逻辑，维持现状）。

## Decisions

**D1 — 依赖以两个 pyproject.toml 的并集显式锁定，写死在 Dockerfile 中**
沿用现有 Dockerfile 的显式列表风格（而非 `pip install -e /opt/oh-service`）：
构建时 service/session-service 代码尚未 COPY（分层缓存友好），且 editable 安装会把
依赖解析耦合到代码层，任何代码改动都使依赖层缓存失效。并集清单（在现有列表基础上新增）：
`websockets>=13,<14`、`boto3>=1.34,<2`、`botocore>=1.34,<2`、
`prometheus-client>=0.20,<1`、`structlog>=24,<25`、`psutil>=6,<7`、
`opentelemetry-api/sdk/exporter-otlp>=1.27,<1.28`、
`opentelemetry-instrumentation-{fastapi,celery,sqlalchemy,redis}==0.48b0`、
`httpx>=0.27,<0.28`。版本约束逐条对齐 pyproject，Dockerfile 注释标注"并集自
service/ 与 session-service/ 的 pyproject.toml，改动依赖时需同步三处"。

**D2 — Dockerfile 与 Dockerfile.fix 双路径同步修改，验证走 fix 增量路径**
全量 `Dockerfile` 是长期真相（新机器冷构建必须正确）；`Dockerfile.fix` 是本次落地
与验证路径（基于现有 11.8GB 镜像增量 pip install + COPY，分钟级完成；全量重建含
whisper.cpp 编译与 ~1GB 模型下载，且无法保证外网稳定）。两处安装同一份依赖清单；
fix 中 pip 对已满足的包自动跳过，幂等。

**D3 — session-service 烧录到 /opt/oh-session-service，PYTHONPATH 不加入该路径**
与 `service → /opt/oh-service` 对称，运行时 volume 挂载可覆盖。区别于 service：
不把 `/opt/oh-session-service` 加进全局 `PYTHONPATH`（避免两个服务同名顶层包
`app` 互相污染——这正是 workdir 事故的根因）。session 靠 compose 的
`working_dir: /opt/oh-session-service` + uvicorn 从 CWD 导入 `app`；api 维持现有
`PYTHONPATH=/app/src:/opt/oh-service` 不变（改它影响 supervisord/oh-serve，超出范围）。

**D4 — 版本 tag 递增，不复用旧 tag**
`Dockerfile.fix` 构建产物打新 tag（`OH_VERSION_HYPERFRAMES_VERSION` 默认值同步更新，
版本段体现 session 整合，如 `..._v2.1`），旧镜像保留可回滚。compose 所有 extends
服务自动跟随。

**D5 — 验收即联调**
新镜像起 `api`、`session`、`session-frontend` 三服务：api `/healthz`、session
`/healthz`（含 db/redis ok）、`http://localhost:5174/healthz`（nginx 反代）均 200；
session 容器日志无 import 错误。api 侧回归：`docker compose up -d api` 后
`/healthz` 200（确认补装依赖未破坏视频服务）。

## Risks / Trade-offs

- [并集依赖版本冲突] → uv/pip 解析期即失败、构建可见；celery 5.4 + otel 0.48b0
  组合已在 service/ 及 oh-session-test 镜像验证过。
- [Dockerfile.fix 与 Dockerfile 清单漂移] → 两文件同注释锚点（"依赖并集"块），
  tasks 中含一致性核对步骤；长期漂移风险接受（fix 本就是增量补丁层）。
- [镜像体积 +~100MB] → 相对 11.8GB 基数可忽略；不做多阶段裁剪。
- [烧录代码与仓库代码不同步]（无挂载场景跑旧代码）→ 与 service/ 现状同构，
  compose 默认挂载覆盖；接受。
- [全量 Dockerfile 本次不实际重建验证]（模型下载/编译耗时且依赖外网）→ 以
  fix 路径验证依赖清单正确性等价覆盖；全量路径留待下次冷构建自然验证，风险接受。

## Migration Plan

1. 修改 `Dockerfile`（依赖并集 + COPY session-service）与 `Dockerfile.fix`（同依赖
   并集 + COPY session-service）。
2. `docker build -f Dockerfile.fix --build-arg BASE_IMAGE=<当前 tag> -t <新 tag> .`
3. `docker-compose.yml` 更新默认版本 tag；`docker compose up -d api session
   session-frontend` 验收（D5）。
4. 回滚：compose 版本 tag 改回旧值即可，旧镜像未删除。

## Open Questions

（无 — 端口、镜像命名、验收标准均已在前置讨论中确定。）
