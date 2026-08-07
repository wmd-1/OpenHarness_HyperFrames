# 设计智能体前端系统（四大模块）建设方案

- 日期：2026-07-31
- 状态：待评审（方案确认后再进入实施）
- 参考物：`demo/设计智能体平台.html`（视觉/交互基准）、`session-frontend/`（功能基准，不改动）、`session-service/`（后端，不改动）

---

## 1. 目标与边界

### 1.1 目标

基于 demo 页面的视觉与交互风格，新建一个**独立的**设计智能体前端系统，包含四大模块：

| 模块 | 功能定位 | 后端对接 |
| --- | --- | --- |
| 文本生成视频 | 完整功能：保留 session-frontend 全部核心能力 + demo 交互整合 | session-service（真实对接） |
| 个人空间 | 「文本生成视频」子模块真实数据管理；其余子模块 demo 演示 | session-service（仅视频 tab） |
| 原型页面设计 | demo 交互演示，接口预留为空 | 无（stub 预留） |
| Drawio 设计 | demo 交互演示，接口预留为空 | 无（stub 预留） |

### 1.2 边界（明确不做）

- **不改动** `session-frontend/`、`web/` 两个现有前端的任何文件。
- **不改动** `session-service/`、`service/` 后端代码（新前端完全适配现有 API 契约）。
- 原型页面设计、Drawio 设计不实现真实生成能力，仅保留 demo 交互；API 层预留空 stub。
- 不引入 i18n 框架（与 session-frontend 一致，文案硬编码中文）。

---

## 2. 新前端工程总体设计

### 2.1 目录位置与命名

新建独立文件夹：**`design-agent-frontend/`**（与 `session-frontend/`、`web/` 平级）。

### 2.2 技术栈（与 session-frontend 对齐，降低维护成本）

| 项 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 + TypeScript 5.7 | 与 session-frontend 一致 |
| 构建 | Vite 6 + @vitejs/plugin-react | dev 端口 **3002**（避开 web/session-frontend 的 5173/3001） |
| 路由 | react-router-dom 7（真实启用路由表） | demo 的视图切换升级为路由：`/`、`/ui`、`/drawio`、`/video`、`/space` |
| 状态 | Zustand 5 | 复用 session-frontend 的 store 设计 |
| HTTP | ky | 复用 `client.ts` 的鉴权/错误拦截设计 |
| 样式 | 原生 CSS 变量（demo 设计令牌）+ Tailwind CSS v4 辅助 | demo 的 `:root` 令牌全量移植为全局 design tokens |
| Markdown | react-markdown + remark-gfm | 聊天区 AI 消息渲染 |
| 虚拟滚动 | @tanstack/react-virtual | 消息列表 |
| 图标 | 沿用 demo 的内联 SVG（封装为 `Icon` 组件库），辅以 lucide-react | 保证与 demo 视觉一致 |
| 测试 | vitest 3 + Testing Library + jsdom；Playwright 1.50.1 | 与 session-frontend 版本严格对齐（含 CI 镜像版本对齐约束） |

> 说明：不引入 xterm/Terminal 相关依赖的替代方案——Terminal 模式作为 session-frontend 核心功能之一予以保留（见 §3.6），依赖照搬 `@xterm/*` 三件套并保持独立 async chunk 拆分。

### 2.3 源码目录结构

```
design-agent-frontend/
├── src/
│   ├── main.tsx                    # 入口：Router + ThemeProvider
│   ├── App.tsx                     # 顶层：鉴权门（无 API Key → Welcome）+ 路由出口
│   ├── index.css                   # demo 设计令牌（:root 变量）+ 全局样式
│   ├── router.tsx                  # 路由表：/、/ui、/drawio、/video、/space
│   ├── shared/                     # 跨模块共享层（大部分自 session-frontend 移植改造）
│   │   ├── api/                    #   client.ts（ky + X-API-Key + 401/403/429/503 拦截）
│   │   │   ├── client.ts           #   sessions.ts（会话/轮次/产物/工作区文件 API）
│   │   │   ├── sessions.ts         #   health.ts（healthz/readyz）
│   │   │   └── health.ts
│   │   ├── ws/                     #   WebSocketClient.ts / protocol.ts / useWebSocket.ts 全量移植
│   │   ├── store/                  #   authStore / sessionStore / conversationStore / wsStore / uiStore
│   │   ├── hooks/                  #   useSessionList / useTurnHistory / useApproval / useHealth ...
│   │   ├── types/                  #   api.ts / ws.ts / session.ts / conversation.ts
│   │   ├── utils/                  #   constants.ts / sanitize.ts / format.ts / slashCommands.ts
│   │   └── components/
│   │       ├── AppHeader.tsx       #   demo 顶栏（logo/返回键/面包屑/用户头像）
│   │       ├── Icon.tsx            #   demo 内联 SVG 图标库
│   │       ├── ErrorBanner.tsx / ConfirmDialog.tsx / HealthBadge.tsx
│   │       └── Welcome/            #   API Key 欢迎页（移植 WelcomeScreen + ApiKeyInput）
│   ├── modules/
│   │   ├── home/                   # 主页：四模块卡片网格（demo 1:1 还原）
│   │   │   └── HomePage.tsx
│   │   ├── video/                  # 文本生成视频（真实功能，见 §3）
│   │   │   ├── VideoModulePage.tsx #   三栏布局容器（video-layout）
│   │   │   ├── HistoryPanel.tsx    #   左栏：新建会话 + 历史会话列表
│   │   │   ├── ChatPanel.tsx       #   中栏：chat-header + 消息区 + 输入区（10% 留白）
│   │   │   ├── chat/               #   MessageList/MessageBubble/AssistantStream/
│   │   │   │                       #   ToolCallCard/TodoPanel/InputBar/ModelSelector/UploadButton
│   │   │   ├── preview/            #   VideoPreviewPanel + 自定义播放器（demo 控制条）
│   │   │   ├── approval/           #   ApprovalModal + Permission/Diff/Question 三件套（移植）
│   │   │   ├── terminal/           #   TerminalView/XtermContainer/TerminalBridge（移植）
│   │   │   └── workspace/          #   WorkspaceFilesPanel（移植，demo 风格化）
│   │   ├── ui-design/              # 原型页面设计（demo 演示）
│   │   │   ├── UiDesignPage.tsx    #   三栏：历史 | 对话 | 界面预览（设备切换/源码 tab）
│   │   │   ├── PreviewPanel.tsx    #   web/phone/tablet/code 四态（demo 逻辑 React 化）
│   │   │   └── api.ts              #   ★ 空 stub：接口签名预留 + TODO
│   │   ├── drawio/                 # Drawio 设计（demo 演示）
│   │   │   ├── DrawioPage.tsx      #   三栏：历史 | 图表预览（常显） | 对话
│   │   │   ├── DiagramCanvas.tsx   #   SVG 画布 + 缩放/适应/下载/全屏（demo 逻辑 React 化）
│   │   │   └── api.ts              #   ★ 空 stub：接口签名预留 + TODO
│   │   └── space/                  # 个人空间（见 §4）
│   │       ├── SpacePage.tsx       #   tabs + 卡片网格 + 分页
│   │       ├── VideoAssetsTab.tsx  #   ★ 真实数据：session-service 产物聚合
│   │       ├── DemoAssetsTab.tsx   #   ui/drawio 两 tab 的 demo 静态数据渲染
│   │       └── useVideoAssets.ts   #   产物聚合 hook（缓存 + 分页）
│   ├── theme/                      # ThemeProvider（沿用 session-frontend 机制，默认主题=demo 亮色令牌）
│   └── test/                       # vitest setup
├── e2e/                            # Playwright 用例 + mock-backend.mjs（移植改造）
├── index.html
├── package.json / tsconfig*.json / vite.config.ts / vitest.config.ts / playwright.config.ts
├── Dockerfile                      # 四阶段：build / test / e2e / runtime（见 §6）
├── nginx.conf.template             # 反代 /v1 + /healthz + /readyz 到 session-service
├── docker-entrypoint.sh            # envsubst 注入 SESSION_HOST/SESSION_PORT
├── .dockerignore / .gitignore / .prettierrc / eslint.config.js
└── README.md                       # 含更新日期注释（遵循项目 README 规范）
```

### 2.4 视觉一致性策略

1. **设计令牌全量移植**：demo `:root` 中的 `--bg-page/--bg-module/--accent/--radius-*/--shadow-*/--transition-*` 等原样落入 `index.css`，四模块统一引用，不允许模块内私有硬编码色值。
2. **模块主题色**：沿用 demo 渐变（ui=蓝 `#1a56db→#3b82f6`、drawio=绿 `#059669→#10b981`、video=橙 `#d97706→#f59e0b`、space=灰 `#475569→#64748b`）。
3. **通用布局骨架**：`AppHeader`（56px 顶栏 + 返回键 + 面包屑）与 `page-detail` 三栏骨架抽象为共享布局组件，三个设计模块复用同一骨架，仅差异化中/右栏内容，保证结构一致。
4. **响应式断点**：沿用 demo 的 1100px / 900px / 640px 三档媒体查询规则。
5. session-frontend 的多主题机制保留（Settings 中可切换），但**默认主题重定义为 demo 亮色令牌**，保证开箱视觉与 demo 一致。

---

## 3. 模块一：文本生成视频（真实功能）

### 3.1 页面布局（demo video-layout + session-frontend 功能融合）

```
┌──────────────────────── AppHeader（56px，返回/面包屑/健康徽标/设置/用户）───────────────────────┐
│ 左栏 295px         │ 中栏 ChatPanel（左右各 10% 留白）        │ 右栏 视频预览（0 ↔ 50% 可展开）   │
│ ┌───────────────┐ │ ┌─────────────────────────────────┐ │ ┌─────────────────────────────┐ │
│ │ [＋ 新建会话]  │ │ │ chat-header：会话标题 | 预览按钮   │ │ │ 视频预览 header：全屏/下载     │ │
│ │ 历史会话       │ │ │  模式切换(Chat/Terminal) 关闭会话 │ │ │ ┌─────────────────────────┐ │ │
│ │ ├ 会话A(活跃)  │ │ ├─────────────────────────────────┤ │ │ │ 占位态 / <video> 播放器    │ │ │
│ │ ├ 会话B       │ │ │ 消息区（虚拟滚动）：               │ │ │ │ demo 自定义控制条：        │ │ │
│ │ ├ 会话C(只读)  │ │ │  系统提示 / 我 / 设计智能体        │ │ │ │ 进度(含缓冲)/播放/音量/    │ │ │
│ │ └ ...分页加载  │ │ │  工具调用卡片 / TODO 面板         │ │ │ │ 倍速/时间/自动隐藏         │ │ │
│ │ 共 N 个会话    │ │ ├─────────────────────────────────┤ │ │ └─────────────────────────┘ │ │
│ └───────────────┘ │ │ 输入区（demo chat-input-box）：    │ │ │ 轮次产物列表（多产物切换）     │ │
│                   │ │  [模型▾][上传文档][标签]    [发送]  │ │ └─────────────────────────────┘ │
│                   │ └─────────────────────────────────┘ │                                   │
└──────────────────────────────── StatusBar（WS 状态/租户配额提示）────────────────────────────────┘
```

要点：

- **会话区左右留白**：中栏 `chat-header/chat-messages/chat-input-area` 各加 `margin-left/right: 10%`（demo 规则）；预览面板展开（`preview-open`）时 margin 归零，与 demo 行为一致。
- 右栏视频预览默认收起（宽 0），点击 chat-header 的「预览」按钮以 `width 0.35s` 过渡展开至 50%（min 360px），完全复刻 demo `panel-preview` 行为。
- `turn_complete.has_artifact=true` 时**自动展开预览面板并加载该轮产物**（demo 中 `videoLoadSrc` 的对应真实化）。

### 3.2 session-frontend 核心功能保留清单（全部移植）

| 功能 | 移植来源 | 改造点 |
| --- | --- | --- |
| API Key 认证（localStorage + X-API-Key + ?api_key= 直链） | authStore / client.ts / WelcomeScreen | UI 换 demo 风格；localStorage key 前缀改 `da.*` 避免与 session-frontend 冲突 |
| 会话列表（服务端权威分页 limit/offset） | useSessionList + sessionStore | 渲染为 demo `history-item` 样式（标题/时间/active 左边条），滚动到底加载更多 |
| 新建会话（permission_policy + extra_oh_args 白名单） | CreateDialog | 改为「新建会话」按钮 → demo 风格弹窗；模型选择联动（§3.3） |
| 历史会话切换（resumable/read_only 判定 → turns 回显 → WS 重连带 last_turn_index） | selectSession 流程 + useTurnHistory | 逻辑不变；只读会话在列表上加「只读」徽标、禁用输入区 |
| WS 流式对话（delta/final full_text 覆盖/turn_complete/replayed 补发） | WebSocketClient + useWebSocket + StreamBuffer | 原样移植（含指数退避、4429/4430/4503 分支、心跳 30s） |
| 工具调用卡片（tool_start/tool_end） | ToolCallCard | demo 卡片风格化 |
| TODO 面板（todo 帧） | TodoPanel | 同上 |
| 审批流三弹窗（permission/edit_diff/question） | Approval/ 全套 | demo 弹窗风格化；逻辑不变 |
| 中断（interrupt）、REST 兜底提交 | InputBar + submitTurnRest | 不变 |
| 视频产物播放/下载（artifactStreamUrl Range 流式 / artifactUrl 302 直链） | VideoPlayer + DownloadButton | 播放器 UI 替换为 demo 自定义控制条（§3.4） |
| 工作区文件浏览/下载（live/archive 双源 + presigned 302） | WorkspaceFilesPanel | chat-header 增加入口按钮，抽屉式面板 |
| Chat/Terminal 双模式 | ModeSwitcher + Terminal/ | 保留；Terminal 仅在 chat-header 提供切换 |
| 错误横幅（401/403 每日配额 fatal/429/503） | ErrorBanner + uiStore.banner | demo 风格化 |
| 关闭会话（DELETE + 确认框） | useCloseSession + ConfirmDialog | 不变 |
| 主题切换 / 设置面板 | Settings/ + theme/ | 默认主题 = demo 令牌 |
| 输入历史（上下箭头）、斜杠命令 | InputBar + slashCommands | 不变 |
| 健康探针徽标 | useHealth + HealthBadge | 顶栏展示 |

### 3.3 demo 功能整合与真实化

| demo 功能 | 真实化方案 |
| --- | --- |
| **模型切换**（输入区模型下拉） | 切换对象为 **OpenHarness 主 agent 的模型**（`oh --model` 的 alias 或完整模型 ID），双通道实现：① **建会话时**经 `extra_oh_args: ["--model", "<name>"]` 设定初始模型（session-service 白名单已放行）；② **会话中途**经现有 WS `submit` 通道发送 `/model <name>`——OpenHarness `handle_line` 内置命令分发会执行运行时切模（`commands/registry.py` 的 `/model` handler，`refresh_runtime` 后 `engine.set_model` 生效），命令回执以系统消息展示。前端约束：轮次进行中（busy）禁用切换；选中值存 `uiStore.selectedModel`（localStorage 持久化）并在新建会话时注入；模型候选列表以前端常量维护（值必须是 OH 主 agent 合法模型标识，可后续接后端列表）。 |
| **上传文档**按钮 | session-service 无上传 API。保留 demo 交互（选择文件 → 文件名标签 + 清除），但发送时仅在输入文本前拼接提示性说明并在 UI 提示「当前版本暂不支持附件上传至后端」；组件内预留 `uploadFile()` stub，后端具备能力后接入。 |
| **视频预览**（占位态 → 播放器） | 占位态 = demo `video-placeholder`（脉冲图标/文案）；有产物时加载 `<video src=artifactStreamUrl>`；控制条 = demo 全套（进度条含缓冲显示、点击 seek、播放/暂停、静音/音量滑杆、0.5x–2x 倍速、时间显示、3s 自动隐藏、hover 保持）。React 化实现为受控组件 `CustomVideoPlayer`。 |
| **全屏/下载**按钮 | 全屏 = `requestFullscreen()`（demo 同款）；下载 = `downloadArtifact()`（`<a download>` 直链，跟随 S3 302）。 |
| **发送交互**（Enter 发送 / Shift+Enter 换行） | 沿用 demo 键位约定，接 `WebSocketClient.submit()`。 |
| **消息气泡**（系统提示/我/设计智能体三色） | demo 的 `msg-system/msg-user/msg-ai` 样式映射到 system/user/assistant 消息类型；assistant 标签固定「设计智能体」+ 绿点；AI 消息体走 react-markdown。 |
| **新建会话/历史高亮** | 接真实 API（§3.2），交互样式与 demo 一致。 |
| **多轮产物** | demo 只有单视频；真实场景一个会话可能多轮产物。预览面板底部加「产物轮次」横向条（第 N 轮），点击切换播放源。 |

### 3.4 关键数据流

1. 进入 `/video` → `useSessionList` 拉 `GET /v1/sessions` → 左栏渲染。
2. 新建会话 → `POST /v1/sessions`（permission_policy + 可选 `--model`）→ `selectSession` → 建 WS。
3. 切历史会话 → `GET /v1/sessions/{sid}/turns` 回显（`hydrateHistory`，含 `has_artifact` 轮次标记）→ 连 WS（`?last_turn_index=N` 去重补发；COLD 服务端自动 `--resume`）。
4. 发送 → WS `submit` → `delta` 流式渲染 → `turn_complete(has_artifact)` → 自动展开预览面板 → `artifactStreamUrl(sid, turn_index)` 播放。
5. 准入失败（error 帧 code=TENANT_QUOTA_EXCEEDED/CAPACITY_FULL）→ 按 session-frontend 现有语义提示与重试策略执行。

---

## 4. 模块二：个人空间

### 4.1 布局

demo `page-space` 1:1 还原：标题区 + 三 tab（原型页面设计 / Drawio 设计 / 文本生成视频，带计数徽标）+ 卡片网格（`minmax(280px,1fr)` 自适应）+ 分页条（每页 6 条）。默认激活 tab 调整为**文本生成视频**（真实数据 tab 优先展示）。

### 4.2 「文本生成视频」tab —— 真实数据

session-service 无独立「产物列表」API（`ArtifactResponse` schema 未暴露路由），采用**前端聚合**方案：

1. `GET /v1/sessions?limit=...&offset=...` 分页拉会话（含 `title/turn_count/created_at`）。
2. 对当前页会话逐个 `GET /v1/sessions/{sid}/turns`，筛出 `has_artifact === true` 的轮次（closed/expired 会话该接口仍可读）。
3. 组装资产卡片：名称=`{会话title或轮次prompt截断}.mp4`、时间=`finished_at`、类型徽标=MP4、缩略块=demo 橙色渐变 thumb。
4. 卡片操作：**下载**（`downloadArtifact(sid, turn_index)` 直链）；**预览**（点击卡片弹出居中模态，内嵌 `CustomVideoPlayer` 播放 `artifactStreamUrl`）。
5. 性能与体验：`useVideoAssets` hook 做「会话页 → 轮次」两级请求的并发限制（并发 4）+ 内存缓存（按 sid+turn_count 失效）；聚合期间骨架屏；空态用 demo `space-empty` 样式。
6. 分页：产物按 `finished_at` 倒序客户端分页（每页 6），tab 计数显示已发现产物总数（随会话分页加载递增，形如 `12+`）。

### 4.3 「原型页面设计」「Drawio 设计」tab —— demo 演示

- 数据源：demo 内置 `spaceRecords.ui / spaceRecords.drawio` 静态数组原样搬入 `space/demoData.ts`。
- 交互：tab 切换、分页、下载按钮（demo 的 data:text/plain 占位下载）全部保留。
- 卡片上加轻量「演示数据」角标（tooltip 说明该子模块暂未接入后端），避免误认为真实资产。

---

## 5. 模块三 & 四：原型页面设计 / Drawio 设计（demo 演示 + 接口预留）

### 5.1 共同原则

- demo 的**全部**交互效果 React 组件化（不再用 DOM 操作），UI 像素级对齐 demo。
- 会话/消息为**本地内存状态**（Zustand 模块内 slice），刷新即重置——与 demo 行为一致。
- 各自 `api.ts` 预留空 stub，签名对齐未来后端形态，全部 `throw new Error('Not implemented')` 或返回 mock，集中 TODO 注释：

```ts
// modules/ui-design/api.ts —— 接口预留（暂未实现，全部 stub）
export interface UiDesignApi {
  listSessions(): Promise<UiSessionSummary[]>;   // TODO: 对接原型设计后端
  createSession(): Promise<UiSession>;
  sendMessage(sid: string, text: string): Promise<void>;
  getPreviewHtml(sid: string): Promise<{ html: string; css: string }>;
}
```

### 5.2 原型页面设计模块（/ui）

保留 demo 交互：三栏布局（历史 295px | 对话 10% 留白 | 预览 0↔50%）；静态历史会话 12 条 + 新建会话（插入置顶/清空消息区）；发送消息 → 800ms 模拟 AI 回复；预览面板：网页/手机（刘海条）/平板三设备切换 + 源码视图（HTML/CSS tab、行号、demo 同款简易语法高亮，静态示例代码）；模型下拉、上传文档标签等输入区交互与视频模块共用组件（纯本地状态）。

### 5.3 Drawio 设计模块（/drawio）

保留 demo 交互：drawio-layout 三栏（历史 240px | 图表预览常显居中 | 对话右侧）；示例 SVG 流程图（信贷审批）；缩放（30%–300%、步长 15%）、适应屏幕（按容器/viewBox 计算）、下载 SVG（XMLSerializer → Blob）、全屏；网格背景画布 + 底部状态栏（文件名/尺寸）；对话区同 §5.2 的本地模拟。

---

## 6. 工程化：构建、部署、编排

### 6.1 Dockerfile（四阶段，遵循前端多阶段镜像规范）

1. **build**：`node:22-alpine`，`npm ci` + `vite build`，生成 `version.json` 版本戳。
2. **test**：基于 build 层，`npm run lint && npm run test`（vitest），失败即构建失败。
3. **e2e**：`FROM oh-e2e-test:latest`（复用已有镜像，不从零构建），Playwright `1.50.1` 与镜像内浏览器版本严格对齐，`PW_CHROMIUM_PATH` 指向镜像内 chrome-headless-shell。
4. **runtime**：`nginx:1.27-alpine` + gettext，拷贝 dist 与 `nginx.conf.template`，HEALTHCHECK wget 首页。

### 6.2 nginx / 运行时配置

- `nginx.conf.template`：照搬 session-frontend 模板——`/v1` 反代 `${SESSION_HOST}:${SESSION_PORT}`（HTTP/1.1 + Upgrade 支持 WS、access_log off 防 api_key 泄漏、3600s 超时、关 buffering）；`/healthz`、`/readyz` 反代；`/index.html` no-cache、`/assets/` immutable；CSP 限制 connect-src 'self'。
- `docker-entrypoint.sh`：envsubst 注入 `SESSION_HOST`（默认 session）/`SESSION_PORT`（默认 8001）。

### 6.3 docker-compose 集成

`docker-compose.yml` 新增服务（不动现有服务定义）：

```yaml
design-frontend:
  build: ./design-agent-frontend        # target: runtime
  ports: ["5175:80"]                    # 5173=web、5174=session-frontend、5175=新前端
  environment:
    SESSION_HOST: session
    SESSION_PORT: "8001"
  depends_on: [session]
```

### 6.4 dev 环境

`vite.config.ts`：dev 端口 3002；`/v1`（`ws:true`）、`/healthz`、`/readyz` 代理到 `http://localhost:8001`；xterm 三包独立 async chunk。

---

## 7. 测试方案（全部在 Docker 镜像内执行，禁止宿主机跑测试）

| 层级 | 内容 | 执行方式 |
| --- | --- | --- |
| 单测（vitest） | shared/api 拦截器、ws 协议编解码与重连分支、store 各 action、`useVideoAssets` 聚合逻辑（并发/缓存/空态）、CustomVideoPlayer 控制逻辑、ui/drawio 模块交互组件（缩放计算、设备切换、分页） | Dockerfile `--target test` 阶段内运行 |
| e2e（Playwright） | 移植改造 session-frontend 的 `mock-backend.mjs`（:8001 模拟）：① 首页四卡片导航；② 视频模块全链路（建会话→WS流式→turn_complete→预览面板自动展开→下载链接断言）；③ 历史会话切换/只读会话；④ 个人空间视频 tab 聚合与分页；⑤ ui/drawio demo 交互冒烟 | `--target e2e` 阶段（基于 oh-e2e-test:latest）|
| Docker 冒烟 | 新增 `e2e/run-design-frontend-docker-tests.sh`（复制 `run-session-frontend-docker-tests.sh` 模式）：test/e2e 阶段构建 + runtime 镜像 nginx 反代/健康检查冒烟；支持 `WEB_IMAGE` 式环境变量复用已有 runtime 镜像 | 宿主机仅执行 docker/curl |
| 真实联调（可选验收） | compose 起 `session + postgres + redis + design-frontend`，浏览器手工验收视频生成全链路 | docker compose |

CI：新增 `.github/workflows/design-frontend.yml`（参照 `session-frontend.yml`：lint/test/e2e 走镜像 target）。

---

## 8. 实施顺序（里程碑）

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| M1 脚手架 + 设计系统 | 工程初始化、路由、demo 设计令牌/AppHeader/主页四卡片、Welcome 鉴权页 | 可运行骨架，主页与 demo 视觉一致 |
| M2 共享层移植 | shared/{api,ws,store,hooks,types,utils} 自 session-frontend 移植 + 单测跟随移植 | 单测通过（镜像内） |
| M3 视频模块 | 三栏布局、聊天全功能、审批/工具卡/TODO、模型下拉、自定义播放器、Terminal、工作区文件 | 视频模块与真实 session-service 联通 |
| M4 个人空间 | 视频 tab 真实聚合 + ui/drawio demo tab + 分页/预览/下载 | 个人空间可用 |
| M5 ui/drawio 演示模块 | demo 交互 React 化 + api stub 预留 | 两模块演示可用 |
| M6 工程化收尾 | Dockerfile/nginx/compose/e2e 脚本/CI、README（含更新日期注释）、全量测试 | 镜像内 lint+单测+e2e 全绿，compose 冒烟通过 |

---

## 9. 风险与决策点

| # | 风险/决策 | 方案 |
| --- | --- | --- |
| 1 | 模型切换（OpenHarness 主 agent）：`/model` 为文本命令通道，回执是非结构化系统消息；且 COLD 会话 resume 后模型是否沿用切换值取决于 OH snapshot 恢复行为 | 双通道方案（§3.3）：建会话 `--model` + 会话中 WS 提交 `/model`；前端以「乐观更新 + 回执文案校验」维护下拉显示态；resume 后模型状态在 M3 联调时实测验证，若不沿用则重连后自动补发一次 `/model` |
| 2 | 上传文档：后端无上传 API | 保留 demo 交互 + 明确「暂不支持」提示 + stub 预留；不做假上传 |
| 3 | 个人空间无产物列表 API，前端聚合有 N+1 请求 | 并发限制 + 缓存 + 按会话分页渐进加载（§4.2）；后续后端补 `ArtifactResponse` 路由时可无缝替换 `useVideoAssets` 数据源 |
| 4 | localStorage 与 session-frontend 同源部署时的键冲突 | 新前端统一 `da.*` 前缀（apiKey/theme/currentSessionId/model 等） |
| 5 | Playwright 版本与 oh-e2e-test 镜像浏览器不一致会崩 | 锁定 1.50.1 与 session-frontend 完全一致 |
| 6 | demo 的 10% 留白在窄屏挤压消息区 | 沿用 demo 断点：预览展开时归零、640px 以下降为 16px 固定边距 |

---

## 10. 验收标准

1. 四大模块视觉与 demo 一致（设计令牌、布局、响应式断点、过渡动画）。
2. 视频模块：session-frontend 核心功能清单（§3.2）逐项可用；demo 交互（模型下拉、视频播放器全控制条、预览展开、Enter 发送等）逐项可用。
3. 个人空间：视频 tab 展示真实产物并可下载/预览；ui/drawio tab 保留 demo 演示且有「演示数据」标识。
4. ui/drawio 模块：demo 全部交互可复现；`api.ts` stub 存在且集中标注 TODO。
5. `session-frontend/`、`web/`、`session-service/` 无任何文件变更（git status 验证）。
6. 镜像内 lint + vitest + Playwright e2e 全部通过；runtime 镜像 compose 冒烟通过。
