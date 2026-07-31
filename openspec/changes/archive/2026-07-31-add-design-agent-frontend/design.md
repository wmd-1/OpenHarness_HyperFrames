## Context

- 视觉/交互基准：`demo/设计智能体平台.html`（2370 行单文件 demo，含设计令牌、四模块布局与全部交互逻辑）。
- 功能基准：`session-frontend/`（React 18.3 + TS 5.7 + Vite 6 + Zustand 5 + ky + Tailwind v4；已实现 session-service 全契约消费），**不改动**。
- 后端：`session-service/`（13 端点：9 REST + 1 WS + 3 探针；X-API-Key 多租户），**不改动**。
- 详细设计来源：`plans/Design_Agent_Frontend_Four_Modules_Plan_2026-07-31.md`（v1 实施细节）、`plans/Design_Agent_Frontend_Architecture_v2_2026-07-31.md`（v2 架构与契约）。本文仅收敛关键决策，细节以两份 plan 为准。
- 项目硬性规则：所有测试必须在已有 Docker 镜像内执行；e2e 基于 `oh-e2e-test:latest` 叠加层，禁止从零重建基础镜像。

## Goals / Non-Goals

**Goals:**
- 新建独立 `design-agent-frontend/` 工程，四大模块视觉/交互/代码结构与 demo 高度一致。
- 视频模块保留 session-frontend 全部核心功能并真实对接 session-service。
- 平台抽象层（Registry/四域接口）使 demo 模块未来转 GA 时呈现层零改动。
- 全链路测试在镜像内绿灯，compose 一键起服务。

**Non-Goals:**
- 不修改 `session-frontend/`、`web/`、`session-service/`、`service/` 任何文件。
- 不实现 ui/drawio 真实生成能力（仅 demo 交互 + api stub）。
- 不引入 i18n、不引入用户体系（沿用单 API Key）。
- 不新增后端 API（契约缺口以前端手段处置，演进预留写入 spec）。

## Decisions

### D1 技术栈完全对齐 session-frontend（而非另选框架）
复用其经受过 e2e 验证的 WS 客户端、store 设计与测试基建，移植成本最低且团队心智一致。备选（Vue/Svelte/Next.js）均需重写 WS 重连与审批流逻辑，收益为零。

### D2 平台抽象层：AgentRegistry + 四域 Provider 接口
主页卡片/路由/个人空间 tab 全部派生自 `AgentRegistry`（`AgentDescriptor{id, maturity, route, theme, artifactMediaTypes, providers, capabilities}`）；呈现层只消费 `SessionProvider` / `TurnStream` / `ArtifactProvider` / `WorkspaceProvider` 接口。demo 与真实通道共享同一 TurnStream 事件模型（ready/delta/tool/todo/approval/complete/error/closed），这是 demo→GA 演进成本趋近于零的前提。备选「各模块直连各自数据源」被否决：会导致个人空间与主页硬编码模块清单，扩展即改核心。

### D3 模型切换 = OpenHarness 主 agent 切模，双通道、零后端改动
① 建会话时 `extra_oh_args: ["--model", "<name>"]`（session-service 白名单已放行）设初始模型；② 会话空闲态经 WS `submit` 发送 `/model <name>`，链路 backend_host `submit_line` → `_process_line` → runtime `handle_line` → OpenHarness 命令注册表 `/model` handler（`engine.set_model` + `refresh_runtime`）已验证成立。前端乐观更新下拉显示态并校验系统消息回执；busy 期间禁用切换；模型候选前端常量维护（无模型列表 API，缺口 G1）。备选「等后端加结构化 set_model 帧」被否决：无需后端改动即可交付，结构化帧作为演进预留写入 spec。

### D4 个人空间视频 tab：前端聚合（N+1）而非等后端产物列表 API
`GET /v1/sessions` 分页 → 逐会话 `GET /turns` 筛 `has_artifact`，并发限制 4 + 按 `sid+turn_count` 缓存失效 + 每页 6 条客户端分页。封装在 `ArtifactProvider.aggregate()` 内，后端未来暴露 `GET /v1/artifacts` 时仅替换 provider 内部实现（缺口 G3）。

### D5 样式策略：demo 设计令牌为唯一色值源
demo `:root` 令牌全量移植 `index.css`，模块禁止私有硬编码色值；`AppHeader` + `page-detail` 三栏骨架抽象为共享布局；响应式沿用 demo 1100/900/640px 三档；session-frontend 多主题机制保留但默认主题重定义为 demo 亮色令牌。

### D6 隔离与冲突防护
localStorage 统一 `da.*` 前缀（apiKey/theme/currentSessionId/model）；dev 端口 3002、compose 端口 5175，与既有前端错开；nginx 模板照搬 session-frontend（/v1 反代 + WS Upgrade + access_log off 防 api_key 泄漏）。

### D7 测试完全走镜像
Dockerfile 四阶段：build（node:22-alpine）→ test（lint+vitest）→ e2e（`FROM oh-e2e-test:latest`，Playwright 锁 1.50.1 与镜像浏览器对齐，mock-backend 模拟 :8001）→ runtime（nginx:1.27-alpine + envsubst）。新增 `e2e/run-design-frontend-docker-tests.sh` 复刻 `run-session-frontend-docker-tests.sh` 模式，支持 `WEB_IMAGE` 式变量复用已有 runtime 镜像。

## Risks / Trade-offs

- [COLD 会话 resume 后是否沿用运行时切换的模型取决于 OH snapshot 行为] → M3 联调实测；若不沿用，重连后自动补发一次 `/model`。
- [无上传 API，demo 的「上传文档」按钮无法真实化] → 保留交互 + 明示「暂不支持」+ `uploadFile()` stub，不做假上传（缺口 G4）。
- [前端聚合 N+1 在会话量大时变慢] → 并发限制 + 缓存 + 渐进分页；provider 可替换性由契约测试保证（AC-3.3）。
- [Playwright 版本与 oh-e2e-test 镜像浏览器不一致会崩] → 锁定 1.50.1，与 session-frontend 完全一致。
- [demo 10% 留白窄屏挤压消息区] → 预览展开时归零、640px 以下降为 16px 固定边距（沿用 demo 断点）。

## Migration Plan

新增工程无迁移负担。部署：compose 增 `design-frontend` 服务（5175:80，depends_on session）；回滚 = 移除该服务定义，不影响任何既有服务。验收红线：`git status` 确认四个既有目录零变更。

## Open Questions

- COLD resume 后模型状态（见 Risks 第 1 条，M3 实测闭环，不阻塞开工）。
