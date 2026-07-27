# unified-backend-image Delta Spec

单一主镜像承载 openharness CLI + 视频服务(api) + 会话服务(session) 的依赖与代码烧录契约。

## ADDED Requirements

### Requirement: 主镜像 venv 依赖为两服务 pyproject 并集
主镜像 MUST 在 `/root/.openharness-venv` 中安装 `service/pyproject.toml` 与
`session-service/pyproject.toml` 中 `[project].dependencies` 的并集（`Dockerfile`
全量路径与 `Dockerfile.fix` 增量路径均如此），且版本约束逐条与 pyproject 对齐。依赖清单块 MUST 带注释标注来源为两个 pyproject 的并集。

#### Scenario: session-service 依赖导入成功
- **WHEN** 在新镜像容器内以 `working_dir=/opt/oh-session-service` 执行
  `python -c "import app.main"`
- **THEN** 导入成功，无 `ModuleNotFoundError`（structlog、websockets、boto3、
  prometheus_client、opentelemetry、httpx、psutil 均可导入）

#### Scenario: 视频服务依赖导入成功（回归）
- **WHEN** 在新镜像容器内以 `working_dir=/opt/oh-service` 执行
  `python -c "import app.main"`
- **THEN** 导入成功，无 `ModuleNotFoundError`

### Requirement: session-service 代码烧录进镜像
主镜像 MUST 将 `session-service/` 烧录到 `/opt/oh-session-service`（与
`service → /opt/oh-service` 对称）。`/opt/oh-session-service` MUST NOT 加入镜像
全局 `PYTHONPATH`（两服务顶层包同名 `app`，加入会互相污染导入）。

#### Scenario: 无挂载 standalone 运行
- **WHEN** 不挂载任何 volume，以 `working_dir=/opt/oh-session-service` 启动
  `uvicorn app.main:app --port 8001`
- **THEN** 服务基于镜像烧录代码正常启动

#### Scenario: 挂载覆盖热更新
- **WHEN** compose 挂载 `./session-service:/opt/oh-session-service` 启动
- **THEN** 运行的是宿主机代码，镜像烧录代码被遮蔽

### Requirement: 增量构建路径可补齐存量镜像
`Dockerfile.fix` MUST 能以现有主镜像为 `BASE_IMAGE` 增量补装依赖并集并烧录
session-service 代码，构建过程 MUST NOT 触发模型/浏览器等大体积资源的重新下载。

#### Scenario: 基于现有镜像增量构建
- **WHEN** 执行 `docker build -f Dockerfile.fix --build-arg BASE_IMAGE=<现有 tag>
  -t <新 tag> .`
- **THEN** 构建成功，新镜像包含依赖并集与 `/opt/oh-session-service` 代码

### Requirement: compose 后端服务共用主镜像且一键启动可用
compose 的 `api`、`session`、`openharness`、`shell` 服务 MUST 通过 `extends` 共用
同一主镜像（新版本 tag）；`session` 服务 MUST 显式设置
`working_dir: /opt/oh-session-service`。MUST NOT 为 session 引入独立后端镜像。

#### Scenario: 一键启动后端全绿
- **WHEN** 执行 `docker compose up -d api session session-frontend`
- **THEN** api `/healthz`、session 直连 `/healthz`（db/redis ok）、
  `http://localhost:5174/healthz`（session-frontend nginx 反代）均返回 200，
  且 session 容器日志无 import 错误

#### Scenario: 版本回滚
- **WHEN** 将 compose 的镜像版本 tag 改回旧值并重启服务
- **THEN** 服务回到旧镜像运行（旧 tag 镜像保留未删除）
