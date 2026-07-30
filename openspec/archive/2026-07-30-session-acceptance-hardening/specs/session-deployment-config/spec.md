# Spec: session-deployment-config

## ADDED Requirements

### Requirement: stub 模式 compose override 固化
仓库 SHALL 提供 `docker-compose.stub.yml` override 文件，仅覆盖 `session` 服务的 `OH_OH_BIN`（指向 `scripts/oh_backend_stub.py`）与 `OH_IDLE_GRACE_SECONDS`。stub 模式 SHALL 以 `docker compose -f docker-compose.yml -f docker-compose.stub.yml` 方式启动，MUST NOT 依赖启动 shell 的临时环境变量覆盖。

#### Scenario: 使用 override 启动 stub 模式
- **WHEN** 执行 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`
- **THEN** session 容器内 `OH_OH_BIN` 指向 stub 脚本，与启动 shell 是否设置该变量无关

#### Scenario: 连带 recreate 不产生配置漂移
- **WHEN** 以 override 组合启动后，任何后续 `up` 操作（含 `depends_on` 连带 recreate）继续携带同一 `-f` 组合
- **THEN** session 容器的 `OH_OH_BIN` 保持指向 stub，不会静默回退到默认真 oh

### Requirement: OH_OH_BIN 配置语义与启动校验
`OH_OH_BIN` 的配置语义 SHALL 为**单一可执行文件路径**（作为 `create_subprocess_exec` 的 argv[0]），MUST NOT 支持带参数的 command 字符串；需要附加参数或解释器包装时 SHALL 使用可执行 wrapper 脚本。session-service SHALL 在应用启动阶段（lifespan）按以下规则校验 `OH_OH_BIN`：
1. 值不含空白字符（含空白视为误配 command，错误信息 SHALL 提示改用 wrapper 脚本）；
2. 路径存在且为普通文件；
3. 具有可执行权限（`os.access(X_OK)`）。

`OH_SESSION_RUNTIME=process` 时任一规则失败 SHALL 记录含当前配置值与修复提示的错误日志并终止启动（fail-fast）；`OH_SESSION_RUNTIME=container` 时 SHALL 降级为 WARN 日志且不阻断启动。

#### Scenario: process 运行时配置错误 fail-fast
- **WHEN** `OH_SESSION_RUNTIME=process` 且 `OH_OH_BIN` 指向不存在或不可执行的路径
- **THEN** 服务启动失败，错误日志包含当前 `OH_OH_BIN` 值与修复提示，不进入"首个 turn 才报错"状态

#### Scenario: 误配为带参数 command
- **WHEN** `OH_SESSION_RUNTIME=process` 且 `OH_OH_BIN` 值含空白字符（如 `python3 /path/stub.py`）
- **THEN** 服务启动失败，错误信息明确说明该变量仅接受单一可执行路径，并提示改用可执行 wrapper 脚本

#### Scenario: process 运行时配置正确
- **WHEN** `OH_OH_BIN` 指向存在且可执行的文件
- **THEN** 服务正常启动，无相关告警

#### Scenario: container 运行时降级告警
- **WHEN** `OH_SESSION_RUNTIME=container` 且网关本地看不到 `OH_OH_BIN` 路径
- **THEN** 仅记录 WARN 日志（注明由容器 spawn 路径兜底），服务正常启动

### Requirement: 前端镜像版本参数化
`docker-compose.yml` 中 session-frontend 镜像 tag SHALL 由 `.env` 的 `SESSION_FRONTEND_VERSION` 变量驱动（`openharness_session_frontend:${SESSION_FRONTEND_VERSION:-v0.1.0}`），`.env.example` SHALL 登记该变量并注明与 `session-frontend/package.json` 的 `version` 同步 bump 的约定。镜像 tag MUST NOT 在多处硬编码。

#### Scenario: 通过 .env 切换前端镜像版本
- **WHEN** `.env` 中设置 `SESSION_FRONTEND_VERSION=v0.2.0` 后执行 `docker compose config`
- **THEN** session-frontend 的 image 解析为 `openharness_session_frontend:v0.2.0`

#### Scenario: 未设置时回退默认值
- **WHEN** 环境与 `.env` 均未设置 `SESSION_FRONTEND_VERSION`
- **THEN** image 解析为 `openharness_session_frontend:v0.1.0`，与现状一致

### Requirement: 前端构建元数据
session-frontend 镜像 SHALL 在构建期通过 build args（`APP_VERSION`、`GIT_SHA`、`BUILD_TIME`）生成静态文件 `/version.json`（字段：`version`、`git_sha`、`build_time`），由 nginx 随静态资源发布。git sha SHALL 由构建脚本注入而非 compose 内执行 git；构建参数缺失时对应字段 SHALL 为 `"unknown"` 而非构建失败。版本 source of truth SHALL 为 `session-frontend/package.json` 的 `version` 字段，构建脚本据此注入 `APP_VERSION`。

nginx SHALL 为 `/version.json` 配置专用 location 并返回 `Cache-Control: no-store`（同时重复声明与其他 location 一致的安全响应头），确保版本探测请求 MUST NOT 命中浏览器或中间缓存。

#### Scenario: 运行镜像版本自查
- **WHEN** 请求运行中前端容器的 `GET /version.json`
- **THEN** 返回 200 与 JSON，包含 `version`、`git_sha`、`build_time` 三字段

#### Scenario: 版本探测不被缓存
- **WHEN** 请求 `GET /version.json` 并检查响应头
- **THEN** `Cache-Control` 包含 `no-store`，镜像升级后客户端再次探测即可读到新版本

#### Scenario: 冒烟阶段检测部署漂移
- **WHEN** 前端流水线在本地全新构建后执行冒烟检查
- **THEN** 断言 `/version.json` 可访问、`git_sha` 与当前 `git rev-parse HEAD` 一致（复用已有镜像模式时跳过该比对）、`Cache-Control` 含 `no-store`

### Requirement: 后端版本与配置可观测
session-service 的 `GET /healthz` 响应 SHALL 增加 `version`（包版本，取不到时 `"unknown"`）、`oh_bin`（当前生效的 `OH_OH_BIN` 路径）、`runtime`（`process`/`container`）字段。健康判定逻辑 MUST 保持不变。

#### Scenario: healthz 返回版本与配置
- **WHEN** 请求 `GET /healthz`
- **THEN** 响应包含 `version`、`oh_bin`、`runtime` 字段，可直接核对运行配置是否漂移

#### Scenario: 版本信息不影响健康判定
- **WHEN** 包版本读取失败
- **THEN** `version` 为 `"unknown"`，healthz 状态码与健康结论不受影响
