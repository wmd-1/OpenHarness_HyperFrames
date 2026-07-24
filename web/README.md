# web — HyperFrames 视频工厂前端

基于 **Vite + React + TypeScript** 的单页应用，对应后端的
`POST /v1/videos` 视频生成服务。

## 开发

```bash
npm install
npm run dev      # http://localhost:5173
```

开发服务器通过 `vite.config.ts` 中的代理把 `/v1` 和 `/healthz`
转发到 `http://localhost:8000`（即后端 `api` 服务），因此本地
开发无需配置 CORS。

## 生产构建

```bash
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物
```

生产环境（非代理）通过环境变量 `VITE_API_BASE` 指向后端地址：

```bash
VITE_API_BASE=https://your-domain.example.com npm run build
```

## CORS

后端只允许 `OH_CORS_ORIGINS`（逗号分隔）中的来源跨域访问，
且 `allow_credentials=false`。生产部署时务必在 `.env` 中设置：

```bash
OH_CORS_ORIGINS=https://your-frontend.example.com
```

## API 约定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/videos` | 创建任务，返回 `task_id` 与 `links` |
| GET | `/v1/videos/{id}` | 查询任务状态 |
| GET | `/v1/videos/{id}/file` | 视频文件（HTTP Range 流式） |
| GET | `/v1/videos/{id}/events` | SSE 事件流（`log`/`done`/`error`） |
| DELETE | `/v1/videos/{id}` | 取消/删除任务 |
| GET | `/healthz` | 健康检查 |

前端在提交后会同时：① 打开 `events` SSE 流接收实时日志；② 每 2 秒
轮询一次任务状态，直到进入终态（`succeeded` / `failed` / `canceled` —— 后端枚举为小写字符串），
成功后展示视频播放器。


## 独立镜像（Standalone Docker 镜像）

`web/` 可独立构建为一个**完全独立**的前端镜像，不依赖 OpenHarness/后端镜像：

```bash
# 在 web/ 目录内构建（构建上下文即 web/ 自身，无需仓库根）
cd web
docker build -t openharness-web .

# 独立运行，指向任意后端（默认 api:8000，仅 compose 内有效）
docker run -p 5173:80   -e API_HOST=your-api-host   -e API_PORT=8000   openharness-web
```

- 镜像基于 `nginx:1.27-alpine`，**不继承** OpenHarness/后端镜像；静态资源由构建阶段产出，运行时只伺服 `dist/` + 反代 API。
- 后端地址通过环境变量注入（`docker-entrypoint.sh` 用 `envsubst` 渲染 `nginx.conf.template`），因此**同一镜像**可部署到任何后端：`API_HOST`（默认 `api`）、`API_PORT`（默认 `8000`）；`docker-compose.yml` 的 `web` 服务已显式设为 `api` / `8000`，与 `api` 服务同网络开箱即用。
- 开发态仍走 `vite.config.ts` 的 proxy（`http://localhost:8000`），与生产镜像的 nginx 反代契约一致（路径同为 `/v1`、`/healthz`、SSE、文件端点）。

## 镜像化测试（所有测试均基于镜像）

所有测试都在 Docker 镜像内执行，宿主机只需 `docker` 与 `curl`：

```bash
# 1) 单测 + lint（在镜像内运行，Dockerfile 的 `test` 阶段，失败则构建失败）
docker build --target test -t openharness-web:test ./web

# 2) 一键全量流水线：镜像内 lint+vitest -> 运行时镜像 -> 容器冒烟（安全头断言）
bash e2e/run-web-docker-tests.sh

# 3) 复用已有运行时镜像做冒烟（不重建）
WEB_IMAGE=openharness_hyperframes_web:v0.1.9_v0.7.20_v1.3_v2.1 \
  bash e2e/run-web-docker-smoke.sh

# 4) 全量测试并给通过验证的新镜像打标
WEB_NEW_TAG=openharness_hyperframes_web:v0.1.9_v0.7.20_v1.3_v2.1 \
  bash e2e/run-web-docker-tests.sh
```

CI（`.github/workflows/web.yml`）同样全镜像化：不在 CI 宿主机安装 Node，
lint/test 通过 `docker build --target test` 执行，冒烟测试跑在运行时容器上。

## 前端结构

- `src/store.tsx` — React context（`TasksProvider`/`useTasks`），管理多任务态（任务列表、SSE 进度、状态轮询、取消/删除），无新增重依赖。
- `src/components/` — `Composer`（提交表单）、`TaskList`（任务列表）、`TaskDetail`（详情：播放/报错/取消删除）、`StatusBadge`、`HealthBadge`。
- `src/api.ts` — 统一 `fetch` 封装（`createVideo`/`getVideo`/`deleteVideo`/`getHealth` 与 `fileUrl`/`eventsUrl`），后端枚举为小写 `queued|running|succeeded|failed|canceled`。
- `src/__tests__/` — `vitest` 单测：`api.test.ts`（fetch 封装）、`App.test.tsx`（空 prompt 拦截、提交建任务并开启 SSE 流）。
- 统一 `npm run test`（vitest）、`npm run lint`（eslint flat + typescript-eslint）与 `npm run build`（`tsc -b && vite build`）。

## API Key 鉴权（X-API-Key）

当部署端在 `.env` 中设置了 `API_KEY`（启用后端 `X-API-Key` 鉴权，见 `service` 的 R15）时：

1. 打开前端页面，在侧栏的 **API Key** 卡片中填入该 Key 并点击「保存」（存于浏览器 `localStorage`，键名 `oh_api_key`）。
2. 此后所有 `fetch` 请求（创建/查询/删除）会自动带上 `X-API-Key` 请求头。
3. SSE 进度流与视频文件下载因浏览器限制无法自定义请求头，故通过 URL 查询参数 `?api_key=<key>` 携带；后端中间件已同时接受 header 与 query 两种形式。
4. 留空则不发送任何鉴权信息（对应部署端未启用 `API_KEY` 的本地开发场景）。

> 注：API Key 由**使用者在前端界面输入并保存在本机浏览器**，不属于仓库 `.env` 配置。

## API Key 存储安全提示（S3）

API Key 以明文保存在浏览器 `localStorage`（键名 `oh_api_key`），仅适用于本地/私有部署：

- 在**公共或共享设备**上切勿保存 Key；使用后请在 **API Key** 卡片中点击「清除」以删除本机存储。
- 该 Key 通过 URL 查询参数 `?api_key=` 注入 SSE 与文件下载请求，因此前端 `nginx` 已对 `/v1` 关闭访问日志（`access_log off`）以规避明文落盘。
- 传输层建议配合 HTTPS 使用；CSP 等响应头提供额外兜底防护（见上方「安全加固」）。

## 安全加固（Security hardening）

前端在多层做了纵深防御（对应 OpenSpec 变更 `harden-web-frontend`）：

- **输入校验与清洗**（`src/utils/sanitize.ts`）
  - 提示词长度上限 `MAX_PROMPT_CHARS`，并剥离 HTML/脚本标签与控制字符。
  - `oh` 附加参数：清洗、去空、截断（`MAX_OH_ARG_LEN`）、数量上限（`MAX_OH_ARGS`）。
  - 下载文件名：扩展名白名单（`FILE_EXT_ALLOWLIST`）、长度上限、去除路径穿越与非法字符。
  - 超时时间收敛到 `[MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS]`。
- **安全渲染**（`src/components/EscapeHtml.tsx`、`ErrorBanner.tsx`）
  - 所有后端返回文本（status / message / error / 日志 / id）均经 `EscapeHtml` 或
    `sanitizeError` 渲染，绝不会被当作 HTML 解析。
- **客户端加固**（`src/api.ts`、`src/store.tsx`）
  - 每个响应都经 `expectOkJson` 处理（非 2xx / 非 JSON 直接抛错）。
  - URL 中的任务 id 经清洗 + `encodeURIComponent` 转义（杜绝路径穿越）。
  - `getHealth` 任意失败都降级为 `degraded`。
  - SSE 流会清洗内容、在终态/出错时关闭，并有界重试 + 退避；`setTasks` 走 rAF 批处理避免状态竞争。
  - 创建请求携带客户端生成的幂等键，并做最小客户端限流。
- **传输 / HTTP 加固**（`nginx.conf.template`）
  - `server_tokens off`，并下发 `Content-Security-Policy`、`X-Frame-Options: DENY`、
    `X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Permissions-Policy`。
  - 由 `e2e/run-web-docker-smoke.sh` 校验（断言 `/` 上的安全头）。

本地检查：

```bash
npm run lint
npm run test
npm run build
npm run audit                       # 依赖漏洞审计
bash e2e/run-web-docker-smoke.sh    # 构建镜像并断言安全响应头
```

