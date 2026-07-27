# unify-backend-image Tasks

## 1. Dockerfile（全量路径）

- [ ] 1.1 将 venv pip 依赖列表升级为 service/ 与 session-service/ 两个
  pyproject.toml 的 `[project].dependencies` 并集（新增 websockets、boto3、
  botocore、prometheus-client、structlog、psutil、opentelemetry-api/sdk/
  exporter-otlp、opentelemetry-instrumentation-{fastapi,celery,sqlalchemy,redis}、
  httpx），版本约束逐条对齐 pyproject，并加注释标注来源与同步要求
- [ ] 1.2 增加 `COPY session-service /opt/oh-session-service`（与
  `COPY service /opt/oh-service` 对称），确认 `/opt/oh-session-service` 不进入
  全局 PYTHONPATH
- [ ] 1.3 核对根 `.dockerignore` 不排除 session-service/（排除其
  `.venv`、`.pytest_cache`、`__pycache__` 等构建无关内容）

## 2. Dockerfile.fix（增量路径）

- [ ] 2.1 增加与 1.1 相同的依赖并集安装块（同注释锚点，pip 幂等跳过已满足包）
- [ ] 2.2 增加 `COPY session-service /opt/oh-session-service`
- [ ] 2.3 核对 Dockerfile 与 Dockerfile.fix 两份依赖清单一致

## 3. 构建与 compose 接线

- [ ] 3.1 以当前镜像为 BASE_IMAGE 执行 Dockerfile.fix 增量构建，打新版本 tag
  （版本段递增体现 session 整合），确认构建未触发模型/浏览器重新下载
- [ ] 3.2 更新 `docker-compose.yml` 的 `OH_VERSION_HYPERFRAMES_VERSION` 默认
  tag 为新版本；确认 session 服务保留 `working_dir: /opt/oh-session-service`

## 4. 验收（对应 spec 场景）

- [ ] 4.1 镜像内导入验证：session（workdir=/opt/oh-session-service）与
  api（workdir=/opt/oh-service）分别 `python -c "import app.main"` 无
  ModuleNotFoundError
- [ ] 4.2 standalone 验证：无挂载启动 uvicorn（烧录代码），端口 8001 可服务
- [ ] 4.3 联调全绿：`docker compose up -d api session session-frontend` 后
  api `/healthz`、session 直连 `/healthz`（db/redis ok）、
  `http://localhost:5174/healthz`（nginx 反代）均 200，session 日志无 import 错误
- [ ] 4.4 api 回归：视频服务 `/healthz` 200，celery worker 正常启动（补装依赖
  未破坏现有功能）
- [ ] 4.5 回滚演练确认：旧 tag 镜像仍存在，compose 改回旧 tag 即可回滚（不必
  实际切换，`docker images` 确认即可）
