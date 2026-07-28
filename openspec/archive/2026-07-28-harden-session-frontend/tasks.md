# Tasks: harden-session-frontend

> 执行顺序对齐 `plans/Session_Frontend_Fix_Plan_2026-07-28.md` 的 Phase 0–3；括号内为审查报告问题编号。
> 质量门（每组完成后执行，均在已有 Docker 镜像内）：
> - 前端单测 + lint：`docker build --target test session-frontend/`
> - E2E：`e2e/run-session-frontend-docker-tests.sh`
> - 后端：`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`
> 禁止在宿主机直接运行 vitest / playwright / pytest。

## 1. 后端协议配合项（session-service，一次发版）

- [x] 1.1 `supervisor.py` 的 `_finalize_turn` 产物注册成功后在 `turn_complete` 帧附带 `has_artifact: bool`；`schemas.py` 的 `TurnResponse` 新增 `has_artifact` 字段（默认 `false`）（A1）
- [x] 1.2 审批超时产出的 `turn_error` 帧附带 `code: "approval_timeout"`（A4）
- [x] 1.3 认证中间件对 `/v1/sessions/{sid}/turns/{idx}/artifact` GET 额外接受 `?api_key=` 查询参数（复用 WS 握手校验逻辑，其余 REST 路径不变）；核对 uvicorn access log 不落查询串明文（A2）
- [x] 1.4 后端 pytest：`turn_complete`/`TurnResponse` 含 `has_artifact`；artifact GET 查询参数合法 200/非法 401；非产物路径查询参数仍 401；`turn_error` 含 `code`（镜像内执行）
- [x] 1.5 （可选，随 Open Question 决策）403 错误体补 `code` 字段区分「配额耗尽」与「无权访问」

## 2. Phase 0 — 前端产物链路 + 规格强制项

- [x] 2.1 `types/ws.ts` 的 `TurnCompleteFrame` 增加可选 `has_artifact`、`TurnErrorFrame` 增加可选 `code`；`useWebSocket` 的 `turn_complete` 分支透传 `completeTurn(sid, idx, { hasArtifact: frame.has_artifact ?? false })`（A1）
- [x] 2.2 `useConversation` REST 兜底：从 `TurnResponse.has_artifact` 透传产物标记，并同步 `wsStore.setLastTurnIndex(sid, turn.turn_index)`（A1/A6）
- [x] 2.3 `api/sessions.ts`：`artifactStreamUrl`/`artifactUrl` 拼接 `?api_key=`；`VideoPlayer` 直用直链 src 并更新注释；`downloadArtifact` 改 `<a download>` 直链，删除 fetch→blob 路径（A2/C1）
- [x] 2.4 `api/client.ts` 拦截器补 403 分支：配额类 403 弹不可关闭 fatal 横幅「今日会话配额已用完，请明天再试」，权限类 403 走普通错误提示（E1）
- [x] 2.5 前端测试：`useWebSocket.test.ts` 补 `has_artifact` 带/缺字段用例；新增 `api/__tests__/client.test.ts` 覆盖 403 两类分支 + 既有 401/429/503 断言
- [x] 2.6 E2E：`e2e/mock-backend.mjs` 的 `turn_complete` 帧补 `has_artifact: true` 场景，`session-flow.spec.ts` 断言视频卡片渲染；跑通质量门

## 3. Phase 1 — 正确性与防误触

- [x] 3.1 `sanitize.ts` 删除 `stripHtmlTags`（函数与调用点），`sanitizeUserInput` 仅保留控制字符剥离；`sanitize.test.ts` 改为反向断言（`Vec<T>`、`a < b > c` 原样保留）（B1）
- [x] 3.2 新增 `Common/ConfirmDialog.tsx` 与 `useCloseSession(sid)` hook：确认 → 乐观置 closed → 失败回滚 `patchSession` + 错误横幅；替换 Sidebar / ChatView / TerminalView 三处关闭入口，删除吞错写法（A5）
- [x] 3.3 `WebSocketClient` 4429 分支：独立计数 `rateLimitRetries`（常量 `RATE_LIMIT_MAX_RETRIES = 2`），超限转 failed，`retry()`/`onopen` 清零；同步类注释与 `WS_CLOSE_MESSAGES[4429]` 文案（A3）
- [x] 3.4 `package.json` devDependencies 显式声明 `@eslint/js`、`globals`（版本与 lock 中现行解析一致）（D2）
- [x] 3.5 测试：`useCloseSession` 单测（reject → 回滚 + 横幅）；4429 有界重试用例（fake timers，第 3 次不再重连）；E2E 断言确认对话框出现、取消后会话仍在；跑通质量门

## 4. Phase 2 — 协议健壮性 + 规格对齐 + 核心补测

- [x] 4.1 `useWebSocket` 的 `turn_error` 分发：优先按 `frame.code === 'approval_timeout'` 判定，保留文案匹配回退并注释移除条件（A4）
- [x] 4.2 `main.tsx` 恢复 `<StrictMode>`；验证 WS 无双活连接（mock-backend 连接计数），如有噪音仅做 dev 态降噪，不关闭 StrictMode（D1）
- [x] 4.3 新增 `remark-gfm` 依赖；`AssistantStream`/`TodoPanel` 挂 `remarkPlugins`；TodoPanel 自定义 `li` 渲染器给已完成项加删除线（A8）
- [x] 4.4 `api/client.ts` 429 横幅读取 `Retry-After` 头拼入等待时间（E2）；CreateDialog 捕获 429 显示「并发会话数已达上限（最多 8 个）…」并抑制全局横幅（E3）
- [x] 4.5 补测 F1：新增 `TerminalBridge.test.ts`（单行/多行/历史导航/Tab 补全/`replaceInput`），先以红测试暴露 A11 多行 Tab 缺陷
- [x] 4.6 补测 F2/F4：`useConversation` REST 兜底路径测试；`useApproval` 倒计时测试（fake timers 推进 300s/250s）
- [x] 4.7 测试全量回归：`useWebSocket` 补 mount→unmount→mount 用例（StrictMode 守护）与 `turn_error` code/回退用例；跑通质量门

## 5. Phase 3 — 性能与长尾清理

- [x] 5.1 `AssistantStream` 接入 `useDeferredValue`（C2）；验证 blob 下载路径已全部移除（C1 收尾）
- [x] 5.2 `useApproval` 倒计时基准修正：`setPendingApproval` 附 `receivedAt`，deadline 用 `useRef` + `requestId` 重置（A7）；`TerminalBridge` 多行状态禁用 Tab 补全，4.5 红测试转绿（A11）
- [x] 5.3 `removeSession` 级联调用 `removeConversation` + `wsStore.clear`，消除状态残留与死代码（A9）；`stores.test.ts` 补级联断言
- [x] 5.4 `App.tsx` 启动恢复改批处理（每批 10 个）+ 404 ID 即时从 localStorage 剔除（A10）
- [x] 5.5 `sanitize.ts` 新增 `sanitizeAnsi`（剥 OSC/危险 CSI、保留 SGR），`TerminalBridge` 写入前调用（B2）；`sanitize.test.ts` 补 SGR 保留/OSC 剥离用例
- [x] 5.6 `nginx.conf.template` 三处 CSP `connect-src` 收紧为 `'self'`（B4）；E2E 冒烟断言响应头且 WS 仍可连
- [x] 5.7 新增 `MarkdownLink` 组件（`target="_blank" rel="noopener noreferrer"` + 外链图标），注入两处 ReactMarkdown（B5）
- [x] 5.8 提取 `utils/slashCommands.ts` 统一分发表，Chat/Terminal 双视图注入差异项，`/help` 行为一致，`SLASH_COMMANDS` 同源生成（D3）；新增 `slashCommands.test.ts`
- [x] 5.9 `TerminalBridge` 历史改 getter 回调 + 提交统一走 `pushInputHistory`，删除内部 history 数组（D4）
- [x] 5.10 提取 `useFocusTrap`（源自 ApprovalModal），接入 CreateDialog / SettingsPanel / ConfirmDialog（D5）；`CreateDialog.test.tsx` 补 Tab 循环断言
- [x] 5.11 `useWebSocket` 删除顶部 store 快照，统一 `getState()` 现取现用（D6）
- [x] 5.12 补测 F5/F6：`InputBar` 键盘状态机测试；`WebSocketClient` 心跳判死测试（3×30s 无 pong → 主动断开重连）
- [x] 5.13 `conversationStore` 为 C3 留 TODO 注释（won't-fix-now，引用报告 C3）；跑通全量质量门

## 6. 规格同步与收尾

- [x] 6.1 校验 4 份 delta spec 与实现一致（`openspec validate --change harden-session-frontend`）
- [x] 6.2 全量质量门通过后更新 `session-frontend/CODE_REVIEW_REPORT.md` 各问题项状态标注（已修复/won't-fix-now）
- [x] 6.3 归档变更（`openspec-archive-change`），delta 合入 `openspec/specs/session-*.md` 主规格
