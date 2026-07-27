## Context

session-service 后端已稳定运行，提供会话管理（REST）和实时流式对话（WebSocket）能力。现有 `web/` 前端面向 video-service，无法复用。`OpenHarness/frontend/terminal/` 提供了成熟的终端 TUI 实现（Ink + React），其交互模型和主题系统可参考移植。

当前约束：
- 后端缺少会话列表查询 API（仅支持单会话 GET）
- WebSocket 协议为自定义 JSON 帧（非 Socket.IO）
- 浏览器 WebSocket API 无法设置自定义请求头（认证需走查询参数）
- 终端前端通过 stdin/stdout 管道通信，Web 前端通过 WebSocket，事件模型需映射适配

## Goals / Non-Goals

**Goals:**

- 提供功能完整的 Web 前端，覆盖 session-service 全部 API 能力
- 支持 Chat Mode（富文本对话）和 Terminal Mode（终端模拟）两种交互模式
- 实现 WebSocket 实时流式对话，含断线重连和消息补发
- 支持 `interactive` 策略下的审批弹窗交互
- 实现响应式布局，适配桌面到移动端
- 提供 5 个内置主题，支持模式间切换
- 可 Docker 容器化部署，Nginx 反向代理

**Non-Goals:**

- 不实现后端会话列表查询 API（前端本地缓存作为临时方案）
- 不复用 video-service 前端的代码（独立项目）
- 不实现 SSE 通信（仅 WebSocket + REST）
- 不实现多人协作/共享会话功能
- 不实现移动端原生 App（仅 PWA 级别响应式）

## Decisions

### D1: 项目独立于现有 web/ 前端

**选择**: 新建 `session-frontend/` 独立项目

**理由**: 现有 `web/` 面向 video-service，数据模型（视频任务 vs 多轮对话）、通信方式（SSE vs WebSocket）、交互模式完全不同。强行合并会增加复杂度和耦合风险。

**替代方案**: 在 `web/` 中新增路由模块 → 放弃，因为状态管理和 API 层差异过大。

### D2: 状态管理选择 Zustand 而非 Redux

**选择**: Zustand + React Context

**理由**: 
- Zustand 轻量（< 1KB），API 简洁，适合中等复杂度
- 不需要 Redux 的 middleware 生态和时间旅行调试
- React Context 用于 UI 偏好（主题、模式）等低频更新场景

### D3: WebSocket 使用原生 API 而非 Socket.IO

**选择**: 原生 WebSocket + 自研 Hook

**理由**: 
- 后端协议为自定义 JSON 帧，不兼容 Socket.IO 协议
- 原生 API 足够，无额外依赖开销
- 自研 `useWebSocket` Hook 可精确控制重连、心跳、消息分发逻辑

### D4: Terminal Mode 使用 xterm.js 而非 Ink Web 移植

**选择**: xterm.js 渲染终端

**理由**: 
- Ink 依赖 Node.js 进程模型（stdin/stdout），无法在浏览器运行
- xterm.js 是成熟的 Web 终端方案，支持 ANSI 转义序列、主题、插件
- 通过 `TerminalBridge` 适配层将 WS 事件转换为终端输出

**替代方案**: 纯 React 组件模拟终端 → 放弃，ANSI 兼容性差，开发成本高。

### D5: HTTP 客户端选择 ky 而非 axios

**选择**: ky

**理由**: 
- 基于 fetch API，体积更小
- 拦截器机制满足 API Key 注入和错误处理需求
- 与现有 `web/` 前端的 fetch 风格一致

### D6: 流式渲染采用批量 flush 策略

**选择**: 50ms 或 384 字符阈值批量刷新

**理由**: 
- 直接逐 token 渲染会导致 React 频繁重渲染，性能劣化
- 该策略从终端前端验证有效，平衡了实时性和性能
- 使用 `useDeferredValue` 进一步避免阻塞用户输入

### D7: 样式方案选择 Tailwind CSS

**选择**: Tailwind CSS 4 + CSS 变量主题

**理由**: 
- 原子化 CSS 避免样式冲突，适合组件化开发
- CSS 变量实现主题切换，无需 CSS-in-JS 运行时开销
- 终端前端的 5 个主题可映射为 CSS 变量集合

### D8: 会话列表本地缓存方案

**选择**: localStorage 存储会话 ID 列表，逐个 GET 查询详情

**理由**: 
- 后端暂无会话列表 API，这是最小侵入的临时方案
- 会话数量有限（每日 200 配额），逐个查询性能可接受
- 后续后端补充列表 API 后，可平滑迁移

## Risks / Trade-offs

**R1: 后端缺少会话列表 API** → 前端本地缓存会话 ID，每次启动时批量 GET 查询。性能在 200 个会话内可接受，但大量历史会话时体验下降。缓解：前端分页加载 + 后续推动后端补充列表 API。

**R2: WebSocket 浏览器兼容性** → 所有现代浏览器均支持 WebSocket，风险极低。缓解：连接失败时降级为 REST 轮询模式（仅 submit turn）。

**R3: xterm.js 体积较大（~300KB gzipped）** → Terminal Mode 按需动态 import，Chat Mode 用户不加载。缓解：代码分割 + lazy loading。

**R4: 主题一致性维护** → 终端前端和 Web 前端的主题需手动同步。缓解：提取共享主题配置到 monorepo 公共包（后续优化）。

**R5: 审批弹窗在 full_auto 模式下误触发** → 前端根据 `permission_policy` 字段条件渲染审批组件，`full_auto` 模式下不挂载 ApprovalModal。

**R6: 产物下载跨域** → S3 302 重定向可能触发 CORS。缓解：Nginx 代理产物下载路径，避免浏览器直连 S3。
