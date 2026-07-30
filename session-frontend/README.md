<!-- 最后更新：2026-07-30 -->

# session-frontend

OpenHarness 会话式前端（React 19 + TypeScript + Vite + Zustand + Tailwind），对接 `session-service` 的 REST + WebSocket 契约，提供多会话对话、终端双模式、审批、产物预览与工作区文件回看能力。

## 能力概览

- **认证与健康**：欢迎页录入 API Key（`X-API-Key`），401 自动清 Key 回认证页；`/healthz`、`/readyz` 健康探测。
- **会话列表（服务端权威）**：侧栏列表来自 `GET /v1/sessions`（30s 轮询 + 事件驱动刷新），状态徽章含 `creating/live/idle/cold/closed/expired/failed` 与「只读 / 不可恢复」语义变体；`session_ready` 触发刷新以呈现并发让位（live→cold）。
- **历史回显与切换**：切换会话经 `GET /v1/sessions/{sid}/turns` 回显历史轮次，严格三步串行（历史 hydration → 设去重游标 → 建立 WS），WS 补发按 `turn_index` 去重；cold 会话点击即唤醒续聊。
- **只读回看**：`closed/expired` 会话保留在列表中，历史消息与工作区文件仍可回看，输入栏禁用且不发起 WS 连接。
- **WS 准入差异化**：4430（并发配额满，不自动重连）、4503（容量不足）、4500（内部错误）差异化提示；创建会话时 409/503/429 映射为可行动提示（503 带倒计时重试）。
- **工作区文件面板**：`GET /v1/sessions/{sid}/workspace/files` 双源（live 实时 / archive 归档快照 + stale 落后提示），`page_token` 分页、`prefix` 前缀过滤（300ms 防抖）、`turn_complete` 后自动刷新、`?api_key=` 直链下载。
- **对话与终端**：Chat/Terminal 双模式共享同一 WS 连接，delta 流式渲染、slash 命令（`/close`、`/status` 等）、审批弹窗、视频产物内嵌预览与下载。

## 目录结构

```
src/
├── api/          REST 客户端（ky + 拦截器）
├── ws/           WS 协议层（重连/心跳/关闭码处理）
├── store/        Zustand 五仓（auth/session/conversation/ws/ui）
├── hooks/        useSessionList / useTurnHistory / useWorkspaceFiles / useConversation …
├── components/   Chat / Terminal / Approval / Session / Layout …
├── theme/        CSS 变量主题
├── types/        与后端契约对齐的类型
├── test/         vitest 单测与测试工具
└── utils/        语义谓词（session.ts）/ sanitize / constants / format
```

## 后端契约要点

- REST：`/v1/sessions`（创建/列表/详情/关闭）、`.../turns`（提交/回显）、
  `.../turns/{idx}/artifact`（产物下载）、`.../workspace/files`（文件列表/下载）。
- WS：`/v1/sessions/{sid}/ws` 是建连的唯一语义入口；事件流含
  `assistant_delta` / `tool_*` / `turn_complete` / `session_ready` / 审批帧。
- 鉴权：默认 header `X-API-Key`；`<a>`/`<video>` 直链下载走 `?api_key=` 查询参数兜底。
- 完整契约见 [session-service/API_DOCUMENTATION.md](../session-service/API_DOCUMENTATION.md)
  与 `openspec/specs/session-*.md`。

## 本地开发

```bash
npm install
npm run dev        # Vite dev server（代理 REST/WS 到 session-service，见 vite.config.ts）
npm run lint       # eslint（--max-warnings 0）
npm run format     # prettier
npm run build      # tsc -b && vite build，产物在 dist/
```

> 单测/E2E 不在宿主机跑（见下方「测试」）；`npm run dev` 仅用于本地联调 UI。

## Docker 镜像

多阶段 `Dockerfile`：`node:22-alpine` 构建（`build`）→ `test`（lint + vitest）→
`e2e`（`E2E_BASE_IMAGE`，Playwright）→ `nginx:1.27-alpine` 运行时（`runtime`）。

```bash
# compose 方式（自动拉起 session 依赖），访问 http://localhost:5174
docker compose up -d --build session-frontend

# 独立运行，指向任意 session-service
docker run -p 5174:80 -e SESSION_HOST=your-host -e SESSION_PORT=8001 \
  openharness_session_frontend:v0.1.0
```

- 运行时 nginx 同源反代 REST + WebSocket 到 `SESSION_HOST:SESSION_PORT`
  （默认 `session:8001`，`docker-entrypoint.sh` 用 envsubst 渲染 `nginx.conf.template`），
  浏览器侧无 CORS 问题。
- 镜像 tag 经 `SESSION_FRONTEND_VERSION` 参数化（`.env`），**与 `package.json` 的
  `version` 同步 bump**；未设时 compose 回退 `v0.1.0`。

## 测试

按仓库规范，所有测试在已有 Docker 镜像内执行，宿主机不直接跑 `npm test`：

```bash
# 单测 + lint（镜像 test 阶段）
cd session-frontend && docker build --target test -t session-frontend-test .

# 全链路流水线：单测 → runtime 冒烟（复用已有镜像）→ Playwright E2E
SESSION_FRONTEND_IMAGE=openharness_session_frontend:v0.1.0 \
  bash e2e/run-session-frontend-docker-tests.sh
```

- E2E 使用 `e2e/mock-backend.mjs` 模拟后端（含 `POST /__mock/seed` 场景预置），
  用例见 `e2e/session-flow.spec.ts` 与 `e2e/history-switch.spec.ts`。
- Playwright 的 npm 版本必须与 CI Docker 镜像版本严格对齐
  （见 `.github/workflows/session-frontend.yml`）。

## 相关文档

- 契约与设计：`openspec/specs/session-*.md`、`plans/archive/` 内历史计划
- 审查与整改记录：[CODE_REVIEW_REPORT.md](./CODE_REVIEW_REPORT.md)
