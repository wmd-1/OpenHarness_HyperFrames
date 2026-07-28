# Session Auth Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-service-frontend` (2026-07-27)

API Key 认证与输入安全：localStorage 存储与脱敏、extra_oh_args 白名单校验、XSS 防护、认证状态机（未认证/失效/成功）。

---

## Requirements

### Requirement: API Key 存储与管理
系统 SHALL 将 API Key 存储在 localStorage 中，支持设置、清除和脱敏显示。

#### Scenario: 首次配置 API Key
- **WHEN** 用户首次打开应用且 localStorage 中无 API Key
- **THEN** 显示欢迎界面，包含 API Key 输入框和连接按钮

#### Scenario: API Key 脱敏显示
- **WHEN** 用户已配置 API Key 并查看设置面板
- **THEN** API Key 显示为 `sk-****xxxx` 格式（仅首尾各 2 字符可见）

#### Scenario: 清除 API Key
- **WHEN** 用户在设置面板点击"清除 API Key"
- **THEN** 系统从 localStorage 移除 API Key，断开所有 WebSocket 连接，返回欢迎界面

### Requirement: 输入参数白名单校验
系统 SHALL 在前端对 `extra_oh_args` 进行白名单校验，仅允许 6 个已知安全参数：`--temperature`、`--max-turns`、`--model`、`--no-cache`、`--verbose`、`--effort`。

#### Scenario: 允许的参数
- **WHEN** 用户输入 `--model qwen-max`
- **THEN** 参数通过前端校验，包含在创建请求中

#### Scenario: 拒绝的参数
- **WHEN** 用户输入 `--permission-mode full_auto`
- **THEN** 前端拒绝提交，显示错误"该参数不允许手动设置"

#### Scenario: Shell 元字符检测
- **WHEN** 用户输入包含 `; | & $ \` ( ) { } < >` 等 shell 元字符
- **THEN** 前端拒绝提交，显示错误"参数值包含非法字符"

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

### Requirement: 认证状态管理
系统 SHALL 根据认证状态控制应用的可访问范围。

#### Scenario: 未认证状态
- **WHEN** 无 API Key 配置
- **THEN** 仅显示 API Key 输入界面，不可访问会话功能

#### Scenario: 认证失效
- **WHEN** 收到 401 响应
- **THEN** 系统清除 API Key，中断所有进行中的请求，弹出重新认证对话框

#### Scenario: 认证成功
- **WHEN** 用户输入有效 API Key 且健康检查通过
- **THEN** 系统保存 API Key，进入主应用界面
