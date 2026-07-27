## ADDED Requirements

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
系统 SHALL 对所有用户输入和助手回复进行 XSS 防护处理。

#### Scenario: Markdown 渲染防 XSS
- **WHEN** 助手回复包含 HTML 标签（如 `<script>alert(1)</script>`）
- **THEN** react-markdown 默认转义 HTML 标签，不执行脚本

#### Scenario: 用户输入清理
- **WHEN** 用户输入包含控制字符或 HTML 标签
- **THEN** 前端在发送前剥离控制字符和 HTML 标签

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
