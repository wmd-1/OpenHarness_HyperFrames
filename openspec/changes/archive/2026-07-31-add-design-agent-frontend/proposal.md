# Add Design Agent Frontend（设计智能体前端系统）

## Why

现有两个前端（`web/` 面向视频任务 API、`session-frontend/` 面向交互式会话）均不具备 demo（`demo/设计智能体平台.html`）所定义的"设计智能体平台"形态：统一主页 + 多设计能力域（原型页面设计 / Drawio 设计 / 文本生成视频 / 个人空间）。需要一个**新建独立**的前端系统，在不改动现有前端与后端的前提下，把 demo 的视觉/交互与 session-frontend 的真实会话能力融合，并以平台抽象层（AgentRegistry / SessionProvider / TurnStream / ArtifactProvider / WorkspaceProvider）承载未来能力域从 demo 到 GA 的演进。

方案依据：`plans/Design_Agent_Frontend_Four_Modules_Plan_2026-07-31.md`（v1 实施方案）+ `plans/Design_Agent_Frontend_Architecture_v2_2026-07-31.md`（v2 架构设计），两者已评审通过。

## What Changes

- 新建独立前端工程 `design-agent-frontend/`（与 `session-frontend/`、`web/` 平级），React 18.3 + TS 5.7 + Vite 6 + Zustand 5 + Tailwind v4，技术栈与 session-frontend 对齐；dev 端口 3002、compose 端口 5175、localStorage 键统一 `da.*` 前缀。
- **平台抽象层**：AgentRegistry 声明式驱动四大模块（主页卡片/路由/个人空间 tab 均派生自注册表）；Session/TurnStream/Artifact/Workspace 四域抽象接口；SessionServiceAdapter（真实）与 DemoAdapter（演示）共享同一 TurnStream 事件模型。
- **文本生成视频模块**（GA）：对接 session-service 现有 REST + WS 契约（不改后端），保留 session-frontend 全部 17 项核心功能（认证/会话列表/历史切换/WS 流式/审批流/Terminal/工作区文件等），融合 demo 交互（10% 会话区留白、预览面板 0↔50% 展开、自定义播放器全控制条、模型下拉）。模型切换对象为 **OpenHarness 主 agent 模型**，双通道：建会话 `extra_oh_args: ["--model", name]` + 会话空闲态经 WS submit 发送 `/model <name>`。
- **个人空间模块**：视频 tab 真实数据（前端聚合 sessions+turns 派生产物列表，限并发+缓存）；ui/drawio tab 保留 demo 演示数据并带「演示」标识。
- **原型页面设计 / Drawio 设计模块**（demo）：demo 全部交互 React 组件化（设备切换/源码视图/SVG 缩放/下载/全屏/模拟对话），`api.ts` 空 stub 预留，本地内存状态。
- **工程化**：四阶段 Dockerfile（build/test/e2e/runtime，e2e 基于 `oh-e2e-test:latest`）、nginx 反代模板（envsubst SESSION_HOST/PORT）、docker-compose 新增 `design-frontend` 服务、`e2e/run-design-frontend-docker-tests.sh` 冒烟脚本、CI workflow。
- 不改动 `session-frontend/`、`web/`、`session-service/`、`service/` 任何文件（无 BREAKING）。

## Capabilities

### New Capabilities

- `design-agent-platform`: 平台抽象层——AgentRegistry 驱动的能力域清单、Session/TurnStream/Artifact/Workspace 四域接口与不变量、demo/GA 成熟度语义、AgentCapabilities 能力开关。
- `design-agent-video`: 文本生成视频模块——session-service REST/WS/错误/重连/多租户契约依赖声明、session-frontend 核心功能保留清单、demo 交互真实化（OpenHarness 主 agent 模型双通道切换、自定义播放器、留白布局、预览面板）。
- `design-agent-space`: 个人空间——跨 provider 产物聚合视图、真实/演示混合呈现、数据源可替换性（前端聚合 → 未来后端产物列表 API）。
- `design-agent-demo-modules`: ui/drawio 演示模块——demo 交互保全清单、api stub 预留形态、与真实通道的 TurnStream 同构约束。

### Modified Capabilities

（无——不修改 `openspec/specs/` 下任何既有 spec；`design-agent-video` 以引用方式依赖 `session-history-switch` 等既有契约，避免双源。）

## Impact

- **新增代码**：`design-agent-frontend/` 全新工程（src/、e2e/、Dockerfile、nginx.conf.template、docker-entrypoint.sh、CI workflow）。
- **修改文件**：仅 `docker-compose.yml`（追加 `design-frontend` 服务定义，不动现有服务）、`e2e/`（新增一个冒烟脚本）、`.github/workflows/`（新增一个 workflow）。
- **后端/API**：零改动；前端完全适配 session-service 现契约，已知缺口（无模型列表 API、运行时切模无结构化契约、无产物列表 API、无上传 API）以前端常量/文本命令通道/前端聚合/stub 处置并在 spec 中声明演进预留。
- **测试**：全部在 Docker 镜像内执行（vitest/lint 走 `--target test`，Playwright 1.50.1 走 `--target e2e` 基于 oh-e2e-test:latest），宿主机仅 docker/curl。
