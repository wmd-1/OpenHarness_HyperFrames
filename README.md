# OpenHarness_HyperFrames

单体仓库（monorepo）：把 OpenHarness 框架、后端视频服务（`service/`）
与前端的 HyperFrames 视频工厂（`web/`）放在同一仓库、彼此平级。

```
OpenHarness_HyperFrames/
├── OpenHarness/            # 框架源码（含 src/、ohmo/、frontend/、output_hyperprames/）
├── service/               # 后端：FastAPI + Celery 视频生成服务
│   ├── app/               # API / worker / runner
│   ├── alembic/          # 数据库迁移
│   ├── tests/            # 服务测试（由上游 tests/service 迁移而来）
│   └── pyproject.toml
├── web/                   # 前端：Vite + React + TypeScript
├── hyperframes_github_skills/  # 构建时 COPY 进镜像的 skill 集合
├── docker/               # supervisord 等构建期资源
├── Dockerfile            # 构建上下文 = 仓库根
├── docker-compose.yml    # 运行时挂载 ./OpenHarness/* 与 ./service
├── .env.example
└── openspec/             # OpenSpec 规格与变更提案
```

## 快速开始

### 1. 后端 + 框架（Docker）

```bash
cp .env.example .env        # 填入 ANTHROPIC_API_KEY / OPENAI_API_KEY 等
docker compose up            # 启动 openharness / postgres / redis / api
```

> **Chrome 预下载**：`Dockerfile` 构建时需要
> `docker/chrome/chrome-headless-shell-linux64.zip`。该 zip 被 git 忽略，
> 需手动从上游下载并放到 `docker/chrome/` 后再构建（与上游行为一致）。

API 默认监听 `http://localhost:8000`，健康检查 `GET /healthz`。

### 2. 前端（本地开发）

```bash
cd web
npm install
npm run dev                 # http://localhost:5173（代理 /v1 → :8000）
```

## 端口

| 服务 | 端口 |
| --- | --- |
| api（FastAPI 视频服务） | 8000 |
| openharness（框架 CLI / TUI） | 3000–3003 |

## 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| POST | `/v1/videos` | 创建任务（201），body：`{prompt, timeout_seconds, extra_oh_args[], idempotency_key?}` |
| GET | `/v1/videos/{id}` | 查询任务 |
| GET | `/v1/videos/{id}/file` | 视频文件（HTTP Range 流式，`video/mp4`） |
| GET | `/v1/videos/{id}/events` | SSE 事件流（`log`/`done`/`error`） |
| DELETE | `/v1/videos/{id}` | 取消/删除任务 |

## CORS

后端仅允许 `OH_CORS_ORIGINS`（逗号分隔，环境变量前缀 `OH_`）中的来源
跨域访问；为空则不允许跨域，`allow_credentials=false`。
前端生产构建用 `VITE_API_BASE` 指向后端地址（见 `web/README.md`）。

## 说明

- 原始 `OpenHarness/` 目录保留作为备份，本仓库为其派生 monorepo。
- 框架内层 `.gitignore` 已移除，使 `OpenHarness/src/` 可被版本管理。
- `hyperframes_github_skills/` 随仓库版本化（不忽略）。
