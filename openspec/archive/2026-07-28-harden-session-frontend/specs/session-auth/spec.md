# Spec Delta: session-auth (harden-session-frontend)

**Baseline:** `openspec/specs/session-auth.md`（由 `session-service-frontend` 建立，2026-07-27）
**Change ID:** `harden-session-frontend`
**Affects:** `session-frontend/src/utils/sanitize.ts`、`session-frontend/src/hooks/useConversation.ts`、`session-frontend/nginx.conf.template`

> 本 delta 修订 XSS 防护条款：移除破坏合法用户输入的「剥离 HTML 标签」要求（B1，`Vec<T>` 等技术文本被静默删改而防护收益为零），防护判据收敛为「渲染层转义 + CSP」，并将 CSP `connect-src` 收紧为 `'self'`（B4）。来源：`session-frontend/CODE_REVIEW_REPORT.md`、`plans/Session_Frontend_Fix_Plan_2026-07-28.md`。其余要求（API Key 存储与管理、输入参数白名单校验、认证状态管理）不变。

---

## MODIFIED Requirements

### Requirement: XSS 防护
系统 SHALL 通过渲染层转义与内容安全策略实现 XSS 防护：用户消息经 React JSX 渲染（自动转义），助手消息经 react-markdown 渲染（默认不渲染内联 HTML，默认 urlTransform 过滤 `javascript:` 等危险协议），nginx SHALL 下发 `Content-Security-Policy` 且 `script-src 'self'`、`connect-src 'self'`（不放行任意 `ws:`/`wss:` 目标）。用户输入在发送前 SHALL 仅剥离控制字符，SHALL NOT 剥离或改写 HTML 标签形态的普通文本（如 `Vec<T>`、`<div>` 字面内容），保证提交给 Agent 的语义完整。

#### Scenario: Markdown 渲染防 XSS
- **WHEN** 助手回复包含 HTML 标签（如 `<script>alert(1)</script>`）
- **THEN** react-markdown 默认转义 HTML 标签，不执行脚本

#### Scenario: 用户输入仅剥离控制字符
- **WHEN** 用户输入包含控制字符（如 `\x00`、`\x1b`）
- **THEN** 前端在发送前剥离控制字符，其余内容原样保留

#### Scenario: 技术文本原样保留
- **WHEN** 用户输入包含 `Vec<T>`、`List<string>` 或 `a < b > c` 等含尖括号的技术文本
- **THEN** 前端不删改任何字符，消息按原文提交给后端并在气泡中原样显示（经 JSX 转义安全渲染）

#### Scenario: CSP 限制连接目标
- **WHEN** 页面脚本尝试向非同源主机建立 WebSocket 或 fetch 连接
- **THEN** 浏览器按 `connect-src 'self'` 阻断该连接；同源 REST 与 WS（ws/wss 同源）不受影响
