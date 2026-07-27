# unify-backend-image Proposal

## Why

docker-compose 中 `session` 服务（session-service，端口 8001）无法启动：主镜像
`openharness_hyperframes_qwen-tts_pptx`（由 `Dockerfile` + `Dockerfile.fix` 构建）的
venv 缺少 session-service 的运行依赖（`structlog`、`websockets`、`boto3`、
`prometheus-client`、`opentelemetry-*`、`httpx`、`psutil` 等），且 compose 未指定
`working_dir`，uvicorn 曾误导入镜像内烧录的旧 `/opt/oh-service` 代码。同时主镜像的
pip 依赖列表已落后于 `service/pyproject.toml`（视频服务同样缺 boto3/structlog/otel，
仅因烧录旧代码未暴露）。刚交付的 session-frontend（端口 5174）依赖 session 后端可用。

明确取向：**不为 session 单独建镜像**，所有后端（api 视频服务 + session 会话服务）与
openharness CLI 整合进同一个主镜像，compose 的 api/session/openharness/shell 服务继续
`extends` 复用一个镜像。

## What Changes

- 修改 `Dockerfile`：venv pip 依赖列表升级为 `service/pyproject.toml` 与
  `session-service/pyproject.toml` 的并集（补 websockets、boto3/botocore、
  prometheus-client、structlog、psutil、opentelemetry 六件套、httpx、celery 保留）；
  烧录 `session-service/` 到 `/opt/oh-session-service`（与 `service → /opt/oh-service`
  对称），运行时仍可被 volume 挂载覆盖实现热更新。
- 修改 `Dockerfile.fix`（增量路径）：在现有主镜像之上补装同一依赖并集 + 烧录
  session-service 代码，避免全量重建（主镜像全量构建含模型下载，成本高）。
- `docker-compose.yml`：`session` 服务保留已加的 `working_dir: /opt/oh-session-service`
  （已验证生效）；镜像版本 tag 递增（`OH_VERSION_HYPERFRAMES_VERSION` 默认值更新）。
- 验证方法：基于新镜像跑通 `docker compose up -d api session session-frontend`，
  `/healthz`（api 直连 + session 直连 + 5174 nginx 反代）全部 200。

## Capabilities

### New Capabilities

- `unified-backend-image`: 单一主镜像承载 openharness CLI + 视频服务(api) +
  会话服务(session) 的依赖与代码烧录契约：依赖并集安装、双服务代码烧录路径、
  compose extends 复用、增量构建路径（Dockerfile.fix）、启动验收标准。

### Modified Capabilities

（无 — `interactive-session`、`video-service-hardening` 的行为需求不变，
本变更只解决其运行镜像的依赖承载问题。）

## Impact

- **文件**：`Dockerfile`、`Dockerfile.fix`、`docker-compose.yml`（版本 tag）、
  可能更新根 `.dockerignore`（session-service 构建上下文）。
- **镜像**：`openharness_hyperframes_qwen-tts_pptx` 体积小幅增加（纯 Python 包，
  约 +100MB 级别）；tag 递增，旧 tag 保留可回滚。
- **服务**：api/session/openharness/shell 四个 compose 服务共用新镜像；
  session-frontend 镜像不受影响（独立 nginx 镜像）。
- **风险**：依赖并集可能存在版本冲突（celery 5.4 与 otel-instrumentation-celery
  0.48b0 已在 service/ 验证兼容）；uv pip 一次性解析可提前暴露冲突。
