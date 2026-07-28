# session-frontend 代码审查报告

- **审查日期**: 2026-07-28
- **审查范围**: `session-frontend/` 全部源码（src/ 约 5400 行）、构建与部署配置（Vite/Dockerfile/nginx）、单测与 E2E
- **参考文档**: openspec 归档 `2026-07-27-session-service-frontend`（proposal/design/tasks）及主规格 `openspec/specs/session-*.md`（7 份）
- **后端契约核对**: `session-service/app`（`routers/ws.py`、`routers/sessions.py`、`security.py`、`main.py` 认证中间件、`session/supervisor.py`）
- **处置状态**: ✅ 已通过 openspec 变更 `harden-session-frontend` 完成整改（2026-07-28）。除 B3、C3 两项明确接受为 won't-fix-now 外，其余问题均已修复并通过镜像内质量门（单测 159 例 + lint + Playwright E2E 6 场景 + 冒烟）。逐项状态见各条目「处置状态」行。

---

## 1. 代码结构和组织分析

### 1.1 分层架构

```
src/
├── api/          REST 客户端（ky + 拦截器）        ← spec: session-rest-api
├── ws/           WS 协议层（Client/protocol/Hook）  ← spec: session-ws-protocol
├── store/        Zustand 五仓（auth/session/conversation/ws/ui）
├── hooks/        组合 Hook（useConversation/useApproval/useHealth/useTheme）
├── components/   按域分组（Chat/Terminal/Approval/Session/Layout/…）
├── theme/        CSS 变量主题（5 内置主题）         ← design D7
├── types/        与后端 schemas/ws 协议对齐的类型
└── utils/        sanitize（镜像后端 security.py）/constants/format
```

**优点（值得保持）**：

1. **分层清晰、单向依赖**：components → hooks → store/ws/api → utils/types，无循环依赖；WS 连接生命周期收敛在 `SessionWorkspace` 层单点调用 `useConversation`，Chat/Terminal 双模式共享同一连接，符合 design 决策。
2. **与规格强关联**：几乎每个文件头注释都标注了对应 task/spec/design 决策编号（如 "task 6.2"、"design D6"），可追溯性极好。
3. **协议层健壮**：`WebSocketClient` 完整实现指数退避（1s→30s、10 次上限）、心跳保活（30s/3 次丢失判死）、关闭码差异化处理（4401/4403/4404/4429），与 spec session-ws-protocol 一致；`decodeServerFrame` 对未知帧类型包装为透传 `event` 帧，保证前向兼容。
4. **安全基线好**：`validateExtraArgs` 白名单与后端 `app/security.py::ALLOWED_OH_FLAGS/TYPED_FLAGS/_SHELL_METACHARS` 逐项核对一致；nginx 模板含完整安全头（CSP/XFO/nosniff/Referrer-Policy），并在每个 location 重复声明（规避 nginx add_header 继承陷阱）；`/v1` 关闭 access_log 防 `api_key` 查询参数泄漏。
5. **测试符合项目规范**：Dockerfile `test` 阶段在镜像内跑 lint + vitest，E2E 基于 `oh-e2e-test:latest` 已有镜像叠加，符合「测试必须基于已有镜像」约定。
6. **性能设计落地**：delta 批量 flush（50ms/384 字符，design D6）、xterm 动态 import + manualChunks 独立分包（R3）、消息列表虚拟滚动（@tanstack/react-virtual）、稳定空引用避免 selector 重渲染循环。

### 1.2 结构性弱点

- `ChatView` 与 `TerminalView` 各自复制了一份 slash 命令分发 switch（见 D4）。
- `TerminalBridge` 内部维护独立 `history`，与 `conversationStore.inputHistory` 双数据源（见 D5）。
- `conversationStore.removeConversation` 与 `wsStore.clear` 定义后从未被调用（死代码 + 状态残留，见 A9）。

---

## 2. 问题分类总览

| 分类 | Critical | High | Medium | Low | 合计 |
|------|:--:|:--:|:--:|:--:|:--:|
| Bug / 功能缺陷 (A) | 0 | 2 | 3 | 6 | 11 |
| 安全 (B) | 0 | 0 | 1 | 4 | 5 |
| 性能 (C) | 0 | 0 | 1 | 2 | 3 |
| 可维护性 / 风格 (D) | 0 | 0 | 2 | 4 | 6 |
| 规格偏离 (E) | 0 | 0 | 1 | 2 | 3 |
| 测试覆盖 (F) | — | — | — | — | 见 §7 |

无 Critical 级问题；整体质量高于本仓库同类前端（web/）首轮审查水平。

---

## 3. Bug / 功能缺陷（A 类）

### A1 产物预览/下载功能不可达 —— `hasArtifact` 永远为 `false`
- **处置状态**: ✅ 已修复（任务 1.1/2.1/2.2：后端 `turn_complete`/`TurnResponse` 附带 `has_artifact`，前端透传）
- **严重程度**: 🔴 High（整条功能链死代码）
- **位置**: [useWebSocket.ts L106-121](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/ws/useWebSocket.ts#L106-L121)、[conversationStore.ts L100/L119](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/store/conversationStore.ts#L100)、[MessageBubble.tsx L60](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/MessageBubble.tsx#L60)
- **描述**: `AssistantMessage.hasArtifact` 初始为 `false`，唯一置 `true` 的入口是 `completeTurn(…, { hasArtifact })`，但两个调用点（WS `turn_complete` 分发、REST 兜底）**均未传该字段**。已核对后端：`supervisor.py` 产出的 `turn_complete` 帧和 `TurnResponse` 均不含 artifact 标记。结果是 `VideoPlayer`、`DownloadButton` 两个组件（以及 `artifactUrl/artifactStreamUrl/downloadArtifact` 三个 API 函数）在运行时永远不会被渲染/调用——spec session-chat-mode「视频产物预览下载」需求实际未打通。
- **修复方案**:
  1. 首选：后端在 `_finalize_turn` 注册产物后于 `turn_complete` 帧附带 `has_artifact: true`（`TurnResponse` 同步补充），前端 `useWebSocket`/`useConversation` 透传给 `completeTurn`；
  2. 兜底：前端收到 `turn_complete` 后对 `GET /v1/sessions/{sid}/turns/{idx}/artifact` 发一次 HEAD/带 `Range: bytes=0-0` 的探测请求，200/206 则置 `hasArtifact=true`。

### A2 `<video>` 内嵌播放在启用认证时必然 401
- **处置状态**: ✅ 已修复（任务 1.3/2.3：artifact GET 支持 `?api_key=`，前端直链播放/下载）
- **严重程度**: 🔴 High（与 A1 联动；A1 修复后立即暴露）
- **位置**: [VideoPlayer.tsx L10-17](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Artifact/VideoPlayer.tsx#L10-L17)
- **描述**: `<video src={artifactStreamUrl(...)}>` 无法携带 `X-API-Key` 头。已核对后端 `app/main.py` 的 `api_key_middleware`：REST 路径**仅接受 Header**（`?api_key=` 查询参数只在 WS 握手支持）。代码注释自己也承认「视频 src 无法带自定义头…这里依赖同源代理转发」，但 nginx 代理只做转发不注入认证——`require_auth=True` 部署下视频流请求 100% 返回 401。
- **修复方案**（任选其一）:
  1. 后端为 artifact GET 增加与 WS 一致的 `?api_key=` 查询参数支持（配合现有 `access_log off` 不泄漏日志）；
  2. 前端用带头 fetch 拿 blob → `URL.createObjectURL` 作为 `src`（小文件可行，大视频结合 `preload="none"` 与 MediaSource 成本较高）；
  3. 改用一次性签名 URL（后端颁发短时效 token）。

### A3 4429 限流重连无上限，与注释语义不符
- **处置状态**: ✅ 已修复（任务 3.3：独立计数 `rateLimitRetries`，超限转 failed）
- **严重程度**: 🟡 Medium
- **位置**: [WebSocketClient.ts L157-161](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/ws/WebSocketClient.ts#L157-L161)
- **描述**: 类头注释与 UI 提示均为「4429 等待 60s **单次**重试」，但 `handleClose` 的 `RATE_LIMITED` 分支每次都无条件 `scheduleReconnect(60s)`，且该路径不经过 `RECONNECT_MAX_ATTEMPTS` 检查：服务端持续限流时客户端将无限循环重连（每次还会 `reconnectAttempt += 1` 却无人消费），并反复弹「已限流」横幅。
- **修复方案**: 在 4429 分支加入独立的限流重试计数（如最多 1~3 次），超限后转 `failed` 状态交给手动 `retry()`；或统一并入指数退避主路径并纳入次数上限。

### A4 审批超时判定依赖错误消息字符串匹配
- **处置状态**: ✅ 已修复（任务 1.2/4.1：结构化 `code: "approval_timeout"`，保留文案回退）
- **严重程度**: 🟡 Medium
- **位置**: [useWebSocket.ts L157-159](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/ws/useWebSocket.ts#L157-L159)
- **描述**: `turn_error` 帧中通过 `frame.message.includes('approval') || includes('审批')` 判断是否为审批超时来关闭弹窗。后端错误文案一旦措辞调整（或本地化），弹窗将无法自动关闭，只能等 `useApproval` 的前端 300s 本地倒计时兜底。协议语义耦合在自然语言文案上是脆弱设计。
- **修复方案**: 与后端约定结构化错误码（如 `turn_error` 帧增加 `code: "approval_timeout"`），前端按 code 分发；过渡期保留字符串匹配作为回退。

### A5 关闭会话无确认 + 乐观更新失败无纠正
- **处置状态**: ✅ 已修复（任务 3.2：`ConfirmDialog` + `useCloseSession`，失败回滚 + 错误横幅）
- **严重程度**: 🟡 Medium
- **位置**: [Sidebar.tsx L25-29](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Layout/Sidebar.tsx#L25-L29)、[ChatView.tsx L46-49](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/ChatView.tsx#L46-L49)、TerminalView `/close` 同款
- **描述**: 两点问题：
  1. spec session-rest-api 场景为「用户点击关闭会话按钮**并确认**」，当前 `SessionCard` 的垃圾桶按钮单击即关，误触即销毁会话（后端 DELETE 会清 workspace/产物，不可逆）；
  2. 三处 `void closeSession(sid).catch(() => undefined)` 把失败完全吞掉，本地已乐观置 `closed`（终态 → WS 断开、只读），注释称「由后端下次 GET 纠正」但代码中没有任何会触发重新 GET 该会话的路径——失败后 UI 与后端状态永久漂移，只能刷新页面。
- **修复方案**: 关闭前加确认（复用 ApprovalModal 的对话框样式即可）；`closeSession` 失败时回滚 `patchSession` 原状态并弹错误横幅。

### A6 REST 兜底成功后未更新 `lastTurnIndex`
- **处置状态**: ✅ 已修复（任务 2.2）
- **严重程度**: 🟢 Low
- **位置**: [useConversation.ts L64-76](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/hooks/useConversation.ts#L64-L76)
- **描述**: WS 断开期间通过 REST 完成的轮次不写 `wsStore.setLastTurnIndex`，重连时 `?last_turn_index=` 偏小，服务端会补发已在本地展示的轮次。当前靠 `completeTurn` 的「已找到同 turnIndex 消息则不重建」逻辑避免了重复气泡，功能正确但属于隐式依赖。
- **修复方案**: REST 提交成功回调里同步 `setLastTurnIndex(sid, turn.turn_index)`。

### A7 `useApproval` 倒计时基准不可靠
- **处置状态**: ✅ 已修复（任务 5.2：`receivedAt` 基准 + `useRef` deadline）
- **严重程度**: 🟢 Low
- **位置**: [useApproval.ts L25-29](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/hooks/useApproval.ts#L25-L29)
- **描述**: `deadline` 用 `useMemo(() => Date.now() + 300_000, [requestId])` 计算——React 明确不保证 memo 缓存永不丢弃，丢弃即倒计时重置；且基准是**弹窗首次渲染时刻**而非**收到帧时刻**（注释声称后者），若帧到达与渲染间有延迟/挂起，前端倒计时会晚于后端 300s 真实截止。
- **修复方案**: 在 `conv.setPendingApproval` 写入帧时附带 `receivedAt: Date.now()`，Hook 从帧数据取基准；`deadline` 改用 `useRef` + `requestId` 变更时显式重置。

### A8 TODO 面板与助手消息缺少 GFM 渲染
- **处置状态**: ✅ 已修复（任务 4.3：`remark-gfm` + 自定义 `li` 删除线）
- **严重程度**: 🟢 Low（规格偏离 E3 同源）
- **位置**: [TodoPanel.tsx L53](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/TodoPanel.tsx#L53)、[AssistantStream.tsx L17](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/AssistantStream.tsx#L17)
- **描述**: `react-markdown` 未挂 `remark-gfm`：任务列表 `- [x]` 渲染为普通列表项且 `[x]` 以字面文本出现，spec session-chat-mode 要求的「已完成项显示删除线」无法呈现；助手回复中的表格/删除线/自动链接同样不渲染。进度条统计（正则解析）不受影响。
- **修复方案**: 新增 `remark-gfm` 依赖并传入 `remarkPlugins={[remarkGfm]}`；TodoPanel 可再加自定义 `li` 渲染器给已完成项加 `line-through`。

### A9 会话删除后 conversation / ws 状态残留（死代码）
- **处置状态**: ✅ 已修复（任务 5.3：`removeSession` 级联清理）
- **严重程度**: 🟢 Low
- **位置**: [conversationStore.ts L235-240](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/store/conversationStore.ts#L235-L240)、[wsStore.ts L37-50](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/store/wsStore.ts#L37-L50)
- **描述**: `removeConversation` 与 `wsStore.clear` 在生产代码中零调用。`sessionStore.removeSession`（404 剔除、关闭剔除）后，该会话的消息数组、`lastTurnIndex` 等仍留在内存直到刷新——长会话多次增删时缓慢累积。
- **修复方案**: 在 `removeSession` 的调用点（或做一个组合 action）级联调用两者；若决定不清理则删除死代码。

### A10 启动恢复无并发控制 / 分页
- **处置状态**: ✅ 已修复（任务 5.4：批处理恢复 + 404 即时剔除）
- **严重程度**: 🟢 Low
- **位置**: [App.tsx L20](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/App.tsx#L20)
- **描述**: `Promise.allSettled(ids.map(getSession))` 对全部缓存 ID 一次性并发 GET。design R1 的缓解措施写明「前端分页加载」，未实现；每日 200 配额上限下最多 200 并发请求，可能触发后端限流（进而弹 429 横幅误导用户）。
- **修复方案**: 简单批处理（如每批 10 个串行推进）即可；顺带把 rejected 且 HTTP 404 的 ID 立即从 localStorage 剔除（当前依赖「下次写入自然清理」）。

### A11 TerminalBridge 多行缓冲下 Tab 补全显示错乱
- **处置状态**: ✅ 已修复（任务 4.5/5.2：多行状态禁用 Tab 补全，红测试转绿）
- **严重程度**: 🟢 Low（边界场景）
- **位置**: [TerminalBridge.ts L238-244](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Terminal/TerminalBridge.ts#L238-L244)
- **描述**: `replaceInput` 只回退擦除**末行**字符却把整个 `lines` 重置为单行。用户 Shift+Enter 多行输入后若末行以 `/` 开头按 Tab，屏幕上残留前几行文本但缓冲区已丢弃，显示与实际提交内容不一致。
- **修复方案**: 多行状态下禁用 Tab 补全（与历史导航的 `lines.length > 1` 守卫保持一致）。

---

## 4. 安全问题（B 类）

### B1 `stripHtmlTags` 破坏合法用户输入
- **处置状态**: ✅ 已修复（任务 3.1：删除 HTML 剥离，spec 同步修订）
- **严重程度**: 🟡 Medium（正确性受损，防护收益为零）
- **位置**: [sanitize.ts L13-20](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/utils/sanitize.ts#L13-L20)、调用点 [useConversation.ts L56](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/hooks/useConversation.ts#L56)
- **描述**: `/<[^>]*>/g` 会把用户提示词中的 `Vec<T>`、`List<string>`、`<div> 标签怎么居中`、`a < b > c` 等技术文本静默删改后才发给 Agent——对一个面向开发场景的 Agent 前端是实打实的语义破坏。而 XSS 收益为零：用户消息经 React JSX 渲染（自动转义），助手消息经 react-markdown（默认不渲染 HTML + 默认 urlTransform 过滤 `javascript:`），再叠加 nginx CSP `script-src 'self'`，三层防护已闭环。spec session-auth 虽写了「剥离 HTML 标签」，但该条款与 Chat 产品语义冲突，应修订规格而非保留破坏性过滤。
- **修复方案**: `sanitizeUserInput` 仅保留 `stripControlChars`；同步用 openspec 流程修订 session-auth spec 对应 Scenario（防护判据改为「渲染层转义 + CSP」）。

### B2 Terminal 模式对服务端文本未过滤 ANSI/OSC 控制序列
- **处置状态**: ✅ 已修复（任务 5.5：`sanitizeAnsi` 剥 OSC/危险 CSI、保留 SGR）
- **严重程度**: 🟢 Low
- **位置**: [TerminalBridge.ts L70](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Terminal/TerminalBridge.ts#L70)
- **描述**: `delta` 文本原样 `term.write()`。若上游模型输出（或被注入的工具输出）包含 OSC/CSI 序列，可清屏、伪造提示符、制造超链接欺骗（WebLinksAddon 已启用）。xterm.js 本身无沙箱逃逸风险，属 UI 欺骗面。
- **修复方案**: 写入前剥离 `\x1b][^\x07\x1b]*(\x07|\x1b\\)`（OSC）与危险 CSI 子集，保留 SGR 颜色序列。

### B3 API Key 明文存 localStorage + WS 查询参数传输
- **处置状态**: 🚫 won't-fix-now（接受的风险，远期改 WS ticket 方案）
- **严重程度**: 🟢 Low（设计已知并已部分缓解，记录为接受的风险）
- **位置**: [authStore.ts](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/store/authStore.ts)、[protocol.ts L54](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/ws/protocol.ts#L54)
- **描述**: 浏览器 WS 无法带自定义头（design 明示约束），查询参数方案已由 nginx `/v1` `access_log off` 缓解日志泄漏；localStorage 存 Key 在 XSS 成立时可被窃取，但 CSP 已收严。UI 侧脱敏（`maskApiKey`）符合 spec。
- **改进建议**（远期）: 改为短时效 WS ticket（REST 换票 → WS 用一次性 ticket），Key 不再进 URL；或 HttpOnly cookie 会话化。

### B4 CSP `connect-src` 放行任意 `ws:`/`wss:` 目标
- **处置状态**: ✅ 已修复（任务 5.6：三处收紧为 `connect-src 'self'`，冒烟断言防回归）
- **严重程度**: 🟢 Low
- **位置**: [nginx.conf.template](file:///root/projects/OpenHarness_HyperFrames/session-frontend/nginx.conf.template)（三处 CSP 声明）
- **描述**: `connect-src 'self' ws: wss:` 允许页面脚本连到**任何主机**的 WebSocket——若发生 XSS，可用作数据外带通道。实际部署为同源反代，`'self'` 已覆盖（现代浏览器 `'self'` 匹配同源 ws/wss）。
- **修复方案**: 收紧为 `connect-src 'self'`；如需兼容老浏览器保留 `wss://$host`。

### B5 Markdown 外链无 `rel="noopener noreferrer"`
- **处置状态**: ✅ 已修复（任务 5.7：`MarkdownLink` 组件注入两处 ReactMarkdown）
- **严重程度**: 🟢 Low
- **位置**: [AssistantStream.tsx](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/AssistantStream.tsx)、[TodoPanel.tsx](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/TodoPanel.tsx)
- **描述**: react-markdown 默认渲染 `<a>` 无 `target`/`rel` 控制；当前同 tab 打开无 opener 风险，但助手输出的钓鱼链接可无提示跳走当前会话页面。
- **修复方案**: 提供自定义 `a` 组件：`target="_blank" rel="noopener noreferrer"` + 外链图标提示。

---

## 5. 性能问题（C 类）

### C1 产物下载全量 blob 进内存
- **处置状态**: ✅ 已修复（任务 2.3：直链 `<a download>`，删除 fetch→blob 路径）
- **严重程度**: 🟡 Medium
- **位置**: [sessions.ts L44-59](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/api/sessions.ts#L44-L59)
- **描述**: `downloadArtifact` 用 fetch → `response.blob()` 把整个视频读进内存再触发下载。数百 MB 级视频会造成明显内存峰值，移动端可能直接崩溃标签页。
- **修复方案**: 与 A2 一并解决——支持带认证的直链（查询参数或签名 URL）后改回 `<a href download>` 让浏览器流式落盘。

### C2 流式渲染每次 flush 全量重解析 Markdown（design D6 的 `useDeferredValue` 未实现）
- **处置状态**: ✅ 已修复（任务 5.1：`useDeferredValue` 接入 AssistantStream）
- **严重程度**: 🟢 Low
- **位置**: [AssistantStream.tsx L15-19](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/AssistantStream.tsx#L15-L19)
- **描述**: 批量 flush 已把频率压到 20fps 以下，但每次 flush 仍对**累计全文**跑一遍 remark 解析，长回复末期单次解析成本线性上升，且与用户输入竞争主线程。design D6 明确提到「使用 `useDeferredValue` 进一步避免阻塞用户输入」，未落地。
- **修复方案**: `const deferredText = useDeferredValue(text)` 传给 ReactMarkdown；或 streaming 期间以 `<pre>` 纯文本渲染、`turn_complete` 后一次性切换 Markdown。

### C3 `appendAssistantText` 每次 flush 复制全量消息数组
- **处置状态**: 🚫 won't-fix-now（任务 5.13：已在 `conversationStore.ts` 留 TODO(C3) 备查）
- **严重程度**: 🟢 Low（可接受，记录备查）
- **位置**: [conversationStore.ts L83-106](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/store/conversationStore.ts#L83-L106)
- **描述**: 每次 flush `[...conv.messages]` + 尾部线性扫描，消息数千条时 O(n) 复制 20 次/秒。虚拟滚动已隔离渲染成本，状态层成本当前量级无感知。
- **改进建议**: 若未来支持超长会话，可把「流式中的最后一条助手消息」拆到独立字段，完成时再并入 messages。

---

## 6. 可维护性 / 代码风格（D 类）

### D1 禁用 React StrictMode 以回避 WS 双连
- **处置状态**: ✅ 已修复（任务 4.2：恢复 `<StrictMode>`，WS 无双活连接）
- **严重程度**: 🟡 Medium
- **位置**: [main.tsx L2-3](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/main.tsx#L2-L3)
- **描述**: 注释直言「不启用 StrictMode：避免开发态双挂载导致 WS 重复建连/断开噪音」。这是用关掉体检来治病：`useWebSocket` 的 effect 实际已有完备清理（`dispose()`），双挂载只是开发态噪音而非错误；关闭 StrictMode 反而失去对**其它**副作用缺陷（如 A9 类泄漏）的早期检测。
- **修复方案**: 恢复 `<StrictMode>`；如嫌噪音可在 `WebSocketClient.connect` 加 50ms 防抖或在开发态日志降噪。

### D2 ESLint 配置依赖幽灵依赖（phantom dependencies）
- **处置状态**: ✅ 已修复（任务 3.4：显式声明 `@eslint/js`、`globals`）
- **严重程度**: 🟡 Medium
- **位置**: [eslint.config.js L1-2](file:///root/projects/OpenHarness_HyperFrames/session-frontend/eslint.config.js#L1-L2)、[package.json](file:///root/projects/OpenHarness_HyperFrames/session-frontend/package.json)
- **描述**: `import js from '@eslint/js'` 与 `import globals from 'globals'` 两个包均未在 `devDependencies` 声明，当前靠 eslint/typescript-eslint 的传递依赖 hoisting 才能解析。依赖树升级（或 pnpm 等严格解析器）会让 Docker `test` 阶段的 lint 直接崩。
- **修复方案**: `npm i -D @eslint/js globals` 显式声明。

### D3 slash 命令分发逻辑在双模式各复制一份
- **处置状态**: ✅ 已修复（任务 5.8：`utils/slashCommands.ts` 统一分发表，`/help` 双视图一致）
- **严重程度**: 🟢 Low
- **位置**: [ChatView.tsx L27-63](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Chat/ChatView.tsx#L27-L63)、[TerminalView.tsx L26-52](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Terminal/TerminalView.tsx#L26-L52)
- **描述**: `/interrupt、/theme、/chat、/terminal、/close` 两份 switch 已出现行为漂移：`/help` 仅 Chat 实现（Terminal 下 `/help` 会被当普通文本发给 Agent）；`/close` 的乐观更新逻辑重复三处（含 Sidebar）。
- **修复方案**: 提取 `utils/slashCommands.ts` 统一分发表（command → handler），两个视图只注入差异项（如 `/clear` 的宿主行为）。

### D4 TerminalBridge 与 store 的输入历史双数据源
- **处置状态**: ✅ 已修复（任务 5.9：历史改 getter 回调，提交统一走 `pushInputHistory`）
- **严重程度**: 🟢 Low
- **位置**: [TerminalBridge.ts L39/L49/L182/L191](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Terminal/TerminalBridge.ts#L39)
- **描述**: bridge 构造时拷贝 `inputHistory` 快照，之后本地 push；Chat 模式期间新增的历史不会同步到已存在的 bridge（当前靠 `key={sid}` 重建缓解），slash 命令只进 bridge 历史不进 store。规格写明「chat 与 terminal 共享」输入历史，实际是最终一致而非实时一致。
- **修复方案**: bridge 提交时统一走 `pushInputHistory`，历史读取改为 getter 回调（`() => convRef.current.inputHistory`）。

### D5 CreateDialog / SettingsPanel 缺焦点圈定，a11y 实现不一致
- **处置状态**: ✅ 已修复（任务 5.10：提取 `useFocusTrap` 复用四处对话框）
- **严重程度**: 🟢 Low
- **位置**: [CreateDialog.tsx L90-102](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Session/CreateDialog.tsx#L90-L102)、[SettingsPanel.tsx](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Settings/SettingsPanel.tsx)
- **描述**: `ApprovalModal` 实现了完整的 focus trap/初始焦点/焦点归还（task 10.6），但另两个 `aria-modal="true"` 对话框没有：Tab 可穿透到遮罩后的页面元素；Escape 依赖 overlay div 的 `onKeyDown`，焦点在 body 上时不生效。
- **修复方案**: 把 ApprovalModal 的焦点圈定 effect 提取为 `useFocusTrap(dialogRef, onEscape)` 复用三处。

### D6 `useWebSocket` 内 store 快照捕获与即时 `getState()` 混用
- **处置状态**: ✅ 已修复（任务 5.11：统一 `getState()` 现取现用）
- **严重程度**: 🟢 Low（风格问题，因 zustand action 引用稳定而无实际 bug）
- **位置**: [useWebSocket.ts L89-91 vs L94/L114/L141](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/ws/useWebSocket.ts#L89-L91)
- **描述**: effect 顶部捕获 `conv/wsState/sessions` 快照调用 action，其它地方又用 `useXxxStore.getState()` 现取。两种写法混用增加「快照读到旧 state」的误判成本（本处只调 action 所以安全，但读取字段时是真陷阱，如 L114 就特意重新 getState）。
- **修复方案**: 统一为「action 现取现用」风格，删除顶部快照。

---

## 7. 规格偏离（E 类，独立于上文者）

### E1 403 配额耗尽未按规格弹全局 fatal 横幅
- **处置状态**: ✅ 已修复（任务 1.5/2.4：后端 403 附 `code`，拦截器分支处理）
- **严重程度**: 🟡 Medium
- **位置**: [client.ts L33-46](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/api/client.ts#L33-L46)
- **描述**: spec session-ui-shell/session-rest-api 要求「收到 403 → 红色横幅『今日会话配额已用完』，不可关闭」。`afterResponse` 拦截器只处理 401/429/503，403 仅在 CreateDialog 内联展示 detail 文本，其它入口（REST 兜底提交等）收到 403 无全局提示。
- **修复方案**: 拦截器补 `response.status === 403 → showBanner('fatal', '今日会话配额已用完，请明天再试', false)`；注意需与「无权限访问他人会话」的 403 区分（可按后端 detail 判别）。

### E2 429 横幅缺少重试等待时间
- **处置状态**: ✅ 已修复（任务 4.4：读取 `Retry-After` 拼入文案）
- **严重程度**: 🟢 Low
- **位置**: [client.ts L40](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/api/client.ts#L40)
- **描述**: spec 要求 429 提示「包含重试等待时间」；当前固定文案。后端若返回 `Retry-After` 头应读取拼入。
- **修复方案**: `const retryAfter = response.headers.get('Retry-After')` 拼入横幅文案。

### E3 创建会话缺「并发超限（8 个）」专属提示
- **处置状态**: ✅ 已修复（任务 4.4：CreateDialog 专属文案 + 抑制全局横幅）
- **严重程度**: 🟢 Low
- **位置**: [CreateDialog.tsx L83-84](file:///root/projects/OpenHarness_HyperFrames/session-frontend/src/components/Session/CreateDialog.tsx#L83-L84)
- **描述**: spec 场景「429（并发配额超限）→ 提示『并发会话数已达上限（最多 8 个）…』」。当前 429 会先被全局拦截器弹通用限流横幅，对话框内再显示后端 detail——文案是否符合规格取决于后端 detail，前端未做区分映射。
- **修复方案**: CreateDialog 捕获 429 时展示规格文案，并抑制全局通用横幅（或接受现状、修订 spec 措辞）。

---

## 8. 测试覆盖分析（F 类）

**现有覆盖**（6 个单测文件 + 1 个 Playwright E2E，均在 Docker 镜像内执行 ✅）：

| 模块 | 文件 | 评价 |
|---|---|---|
| WS 协议编解码 | `protocol.test.ts`（13 用例） | 覆盖未知帧透传、URL 构建 |
| useWebSocket | `useWebSocket.test.ts`（276 行） | MockWebSocket 质量高，覆盖重连/帧分发/审批 |
| 五个 store | `stores.test.ts`（197 行） | 覆盖持久化与状态迁移 |
| 输入校验 | `sanitize.test.ts`（21 用例） | 白名单/元字符边界充分 |
| 审批弹窗 | `ApprovalModal.test.tsx`（12 用例） | 含键盘交互 |
| 创建对话框 | `CreateDialog.test.tsx`（6 用例） | 基本流 |
| E2E | `session-flow.spec.ts`（6 场景）+ mock-backend | 主链路冒烟 |

**主要缺口**（按风险排序；✅ 均已在 harden-session-frontend 中补齐，见任务 2.5/3.5/4.5/4.6/4.7/5.12）：

1. **`TerminalBridge`（265 行，0 测试）**——行编辑/历史/多行/帧渲染全部逻辑纯类、无 DOM 依赖，是性价比最高的补测对象（A11 即可由测试暴露）。
2. **`useConversation` REST 兜底路径**——WS 不可用降级是规格要求的关键行为，无任何测试。
3. **`api/client.ts` 拦截器**——401 清 Key、429/503 横幅、`NoApiKeyError` 均未测（E1 修复时应连带补齐）。
4. **`useApproval` 倒计时**——`vi.useFakeTimers` 即可覆盖超时自动关闭。
5. **`InputBar` 历史导航与 slash 补全**——键盘状态机分支多，回归风险高。
6. **`WebSocketClient` 心跳/4429 路径**——useWebSocket 测试覆盖了主流程，但心跳判死与限流重试（A3）无直接用例。

---

## 9. 最佳实践建议

1. **恢复 StrictMode 并保持 effect 可重入**（D1）——这是 React 18/19 生态的基线约定，也是并发特性（`useDeferredValue`，见 C2）的前置条件。
2. **协议语义结构化**：所有「按文案判断行为」的点（A4）改为结构化 code；前后端共享一份 WS 帧 schema（可从 `app/schemas.py` 生成 TS 类型），杜绝 `types/ws.ts` 手工对齐漂移。
3. **提取共享 UI 原语**：`useFocusTrap`（D5）、`ConfirmDialog`（A5）、slash 命令表（D3）三者提取后可消除当前大部分重复与不一致。
4. **依赖卫生**：显式声明所有直接 import 的包（D2）；考虑在 CI lint 阶段加 `eslint-plugin-import` 的 `no-extraneous-dependencies` 规则防回归。
5. **规格与实现双向同步**：本次发现的 spec 与实现冲突（B1 的 HTML 剥离、E3 文案）应走 openspec 变更流程修订，而不是让实现静默偏离——本项目的 task 编号注释文化很好，值得延续。
6. **可观测性**：WS 状态机事件（重连次数、关闭码分布）目前只进 UI，建议加轻量 `console.debug` 分级日志或 window 事件钩子，便于生产排障（nginx 侧已关 `/v1` 日志，前端是唯一观测点）。
7. **测试策略**：新增逻辑优先写纯函数/纯类（TerminalBridge 模式），保持「组件薄、逻辑下沉」现状，使镜像内 vitest 保持秒级。

---

## 10. 总结与优先级排序

session-frontend 是一个**结构清晰、规格可追溯、协议层扎实**的中小型 React 项目，安全基线（白名单校验、CSP、认证拦截）与工程规范（镜像内测试、分层、类型对齐）落实良好。核心问题集中在**产物链路从未真正打通**（A1+A2，两个 High 联动，等于砍掉一个规格能力）以及若干「实现与注释/规格自相矛盾」的点（A3、A5、B1、E1）。

### 修复优先级

| 优先级 | 问题 | 工作量 | 说明 |
|:--:|---|:--:|---|
| **P0** | A1 + A2 产物预览/下载链路 | 中（需后端配合） | 规格能力缺失，建议一个变更内联动修复 |
| **P0** | E1 403 全局横幅 | 小 | 规格明确要求，5 行拦截器改动 |
| **P1** | B1 停用 HTML 剥离 | 小（含 spec 修订） | 正在破坏真实用户输入 |
| **P1** | A5 关闭确认 + 失败回滚 | 小 | 不可逆操作的防误触 |
| **P1** | A3 4429 重试上限 | 小 | 防限流风暴 |
| **P1** | D2 幽灵依赖 | 极小 | 防 CI 随机崩溃 |
| **P2** | A4 审批超时结构化 code | 中（需后端配合） | 与 A1 后端改动可合并 |
| **P2** | D1 恢复 StrictMode | 小 | 回归验证 WS 生命周期 |
| **P2** | A8/E2/E3 GFM 渲染与文案 | 小 | 体验与规格对齐 |
| **P2** | F 补测：TerminalBridge / REST 兜底 / client 拦截器 | 中 | 覆盖最高风险缺口 |
| **P3** | C1/C2 性能（blob 下载、useDeferredValue） | 中 | 随 P0 产物链路一并考虑 |
| **P3** | A6/A7/A9/A10/A11、B2/B4/B5、D3~D6 | 小~中 | 常规迭代消化 |

> 验证方式提醒：所有修复的回归验证按项目规则在已有镜像内执行——单测/lint 走 `docker build --target test session-frontend/`，E2E 走 `e2e/run-session-frontend-docker-tests.sh`，勿在宿主机直接运行 vitest/playwright。

---

## 11. 整改复查结论（2026-07-28）

通过 openspec 变更 `harden-session-frontend`（39 项任务，含后端协议配合项）完成整改：

- **已修复**：A1–A11、B1/B2/B4/B5、C1/C2、D1–D6、E1–E3，F 类六大缺口全部补齐（单测文件 6→14 个，159 用例）。
- **won't-fix-now**：B3（接受的风险，远期 WS ticket 方案）、C3（当前量级无感知，已留 TODO 备查）。
- **质量门**：镜像内 lint + vitest（14 文件 159 例全绿）；镜像内 Playwright E2E 6 场景全绿；运行时镜像冒烟（含安全头 + CSP connect-src 收紧断言）通过。
- **规格同步**：4 份 delta spec 随变更归档合入 `openspec/specs/session-*.md`。
