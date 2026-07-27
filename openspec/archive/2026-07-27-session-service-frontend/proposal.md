## Why

session-service 后端已提供完整的会话管理、实时流式对话（WebSocket）和产物下载能力，但目前缺少配套的前端应用。现有的 `web/` 前端面向 video-service，无法覆盖多轮对话交互场景。需要一个功能完整的前端应用，支持 Chat Mode（Web 对话界面）和 Terminal Mode（终端模拟）两种交互模式，让用户能够通过可视化界面与 session-service 后端进行实时交互。

## What Changes

- 新建 `session-frontend/` 前端项目，基于 React 18 + TypeScript + Vite 6 + Zustand + Tailwind CSS 4
- 实现 Chat Mode：现代化 Web 对话界面，支持流式助手回复、工具调用展示、TODO 面板、审批弹窗、视频产物预览
- 实现 Terminal Mode：基于 xterm.js 的终端模拟界面，复用终端前端的交互模式和主题系统
- 实现 WebSocket 客户端：支持实时流式对话、断线重连（指数退避 + `last_turn_index` 补发）、心跳保活
- 实现 REST API 客户端：会话 CRUD、对话轮次提交（REST 兜底）、产物下载
- 实现 API Key 认证：HTTP 通过 `X-API-Key` 头，WebSocket 通过 `?api_key=` 查询参数
- 实现会话全生命周期管理：创建、活跃、空闲、休眠、关闭、过期等状态可视化
- 实现 5 个内置主题（default/dark/minimal/cyberpunk/solarized），支持 Chat/Terminal 模式切换
- 实现响应式布局：侧栏会话列表 + 主区域对话视图，支持桌面/平板/移动端适配
- 集成健康检查、错误处理（分级：info/warning/error/fatal）、限流提示
- 配置 Docker 部署 + Nginx 反向代理（含 WebSocket 代理）+ CI/CD 流水线

## Capabilities

### New Capabilities

- `session-chat-mode`: Chat Mode 核心功能 — 流式对话视图、消息渲染（用户/助手/工具/系统）、输入栏、工具调用折叠卡片、TODO 面板、流式文本批量渲染优化
- `session-terminal-mode`: Terminal Mode 核心功能 — xterm.js 终端容器、WS 事件到终端输出的桥接、键盘快捷键、命令历史、终端主题映射
- `session-ws-protocol`: WebSocket 客户端协议实现 — 连接管理、消息编解码（submit/interrupt/approval/ping）、断线重连、心跳、关闭码处理
- `session-rest-api`: REST API 客户端 — 会话 CRUD、轮次提交、产物下载、API Key 注入、错误拦截
- `session-auth`: 认证与安全 — API Key 存储/脱敏/注入、输入校验（白名单参数、Shell 元字符禁止）、XSS 防护
- `session-ui-shell`: UI 框架 — 响应式布局（AppShell/Sidebar/TopBar/StatusBar）、模式切换、主题系统、会话列表/详情组件
- `session-approval`: 审批交互流 — interactive 策略下的审批弹窗（权限确认、edit_diff 审批、question 回答）、审批超时处理

### Modified Capabilities

（无现有 spec 需要修改）

## Impact

- **新增代码目录**: `session-frontend/` — 全新前端项目，不影响现有代码
- **依赖**: 新增 npm 依赖（react, zustand, xterm.js, ky, tailwindcss, react-markdown 等）
- **部署**: 需要新增 Docker 镜像构建、docker-compose 服务、nginx 配置
- **后端依赖**: 依赖 session-service (:8001) 运行；后端缺少会话列表查询 API，前端需本地缓存会话 ID 作为临时方案
- **CI/CD**: 新增 GitHub Actions workflow 用于 lint/test/build
- **现有项目**: 无影响，独立项目目录
