## ADDED Requirements

### Requirement: 会话创建
系统 SHALL 通过 `POST /v1/sessions` 创建新会话，支持选择权限策略和额外参数。

#### Scenario: 创建 full_auto 会话
- **WHEN** 用户在创建对话框中选择 `full_auto` 策略并点击创建
- **THEN** 系统发送 `POST /v1/sessions` 请求，成功后（201）将会话加入列表并自动选中

#### Scenario: 创建 interactive 会话
- **WHEN** 用户选择 `interactive` 策略并创建
- **THEN** 系统创建会话并建立 WebSocket 连接，后续对话中显示审批弹窗

#### Scenario: 创建带额外参数的会话
- **WHEN** 用户在高级选项中填写 `--model qwen-max` 和 `--temperature 0.7`
- **THEN** 请求体包含 `extra_oh_args: ["--model", "qwen-max", "--temperature", "0.7"]`

#### Scenario: 创建失败 - 配额超限
- **WHEN** 后端返回 403（每日配额超限）
- **THEN** 系统显示全局横幅"今日会话配额已用完，请明天再试"

#### Scenario: 创建失败 - 并发超限
- **WHEN** 后端返回 429（并发配额超限）
- **THEN** 系统显示提示"并发会话数已达上限（最多 8 个），请关闭部分会话后重试"

### Requirement: 会话查询
系统 SHALL 通过 `GET /v1/sessions/{sid}` 查询会话详情，包括状态、轮次数、创建时间等。

#### Scenario: 查询活跃会话
- **WHEN** 用户选中一个会话
- **THEN** 系统查询会话详情并更新侧栏卡片和详情头信息

#### Scenario: 查询不存在的会话
- **WHEN** 后端返回 404
- **THEN** 系统从本地缓存移除该会话 ID，显示错误提示

### Requirement: 会话关闭
系统 SHALL 通过 `DELETE /v1/sessions/{sid}` 关闭会话。

#### Scenario: 关闭活跃会话
- **WHEN** 用户点击关闭会话按钮并确认
- **THEN** 系统发送 DELETE 请求，关闭 WebSocket 连接，更新会话状态为 closed

### Requirement: REST 兜底对话提交
系统 SHALL 在 WebSocket 不可用时，通过 `POST /v1/sessions/{sid}/turns` 提交对话（阻塞式）。

#### Scenario: WebSocket 不可用时降级
- **WHEN** WebSocket 连接断开且用户在输入栏发送消息
- **THEN** 系统通过 REST API 提交对话轮次，显示加载状态直到响应返回

### Requirement: 产物下载
系统 SHALL 通过 `GET /v1/sessions/{sid}/turns/{idx}/artifact` 下载产物文件。

#### Scenario: 下载视频产物
- **WHEN** 用户点击下载按钮
- **THEN** 系统请求产物 API，处理 S3 302 重定向，触发浏览器文件下载

#### Scenario: 分段下载
- **WHEN** 用户拖动视频进度条到未缓冲位置
- **THEN** 系统发送 Range 请求获取对应数据段

### Requirement: API Key 自动注入
系统 SHALL 在每个 REST 请求中自动注入 `X-API-Key` 请求头。

#### Scenario: 已配置 API Key 时注入
- **WHEN** localStorage 中存在 API Key
- **THEN** 每个请求自动携带 `X-API-Key` 头

#### Scenario: 未配置 API Key 时拦截
- **WHEN** localStorage 中无 API Key
- **THEN** 请求不发送，弹出 API Key 输入对话框

### Requirement: 统一错误拦截
系统 SHALL 对 REST 响应进行统一错误拦截处理。

#### Scenario: 401 响应
- **WHEN** 任何 REST 请求返回 401
- **THEN** 系统清除本地 API Key，弹出重新认证对话框

#### Scenario: 429 响应
- **WHEN** 任何 REST 请求返回 429
- **THEN** 系统显示限流横幅提示，包含重试等待时间

#### Scenario: 503 响应
- **WHEN** 任何 REST 请求返回 503
- **THEN** 系统显示全屏错误页"服务暂不可用，节点容量已满"
