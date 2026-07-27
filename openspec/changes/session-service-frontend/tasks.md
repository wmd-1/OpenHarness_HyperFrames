## 1. 项目初始化与基础设施

- [ ] 1.1 创建 `session-frontend/` 目录，初始化 Vite + React 18 + TypeScript 项目
- [ ] 1.2 配置 `package.json`，安装核心依赖（react, react-dom, zustand, ky, tailwindcss, react-router, lucide-react）
- [ ] 1.3 配置 Tailwind CSS 4 + CSS 变量主题体系，创建 `tailwind.config.ts` 和 `index.css`
- [ ] 1.4 配置 Vite 开发服务器（端口 3001，代理 `/v1` 和 `/healthz` 到 `localhost:8001`，含 WS 代理）
- [ ] 1.5 配置 ESLint + Prettier + tsconfig
- [ ] 1.6 创建项目目录结构（src/api, src/ws, src/store, src/hooks, src/components, src/theme, src/utils, src/types）

## 2. 类型定义与工具层

- [ ] 2.1 创建 `src/types/session.ts` — Session、SessionStatus、PermissionPolicy 等类型
- [ ] 2.2 创建 `src/types/conversation.ts` — Message、ToolCall、TurnStatus、ArtifactInfo 等类型
- [ ] 2.3 创建 `src/types/ws.ts` — ClientFrame、ServerFrame 联合类型
- [ ] 2.4 创建 `src/types/api.ts` — API 请求/响应类型（SessionCreateRequest、TurnSubmitRequest 等）
- [ ] 2.5 创建 `src/utils/sanitize.ts` — 输入清理、控制字符剥离、HTML 标签过滤、Shell 元字符检测
- [ ] 2.6 创建 `src/utils/format.ts` — 时间格式化（相对时间）、文件大小格式化
- [ ] 2.7 创建 `src/utils/constants.ts` — 常量定义（白名单参数、关闭码映射、心跳间隔等）

## 3. 主题系统

- [ ] 3.1 创建 `src/theme/themes.ts` — 5 个内置主题定义（default/dark/minimal/cyberpunk/solarized），映射为 CSS 变量
- [ ] 3.2 创建 `src/theme/ThemeProvider.tsx` — 主题 Context Provider，支持切换和 localStorage 持久化
- [ ] 3.3 创建 `src/hooks/useTheme.ts` — 主题切换 Hook

## 4. 认证与安全

- [ ] 4.1 创建 `src/api/client.ts` — ky 实例，配置 API Key 自动注入拦截器（`X-API-Key` 头）
- [ ] 4.2 创建 `src/api/health.ts` — 健康检查 API（`/healthz`、`/readyz`）
- [ ] 4.3 创建 `src/api/sessions.ts` — 会话 REST API（创建/查询/关闭/提交轮次/产物下载）
- [ ] 4.4 创建 `src/hooks/useHealth.ts` — 健康状态轮询 Hook（30s 间隔）
- [ ] 4.5 创建 `src/components/Settings/ApiKeyInput.tsx` — API Key 输入/脱敏/清除组件
- [ ] 4.6 创建认证状态管理逻辑 — 未认证→欢迎界面、认证失效→重弹对话框

## 5. 状态管理

- [ ] 5.1 创建 `src/store/sessionStore.ts` — Zustand store：会话列表、当前选中会话、本地缓存（localStorage 存储会话 ID）
- [ ] 5.2 创建 `src/store/conversationStore.ts` — Zustand store：消息列表、轮次状态、流式 delta 缓冲、工具调用、TODO 列表、待处理审批
- [ ] 5.3 创建 `src/store/uiStore.ts` — Zustand store：当前模式（chat/terminal）、全局错误消息、对话框可见性
- [ ] 5.4 创建 `src/store/wsStore.ts` — Zustand store：连接状态、最后消息时间、重连尝试次数、last_turn_index

## 6. WebSocket 客户端

- [ ] 6.1 创建 `src/ws/protocol.ts` — 消息编解码、类型校验、关闭码常量
- [ ] 6.2 创建 `src/ws/WebSocketClient.ts` — WebSocket 连接管理类：连接建立（携带 api_key + last_turn_index）、消息发送（submit/interrupt/approval/ping）、帧分发、指数退避重连（1s→30s，最多 10 次）、心跳保活（30s ping）、关闭码差异化处理
- [ ] 6.3 创建 `src/ws/useWebSocket.ts` — React Hook：封装连接生命周期、消息回调、状态同步到 wsStore

## 7. UI 框架（session-ui-shell）

- [ ] 7.1 创建 `src/components/Layout/AppShell.tsx` — 三段式响应式布局（侧栏 + 主区域 + 顶栏）
- [ ] 7.2 创建 `src/components/Layout/Sidebar.tsx` — 会话列表侧栏（新建按钮 + 会话卡片列表）
- [ ] 7.3 创建 `src/components/Layout/TopBar.tsx` — 顶栏（Logo + 健康徽章 + 模式切换 + 设置按钮）
- [ ] 7.4 创建 `src/components/Layout/ModeSwitcher.tsx` — Chat/Terminal 模式切换按钮
- [ ] 7.5 创建 `src/components/Session/SessionCard.tsx` — 会话卡片（状态徽章 + 策略图标 + 轮次数 + 时间）
- [ ] 7.6 创建 `src/components/Session/SessionDetail.tsx` — 会话详情头（ID + 状态 + 策略 + 轮次 + 时间）
- [ ] 7.7 创建 `src/components/Session/CreateDialog.tsx` — 创建会话对话框（权限策略选择 + 高级参数 + 白名单校验）
- [ ] 7.8 创建 `src/components/Session/StatusBadge.tsx` — 会话状态徽章（颜色编码）
- [ ] 7.9 创建 `src/components/Common/HealthBadge.tsx` — 服务健康状态徽章
- [ ] 7.10 创建 `src/components/Common/ErrorBanner.tsx` — 全局错误横幅（分级：info/warning/error/fatal）
- [ ] 7.11 创建底部 StatusBar 组件 — WebSocket 连接状态 + 会话状态 + 轮次计数 + 权限策略
- [ ] 7.12 创建 `src/components/Settings/SettingsPanel.tsx` 和 `ThemeSelector.tsx` — 设置面板和主题选择器

## 8. Chat Mode 实现（session-chat-mode）

- [ ] 8.1 创建 `src/components/Chat/ChatView.tsx` — Chat Mode 主视图（消息列表 + 输入栏 + TODO 面板）
- [ ] 8.2 创建 `src/components/Chat/MessageList.tsx` — 消息列表（虚拟滚动，使用 @tanstack/virtual）
- [ ] 8.3 创建 `src/components/Chat/MessageBubble.tsx` — 单条消息气泡（用户/助手/系统角色区分）
- [ ] 8.4 创建 `src/components/Chat/AssistantStream.tsx` — 流式助手回复渲染（批量 flush 50ms/384字符 + react-markdown + 打字光标）
- [ ] 8.5 创建 `src/components/Chat/ToolCallCard.tsx` — 工具调用折叠卡片（名称 + 输入摘要 + 状态 + 展开详情）
- [ ] 8.6 创建 `src/components/Chat/TodoPanel.tsx` — TODO 面板（可折叠 + markdown 解析 + 进度显示）
- [ ] 8.7 创建 `src/components/Chat/InputBar.tsx` — 输入栏（多行 + Enter 发送 + Shift+Enter 换行 + / 命令补全）
- [ ] 8.8 创建 `src/components/Artifact/VideoPlayer.tsx` — 视频预览播放器
- [ ] 8.9 创建 `src/components/Artifact/DownloadButton.tsx` — 产物下载按钮（处理 S3 302 重定向）
- [ ] 8.10 创建 `src/hooks/useConversation.ts` — 对话交互 Hook（submit/interrupt/approve 操作封装）

## 9. Terminal Mode 实现（session-terminal-mode）

- [ ] 9.1 安装 xterm.js 及插件（xterm-addon-fit、xterm-addon-web-links）
- [ ] 9.2 创建 `src/components/Terminal/XtermContainer.tsx` — xterm.js 容器组件（动态 import 按需加载）
- [ ] 9.3 创建 `src/components/Terminal/TerminalBridge.ts` — WS 事件到 xterm 终端输出的桥接适配（delta→文本、tool_start/tool_end→彩色输出、turn_complete→提示符）
- [ ] 9.4 创建 `src/components/Terminal/TerminalTheme.ts` — 终端主题映射（5 个内置主题 → xterm.js ITheme）
- [ ] 9.5 创建 `src/components/Terminal/TerminalView.tsx` — Terminal Mode 主视图（终端 + 底部状态栏 + 键盘快捷键处理）
- [ ] 9.6 实现键盘快捷键 — Ctrl+C 中断、Escape 中断、上下箭头历史、Tab 补全、Shift+Enter 换行

## 10. 审批交互流（session-approval）

- [ ] 10.1 创建 `src/components/Approval/ApprovalModal.tsx` — 审批模态框容器（根据 modal 类型分发）
- [ ] 10.2 创建 `src/components/Approval/PermissionPrompt.tsx` — 权限确认弹窗（允许一次/始终允许/拒绝）
- [ ] 10.3 创建 `src/components/Approval/DiffApproval.tsx` — edit_diff 审批弹窗（diff 视图 + 审批选项）
- [ ] 10.4 创建 `src/components/Approval/QuestionPrompt.tsx` — question 回答弹窗（问题文本 + 输入框）
- [ ] 10.5 创建 `src/hooks/useApproval.ts` — 审批流 Hook（接收 approval_request、管理弹窗状态、提交 approval 帧、超时倒计时）
- [ ] 10.6 实现审批弹窗可访问性 — Tab 焦点管理、Enter 确认、Escape 拒绝

## 11. 应用入口与路由

- [ ] 11.1 创建 `src/App.tsx` — 顶层路由（欢迎页 / 主应用）
- [ ] 11.2 创建 `src/main.tsx` — 应用入口（Provider 嵌套：ThemeProvider → SessionProvider → App）
- [ ] 11.3 实现欢迎界面 — API Key 输入 + 健康检查 + 连接按钮
- [ ] 11.4 实现会话生命周期状态机前端逻辑 — creating→live→idle→cold→closed/expired 状态转换和 UI 响应

## 12. 测试

- [ ] 12.1 配置 Vitest + Testing Library + Playwright
- [ ] 12.2 编写 `utils/sanitize.ts` 单元测试 — 输入清理、XSS 防护
- [ ] 12.3 编写 `ws/protocol.ts` 单元测试 — 消息编解码、类型校验
- [ ] 12.4 编写 `store/*` 单元测试 — 状态变更逻辑
- [ ] 12.5 编写 `useWebSocket` Hook 集成测试 — 连接/断开/重连行为
- [ ] 12.6 编写 `CreateDialog` 集成测试 — 表单校验、提交行为
- [ ] 12.7 编写 `ApprovalModal` 集成测试 — 审批交互流程
- [ ] 12.8 编写 Playwright E2E 测试 — 完整对话流程、断线重连、模式切换、错误恢复

## 13. 部署配置

- [ ] 13.1 创建 `Dockerfile` — 多阶段构建（node:20-alpine build → nginx:alpine serve）
- [ ] 13.2 创建 `nginx.conf.template` — SPA 路由 fallback + API 代理 + WebSocket 代理 + 静态资源缓存
- [ ] 13.3 更新 `docker-compose.yml` — 添加 session-frontend 服务
- [ ] 13.4 创建 `.github/workflows/session-frontend.yml` — CI 流水线（lint + unit test + integration test + E2E）
