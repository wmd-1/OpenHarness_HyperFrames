# Session Service 前端应用设计方案

> 版本: v1.0 | 日期: 2026-07-27 | 状态: 草案

---

## 1. 项目概述

### 1.1 目标

为 `session-service` 后端设计一个功能完整、界面友好的前端应用，支持 **Web 对话模式** 和 **终端模拟模式** 两种交互形态，覆盖会话全生命周期管理、实时流式对话、审批交互、产物预览/下载等核心场景。

### 1.2 后端能力摘要

| 能力 | 说明 |
|------|------|
| REST API | 会话 CRUD、对话轮次提交（REST 兜底）、产物下载 |
| WebSocket | 实时流式对话（delta/tool_start/tool_end/todo/approval_request） |
| 权限策略 | `full_auto`（无人值守）/ `interactive`（需审批） |
| 认证 | API Key（HTTP: `X-API-Key` 头, WS: `?api_key=` 查询参数） |
| 限流 | IP 令牌桶 + 租户并发配额(8) + 每日配额(200) + 节点容量(16) |
| 产物 | 视频文件，支持 Range 分段 + S3 302 重定向 |

### 1.3 双模式设计理念

```
┌─────────────────────────────────────────────────┐
│                 Session Frontend                 │
│                                                  │
│  ┌──────────────┐    ┌──────────────────────┐   │
│  │  Chat Mode   │    │   Terminal Mode       │   │
│  │  (Web UI)    │    │   (终端模拟)          │   │
│  │              │    │                       │   │
│  │ 标准对话界面  │    │ 仿 CLI 终端界面       │   │
│  │ 富文本渲染   │    │ 等宽字体 + ANSI 风格   │   │
│  │ 视频预览     │    │ 紧凑信息密度          │   │
│  │ 拖拽交互     │    │ 键盘驱动              │   │
│  └──────┬───────┘    └──────────┬───────────┘   │
│         │                       │                │
│         └───────┬───────────────┘                │
│                 ▼                                │
│       ┌─────────────────┐                        │
│       │  Shared Layer   │                        │
│       │  - WS Client    │                        │
│       │  - REST Client  │                        │
│       │  - State Store  │                        │
│       │  - Auth         │                        │
│       └─────────────────┘                        │
└─────────────────────────────────────────────────┘
```

---

## 2. 技术栈选择与架构设计

### 2.1 技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| **框架** | React 18 + TypeScript 5.7 | 与现有 `web/` 和 `terminal/` 保持一致；生态成熟 |
| **构建** | Vite 6 | 极速 HMR，与现有项目一致 |
| **路由** | React Router v7 | SPA 多页面导航（会话列表、对话、设置） |
| **状态管理** | Zustand + React Context | Zustand 管理全局会话状态/WS连接；Context 管理主题/UI 偏好 |
| **WebSocket** | 原生 WebSocket + 自研 Hook | 后端协议为自定义 JSON 帧，无需 Socket.IO |
| **HTTP** | ky (轻量 fetch 封装) | 类型安全、拦截器、自动重试 |
| **Markdown** | react-markdown + remark-gfm | 对话消息富文本渲染 |
| **终端模拟** | xterm.js + xterm-addon-fit | Terminal Mode 的终端渲染引擎 |
| **视频播放** | 原生 `<video>` + video.js (可选) | 产物预览 |
| **样式** | Tailwind CSS 4 + CSS 变量主题 | 原子化 CSS + 主题切换，从终端前端的 5 主题移植 |
| **图标** | Lucide React | 轻量、一致的图标集 |
| **表单** | React Hook Form + Zod | 输入校验与后端 Schema 对齐 |
| **测试** | Vitest + Testing Library + Playwright | 单元/集成/E2E 三层测试 |
| **代码质量** | ESLint + Prettier | 与现有项目一致 |

### 2.2 项目结构

```
session-frontend/
├── public/
│   └── favicon.svg
├── src/
│   ├── api/
│   │   ├── client.ts              # ky 实例 + 拦截器
│   │   ├── sessions.ts            # 会话 REST API
│   │   ├── artifacts.ts           # 产物下载 API
│   │   └── health.ts              # 健康检查 API
│   ├── ws/
│   │   ├── WebSocketClient.ts     # WS 连接管理 + 自动重连
│   │   ├── protocol.ts            # 消息类型定义 + 编解码
│   │   └── useWebSocket.ts        # React Hook
│   ├── store/
│   │   ├── sessionStore.ts        # 会话列表 + 当前会话状态
│   │   ├── conversationStore.ts   # 对话消息 + 轮次状态
│   │   └── uiStore.ts             # UI 偏好 (模式/主题/侧栏)
│   ├── hooks/
│   │   ├── useSession.ts          # 会话 CRUD 操作
│   │   ├── useConversation.ts     # 对话交互 (submit/interrupt/approve)
│   │   ├── useApproval.ts         # 审批流处理
│   │   ├── useArtifact.ts         # 产物下载/流式播放
│   │   ├── useHealth.ts           # 健康状态轮询
│   │   └── useTheme.ts            # 主题切换
│   ├── components/
│   │   ├── Layout/
│   │   │   ├── AppShell.tsx       # 顶层布局 (侧栏 + 主区域)
│   │   │   ├── Sidebar.tsx        # 会话列表侧栏
│   │   │   ├── TopBar.tsx         # 顶栏 (健康状态 + 设置)
│   │   │   └── ModeSwitcher.tsx   # Chat/Terminal 模式切换
│   │   ├── Chat/
│   │   │   ├── ChatView.tsx       # Chat Mode 主视图
│   │   │   ├── MessageList.tsx    # 消息列表 (虚拟滚动)
│   │   │   ├── MessageBubble.tsx  # 单条消息渲染
│   │   │   ├── AssistantStream.tsx# 流式助手回复渲染
│   │   │   ├── ToolCallCard.tsx   # 工具调用折叠卡片
│   │   │   ├── TodoPanel.tsx      # TODO 列表面板
│   │   │   └── InputBar.tsx       # 输入栏 (多行 + 命令补全)
│   │   ├── Terminal/
│   │   │   ├── TerminalView.tsx   # Terminal Mode 主视图
│   │   │   ├── XtermContainer.tsx # xterm.js 容器
│   │   │   ├── TerminalBridge.ts  # WS 事件 → xterm 写入适配
│   │   │   └── TerminalTheme.ts   # 终端主题映射
│   │   ├── Approval/
│   │   │   ├── ApprovalModal.tsx  # 审批弹窗
│   │   │   ├── PermissionPrompt.tsx
│   │   │   ├── DiffApproval.tsx   # edit_diff 审批
│   │   │   └── QuestionPrompt.tsx # question 回答
│   │   ├── Artifact/
│   │   │   ├── ArtifactList.tsx   # 产物列表
│   │   │   ├── VideoPlayer.tsx    # 视频预览播放器
│   │   │   └── DownloadButton.tsx # 下载按钮
│   │   ├── Session/
│   │   │   ├── SessionCard.tsx    # 会话卡片 (侧栏)
│   │   │   ├── SessionDetail.tsx  # 会话详情头
│   │   │   ├── CreateDialog.tsx   # 创建会话对话框
│   │   │   └── StatusBadge.tsx    # 会话状态徽章
│   │   ├── Common/
│   │   │   ├── HealthBadge.tsx    # 服务健康状态
│   │   │   ├── ErrorBanner.tsx    # 全局错误横幅
│   │   │   ├── LoadingSpinner.tsx
│   │   │   └── ConfirmDialog.tsx
│   │   └── Settings/
│   │       ├── SettingsPanel.tsx   # 设置面板
│   │       ├── ApiKeyInput.tsx     # API Key 配置
│   │       └── ThemeSelector.tsx   # 主题选择器
│   ├── theme/
│   │   ├── themes.ts              # 5 个内置主题 (从终端前端移植)
│   │   ├── ThemeProvider.tsx       # 主题 Context Provider
│   │   └── tailwind.config.ts     # Tailwind 主题色映射
│   ├── utils/
│   │   ├── sanitize.ts            # 输入清理 (复用现有)
│   │   ├── format.ts              # 时间/大小格式化
│   │   └── constants.ts           # 常量定义
│   ├── types/
│   │   ├── session.ts             # 会话类型
│   │   ├── conversation.ts        # 对话类型
│   │   ├── ws.ts                  # WebSocket 消息类型
│   │   └── api.ts                 # API 响应类型
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── tests/
│   ├── unit/                      # Vitest 单元测试
│   ├── integration/               # Testing Library 集成测试
│   └── e2e/                       # Playwright E2E
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
└── playwright.config.ts
```

---

## 3. 页面布局与 UI 设计

### 3.1 整体布局

```
┌──────────────────────────────────────────────────────────────┐
│ TopBar: [Logo] [HealthBadge] [HealthCheck]    [ModeSwitch] [Settings] │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                    │
│ Sidebar  │              Main Content Area                     │
│          │                                                    │
│ [+ New]  │  ┌─ SessionDetail ─────────────────────────────┐  │
│          │  │ Session ID | Status | Policy | Turns | Time  │  │
│ ──────── │  └──────────────────────────────────────────────┘  │
│ Session  │                                                    │
│  List    │  ┌──────────────────────────────────────────────┐  │
│          │  │                                              │  │
│ ● sess-1 │  │   ChatView / TerminalView                    │  │
│ ○ sess-2 │  │   (根据 ModeSwitcher 选择切换)               │  │
│ ● sess-3 │  │                                              │  │
│          │  │                                              │  │
│          │  └──────────────────────────────────────────────┘  │
│          │                                                    │
│          │  ┌──────────────────────────────────────────────┐  │
│          │  │ InputBar / Terminal Input                     │  │
│          │  └──────────────────────────────────────────────┘  │
│          │                                                    │
├──────────┴───────────────────────────────────────────────────┤
│ StatusBar: [Connection] [Session Status] [Turn Count] [Policy]│
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Chat Mode 视图

Chat Mode 是默认模式，提供现代化的 Web 对话体验：

- **消息流**: 用户消息（右对齐，主题色背景）+ 助手回复（左对齐，浅灰背景）
- **流式渲染**: 助手回复实时流式显示，带打字光标动画
- **工具调用**: 折叠式卡片，显示工具名、输入参数摘要、执行结果/错误
- **TODO 面板**: 可折叠的侧面板，实时展示任务清单
- **审批弹窗**: `interactive` 策略下，模态框弹出审批请求
- **产物区域**: 轮次完成后，消息内嵌视频预览卡片 + 下载按钮
- **输入栏**: 多行文本框，支持 `/` 命令补全、Shift+Enter 换行、Enter 发送

### 3.3 Terminal Mode 视图

Terminal Mode 提供仿 CLI 终端体验，面向高级用户：

- **终端渲染**: 基于 xterm.js，等宽字体，暗色背景
- **信息密度**: 紧凑布局，最大化信息展示
- **交互方式**: 键盘驱动，支持终端前端的快捷键体系：
  - `Ctrl+C`: 中断/退出
  - `Escape`: 运行中中断
  - `↑/↓`: 历史命令导航
  - `Tab`: 命令补全
  - `Shift+Enter`: 换行
- **状态栏**: 终端底部显示模型、token 用量、权限模式
- **主题**: 复用终端前端的 5 个主题（default/dark/minimal/cyberpunk/solarized）

### 3.4 响应式设计

| 断点 | 布局调整 |
|------|----------|
| `≥1280px` | 侧栏展开 (280px) + 主区域 |
| `768-1279px` | 侧栏可折叠 (64px 图标模式) |
| `<768px` | 侧栏隐藏（汉堡菜单唤出），全宽主区域 |

---

## 4. 与后端 API 的集成方案

### 4.1 REST 客户端

```typescript
// src/api/client.ts
import ky from 'ky';

export const apiClient = ky.create({
  prefixUrl: '/v1',
  headers: {
    // 动态注入 X-API-Key
  },
  hooks: {
    beforeRequest: [
      (request) => {
        const apiKey = localStorage.getItem('api_key');
        if (apiKey) {
          request.headers.set('X-API-Key', apiKey);
        }
      }
    ],
    afterResponse: [
      async (_request, _options, response) => {
        if (response.status === 401) {
          // 触发重新登录
          uiStore.showAuthDialog();
        }
        if (response.status === 429) {
          // 限流提示
          uiStore.showRateLimitBanner();
        }
      }
    ]
  },
  retry: { limit: 2, methods: ['GET'] }
});
```

### 4.2 API 封装

```typescript
// src/api/sessions.ts
export const sessionsApi = {
  // 创建会话
  create: (req: SessionCreateRequest) =>
    apiClient.post('sessions', { json: req }).json<SessionResponse>(),

  // 查询会话
  get: (sid: string) =>
    apiClient.get(`sessions/${sid}`).json<SessionResponse>(),

  // 关闭会话
  close: (sid: string) =>
    apiClient.delete(`sessions/${sid}`).json<DeleteResponse>(),

  // REST 兜底提交对话
  submitTurn: (sid: string, text: string) =>
    apiClient.post(`sessions/${sid}/turns`, { json: { text } }).json<TurnResponse>(),

  // 下载产物 (返回 blob 或跟随 S3 重定向)
  downloadArtifact: (sid: string, turnIdx: number, mode?: 'stream') =>
    apiClient.get(`sessions/${sid}/turns/${turnIdx}/artifact`, {
      searchParams: mode ? { mode } : {},
    }).blob(),
};
```

### 4.3 WebSocket 客户端

```typescript
// src/ws/WebSocketClient.ts
export class SessionWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private lastTurnIndex = 0;

  constructor(
    private sid: string,
    private onMessage: (msg: ServerFrame) => void,
    private onStatusChange: (status: WSStatus) => void,
  ) {}

  connect() {
    const apiKey = localStorage.getItem('api_key') || '';
    const params = new URLSearchParams({
      api_key: apiKey,
      last_turn_index: String(this.lastTurnIndex),
    });
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/v1/sessions/${this.sid}/ws?${params}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatusChange('connected');
    };

    this.ws.onmessage = (event) => {
      const frame = JSON.parse(event.data) as ServerFrame;
      this.handleFrame(frame);
    };

    this.ws.onclose = (event) => {
      this.handleClose(event.code);
    };

    // 心跳
    this.heartbeatInterval = setInterval(() => {
      this.send({ op: 'ping' });
    }, 30_000);
  }

  private handleFrame(frame: ServerFrame) {
    switch (frame.type) {
      case 'session_ready':
        this.onStatusChange('ready');
        break;
      case 'delta':
        this.lastTurnIndex = frame.turn_index;
        break;
      case 'turn_complete':
        this.lastTurnIndex = frame.turn_index;
        break;
      case 'pong':
        break;
      // ... 其他帧处理
    }
    this.onMessage(frame);
  }

  private handleClose(code: number) {
    clearInterval(this.heartbeatInterval);
    switch (code) {
      case 4401: this.onStatusChange('auth_failed'); break;
      case 4403: this.onStatusChange('session_closed'); break;
      case 4404: this.onStatusChange('not_found'); break;
      case 4429: this.onStatusChange('rate_limited'); break;
      default:
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
          setTimeout(() => this.connect(), delay);
          this.reconnectAttempts++;
          this.onStatusChange('reconnecting');
        } else {
          this.onStatusChange('disconnected');
        }
    }
  }

  // 客户端发送方法
  submit(text: string) { this.send({ op: 'submit', text }); }
  interrupt() { this.send({ op: 'interrupt' }); }
  approval(req: ApprovalRequest) { this.send({ op: 'approval', ...req }); }
}
```

### 4.4 断线重连策略

```
连接断开
  │
  ├─ 4401 (鉴权失败) → 提示重新输入 API Key，不重连
  ├─ 4403 (会话关闭) → 标记会话 closed，不重连
  ├─ 4404 (不存在)   → 提示错误，不重连
  ├─ 4429 (限流)     → 等待 60s 后尝试一次
  ├─ 4500 (不可用)   → 等待 10s 后尝试一次
  └─ 其他/网络断开   → 指数退避重连 (1s → 2s → 4s → ... → 30s max)
                       携带 last_turn_index 补发缺失轮次
                       最多 10 次尝试
```

---

## 5. 数据流管理与状态管理策略

### 5.1 状态分层

```
┌─────────────────────────────────────────────┐
│                  UI State                    │
│  (Zustand: uiStore)                         │
│  - 当前模式 (chat/terminal)                  │
│  - 主题 (default/dark/minimal/cyberpunk/...) │
│  - 侧栏展开/折叠                            │
│  - 全局错误消息                              │
│  - 认证对话框可见性                          │
├─────────────────────────────────────────────┤
│              Session State                   │
│  (Zustand: sessionStore)                    │
│  - 会话列表 (id, status, turn_count, ...)    │
│  - 当前选中会话 ID                           │
│  - 会话详情缓存                              │
│  - 会话列表加载状态                          │
├─────────────────────────────────────────────┤
│           Conversation State                 │
│  (Zustand: conversationStore)               │
│  - 消息列表 (user/assistant/tool/system)     │
│  - 当前轮次状态 (idle/running/completed)     │
│  - 流式 delta 缓冲                           │
│  - 工具调用列表                              │
│  - TODO 列表                                 │
│  - 待处理审批请求                            │
│  - 产物列表 (按 turn_index)                  │
├─────────────────────────────────────────────┤
│          WebSocket State                     │
│  (Zustand: wsStore)                         │
│  - 连接状态 (connecting/connected/closed)    │
│  - 最后消息时间                              │
│  - 重连尝试次数                              │
│  - last_turn_index (用于重连补发)            │
└─────────────────────────────────────────────┘
```

### 5.2 数据流图

```
User Input
    │
    ▼
┌─────────┐   submit/interrupt/approval   ┌──────────────┐
│ InputBar │ ─────────────────────────────▶│ WS Client    │
└─────────┘                               └──────┬───────┘
                                                  │
                                           WebSocket
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │ Server Frame  │
                                          │ Dispatcher    │
                                          └──────┬───────┘
                                                  │
                    ┌─────────────────────────────┼───────────────────┐
                    ▼                             ▼                   ▼
           conversationStore              conversationStore    wsStore
           (messages, turns)              (tool_calls, todos)  (status)
                    │                             │                   │
                    ▼                             ▼                   ▼
           ┌──────────────┐            ┌────────────────┐   ┌──────────┐
           │ MessageList   │            │ ToolCallCard   │   │ StatusBar│
           │ AssistantStream│           │ TodoPanel      │   │ Health   │
           └──────────────┘            └────────────────┘   └──────────┘
```

### 5.3 流式渲染优化

参考终端前端的批量 flush 策略：

```typescript
// 50ms 或 384 字符阈值，取先到者
const BATCH_INTERVAL_MS = 50;
const BATCH_CHAR_THRESHOLD = 384;

function useStreamBuffer(onFlush: (text: string) => void) {
  const buffer = useRef('');
  const timer = useRef<number>();

  const append = useCallback((delta: string) => {
    buffer.current += delta;
    if (buffer.current.length >= BATCH_CHAR_THRESHOLD) {
      flush();
    } else if (!timer.current) {
      timer.current = window.setTimeout(flush, BATCH_INTERVAL_MS);
    }
  }, []);

  const flush = useCallback(() => {
    if (buffer.current) {
      onFlush(buffer.current);
      buffer.current = '';
    }
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, [onFlush]);

  return { append, flush };
}
```

---

## 6. 用户交互流程与体验设计

### 6.1 首次使用流程

```
启动应用
  │
  ▼
┌──────────────────────────────┐
│  Welcome Screen              │
│  ┌────────────────────────┐  │
│  │ 🔑 请输入 API Key      │  │
│  │ [___________________]  │  │
│  │                        │  │
│  │ [连接并开始]            │  │
│  └────────────────────────┘  │
│                              │
│  服务状态: ● 在线 / ○ 离线   │
└──────────────────────────────┘
  │
  ▼ (输入 API Key)
  │
  ▼ (验证成功 → GET /healthz)
  │
  ▼
┌──────────────────────────────┐
│  空会话列表 + "创建新会话"    │
└──────────────────────────────┘
```

### 6.2 创建会话流程

```
点击 [+ 新会话]
  │
  ▼
┌────────────────────────────────┐
│  Create Session Dialog          │
│                                 │
│  权限策略:                      │
│  ○ full_auto (自动执行)         │
│  ● interactive (交互审批)       │
│                                 │
│  高级选项 (可折叠):             │
│  ┌─────────────────────────┐   │
│  │ 额外参数 (每行一个):     │   │
│  │ --model qwen-max         │   │
│  │ --temperature 0.7        │   │
│  └─────────────────────────┘   │
│                                 │
│  [取消]          [创建会话]     │
└────────────────────────────────┘
  │
  ▼ POST /v1/sessions
  │
  ▼ 201 Created → 自动建立 WS 连接 → 进入对话视图
```

### 6.3 对话交互流程

```
┌─ Chat Mode ──────────────────────────────────────────────┐
│                                                           │
│  ┌─ User ──────────────────────────────────────────────┐ │
│  │ 帮我生成一个产品介绍视频                             │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Assistant (流式) ──────────────────────────────────┐ │
│  │ 好的，我来帮你创建产品介绍视频。让我先分析一下需求...│ │
│  │ █ (打字光标)                                        │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Tool Call (折叠) ──────────────────────────────────┐ │
│  │ ▶ generate_video(prompt="产品介绍", duration=30)     │ │
│  │   状态: 执行中... ⠋                                  │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ TODO Panel ────────────────────────────────────────┐ │
│  │ ☑ 分析需求                                          │ │
│  │ ☐ 生成视频脚本                                      │ │
│  │ ☐ 渲染视频                                          │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Approval Modal (interactive 模式) ─────────────────┐ │
│  │ 🔐 权限请求                                          │ │
│  │ 是否允许执行: generate_video ?                       │ │
│  │ [允许一次] [始终允许] [拒绝]                         │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Assistant (完成) ──────────────────────────────────┐ │
│  │ 视频已生成完成！                                      │ │
│  │ ┌─────────────────────────────┐                     │ │
│  │ │ 🎬 [视频预览播放器]          │                     │ │
│  │ │ ▶ ━━━━━━━●━━━━━ 0:15 / 0:30 │                     │ │
│  │ └─────────────────────────────┘                     │ │
│  │ [下载视频]                                           │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ Input Bar ─────────────────────────────────────────┐ │
│  │ [输入消息... (Shift+Enter 换行)]          [发送 ▶] │ │
│  └─────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

### 6.4 Terminal Mode 交互

```
┌─ Terminal Mode ──────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────┐│
│  │  ╔══════════════════════════════════════════╗        ││
│  │  ║  Session Service Terminal v1.0           ║        ││
│  │  ║  Session: abc-123 | Policy: full_auto    ║        ││
│  │  ╚══════════════════════════════════════════╝        ││
│  │                                                      ││
│  │  > 帮我生成一个产品介绍视频                           ││
│  │                                                      ││
│  │  ⠋ 正在处理...                                      ││
│  │  [tool] generate_video                               ││
│  │    input: {"prompt": "产品介绍", "duration": 30}     ││
│  │    output: video_abc.mp4 (2.3MB)                     ││
│  │                                                      ││
│  │  ✓ 视频已生成: video_abc.mp4                         ││
│  │                                                      ││
│  │  > │   (光标闪烁)                                    ││
│  │                                                      ││
│  │  ─────────────────────────────────────────────────── ││
│  │  qwen-max | tokens: 1.2k/4k | full_auto | live      ││
│  └──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

### 6.5 会话生命周期交互

| 事件 | 前端行为 |
|------|----------|
| 会话创建成功 (201) | 加入列表，自动选中，建立 WS |
| 会话变为 idle | 状态徽章变灰，WS 保持连接 |
| 会话变为 cold | 状态徽章变暗，WS 断开，提示"会话已休眠" |
| WS 重连复活 cold→live | 状态自动恢复，补发缺失轮次 |
| 会话 closed/expired | 状态徽章红色，禁用输入，WS 断开 |
| 会话 failed | 状态徽章红色，显示错误信息 |
| 超过每日配额 (403) | 全局横幅提示"今日配额已用完" |
| 超过并发配额 (429) | 创建对话框提示"并发会话数已达上限" |

---

## 7. 安全性和错误处理机制

### 7.1 认证安全

| 措施 | 实现 |
|------|------|
| API Key 存储 | localStorage（与现有 web 前端一致） |
| API Key 传输 | HTTP: `X-API-Key` 头; WS: `?api_key=` 查询参数 |
| API Key 脱敏 | 界面显示为 `sk-****xxxx`，仅首尾可见 |
| 401 响应 | 清除本地 Key，弹出重新输入对话框 |
| 会话隔离 | 关闭浏览器标签时不清除 Key（跨会话复用） |

### 7.2 输入安全

| 措施 | 实现 |
|------|------|
| 对话文本 | 最大 32000 字符，前端截断 + 提示 |
| extra_oh_args | 前端白名单校验（仅允许 6 个已知安全参数） |
| Shell 元字符 | 禁止 `; | & $ \` ( ) { } < >` 等 |
| XSS 防护 | react-markdown 默认 HTML 转义 + DOMPurify 兜底 |
| CSRF | API Key 认证天然免疫 |

### 7.3 错误处理策略

```typescript
// 分级错误处理
enum ErrorSeverity {
  INFO,      // 临时提示，自动消失 (如: 会话创建成功)
  WARNING,   // 横幅提示，可手动关闭 (如: 限流)
  ERROR,     // 模态框，需用户确认 (如: 鉴权失败)
  FATAL,     // 全屏错误页 (如: 服务不可达)
}

// 错误映射
const ERROR_MAP: Record<number, { severity: ErrorSeverity; message: string }> = {
  401: { severity: 'ERROR', message: 'API Key 无效或已过期，请重新配置' },
  403: { severity: 'WARNING', message: '今日会话配额已用完，请明天再试' },
  404: { severity: 'ERROR', message: '会话不存在或已被关闭' },
  409: { severity: 'WARNING', message: '当前有轮次正在执行，请等待完成' },
  422: { severity: 'WARNING', message: '请求参数有误，请检查输入' },
  429: { severity: 'WARNING', message: '请求过于频繁，请稍后再试' },
  502: { severity: 'ERROR', message: '后端服务异常，请稍后重试' },
  503: { severity: 'FATAL', message: '服务暂不可用，节点容量已满' },
};
```

### 7.4 WebSocket 错误处理

| 关闭码 | 用户提示 | 自动行为 |
|--------|----------|----------|
| 4400 | "会话 ID 格式无效" | 不重连，返回会话列表 |
| 4401 | "认证失败" | 弹出 API Key 输入框 |
| 4403 | "会话已关闭" | 标记会话 closed |
| 4404 | "会话不存在" | 从列表移除，提示错误 |
| 4429 | "请求过于频繁" | 60s 后重试一次 |
| 4500 | "服务暂不可用" | 10s 后重试 |
| 1006/其他 | "连接已断开，正在重连..." | 指数退避重连 |

---

## 8. 性能优化建议

### 8.1 渲染优化

| 策略 | 实现 |
|------|------|
| **虚拟滚动** | 消息列表使用 `@tanstack/virtual`，仅渲染可见区域消息 |
| **流式批量** | 50ms/384字符 批量 flush（参考终端前端），避免逐 token 重渲染 |
| **React.memo** | 消息气泡、工具调用卡片等纯组件 memo 化 |
| **useDeferredValue** | 流式文本使用延迟值，避免阻塞输入响应 |
| **Web Worker** | Markdown 解析移入 Worker，避免阻塞主线程 |

### 8.2 网络优化

| 策略 | 实现 |
|------|------|
| **WS 心跳** | 30s 间隔 ping/pong，检测死连接 |
| **断线重连** | 指数退避 (1s→30s)，携带 last_turn_index 补发 |
| **请求去重** | 同一会话的 GET 请求去重（避免重复查询） |
| **乐观更新** | 发送消息后立即追加到消息列表，失败时回滚 |
| **产物缓存** | 已下载的产物 blob 缓存在内存中，避免重复下载 |

### 8.3 构建优化

| 策略 | 实现 |
|------|------|
| **代码分割** | Chat Mode / Terminal Mode 按需加载（动态 import） |
| **Tree Shaking** | 仅导入使用的 Lucide 图标 |
| **Gzip/Brotli** | Vite 构建配置压缩 |
| **资源内联** | 小图标 SVG 内联，减少请求数 |

### 8.4 数据优化

| 策略 | 实现 |
|------|------|
| **会话列表缓存** | 已加载的会话列表本地缓存，切换时即时展示 |
| **消息分页** | 历史消息按需加载（向上滚动加载更多） |
| **增量同步** | WS 断线重连时仅补发缺失轮次，非全量重放 |

---

## 9. 测试策略

### 9.1 测试金字塔

```
         ┌─────────┐
         │  E2E    │  Playwright (10%)
         │  Tests  │  关键用户流程
        ┌┴─────────┴┐
        │Integration│  Testing Library (30%)
        │  Tests    │  组件交互、Hook 行为
       ┌┴───────────┴┐
       │  Unit Tests  │  Vitest (60%)
       │              │  纯函数、工具、Store
       └──────────────┘
```

### 9.2 单元测试 (Vitest)

| 测试目标 | 覆盖内容 |
|----------|----------|
| `ws/protocol.ts` | 消息编解码、类型校验 |
| `utils/sanitize.ts` | 输入清理、XSS 防护 |
| `utils/format.ts` | 时间/大小格式化 |
| `store/*` | 状态变更逻辑、reducer 纯函数 |
| `api/*` | Mock fetch，验证请求参数和错误处理 |

### 9.3 集成测试 (Testing Library)

| 测试目标 | 覆盖内容 |
|----------|----------|
| `CreateDialog` | 表单校验、提交行为 |
| `ChatView` | 消息渲染、输入发送 |
| `ApprovalModal` | 审批交互流程 |
| `SessionCard` | 状态徽章渲染 |
| `useWebSocket` Hook | 连接/断开/重连行为 |
| `useConversation` Hook | submit/interrupt/approval 操作 |

### 9.4 E2E 测试 (Playwright)

| 场景 | 步骤 |
|------|------|
| 完整对话流程 | 输入 API Key → 创建会话 → 发送消息 → 等待回复 → 关闭会话 |
| 断线重连 | 创建会话 → 模拟网络断开 → 验证重连提示 → 恢复连接 → 验证消息补发 |
| 审批流程 | interactive 模式 → 发送消息 → 审批弹窗 → 允许/拒绝 → 验证行为 |
| 模式切换 | Chat Mode → 切换 Terminal Mode → 验证状态保持 → 切回 Chat Mode |
| 错误恢复 | 无效 API Key → 验证错误提示 → 重新输入 → 验证恢复 |
| 限流场景 | 快速创建多个会话 → 验证限流提示 → 验证配额展示 |

---

## 10. 部署方案

### 10.1 开发环境

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    port: 3001,
    proxy: {
      '/v1': {
        target: 'http://localhost:8001', // session-service 端口
        changeOrigin: true,
        ws: true, // WebSocket 代理
      },
      '/healthz': 'http://localhost:8001',
      '/readyz': 'http://localhost:8001',
    }
  }
});
```

### 10.2 Docker 部署

```dockerfile
# Dockerfile.session-frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
```

### 10.3 Nginx 配置

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA 路由 fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 代理
    location /v1/ {
        proxy_pass http://session-service:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-API-Key $http_x_api_key;
    }

    # WebSocket 代理
    location ~ /v1/sessions/.+/ws {
        proxy_pass http://session-service:8001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-API-Key $arg_api_key;
        proxy_read_timeout 3600s; # 长连接
    }

    # 健康检查透传
    location /healthz {
        proxy_pass http://session-service:8001;
    }

    # 静态资源缓存
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### 10.4 docker-compose 集成

```yaml
# 添加到现有 docker-compose.yml
session-frontend:
  build:
    context: ./session-frontend
    dockerfile: Dockerfile
  ports:
    - "3001:80"
  environment:
    - SESSION_SERVICE_URL=http://session-service:8001
  depends_on:
    - session-service
```

### 10.5 CI/CD

```yaml
# .github/workflows/session-frontend.yml
name: Session Frontend CI
on:
  push:
    paths: ['session-frontend/**']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: session-frontend
      - run: npm run lint
        working-directory: session-frontend
      - run: npm run test:unit
        working-directory: session-frontend
      - run: npm run test:integration
        working-directory: session-frontend
  e2e:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.e2e.yml up -d
      - run: npx playwright test
        working-directory: session-frontend
```

---

## 11. 主题系统

### 11.1 从终端前端移植

将 `/OpenHarness/frontend/terminal/src/theme/builtinThemes.ts` 的 5 个主题映射为 CSS 变量：

| 主题 | 风格 | 适用模式 |
|------|------|----------|
| `default` | 浅色背景，蓝色强调 | Chat |
| `dark` | 深色背景，绿色强调 | Terminal |
| `minimal` | 极简灰白 | Chat |
| `cyberpunk` | 深色 + 霓虹色 | Terminal |
| `solarized` | Solarized 配色 | Both |

### 11.2 CSS 变量体系

```css
:root[data-theme="dark"] {
  --color-bg-primary: #1a1b26;
  --color-bg-secondary: #24283b;
  --color-bg-message-user: #364a82;
  --color-bg-message-assistant: #24283b;
  --color-text-primary: #c0caf5;
  --color-text-secondary: #565f89;
  --color-accent: #7aa2f7;
  --color-success: #9ece6a;
  --color-error: #f7768e;
  --color-warning: #e0af68;
  --color-tool-bg: #1e2030;
  --color-tool-border: #3b4261;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```

---

## 12. 关键实现注意事项

### 12.1 与现有 web/ 前端的区别

| 维度 | 现有 web/ | 新 session-frontend |
|------|-----------|---------------------|
| 后端 | video-service (:8000) | session-service (:8001) |
| 通信 | SSE (EventSource) | WebSocket |
| 交互 | 任务提交 + 进度查看 | 多轮对话 + 流式回复 |
| 产物 | 视频任务 | 对话轮次产物 |
| 认证 | 相同 API Key 机制 | 相同 + WS 查询参数 |

### 12.2 后端尚未提供的能力

| 缺失能力 | 影响 | 临时方案 |
|----------|------|----------|
| 会话列表查询 API | 无法获取历史会话列表 | 前端本地缓存已创建会话 ID，逐个 GET 查询 |
| 产物元数据查询 API | 无法列出轮次产物 | 通过 `turn_complete` 帧中的信息推断 |
| 会话搜索/过滤 | 大量会话时不便 | 前端本地过滤 + 分页 |

### 12.3 浏览器兼容性

| 特性 | 最低版本 |
|------|----------|
| WebSocket | 所有现代浏览器 |
| Fetch API | Chrome 42+, Firefox 39+ |
| CSS Grid | Chrome 57+, Firefox 52+ |
| ResizeObserver | Chrome 64+, Firefox 69+ |
| Web Workers | 所有现代浏览器 |

目标: 最近 2 个主版本的主流浏览器。

---

## 附录 A: 类型定义参考

```typescript
// src/types/session.ts
type SessionStatus = 'creating' | 'live' | 'idle' | 'cold' | 'closed' | 'expired' | 'failed';
type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'timed_out';
type PermissionPolicy = 'full_auto' | 'interactive';

interface Session {
  session_id: string;
  status: SessionStatus;
  permission_policy: PermissionPolicy;
  turn_count: number;
  oh_session_id: string | null;
  created_at: string;
  last_active_at: string;
  ws_url: string | null;
}

// src/types/conversation.ts
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  turn_index: number;
  timestamp: string;
  status?: TurnStatus;
  tool_calls?: ToolCall[];
  artifact?: ArtifactInfo;
}

interface ToolCall {
  tool_name: string;
  tool_input: string;
  output?: string;
  is_error?: boolean;
  turn_index: number;
}

// src/types/ws.ts
type ClientFrame =
  | { op: 'submit'; text: string }
  | { op: 'interrupt' }
  | { op: 'approval'; request_id: string; allowed: boolean; reply: 'once' | 'always' | 'reject'; answer: string }
  | { op: 'ping' };

type ServerFrame =
  | { type: 'session_ready'; session_id?: string }
  | { type: 'delta'; text: string; turn_index: number; final?: boolean }
  | { type: 'tool_start'; tool_name: string; tool_input: string; turn_index: number }
  | { type: 'tool_end'; tool_name: string; output: string; is_error: boolean; turn_index: number }
  | { type: 'todo'; todo_markdown: string; turn_index: number }
  | { type: 'approval_request'; request_id: string; modal: any; turn_index: number }
  | { type: 'turn_complete'; turn_index: number; interrupted?: boolean; replayed?: boolean; assistant_text?: string }
  | { type: 'turn_error'; message: string; turn_index?: number }
  | { type: 'busy' }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'event'; event: string; turn_index: number };
```
