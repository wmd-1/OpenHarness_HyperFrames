# Proposal: Session 前端硬化与产物链路打通（harden-session-frontend）

**Change ID:** `harden-session-frontend`
**Created:** 2026-07-28
**Status:** Draft
**Capabilities:** `session-ws-protocol` / `session-rest-api` / `session-auth` / `session-terminal-mode`（均为既有基线，MODIFY + ADD）
**Repos touched:** `session-frontend/`（主）、`session-service/`（协议配合项）
**Sources:** `session-frontend/CODE_REVIEW_REPORT.md`（2026-07-28 审查，27 项问题）、`plans/Session_Frontend_Fix_Plan_2026-07-28.md`（Phase 0–3 修复计划）

---

## Why

`session-service-frontend`（2026-07-27）交付了 Session Console MVP 并建立 7 份 `session-*` 规格基线。随后的全面代码审查（前后端契约交叉核对）发现：基线在**产物链路**、**协议健壮性**与**输入正确性**上存在缺口，其中两项 🔴 High 联动，等于砍掉一个规格能力：

- **A1（🔴）**：`hasArtifact` 永远为 `false`——后端 `turn_complete` 帧与 `TurnResponse` 均无产物标记，前端 `completeTurn` 调用点均不传该字段，`VideoPlayer`/`DownloadButton` 及 3 个 artifact API 函数是运行时死代码；spec session-chat-mode 的「视频产物预览下载」能力实际未打通。
- **A2（🔴）**：`<video src>` 无法携带 `X-API-Key` 头，而后端 REST 中间件仅接受 Header 认证——A1 修复后视频流在启用认证部署下必然 401。
- **A3（🟠）**：4429 限流分支无限重连，与规格「等待 60s 后尝试**一次**重连」及代码注释均矛盾，服务端持续限流时形成重连风暴。
- **A4（🟠）**：审批超时靠 `message.includes('审批')` 字符串匹配关闭弹窗，协议语义耦合在自然语言文案上，后端改文案即失效。
- **B1（🟠）**：spec session-auth 要求的「剥离 HTML 标签」会把用户输入中的 `Vec<T>`、`List<string>` 等技术文本静默删改后才发给 Agent，而 XSS 防线已由 React 渲染转义 + react-markdown 默认不渲染 HTML + nginx CSP 三层闭环——该条款与 Chat 产品语义冲突，防护收益为零、正确性受损，应修订规格。
- **A5/E1/E2（🟠/🟡）**：关闭会话（不可逆，清 workspace）虽然规格要求确认但实现单击即关、失败不回滚；403 配额横幅与 429 Retry-After 等规格既有要求未实现。
- **B2/B4（🟡）**：Terminal 模式对服务端文本未过滤 OSC/危险 CSI 控制序列（UI 欺骗面）；CSP `connect-src` 放行任意 `ws:`/`wss:` 目标（XSS 成立时的数据外带通道）。

本变更把修复沉淀为规格：**MODIFY** 四份既有规格中涉及协议契约与安全语义的条款，其余实现级修复（StrictMode、GFM 渲染、焦点圈定、测试补齐等）作为 tasks 落地，不改规格。

## What Changes

- **MODIFY `session-ws-protocol` — turn_complete 帧**：新增 `has_artifact: bool` 字段（后端 supervisor 产出、前端透传 `completeTurn`），打通产物预览/下载链路（A1）。**后端配合项**。
- **MODIFY `session-ws-protocol` — turn_error 帧**：新增结构化 `code` 字段（首个取值 `approval_timeout`），前端按 code 分发关闭审批弹窗，过渡期保留文案匹配回退（A4）。**后端配合项**。
- **MODIFY `session-ws-protocol` — 4429 限流处理**：限流重试次数有界（等待 60s、最多 2 次），超限转 failed 态交手动重试，纳入独立计数（A3）。
- **MODIFY `session-rest-api` — 产物下载**：artifact GET 接受 `?api_key=` 查询参数认证（与 WS 握手一致，仅限该路径；nginx `/v1` `access_log off` 已就位），`<video>` 内嵌播放与 `<a download>` 直链流式下载可用（A2，顺带消除 C1 全量 blob 内存峰值）。**后端配合项**。
- **MODIFY `session-rest-api` — REST 兜底对话提交**：`TurnResponse` 新增 `has_artifact` 字段，REST 路径与 WS 路径产物标记行为一致；提交成功同步 `last_turn_index`（A1/A6）。**后端配合项**。
- **MODIFY `session-rest-api` — 会话关闭**：明确确认对话框为规格要求；新增「关闭失败回滚乐观更新并提示」场景（A5）。
- **MODIFY `session-auth` — XSS 防护**：删除「剥离 HTML 标签」条款，用户输入仅剥离控制字符；防护判据改为「渲染层转义（React JSX + react-markdown 默认行为）+ nginx CSP」；CSP `connect-src` 收紧为 `'self'`（B1/B4）。
- **ADD `session-terminal-mode` — 终端输出控制序列过滤**：服务端文本写入 xterm 前剥离 OSC 与危险 CSI 子集，保留 SGR 颜色序列（B2）。
- **实现级修复（不改规格，随 tasks 交付）**：403 配额全局 fatal 横幅、429 拼入 Retry-After、并发超限专属文案（E1/E2/E3，规格既有要求）；恢复 StrictMode（D1）；幽灵依赖显式声明（D2）；remark-gfm 渲染（A8）；审批倒计时基准、会话删除级联清理、启动恢复批量化、多行 Tab 守卫（A7/A9/A10/A11）；Markdown 外链加固（B5）；slash 命令统一分发表、输入历史单一数据源、`useFocusTrap` 复用、store 访问风格统一（D3–D6）；`useDeferredValue` 流式渲染（C2）；测试缺口补齐（F1–F6）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `session-ws-protocol`：`turn_complete` 帧新增 `has_artifact`；`turn_error` 帧新增结构化 `code`；4429 限流重试改为有界（60s × 最多 2 次 → failed）。
- `session-rest-api`：产物下载认证方式扩展（artifact GET 支持 `?api_key=`，直链播放/下载）；REST 兜底提交响应新增 `has_artifact` 并同步 `last_turn_index`；会话关闭补「失败回滚」场景。
- `session-auth`：XSS 防护条款修订——移除破坏性 HTML 标签剥离，改为「控制字符剥离 + 渲染层转义 + CSP」，`connect-src` 收紧为 `'self'`。
- `session-terminal-mode`：新增「终端输出控制序列过滤」要求（OSC/危险 CSI 剥离、SGR 保留）。

## Impact

| Component | Change Required | Details |
|---|---|---|
| `session-service/app/session/supervisor.py`、`app/schemas.py` | Yes | `turn_complete` 帧 + `TurnResponse` 增加 `has_artifact`；`turn_error` 帧增加 `code` |
| `session-service/app/main.py`（认证中间件） | Yes | artifact GET 路径额外接受 `?api_key=`（复用 WS 校验逻辑，其余 REST 仅 Header 不变） |
| `session-frontend/src/ws/**`（Client/protocol/useWebSocket/types） | Yes | `has_artifact`/`code` 透传、4429 有界重试、`turn_error` 结构化分发 |
| `session-frontend/src/api/**`（client/sessions） | Yes | 403 横幅、429 Retry-After、artifact 直链 URL、blob 下载移除 |
| `session-frontend/src/store/**`、`hooks/**` | Yes | `useCloseSession`（确认+回滚）、审批倒计时基准、删除级联清理、REST 兜底 lastTurnIndex |
| `session-frontend/src/components/**` | Yes | VideoPlayer 直链、ConfirmDialog、GFM、MarkdownLink、slash 分发表、useFocusTrap |
| `session-frontend/src/utils/sanitize.ts` | Yes | 删除 `stripHtmlTags`、新增 `sanitizeAnsi` |
| `session-frontend/nginx.conf.template` | Yes | 三处 CSP `connect-src` 收紧为 `'self'` |
| `session-frontend/src/main.tsx`、`package.json`、`eslint.config.js` | Yes | 恢复 StrictMode；`remark-gfm`、`@eslint/js`、`globals` 显式声明 |
| 单测 / E2E | Yes | 新增 `TerminalBridge`/`client` 拦截器/REST 兜底/审批倒计时等测试；`e2e/mock-backend.mjs` 补 `has_artifact` 帧；全部在 Docker 镜像内执行 |
| 向后兼容性 | — | `has_artifact`/`code` 均为可选字段，旧前端忽略新字段、新前端对缺失字段有回退；artifact 查询参数认证为**新增**方式，Header 认证不变，无 BREAKING |
