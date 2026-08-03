<!-- 最后更新：2026-07-31 -->

# design-agent-frontend

设计智能体平台前端（React 18.3 + TypeScript + Vite 6 + Zustand 5 + Tailwind v4）。以「平台 + 能力域」架构承载多个设计类智能体：**文本生成视频**（真实对接 `session-service`，GA）、**个人空间**、**原型页面设计**（演示）、**Drawio 流程图设计**（演示）。视觉基准为 `demo/设计智能体平台.html`。

> 本工程独立于 `session-frontend/`、`web/`，不修改任何既有前端目录。视频能力域复用 session-service 的 REST + WebSocket 契约；演示能力域（ui/drawio）完全在客户端运行。

## 能力概览

- **平台架构**：`src/platform/` 定义能力域契约（`AgentDescriptor` / `SessionProvider` / `TurnStream` / `ArtifactProvider` / `WorkspaceProvider`），`AgentRegistry` 注册 `video-generation(ga)` / `ui-prototype(demo)` / `drawio-diagram(demo)`——主页卡片、路由、个人空间 tab 全部由注册表派生；`maturity !== ga` 的数据统一带「演示」标识。
- **认证与健康**：欢迎页录入 API Key（`X-API-Key`，localStorage 键统一 `da.*` 前缀），401 自动清 Key 回认证页；`/healthz`、`/readyz` 健康探测。
- **文本生成视频（GA）**：三栏工作台（历史/对话/预览），经 `SessionServiceAdapter` 对接 session-service。WS 流式渲染、模型切换（建会话注入 `--model`、空闲态经 `/model <name>` 双通道 + 乐观更新）、审批弹窗、`turn_complete.has_artifact` 后预览面板自动展开加载，`CustomVideoPlayer` 全套控制条 + 多轮产物切换 + `?api_key=` 直链下载。
- **个人空间**：三 tab（视频/原型/流程图）+ 计数徽标 + 分页。视频 tab 经 `useVideoAssets` 聚合真实产物（sessions→turns 筛 `has_artifact`，并发 4，`sid+turn_count` 缓存，`finished_at` 倒序）；ui/drawio tab 为演示静态数据 + 演示角标。
- **演示能力域**：`ui-prototype` / `drawio-diagram` 经 `DemoAdapter`（内存 SessionProvider + 固定延迟 TurnStream + 静态 ArtifactProvider）纯客户端运行，事件模型与真实通道同构，无需后端。
- **WS 准入差异化**：4430（并发配额满，不自动重连）、4503（容量不足，15s×4 有界重连）、4500（内部错误）差异化提示。

## 目录结构

```
src/
├── platform/     能力域契约类型 + AgentRegistry + DemoAdapter / SessionServiceAdapter
├── modules/      video / space / ui / drawio / demo-shared 能力域页面
├── api/          REST 客户端（ky + 拦截器，da.* 存储）
├── ws/           WS 协议层（重连/心跳/关闭码处理）
├── store/        Zustand 仓（auth/session/conversation/ws/ui）
├── hooks/        useSessionList / useTurnHistory / useVideoAssets / useConversation …
├── components/   Chat / Terminal / Approval / Session / Layout / Settings …
├── shared/       AppHeader / PlatformLayout / 内联 SVG 图标
└── theme/        demo 设计令牌（CSS 变量）
```

## 路由

| 路径     | 页面                       | 成熟度 |
| -------- | -------------------------- | ------ |
| `/`      | 主页四模块卡片             | —      |
| `/video` | 文本生成视频工作台         | GA     |
| `/space` | 个人空间（三 tab 聚合）    | —      |
| `/ui`    | 原型页面设计               | demo   |
| `/drawio`| Drawio 流程图设计          | demo   |

## 本地开发

```bash
npm install
npm run dev        # Vite dev server（/v1、/healthz、/readyz 代理到 :8001，见 vite.config.ts）
npm run lint       # eslint（--max-warnings 0）
npm run build      # tsc -b && vite build，产物在 dist/
```

> 单测/E2E 不在宿主机跑（见下方「测试」）；`npm run dev` 仅用于本地联调 UI。

## Docker 镜像

多阶段 `Dockerfile`：`node:22-alpine` 构建（`build`）→ `test`（lint + vitest）→
`e2e`（`E2E_BASE_IMAGE`，Playwright）→ `nginx:1.27-alpine` 运行时（`runtime`）。

```bash
# compose 方式（自动拉起 session 依赖），访问 http://localhost:5175
docker compose up -d --build design-frontend

# 独立运行，指向任意 session-service
docker run -p 5175:80 -e SESSION_HOST=your-host -e SESSION_PORT=8001 \
  openharness_design_frontend:v0.1.0
```

- 运行时 nginx 同源反代 REST + WebSocket 到 `SESSION_HOST:SESSION_PORT`
  （默认 `session:8001`，`docker-entrypoint.sh` 用 envsubst 渲染 `nginx.conf.template`），
  浏览器侧无 CORS 问题。
- 镜像 tag 经 `DESIGN_FRONTEND_VERSION` 参数化（`.env`），**与 `package.json` 的
  `version` 同步 bump**；未设时 compose 回退 `v0.1.0`。

## 测试

按仓库规范，所有测试在已有 Docker 镜像内执行，宿主机不直接跑 `npm test`：

```bash
# 单测 + lint（镜像 test 阶段）
cd design-agent-frontend && docker build --target test -t openharness-design-frontend:test .

# 全链路流水线：单测 → runtime 冒烟（可复用已有镜像）→ Playwright E2E
DESIGN_FRONTEND_IMAGE=openharness_design_frontend:v0.1.0 \
  bash e2e/run-design-frontend-docker-tests.sh
```

- E2E 现已统一基于**真实后端**（`docker compose -f docker-compose.yml -f docker-compose.stub.yml up session`
  搭配 `oh_backend_stub`，免 LLM key），由 `e2e/run-design-frontend-real-backend-tests.sh` 触发；用例见
  `e2e/real-*.spec.ts`（`real-journey` / `real-boundary` / `real-category2` / `real-advanced` / `real-compat` /
  `real-errors` / `real-platform`）。`e2e/mock-backend.mjs` 已**废弃**（Playwright 配置不再启用，旧 mock
  用例已删除），仅作本地调试参考。详细断言与租户隔离方案见
  `docs/design-frontend-real-backend-e2e-report-2026-08-01.md`。
- Playwright 的 npm 版本必须与 CI Docker 镜像版本严格对齐
  （见 `.github/workflows/design-frontend.yml`）。

## 相关文档

- 变更与契约：`openspec/changes/add-design-agent-frontend/`（proposal / design / specs / tasks）
- 后端契约：[session-service/API_DOCUMENTATION.md](../session-service/API_DOCUMENTATION.md)
