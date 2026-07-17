# Spec Delta: web-front-end (establish-web-frontend)

**Baseline:** `openspec/specs/web-front-end.md` (NEW — 本变更新建该能力规格)
**Change ID:** `establish-web-frontend`

本 delta 为**新建**前端能力规格，固化 `web/` 前端现有契约（SPA 架构、同源反向代理、构建/容器镜像、dev/prod 一致性、任务生命周期 UI 基线），为后续前端工作提供锚点。开发代理 / 生产 CORS 已由 `create-monorepo-openharness-hyperframes` 覆盖，此处不重复，仅引用。

---

## ADDED Requirements

### Requirement: WF1 — 前端 SPA 架构

`web/` SHALL 是一个 Vite + React + TypeScript 单页应用（SPA），作为「视频工厂」控制台。入口为 `index.html` → `src/main.tsx` → `src/App.tsx`，API 客户端集中在 `src/api.ts`，类型集中在 `src/types.ts`。

#### Scenario: 单页控制台挂载
- **Given** 用户访问前端根路径
- **When** 页面加载
- **Then** 渲染「视频工厂」控制台（prompt 输入 + 任务区 + 日志区），不刷新整页切换视图

#### Scenario: API 客户端集中
- **Given** 新增一个后端调用
- **When** 在组件中调用
- **Then** 经由 `src/api.ts` 统一封装（不含散落的 fetch）

---

### Requirement: WF2 — 通过后端的同源反向代理集成

生产环境前端 SHALL 由 `web/nginx.conf` 把 API 请求同源反向代理到 `api:8000`，**默认免 CORS**：
- `location /v1` 与 `location /healthz` 代理到 `api:8000`；
- SSE 端点 `/v1/videos/{id}/events` SHALL 关闭 `proxy_buffering`（保证进度流实时）；
- 文件端点 `/v1/videos/{id}/file` SHALL 透传 `Range` / `If-Range`（支持断点续传），不因 nginx 缓冲而失效；
- `VITE_API_BASE` 默认空 → 前端走相对路径（同源）。

> 开发环境改由 Vite proxy（`web/vite.config.ts`）把 `/v1`、`/healthz` 代理到 `http://localhost:8000`，与生产同源契约一致（详见 `create-monorepo-openharness-hyperframes`）。

#### Scenario: 生产环境同源可达后端
- **Given** `docker compose up` 启动 `web` 与 `api`
- **When** 浏览器从 `web`（:5173）调用 `/v1/videos`
- **Then** 请求经 nginx 到达 `api:8000`，响应正常（无需后端 CORS 头）

#### Scenario: SSE 进度流实时推送
- **Given** 一个任务正在运行
- **When** 前端打开 `EventSource(/v1/videos/{id}/events)`
- **Then** `log`/`done`/`error` 事件实时到达，nginx 未缓冲整段

#### Scenario: 文件下载支持 Range 透传
- **Given** 任务已完成、视频文件存在
- **When** 浏览器以 `Range: bytes=0-1023` 请求 `/v1/videos/{id}/file`
- **Then** 代理透传 Range/If-Range，返回 `206` 部分内容

---

### Requirement: WF3 — 构建与容器镜像

`web/` SHALL 通过多阶段 `Dockerfile` 构建出一个**完全独立**的前端镜像（基于 `nginx:1.27-alpine`，**不继承** OpenHarness/后端镜像）：阶段 1（`node:22-alpine`）执行 `npm ci && npm run build` 产出 `dist/`；阶段 2 挂载 `dist/` 并用 `docker-entrypoint.sh` 经 `envsubst` 渲染 `nginx.conf.template`（后端坐标由 `API_HOST`/`API_PORT` 注入），容器内监听 `:80`。`docker-compose.yml` 的 `web` 服务构建 `./web` 并发布 `5173:80`；默认 `API_HOST=api`、`API_PORT=8000`，与 `api` 服务同网络开箱即用。

#### Scenario: 镜像构建产出静态资源
- **Given** 执行 `docker compose build web`
- **When** 构建完成
- **Then** 产物镜像内含 `dist/`（SPA 静态资源）并由 nginx 伺服

#### Scenario: 本地访问前端
- **Given** `web` 服务已启动
- **When** 浏览器访问 `http://localhost:5173`
- **Then** 返回 SPA 首页（同源反代到 `api:8000`）

---

### Requirement: WF4 — 开发/生产一致性

前端 SHALL 在开发（Vite dev server + proxy）与生产（nginx 反代）下消费**同一份** `src/api.ts` 与类型，仅由环境变量（`VITE_API_BASE`）决定是否走相对路径或显式 base URL，契约路径（`/v1`、`/healthz`、SSE、文件端点）保持一致。

#### Scenario: 同一客户端双环境可用
- **Given** `VITE_API_BASE` 为空（生产）或指向 `http://localhost:8000`（开发）
- **When** 同一 `api.ts` 发起 `/v1/videos` 请求
- **Then** 在两种部署下均命中正确的后端端点，行为一致

---

### Requirement: WF5 — 任务生命周期 UI（基线 MVP）

前端 SHALL 提供任务生命周期交互基线：提交 prompt（含超时、可选幂等键）→ 通过 SSE 接收进度日志 → 每 ~2s 轮询任务状态 → 终态处理（`SUCCEEDED` 播放视频 / `FAILED` 显示错误 / `CANCELED` 提示）→ 支持取消与删除任务。

#### Scenario: 提交到播放闭环
- **Given** 用户输入非空 prompt 并提交
- **When** 后端返回 `task_id` 且任务最终 `SUCCEEDED`
- **Then** 前端展示进度日志、状态徽标，并渲染 `<video>` 播放器（src 取自 `file` 链接）

#### Scenario: 失败态展示错误
- **Given** 任务最终 `FAILED`
- **When** 轮询拿到终态
- **Then** 前端停止 SSE/轮询并展示 `error` 字段

#### Scenario: 空 prompt 被拦截
- **Given** prompt 为空
- **When** 点击「生成视频」
- **Then** 不发起请求，展示「请输入 prompt」提示

---

## MODIFIED Requirements

(none — 本变更为新建前端能力规格，不修改既有基线 spec。)

## REMOVED Requirements

(none)
