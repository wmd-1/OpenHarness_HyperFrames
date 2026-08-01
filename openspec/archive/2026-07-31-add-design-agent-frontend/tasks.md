## 1. 脚手架与设计系统（v1 M1）

- [x] 1.1 初始化 `design-agent-frontend/` 工程：package.json（依赖版本对齐 session-frontend：React 18.3/TS 5.7/Vite 6/Zustand 5/ky/Tailwind v4/react-markdown/@tanstack/react-virtual/@xterm 三件套/react-router-dom 7/lucide-react；vitest 3/Playwright 1.50.1）、tsconfig*、vite.config.ts（dev 3002，/v1 ws:true、/healthz、/readyz 代理 :8001，xterm 独立 chunk）、vitest.config.ts、eslint/.prettierrc/.gitignore/.dockerignore、index.html
- [x] 1.2 移植 demo 设计令牌到 `src/index.css`（:root 全量变量 + 全局样式 + 1100/900/640px 断点），建立 ThemeProvider（默认主题=demo 亮色令牌，保留多主题机制）
- [x] 1.3 实现共享布局与基础组件：AppHeader（56px 顶栏/返回键/面包屑/健康徽标/设置/用户）、Icon（demo 内联 SVG 库）、page-detail 三栏骨架、ErrorBanner/ConfirmDialog/HealthBadge
- [x] 1.4 实现路由表（/、/ui、/drawio、/video、/space）与主页四模块卡片（demo 1:1，含模块主题色渐变），入口 App.tsx 鉴权门 + Welcome API Key 页（移植 WelcomeScreen/ApiKeyInput，`da.*` 前缀）

## 2. 平台抽象层（v2 §2，spec: design-agent-platform）

- [x] 2.1 定义四域契约类型：AgentDescriptor/AgentCapabilities、SessionProvider/SessionSummary、TurnStream（事件模型 ready/delta/tool/todo/approval/complete/error/closed + ChannelState）、ArtifactProvider/ArtifactRef、WorkspaceProvider
- [x] 2.2 实现 AgentRegistry：注册 video-generation(ga)/ui-prototype(demo)/drawio-diagram(demo)，主页卡片/路由/个人空间 tab 全部由注册表派生；maturity!==ga 数据带「演示」标识的通用机制
- [x] 2.3 实现 DemoAdapter：内存 SessionProvider + TurnStream（固定延迟模拟回复）+ 静态 ArtifactProvider，事件类型与真实通道一致
- [x] 2.4 平台层单测：注册表派生一致性、TurnStream 事件类型集合同构（类型级 + 运行时契约测试）、canResumeSession 谓词

## 3. 共享层移植（v1 M2）

- [x] 3.1 移植 API 层：client.ts（ky + X-API-Key + 401/403/429/503 拦截，`da.*` 存储）、sessions.ts（全部 REST 端点 + artifactUrl/artifactStreamUrl/workspace 直链 ?api_key=）、health.ts
- [x] 3.2 移植 WS 层：WebSocketClient（指数退避/4400-4503 close code 策略/心跳 30s/last_turn_index）、protocol.ts、useWebSocket、StreamBuffer（delta final+full_text 覆盖语义）
- [x] 3.3 移植 store/hooks/utils：authStore/sessionStore/conversationStore/wsStore/uiStore（增 selectedModel）、useSessionList/useTurnHistory/useApproval/useHealth、constants/sanitize/format/slashCommands
- [x] 3.4 以 SessionServiceAdapter 将移植层封装为平台 provider 实现（SessionProvider/TurnStream/ArtifactProvider/WorkspaceProvider）
- [x] 3.5 移植并适配对应单测（api 拦截、ws 协议/重连分支、store action）

## 4. 视频模块（v1 M3，spec: design-agent-video）

- [x] 4.1 三栏布局 VideoModulePage：HistoryPanel（新建会话/历史列表/只读徽标/分页加载）、ChatPanel（chat-header + 10% 留白 + 预览联动归零 + 640px 降 16px）、预览面板 0↔50% 过渡展开
- [x] 4.2 聊天全功能：MessageList（虚拟滚动）+ MessageBubble（msg-system/user/ai 三色 + react-markdown）+ AssistantStream + ToolCallCard + TodoPanel + InputBar（Enter/Shift+Enter、输入历史、斜杠命令、中断、REST 兜底）
- [x] 4.3 模型切换 ModelSelector：前端常量候选、`da.model` 持久化、建会话注入 `--model`、空闲态经 WS 提交 `/model <name>` + 乐观更新 + 回执校验、busy 禁用
- [x] 4.4 上传按钮（demo 交互 + 「暂不支持」提示 + uploadFile stub）、审批流三弹窗移植（demo 风格化）、Chat/Terminal 双模式移植、工作区文件抽屉（live/archive）
- [x] 4.5 CustomVideoPlayer（demo 全套控制条：缓冲进度/seek/播放/音量/倍速/时间/3s 自动隐藏）+ 全屏/下载 + 多轮产物切换条 + turn_complete.has_artifact 自动展开加载
- [x] 4.6 视频模块单测（播放器控制逻辑、模型切换双通道、留白联动、历史切换流程）

## 5. 个人空间（v1 M4，spec: design-agent-space）

- [x] 5.1 SpacePage：三 tab + 计数徽标 + 卡片网格 + 分页（每页 6），默认激活视频 tab
- [x] 5.2 useVideoAssets 聚合 hook（sessions→turns 筛 has_artifact、并发 4、sid+turn_count 缓存、finished_at 倒序、骨架屏/空态），封装于 ArtifactProvider.aggregate()
- [x] 5.3 视频资产卡片：预览模态（CustomVideoPlayer + stream）与下载直链；ui/drawio DemoAssetsTab（demo 静态数据 + 演示角标 + 占位下载）
- [x] 5.4 个人空间单测（聚合并发/缓存/空态、provider 可替换性契约测试、演示标识）

## 6. ui/drawio 演示模块（v1 M5，spec: design-agent-demo-modules）

- [x] 6.1 UiDesignPage：三栏 + 静态历史 12 条 + 新建会话 + DemoAdapter 模拟对话 + PreviewPanel（网页/手机刘海/平板/源码 tab 行号高亮）
- [x] 6.2 DrawioPage：三栏 + 示例 SVG 流程图 + DiagramCanvas（缩放 30–300%/适应/下载 SVG/全屏/网格背景/状态栏）+ 模拟对话
- [x] 6.3 两模块 `api.ts` 空 stub（签名预留 + 集中 TODO）；单测（缩放计算、设备切换、下载合法性）

## 7. 工程化与测试（v1 M6，spec: AC-5）

- [x] 7.1 Dockerfile 四阶段（build node:22-alpine / test lint+vitest / e2e FROM oh-e2e-test:latest + PW_CHROMIUM_PATH / runtime nginx:1.27-alpine + version.json + HEALTHCHECK）、nginx.conf.template（/v1 反代 + WS Upgrade + access_log off + 缓存策略 + CSP）、docker-entrypoint.sh（envsubst SESSION_HOST/SESSION_PORT）
- [x] 7.2 Playwright e2e：移植改造 mock-backend.mjs（:8001）；用例①主页四卡片导航 ②视频全链路（建会话→WS 流式→turn_complete→预览自动展开→下载断言）③历史切换/只读 ④个人空间聚合分页 ⑤ui/drawio 冒烟 ⑥错误场景（401/403/429/503/4430/4503）
- [x] 7.3 docker-compose.yml 追加 design-frontend 服务（5175:80，SESSION_HOST=session，depends_on session；不动既有服务）；新增 `e2e/run-design-frontend-docker-tests.sh`（复刻 session-frontend 模式，支持镜像复用变量）；新增 `.github/workflows/design-frontend.yml`
- [x] 7.4 README.md（含更新日期注释）；镜像内全量验证：`--target test`（lint+vitest）与 `--target e2e`（Playwright）构建通过，runtime 冒烟（nginx 反代/健康检查）通过
- [x] 7.5 隔离性验收：`git status` 确认 session-frontend/、web/、session-service/、service/ 零变更；localStorage 键全部 `da.*` 前缀
