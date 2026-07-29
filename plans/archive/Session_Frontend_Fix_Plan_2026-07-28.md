# Session Frontend 修复计划（Session_Frontend_Fix_Plan）

**Created:** 2026-07-28
**关联报告:** `session-frontend/CODE_REVIEW_REPORT.md`（2026-07-28 审查，27 项问题 + 测试缺口）
**关联规格:** `openspec/specs/session-*.md`（7 份）、归档 `openspec/archive/2026-07-27-session-service-frontend/`
**范围:** `session-frontend/`（Vite + React 18 + TypeScript + Zustand SPA）；Phase 0/2 含少量 `session-service/` 后端配合改动
**技术栈:** React 18, TypeScript, Vite 6, Zustand 5, Tailwind CSS 4, ky, xterm.js, react-markdown, vitest, Playwright

---

## 目标与原则

- 覆盖审查报告**全部问题**（A1–A11、B1–B5、C1–C3、D1–D6、E1–E3）及 §8 测试缺口（F1–F6）。
- 每项修复给出：**位置 → 方案 → 验收标准 → 回归测试**。
- 分四个阶段（Phase 0–3）交付，与报告 §10 的 P0–P3 优先级一一对应。
- **测试必须在已有 Docker 镜像内执行**（项目 always-on 规则）：
  - 单测 + lint：`docker build --target test session-frontend/`
  - E2E：`e2e/run-session-frontend-docker-tests.sh`
  - 禁止宿主机直接运行 `vitest` / `playwright` / `npm test`。
- 涉及 WS 协议 / REST 契约的改动（A1、A2、A4）须**前后端同一变更内联动**，并通过 openspec 流程修订对应 spec（`session-ws-protocol`、`session-rest-api`、`session-auth`）。
- 不引入重依赖；新增依赖仅限 `remark-gfm`（A8）与显式声明既有传递依赖 `@eslint/js`、`globals`（D2）。
- 提交粒度：每个任务完成即提交，message 用 `fix:`/`feat:`/`refactor:`/`test:`/`chore:` 前缀。

## 阶段总览

| 阶段 | 主题 | 问题项 | 退出门 |
| --- | --- | --- | --- |
| **Phase 0** | 产物链路打通 + 规格强制项 | A1, A2, E1（顺带 C1 部分） | 视频预览/下载端到端可用；403 全局横幅就位 |
| **Phase 1** | 正确性与防误触 | B1, A5, A3, D2 | 用户输入不被破坏；关闭有确认可回滚；限流不风暴；lint 依赖自洽 |
| **Phase 2** | 协议健壮性 + 规格对齐 + 补测 | A4, D1, A8, E2, E3, F1–F4 | 审批超时结构化；StrictMode 恢复；GFM 渲染；核心缺口测试就位 |
| **Phase 3** | 性能与长尾清理 | C1, C2, C3, A6, A7, A9, A10, A11, B2, B4, B5, D3, D4, D5, D6, F5, F6 | 长尾问题清零；lint/测试全绿 |

---

# Phase 0 — 产物链路打通 + 规格强制项（P0）

> A1 与 A2 是联动 High：A1 修好后 A2 立即暴露，必须一个变更内一起交付。建议走 openspec 变更 `fix-artifact-delivery-chain`，delta 覆盖 `session-ws-protocol`（turn_complete 帧新增字段）与 `session-rest-api`（artifact GET 认证方式）。

## 任务 0.1 · A1 `hasArtifact` 链路打通（需后端配合）🔴 High

- **位置（前端）:**
  - `src/ws/useWebSocket.ts` L106–121（`turn_complete` 分发）
  - `src/hooks/useConversation.ts` L64–76（REST 兜底 `completeTurn` 调用点）
  - `src/store/conversationStore.ts` L100/L119（`completeTurn` 已支持 `opts.hasArtifact`，无需改）
  - `src/types/ws.ts`（`TurnCompleteFrame` 增加字段）
- **位置（后端）:**
  - `session-service/app/session/supervisor.py`（`_finalize_turn` 后产出的 `turn_complete` 帧）
  - `session-service/app/schemas.py`（`TurnResponse` 补充字段）
- **方案:**
  1. 后端：`_finalize_turn` 注册产物成功后，`turn_complete` 帧附带 `has_artifact: bool`；`TurnResponse` 同步新增 `has_artifact` 字段（默认 `false`，向后兼容）。
  2. 前端：`types/ws.ts` 的 `TurnCompleteFrame` 增加可选 `has_artifact?: boolean`；`useWebSocket` 的 `turn_complete` 分支透传 `completeTurn(sid, frame.turn_index, { hasArtifact: frame.has_artifact ?? false })`。
  3. 前端 REST 兜底：`useConversation` 提交成功后从 `TurnResponse.has_artifact` 透传。
  4. 兜底策略（后端字段缺失的旧版本兼容）：收到 `turn_complete` 且 `has_artifact === undefined` 时，可选发一次 `Range: bytes=0-0` 探测 `GET /v1/sessions/{sid}/turns/{idx}/artifact`，200/206 置 true——**仅当需要兼容旧后端时实现**，同版本部署可跳过。
- **验收:** 带产物的轮次完成后，`MessageBubble` 渲染 `VideoPlayer` + `DownloadButton`；无产物轮次不渲染。WS 路径与 REST 兜底路径行为一致。
- **回归测试:**
  - 前端：`useWebSocket.test.ts` 新增用例——mock `turn_complete` 帧带/不带 `has_artifact`，断言 `conversationStore` 中消息的 `hasArtifact`。
  - 后端：`session-service/tests/` 断言 `turn_complete` 帧与 `TurnResponse` 含 `has_artifact`（在主镜像容器内跑 pytest：`docker compose run --rm --entrypoint bash openharness -c "cd /opt/oh-session-service && python -m pytest ..."`）。
  - E2E：`e2e/mock-backend.mjs` 的 `turn_complete` 帧补 `has_artifact: true`，`session-flow.spec.ts` 断言视频卡片出现。

## 任务 0.2 · A2 `<video>` 认证 401（需后端配合）🔴 High

- **位置:**
  - `src/components/Artifact/VideoPlayer.tsx` L10–17
  - `src/api/sessions.ts`（`artifactStreamUrl` / `downloadArtifact`）
  - `session-service/app/main.py` L83–90（`api_key_middleware`）
  - `session-frontend/nginx.conf.template`（`/v1` 已 `access_log off`，无需改）
- **方案（选定：查询参数方案，与 WS 握手认证方式对齐）:**
  1. 后端：`api_key_middleware` 对 artifact GET 路径（`/v1/sessions/{sid}/turns/{idx}/artifact`）额外接受 `?api_key=` 查询参数（复用 WS 握手同一校验函数；其余 REST 路径保持仅 Header，不扩大攻击面）。
  2. 前端：`artifactStreamUrl` 拼接 `?api_key=`（从 `authStore` 取）；`VideoPlayer` 的 `<video src>` 直接可用，注释更新。
  3. `downloadArtifact` 改为 `<a href={artifactUrl(...)+'?api_key='} download>` 直链下载，删除 fetch→blob 路径 → **顺带解决 C1**（全量 blob 内存峰值）。
  4. 日志安全核对：确认 nginx `/v1` `access_log off` 覆盖该路径；后端 access log（uvicorn）确认不打印 query string 或做脱敏。
  5. 备选方案（如安全评审否决查询参数）：后端颁发短时效签名 URL（`POST .../artifact/sign` → 60s token）；本计划默认不走此路径，记录备查。
- **验收:** `require_auth=True` 部署下，视频内嵌播放与下载均 200/206；`api_key` 不出现在 nginx access log。
- **回归测试:**
  - 后端：pytest 断言 artifact GET 带 `?api_key=` 合法 Key 200、非法 Key 401、其它 REST 路径带 `?api_key=` 仍 401。
  - 前端：`sessions.ts` 单测断言 `artifactStreamUrl` 含脱敏后的 key 参数拼接逻辑。
  - E2E 冒烟：Docker compose 环境 `curl -o /dev/null -w '%{http_code}' "…/artifact?api_key=xxx"`。

## 任务 0.3 · E1 403 配额耗尽全局 fatal 横幅 🟠 Medium（规格强制）

- **位置:** `src/api/client.ts` L33–46（`afterResponse` 拦截器）
- **方案:**
  1. 拦截器补 403 分支：`showBanner('fatal', '今日会话配额已用完，请明天再试', /*dismissible*/ false)`。
  2. 区分「配额耗尽」与「无权访问他人会话」两种 403：按后端 `detail` 字段判别（如 `detail` 含 `quota`/`配额` 才弹 fatal 横幅，否则走普通错误提示）；若后端 detail 不可判别，与后端约定错误体加 `code` 字段（小改动，可并入 0.1 的后端变更）。
- **验收:** 任意 REST 入口（创建会话、REST 兜底提交）收到配额 403 均弹不可关闭红色横幅；权限 403 不误弹。
- **回归测试:** 新增 `src/api/__tests__/client.test.ts`（同时覆盖 F3 的一部分）：mock 403 两种 detail，断言 `uiStore` banner 状态；连带补 401 清 Key、429/503 既有分支断言。

**Phase 0 退出门:** `docker build --target test session-frontend/` 全绿；`e2e/run-session-frontend-docker-tests.sh` 通过（含新增产物场景）；openspec 变更 `fix-artifact-delivery-chain` 的 delta spec 与实现一致。

---

# Phase 1 — 正确性与防误触（P1）

## 任务 1.1 · B1 停用破坏性 HTML 剥离（含 spec 修订）🟠 Medium

- **位置:** `src/utils/sanitize.ts` L13–20（`stripHtmlTags`）、`src/hooks/useConversation.ts` L56（调用点）
- **方案:**
  1. `sanitizeUserInput` 仅保留 `stripControlChars`，删除 `stripHtmlTags` 调用（函数本体一并删除，避免死代码）。
  2. openspec 修订 `session-auth` 对应 Scenario：防护判据由「剥离 HTML 标签」改为「渲染层转义（React JSX 自动转义 + react-markdown 默认不渲染 HTML）+ nginx CSP `script-src 'self'`」。
  3. 更新 `sanitize.test.ts`：删除 stripHtmlTags 用例，**新增反向断言**——`Vec<T>`、`List<string>`、`a < b > c` 原样保留。
- **验收:** 含泛型/HTML 字面文本的输入原样提交给后端；XSS 防线（渲染转义 + CSP）不变。
- **回归测试:** 镜像内 vitest `sanitize.test.ts`；E2E 输入 `Vec<T>` 断言消息气泡原样显示。

## 任务 1.2 · A5 关闭会话确认 + 失败回滚 🟠 Medium

- **位置:** `src/components/Layout/Sidebar.tsx` L25–29、`src/components/Chat/ChatView.tsx` L46–49、`src/components/Terminal/TerminalView.tsx`（`/close` 分支）
- **方案:**
  1. 新增 `src/components/Common/ConfirmDialog.tsx`（复用 ApprovalModal 的遮罩/键盘样式；焦点圈定待 Phase 3 D5 的 `useFocusTrap` 落地后接入，本阶段先保证 Escape/初始焦点基本可用）。
  2. 三处关闭入口统一收敛为一个 `useCloseSession(sid)` hook：弹确认 → 确认后乐观置 `closed` → `closeSession(sid)` 失败时 `patchSession(sid, 原状态)` 回滚 + `showBanner('error', '关闭会话失败，请重试')`。
  3. 删除三处 `void closeSession(sid).catch(() => undefined)` 吞错写法。
- **验收:** 误触垃圾桶不会直接销毁会话；后端 DELETE 失败后 UI 状态与后端一致、有错误提示。
- **回归测试:** 新增 `useCloseSession` 单测（mock closeSession reject，断言回滚 + 横幅）；E2E 断言确认对话框出现、取消后会话仍在。

## 任务 1.3 · A3 4429 限流重试上限 🟠 Medium

- **位置:** `src/ws/WebSocketClient.ts` L157–161（`handleClose` 的 `RATE_LIMITED` 分支）
- **方案:**
  1. 新增独立计数 `rateLimitRetries`，上限取 `RATE_LIMIT_MAX_RETRIES = 2`（进 `utils/constants.ts`）。
  2. 超限后置 `failed` 状态，交给 UI 的手动 `retry()`（重置计数）；成功建连（`onopen`）时清零。
  3. 同步修正类头注释与 `WS_CLOSE_MESSAGES[4429]` 文案（「已限流，将在 60s 后重试（最多 2 次）」）。
- **验收:** 服务端持续 4429 时，客户端最多重试 2 次后停止并显示可手动重试的 failed 态；不再无限弹横幅。
- **回归测试:** `useWebSocket.test.ts` 或新增 `WebSocketClient.test.ts`：`vi.useFakeTimers` + MockWebSocket 连续 close(4429)，断言第 3 次不再重连、状态为 `failed`（同时覆盖 F6 的限流路径）。

## 任务 1.4 · D2 显式声明幽灵依赖 🟠 Medium

- **位置:** `session-frontend/package.json`、`eslint.config.js` L1–2
- **方案:**
  1. `devDependencies` 显式加入 `@eslint/js`、`globals`（版本与当前 lock 中传递解析到的版本一致，避免升级引入行为变化）。
  2. 依赖变更后在镜像内重跑 lint 验证（Dockerfile `test` 阶段自动覆盖）。
  3. 可选防回归：eslint 配置加 `import/no-extraneous-dependencies`（若引入 `eslint-plugin-import` 成本可接受；否则记录到 backlog）。
- **验收:** `package.json` 声明齐全；`docker build --target test session-frontend/` lint 阶段通过。
- **回归测试:** 即构建本身。

**Phase 1 退出门:** 镜像内 lint + vitest 全绿；E2E 通过；`session-auth` spec 修订完成归档。

---

# Phase 2 — 协议健壮性 + 规格对齐 + 补测（P2）

## 任务 2.1 · A4 审批超时结构化错误码（需后端配合）🟠 Medium

- **位置:** `src/ws/useWebSocket.ts` L157–159、`src/types/ws.ts`（`TurnErrorFrame`）、后端 `session-service` 审批超时产出 `turn_error` 处
- **方案:**
  1. 后端：`turn_error` 帧新增可选 `code` 字段，审批超时时置 `"approval_timeout"`（可与 Phase 0 后端改动合并提交，减少一次后端发版）。
  2. 前端：`TurnErrorFrame` 加 `code?: string`；分发逻辑改为 `frame.code === 'approval_timeout'` 优先判定，**过渡期保留字符串匹配作为回退**（注释标注移除条件：后端 code 字段全量上线后删除）。
  3. openspec 修订 `session-ws-protocol` 的 `turn_error` 帧定义。
- **验收:** 后端改文案不影响审批弹窗自动关闭。
- **回归测试:** `useWebSocket.test.ts` 新增：`turn_error` 帧带 `code: 'approval_timeout'`（任意 message 文案）断言 `pendingApproval` 清空；不带 code 但 message 含「审批」同样清空（回退路径）。

## 任务 2.2 · D1 恢复 React StrictMode 🟠 Medium

- **位置:** `src/main.tsx` L2–3
- **方案:**
  1. 恢复 `<StrictMode>` 包裹。
  2. 验证 `useWebSocket` effect 清理在双挂载下无泄漏：dev 态观察一次建连-清理-重连即稳定（`dispose()` 已实现，预期只有噪音）；如日志噪音影响开发，在 `WebSocketClient.connect` 前加 50ms 防抖或 dev 态降噪 `console.debug`，**不得**再次关闭 StrictMode。
  3. 顺带用双挂载检验 A9（Phase 3）之外是否还有隐藏副作用缺陷，发现则记录新问题项。
- **验收:** StrictMode 开启后 dev/prod 构建均正常，WS 不出现双活连接（可用 mock-backend 的连接计数断言）。
- **回归测试:** E2E 全量回归（StrictMode 只影响 dev，但需确认无逻辑依赖挂载次数）；`useWebSocket.test.ts` 补「快速 mount→unmount→mount」用例断言旧连接被 dispose。

## 任务 2.3 · A8 GFM 渲染（TODO 面板 + 助手消息）🟢 Low

- **位置:** `src/components/Chat/TodoPanel.tsx` L53、`src/components/Chat/AssistantStream.tsx` L17、`package.json`
- **方案:**
  1. 新增依赖 `remark-gfm`，两处 `<ReactMarkdown remarkPlugins={[remarkGfm]}>`。
  2. TodoPanel 自定义 `li` 渲染器：checked 项加 `line-through text-muted`（满足 spec session-chat-mode「已完成项显示删除线」）。
  3. 同步接入 B5（见 4.x）的自定义 `a` 组件可留到 Phase 3，此处不阻塞。
- **验收:** `- [x]` 渲染为勾选框 + 删除线；助手回复中表格/删除线正常渲染；进度条统计不回归。
- **回归测试:** TodoPanel 组件测试：传入含 `- [x]`/`- [ ]` 的 markdown，断言 DOM 含 `line-through`。

## 任务 2.4 · E2 429 横幅拼入 Retry-After 🟢 Low

- **位置:** `src/api/client.ts` L40
- **方案:** `const retryAfter = response.headers.get('Retry-After')`，有值时文案追加「，请 {n} 秒后重试」；无值保持现文案。确认后端/nginx 是否透传该头，若后端未设置则在 backlog 记后端项，前端逻辑先就位。
- **验收:** mock 429 + `Retry-After: 30` 时横幅含「30 秒」。
- **回归测试:** 并入 `client.test.ts`（任务 0.3 已建）。

## 任务 2.5 · E3 创建会话 429 并发超限专属文案 🟢 Low

- **位置:** `src/components/Session/CreateDialog.tsx` L83–84、`src/api/client.ts`
- **方案:**
  1. `createSession` 调用处捕获 429：对话框内展示规格文案「并发会话数已达上限（最多 8 个），请先关闭部分会话」。
  2. 抑制该请求的全局通用限流横幅：`ky` 请求级加自定义 header/ctx 标记（如 `hooks` 局部覆盖或 `searchParams` 外的 context 约定），拦截器识别后跳过 `showBanner`。实现取最简：在 client 暴露 `suppressBannerFor(request)` 约定（如自定义头 `X-Suppress-Banner: 1`，拦截器读取后不外发——ky `beforeRequest` 删除该头）。
- **验收:** 创建触发并发限流时只出现对话框内文案，无双重提示；其它 429 场景全局横幅行为不变。
- **回归测试:** `CreateDialog.test.tsx` 补 429 用例断言文案与无全局横幅。

## 任务 2.6 · F1–F4 核心测试缺口补齐 🟠

- **F1 `TerminalBridge`（265 行 0 测试，性价比最高）:**
  - 新增 `src/components/Terminal/__tests__/TerminalBridge.test.ts`，mock 最小 xterm 接口（`write`/`onData` 回调）。
  - 覆盖：单行提交、多行（Shift+Enter）、历史导航（含 `lines.length > 1` 守卫）、Tab 补全、`replaceInput`——A11 的多行 Tab 缺陷应先由测试暴露（红），修复放 Phase 3 任务 3.5（绿）；若顺手可在本任务一并修。
- **F2 `useConversation` REST 兜底路径:**
  - mock `wsStore` 状态为断开，断言消息经 REST 提交、`completeTurn` 被正确调用、错误时横幅。
- **F3 `api/client.ts` 拦截器:** 任务 0.3/2.4 已建 `client.test.ts`，本任务补齐 401 清 Key + `NoApiKeyError` 分支，达成拦截器全分支覆盖。
- **F4 `useApproval` 倒计时:** `vi.useFakeTimers` 推进 300s，断言超时自动关闭与 250s 警告态切换。
- **验收:** 上述测试全部并入 Dockerfile `test` 阶段执行且通过；`TerminalBridge` 语句覆盖 ≥ 80%。

**Phase 2 退出门:** 镜像内 vitest 全绿（新增 ≥ 4 个测试文件）；`session-ws-protocol` spec 修订归档；StrictMode 开启下 E2E 通过。

---

# Phase 3 — 性能与长尾清理（P3）

> 本阶段任务彼此独立，可穿插常规迭代消化；建议按「同文件就近合并提交」组织。

## 任务 3.1 · C1 产物下载流式化 🟠 Medium
- **位置:** `src/api/sessions.ts` L44–59
- **方案:** 已在任务 0.2 第 3 步落地（直链 `<a download>`）；本任务仅验证并删除遗留 blob 代码与相关 import。
- **验收:** 大文件下载浏览器直接落盘，无内存峰值；`downloadArtifact` 的 fetch→blob 路径不存在。

## 任务 3.2 · C2 流式渲染 `useDeferredValue` 🟢 Low
- **位置:** `src/components/Chat/AssistantStream.tsx` L15–19
- **方案:** `const deferredText = useDeferredValue(text)` 传 ReactMarkdown（依赖 D1 已恢复 StrictMode/并发特性基线）。若长文实测仍卡，再评估「streaming 期 `<pre>` 纯文本、完成后切 Markdown」，默认不做。
- **验收:** 长回复流式期间输入框打字无可感知卡顿（人工验证 + E2E 长文本场景不超时）。

## 任务 3.3 · C3 流式消息独立字段（记录备查，默认不做）
- **位置:** `src/store/conversationStore.ts` L83–106
- **方案:** 仅当出现数千条消息的真实场景再实施「流式中的最后一条助手消息拆独立字段」；本计划标记为 **won't-fix-now**，在 store 注释中留 TODO 引用报告 C3。

## 任务 3.4 · A6 REST 兜底同步 `lastTurnIndex` 🟢 Low
- **位置:** `src/hooks/useConversation.ts` L64–76
- **方案:** REST 提交成功回调补 `wsStore.getState().setLastTurnIndex(sid, turn.turn_index)`，消除对 `completeTurn` 去重的隐式依赖。
- **回归测试:** 并入 F2 测试文件断言。

## 任务 3.5 · A7 审批倒计时基准修正 + A11 多行 Tab 禁用 🟢 Low
- **A7 位置:** `src/hooks/useApproval.ts` L25–29、`src/store/conversationStore.ts`（`setPendingApproval`）
  - **方案:** `setPendingApproval` 写入时附 `receivedAt: Date.now()`；hook 的 deadline 改从帧数据算、`useRef` 持有，`requestId` 变更时显式重置。F4 测试同步更新。
- **A11 位置:** `src/components/Terminal/TerminalBridge.ts` L238–244
  - **方案:** `lines.length > 1` 时跳过 Tab 补全（与历史导航守卫一致）；F1 中预置的红测试转绿。

## 任务 3.6 · A9 会话删除级联清理 🟢 Low
- **位置:** `src/store/sessionStore.ts`（`removeSession` 调用点）、`src/store/conversationStore.ts` L235–240、`src/store/wsStore.ts` L37–50
- **方案:** 新增组合 action（或在 `removeSession` 调用点级联）：`removeSession(sid)` → `removeConversation(sid)` + `wsStore.clear(sid)`，消灭死代码与内存残留。
- **回归测试:** `stores.test.ts` 补级联断言。

## 任务 3.7 · A10 启动恢复批量化 + 404 即时剔除 🟢 Low
- **位置:** `src/App.tsx` L20
- **方案:** `Promise.allSettled` 改为每批 10 个串行推进的简单批处理；rejected 且 HTTP 404 的 ID 立即从 localStorage `sf.sessionIds` 剔除。
- **回归测试:** App 级测试 mock 25 个 ID，断言并发峰值 ≤ 10、404 ID 被清除。

## 任务 3.8 · B2 Terminal ANSI/OSC 过滤 🟢 Low
- **位置:** `src/components/Terminal/TerminalBridge.ts` L70
- **方案:** 新增 `sanitizeAnsi(text)`（放 `utils/sanitize.ts`）：剥离 OSC `\x1b][^\x07\x1b]*(\x07|\x1b\\)` 与危险 CSI 子集（清屏/光标定位/模式切换），保留 SGR 颜色 `\x1b\[[0-9;]*m`；`delta` 写入前过滤。
- **回归测试:** `sanitize.test.ts` 补：SGR 保留、OSC 剥离、伪造提示符序列剥离。

## 任务 3.9 · B4 收紧 CSP connect-src 🟢 Low
- **位置:** `nginx.conf.template`（三处 CSP 声明同步改）
- **方案:** `connect-src 'self' ws: wss:` → `connect-src 'self'`（现代浏览器 `'self'` 覆盖同源 ws/wss）。三处 location 同步，避免 add_header 继承陷阱。
- **回归测试:** `e2e/run-session-frontend-docker-tests.sh` 冒烟断言响应头；E2E 全量确认 WS 仍可连。

## 任务 3.10 · B5 Markdown 外链加固 🟢 Low
- **位置:** `src/components/Chat/AssistantStream.tsx`、`TodoPanel.tsx`
- **方案:** 共享自定义 `a` 组件（`src/components/Chat/MarkdownLink.tsx`）：`target="_blank" rel="noopener noreferrer"` + 外链图标；两处 `components={{ a: MarkdownLink }}` 注入。
- **回归测试:** 组件测试断言渲染出的 `<a>` 属性。

## 任务 3.11 · D3 slash 命令统一分发表 🟢 Low
- **位置:** `src/components/Chat/ChatView.tsx` L27–63、`src/components/Terminal/TerminalView.tsx` L26–52、`src/components/Layout/Sidebar.tsx`
- **方案:** 提取 `src/utils/slashCommands.ts`：`command → handler` 分发表 + 视图注入差异项（`/clear` 宿主行为）；`/help` 两模式行为一致；`/close` 统一走任务 1.2 的 `useCloseSession`。`SLASH_COMMANDS` 常量与分发表同源生成，防止补全候选与实现漂移。
- **回归测试:** 新增 `slashCommands.test.ts` 全命令分发断言；E2E Terminal 模式 `/help` 不再发给 Agent。

## 任务 3.12 · D4 输入历史单一数据源 🟢 Low
- **位置:** `src/components/Terminal/TerminalBridge.ts` L39/L49/L182/L191
- **方案:** bridge 构造参数改为 getter 回调 `getHistory: () => string[]` + 提交回调统一走 `pushInputHistory`；删除 bridge 内部 `history` 数组。F1 测试同步调整。
- **验收:** Chat 模式提交的历史在 Terminal 模式 ↑ 可见（无需重建 bridge），符合规格「共享输入历史」。

## 任务 3.13 · D5 `useFocusTrap` 提取复用 🟢 Low
- **位置:** `src/components/Approval/ApprovalModal.tsx`（提取源）、`src/components/Session/CreateDialog.tsx` L90–102、`src/components/Settings/SettingsPanel.tsx`、任务 1.2 的 `ConfirmDialog`
- **方案:** 提取 `src/hooks/useFocusTrap.ts`（focus trap + 初始焦点 + 焦点归还 + Escape 回调），四处对话框统一接入；ApprovalModal 行为不变（既有 12 用例即回归保障）。
- **回归测试:** `ApprovalModal.test.tsx` 全绿；`CreateDialog.test.tsx` 补 Tab 循环断言。

## 任务 3.14 · D6 store 访问风格统一 🟢 Low
- **位置:** `src/ws/useWebSocket.ts` L89–91 及各分发点
- **方案:** 删除 effect 顶部 `conv/wsState/sessions` 快照，统一「`useXxxStore.getState()` 现取现用」；纯重构，行为不变。
- **回归测试:** 既有 `useWebSocket.test.ts`（含 Phase 2 新增用例）全绿即可。

## 任务 3.15 · F5/F6 剩余测试缺口 🟢
- **F5 `InputBar` 历史导航与 slash 补全:** 键盘状态机分支测试（↑/↓ 边界、补全选中、Escape 取消），依赖任务 3.11 完成后编写（分发表可 mock）。
- **F6 `WebSocketClient` 心跳判死:** fake timers 推进 3×30s 无 pong，断言主动断开重连；4429 路径已由任务 1.3 覆盖。

**Phase 3 退出门:** 全部问题项闭环（C3 标记 won't-fix-now 除外）；镜像内 lint + vitest 全绿；E2E 通过；报告中 §8 六个缺口全部有对应测试文件。

---

## 后端配合项汇总（需 session-service 变更）

| 任务 | 后端改动 | 建议合并方式 |
| --- | --- | --- |
| 0.1 A1 | `turn_complete` 帧 + `TurnResponse` 增加 `has_artifact` | openspec 变更 `fix-artifact-delivery-chain`，一次后端发版 |
| 0.2 A2 | artifact GET 支持 `?api_key=` | 同上 |
| 0.3 E1 | （可选）403 错误体加 `code` 区分配额/权限 | 同上（可选项） |
| 2.1 A4 | `turn_error` 帧增加 `code: "approval_timeout"` | 若排期允许并入 Phase 0 后端变更，避免二次发版 |

## 质量门与验证方式（每阶段必跑）

```bash
# 单测 + lint（镜像内，禁止宿主机 vitest）
docker build --target test session-frontend/

# E2E（基于已有 oh-e2e-test 镜像叠加）
e2e/run-session-frontend-docker-tests.sh

# 后端配合项回归（Phase 0 / 2）
docker compose run --rm --entrypoint bash openharness \
  -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"
```

## 里程碑

| 里程碑 | 内容 | 依赖 |
| --- | --- | --- |
| M1 | Phase 0 完成：产物链路端到端可用 | 后端发版（has_artifact + api_key 查询参数） |
| M2 | Phase 1 完成：正确性/防误触问题清零 | 无外部依赖 |
| M3 | Phase 2 完成：协议结构化 + StrictMode + 核心补测 | A4 后端 code 字段（可与 M1 合并发版） |
| M4 | Phase 3 完成：长尾清零，报告全部问题闭环 | 无外部依赖 |
