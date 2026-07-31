<!-- 最后更新：2026-07-31 -->

# OpenHarness_HyperFrames

单体仓库（monorepo）：把 OpenHarness 框架、后端**视频生成服务**（`service/`）、
后端**交互会话服务**（`session-service/`）以及三套前端
（`web/` 视频工厂、`session-frontend/` 会话前端、`design-agent-frontend/` 设计智能体平台）
放在同一仓库、彼此平级，共享一套 Docker 镜像与 compose 拓扑。

## 仓库结构

```
OpenHarness_HyperFrames/
├── OpenHarness/                # 框架源码（src/、ohmo/、frontend/、output_hyperprames/）
├── service/                    # 后端①：FastAPI + Celery 视频生成服务（:8000）
│   ├── app/                    # API / worker / runner
│   ├── alembic/                # 数据库迁移
│   ├── tests/                  # 服务测试
│   └── API_DOCUMENTATION.md    # 完整 API 文档
├── session-service/            # 后端②：FastAPI 交互会话服务（:8001，oh --backend-only 桥接）
│   ├── app/                    # REST + WebSocket / 会话运行时 / MinIO stage-in/out
│   ├── alembic/                # 独立迁移（version table: alembic_version_session）
│   ├── tests/                  # 服务测试
│   └── API_DOCUMENTATION.md    # 完整 API 文档
├── web/                        # 前端①：视频工厂（Vite + React，nginx 镜像 :5173）
├── session-frontend/           # 前端②：会话前端（Chat/Terminal 双模式，WS 流式，:5174）
├── design-agent-frontend/      # 前端③：设计智能体平台（文本生成视频 GA + 个人空间 + ui/drawio demo，:5175）
├── Qwen3-TTS-Script/           # Qwen3-TTS 声音克隆批量合成脚本（配合 vllm-omni）
├── assets/tts-ref/             # QwenTTS 参考音频宿主机目录（挂载到容器 /opt/tts-ref）
├── hyperframes_github_skills/  # 构建时 COPY 进镜像的 skill 集合（随仓库版本化）
├── pptx2html_github_skills/    # pptx→html skill（同上）
├── docker/                     # supervisord、chrome 等构建期资源
├── e2e/                        # E2E / 冒烟 / 验收脚本与测试报告
├── openspec/                   # OpenSpec 规格与变更提案（归档在 openspec/archive/）
├── plans/                      # 实施计划文档
├── docs/                       # 补丁说明、测试报告等文档
├── Dockerfile                  # 主镜像（构建上下文 = 仓库根）
├── Dockerfile.fix              # 在已有镜像上打补丁层（ARG BASE_IMAGE，不重建基础镜像）
├── Dockerfile.e2e / .test / .session-test / .oh-test   # 测试叠加层镜像
├── docker-compose.yml          # 运行时挂载 ./OpenHarness/*、./service、./session-service
├── docker-compose.stub.yml     # session stub 模式 override（e2e/实况验收）
├── docker-compose.e2e.yml      # e2e 专用 compose
└── .env.example                # 环境变量模板（详见「配置说明」）
```

## 服务拓扑与端口

由 `docker-compose.yml` 统一编排，主镜像
`openharness_hyperframes_qwen-tts_pptx:${OH_VERSION_HYPERFRAMES_VERSION}`
（默认 `v0.1.9_v0.7.77_v1.4_v2.1`）：

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| api | 8000 | FastAPI 视频服务（uvicorn + celery worker/beat，启动时自动 alembic 迁移） |
| session | 127.0.0.1:8001 | FastAPI 交互会话服务；仅绑定本机回环，容器间走 `session:8001`，前端经 nginx 同源反代 |
| web | 5173 | 视频工厂前端（nginx 静态资源 + 反代 api/session，同源无 CORS） |
| session-frontend | 5174 | 会话前端（nginx 反代 REST + WebSocket 到 session:8001） |
| design-frontend | 5175 | 设计智能体平台前端（nginx 反代 REST + WebSocket 到 session:8001，tag 由 `DESIGN_FRONTEND_VERSION` 控制） |
| openharness / shell | 3000–3003 | 框架 CLI/TUI 与 hyperframes preview 端口；**优先归 session**，`--service-ports` 启动时与 session 互斥 |
| minio | （内部）9000 / 9001 | 租户数据与视频产物权威源，bucket `oh-tenants` |
| postgres / redis | （内部） | 两个后端共用；redis 上 api 用 db=0、session 用 db=1 |

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env        # 至少填 ANTHROPIC_API_KEY / OPENAI_API_KEY 之一
```

### 2. 一键拉起后端 + 三前端

```bash
docker compose up -d api session web session-frontend design-frontend
docker compose logs -f session      # 追服务日志
docker compose down                 # 停止并移除容器（数据卷保留）
```

- 视频工厂前端：<http://localhost:5173>
- 会话前端：<http://localhost:5174>
- 设计智能体平台：<http://localhost:5175>
- 视频服务健康检查：`GET http://localhost:8000/healthz`（另有 `/readyz`）
- 会话服务健康检查：`GET http://127.0.0.1:8001/healthz`

> **Chrome 预下载**：`Dockerfile` 构建时需要
> `docker/chrome/chrome-headless-shell-linux64.zip`。该 zip 被 git 忽略，
> 需手动从上游下载并放到 `docker/chrome/` 后再构建（与上游行为一致）。

### 3. CLI / 交互终端（可选）

```bash
docker compose run --rm shell                          # 进入 bash（不映射端口）
docker compose run --rm --service-ports shell          # 映射 3000-3003（需 session 未占用）
docker compose run --rm openharness --version          # 运行 oh 子命令
```

### 4. 前端本地开发（可选）

```bash
cd web && npm install && npm run dev                # :5173，代理 /v1 → :8000
cd session-frontend && npm install && npm run dev   # 见 session-frontend/README.md
cd design-agent-frontend && npm install && npm run dev  # 见 design-agent-frontend/README.md
```

## 后端 API 摘要

### 视频服务 api（:8000，前缀 `/v1/videos`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` · `/readyz` | 健康 / 就绪检查 |
| POST | `/v1/videos` | 创建任务（201），body：`{prompt, timeout_seconds, extra_oh_args[], idempotency_key?}` |
| GET | `/v1/videos/{id}` | 查询任务 |
| GET | `/v1/videos/{id}/file` | 视频文件（配置公网 MinIO 时 302 presigned URL，否则 HTTP Range 流式） |
| GET | `/v1/videos/{id}/events` | SSE 事件流（`log`/`done`/`error`） |
| DELETE | `/v1/videos/{id}` | 取消/删除任务 |

完整文档见 [service/API_DOCUMENTATION.md](service/API_DOCUMENTATION.md)。

### 交互会话服务 session（:8001，前缀 `/v1/sessions`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` · `/readyz` | 健康 / 就绪检查 |
| POST | `/v1/sessions` | 创建会话（201，每会话 spawn 一个 `oh --backend-only`） |
| GET | `/v1/sessions` | 会话历史列表 |
| GET | `/v1/sessions/{sid}` | 查询会话详情 |
| DELETE | `/v1/sessions/{sid}` | 关闭会话 |
| POST | `/v1/sessions/{sid}/turns` | 提交一轮对话（REST 兜底，非流式） |
| GET | `/v1/sessions/{sid}/turns` | 轮次历史列表（回显） |
| GET | `/v1/sessions/{sid}/turns/{idx}/artifact` | 下载轮次产物（视频） |
| GET | `/v1/sessions/{sid}/workspace/files` | 工作目录文件列表 |
| GET | `/v1/sessions/{sid}/workspace/files/{path}` | 下载工作目录文件 |
| WS | `/v1/sessions/{sid}/ws` | WebSocket 流式对话 + 审批流（建连唯一语义入口） |

完整文档见 [session-service/API_DOCUMENTATION.md](session-service/API_DOCUMENTATION.md)。

## 配置说明（`.env`）

按 [.env.example](.env.example) 分组，常用项如下：

| 分组 | 变量 | 说明 |
| --- | --- | --- |
| LLM Keys | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 至少配置一个；可选 `OPENROUTER_API_KEY` 等 |
| 镜像版本 | `OH_VERSION_HYPERFRAMES_VERSION` | 主镜像 tag；`SESSION_FRONTEND_VERSION` 为会话前端镜像 tag、`DESIGN_FRONTEND_VERSION` 为设计智能体平台前端镜像 tag（各与 `package.json` 同步 bump） |
| 会话鉴权 | `OH_API_KEY` / `OH_REQUIRE_AUTH` | 默认开放模式（仅限内网/e2e）；生产设强随机 key 并置 `OH_REQUIRE_AUTH=true`（fail-fast）。启用后前端在侧栏「API Key」卡片填同一 key，请求自动带 `X-API-Key` |
| MinIO | `OH_MINIO_ACCESS_KEY` / `OH_MINIO_SECRET_KEY` / `OH_MINIO_BUCKET` | 租户数据权威源，默认凭据仅供本地，生产务必更换 |
| 视频存储 | `OH_STORAGE_KIND`（默认 `s3`）/ `OH_S3_PUBLIC_ENDPOINT` | 产物存 MinIO（key 带租户前缀）；配置公网端点后下载 302 presigned URL，否则流式兜底；设 `local` 回退共享卷旧拓扑 |
| Workspace 归档 | `OH_WORKSPACE_SYNC_*` / `OH_WORKSPACE_TOMBSTONE_RETENTION_DAYS` | 会话工作目录随 turn/驱逐/close 增量归档到 MinIO |
| 会话运行时 | `OH_SESSION_RUNTIME`（`process`/`container`）/ `OH_OH_BIN` / `OH_MAX_LIVE_SESSIONS` 等 | 容器运行时复用既有主镜像；池化调度容量与准入队列可调 |
| QwenTTS | `QWENTTS_URL` / `QWENTTS_REF_AUDIO(_HOST_DIR)` / `QWENTTS_REF_TEXT` 等 | 本地 TTS 声音克隆；设 `QWENTTS_URL` 即启用 qwentts provider（优先级最高），参考音频 + 转写文本必配。服务部署与脚本见 [Qwen3-TTS-Script/README.md](Qwen3-TTS-Script/README.md) |

### CORS

后端仅允许 `OH_CORS_ORIGINS`（逗号分隔，环境变量前缀 `OH_`）中的来源
跨域访问；为空则不允许跨域，`allow_credentials=false`。
compose 部署下前端经 nginx 同源反代，无需配置 CORS；
前端独立部署时用 `VITE_API_BASE` 指向后端地址（见 `web/README.md`）。

## 测试与 E2E

所有测试（单测、集成、E2E、冒烟）**必须在已有 Docker 镜像内执行**，
宿主机只允许 `docker` / `docker compose` / `curl`：

- **后端单测**：在主镜像容器内跑 pytest，例如
  `docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-service && python -m pytest ..."`
  （session 服务对应 `/opt/oh-session-service`）。
- **E2E / 冒烟 / 验收**：使用 `e2e/` 下既有脚本
  （`run_e2e.sh`、`run-session-frontend-docker-tests.sh`、`run-web-docker-tests.sh`、
  `run-design-frontend-docker-tests.sh`、`run-session-live-acceptance.sh` 等），
  基于 `oh-e2e` / `oh-e2e-test` 系列叠层镜像。
- **镜像变更**：用 `Dockerfile.fix`（`ARG BASE_IMAGE`）在已有镜像上打补丁层，不从零重建；
  测试叠加层参考 `Dockerfile.e2e` → `Dockerfile.test` → `Dockerfile.session-test` 链条。
- 源码（`OpenHarness/src`、`ohmo`、`service/`、`session-service/`）均为运行时 volume 挂载，
  改代码后无需重建镜像即可测试。

## 说明

- 原始 `OpenHarness/` 目录保留作为备份，本仓库为其派生 monorepo。
- 框架内层 `.gitignore` 已移除，使 `OpenHarness/src/` 可被版本管理。
- `hyperframes_github_skills/` 随仓库版本化（不忽略）；根目录
  `sync_hyperframes_skills.sh` 用于与容器内 skill 同步（先删后拷）。
- OpenSpec 变更流程：提案在 `openspec/changes/`，完成后归档至 `openspec/archive/`。
