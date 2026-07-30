# Session REST API Client Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-service-frontend` (2026-07-27)

前端对 session-service REST 接口的调用契约：会话创建/查询/关闭、REST 兜底对话提交、产物下载、API Key 自动注入与统一错误拦截。

---

## Requirements

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
系统 SHALL 通过 `DELETE /v1/sessions/{sid}` 关闭会话。关闭为不可逆操作（后端清理 workspace 与产物），所有关闭入口（侧栏按钮、`/close` 命令）SHALL 弹出确认对话框，用户确认后才发起请求。关闭采用乐观更新（本地先置 `closed`），请求失败时 SHALL 回滚本地状态到关闭前并显示错误提示，不允许静默吞掉失败。

#### Scenario: 关闭活跃会话
- **WHEN** 用户点击关闭会话按钮并在确认对话框中确认
- **THEN** 系统发送 DELETE 请求，关闭 WebSocket 连接，更新会话状态为 closed

#### Scenario: 确认对话框内取消
- **WHEN** 用户点击关闭会话按钮后在确认对话框中取消
- **THEN** 不发送 DELETE 请求，会话状态与连接保持不变

#### Scenario: 关闭失败回滚
- **WHEN** DELETE 请求失败（网络错误或后端 5xx）
- **THEN** 系统将本地会话状态回滚到关闭前的状态，并显示"关闭会话失败，请重试"错误提示

### Requirement: REST 兜底对话提交
系统 SHALL 在 WebSocket 不可用时，通过 `POST /v1/sessions/{sid}/turns` 提交对话（阻塞式）。响应 `TurnResponse` SHALL 包含 `has_artifact: bool` 字段，前端 SHALL 将其透传到轮次消息状态（与 WS 路径的 `turn_complete.has_artifact` 行为一致），并在提交成功后同步更新本地 `last_turn_index`，保证后续 WS 重连的补发基准正确。

#### Scenario: WebSocket 不可用时降级
- **WHEN** WebSocket 连接断开且用户在输入栏发送消息
- **THEN** 系统通过 REST API 提交对话轮次，显示加载状态直到响应返回

#### Scenario: REST 提交后的产物标记与补发基准
- **WHEN** REST 提交成功且响应 `TurnResponse.has_artifact` 为 `true`、`turn_index` 为 N
- **THEN** 该轮次助手消息标记 `hasArtifact = true`（渲染产物预览/下载入口），且本地 `last_turn_index` 更新为 N，后续 WS 重连不重复补发该轮次

### Requirement: 产物下载
系统 SHALL 通过 `GET /v1/sessions/{sid}/turns/{idx}/artifact` 下载产物文件。该端点 SHALL 在 `X-API-Key` 请求头之外额外接受 `?api_key=` 查询参数认证（仅限该路径，复用 WebSocket 握手的同一校验逻辑；其余 REST 路径保持仅 Header 认证），使 `<video>` 内嵌播放与 `<a download>` 直链下载可在启用认证的部署下工作。下载 SHALL 使用直链方式交由浏览器流式落盘，不允许将产物全量读入内存（blob）后再触发下载。含 `api_key` 查询参数的请求 SHALL 不落入访问日志明文（nginx `/v1` 已 `access_log off`，后端访问日志不记录或脱敏查询串）。

#### Scenario: 认证部署下内嵌播放视频产物
- **WHEN** 轮次消息标记有产物且部署启用 `require_auth`
- **THEN** `<video>` 元素以携带 `?api_key=` 的产物流 URL 为 src，请求返回 200/206，视频可播放

#### Scenario: 下载视频产物
- **WHEN** 用户点击下载按钮
- **THEN** 系统通过携带 `?api_key=` 的直链 `<a download>` 触发浏览器下载，处理 S3 302 重定向，浏览器流式写盘（无全量内存缓冲）

#### Scenario: 分段下载
- **WHEN** 用户拖动视频进度条到未缓冲位置
- **THEN** 系统发送 Range 请求获取对应数据段

#### Scenario: 查询参数认证仅限产物路径
- **WHEN** 非产物 REST 路径（如 `GET /v1/sessions/{sid}`）仅携带 `?api_key=` 查询参数而无 `X-API-Key` 头
- **THEN** 后端返回 401，查询参数认证不对其它 REST 路径生效

#### Scenario: 产物路径非法 Key 被拒绝
- **WHEN** 产物 GET 请求携带非法的 `?api_key=` 值
- **THEN** 后端返回 401，不返回产物内容

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

### Requirement: Workspace 文件下载 MUST 支持查询参数鉴权
系统 SHALL 允许 `GET /v1/sessions/{sid}/workspace/files/{path}` 通过 `?api_key=` 查询参数鉴权（与 turn artifact 下载同等待遇），因为 `<a download>` 导航无法携带 `X-API-Key` 请求头。该豁免 SHALL 仅限 GET 方法与该下载路径，其余 REST 端点 SHALL 保持仅接受请求头鉴权。（服务端约束，Established by change: `fix-session-review-2026-07`）

#### Scenario: 有效 key 经查询参数下载 workspace 文件
- **WHEN** 启用鉴权且客户端请求 `GET /v1/sessions/{sid}/workspace/files/output/a.txt?api_key=<有效key>`
- **THEN** 中间件解析出对应租户并放行，返回 200 或 302（presigned 重定向）

#### Scenario: 无效 key 经查询参数下载被拒
- **WHEN** 启用鉴权且客户端以缺失或无效的 `?api_key=` 请求 workspace 文件下载
- **THEN** 返回 401

#### Scenario: 查询参数鉴权不外溢到其它端点
- **WHEN** 客户端对非下载端点（如列表 `GET .../workspace/files` 或任意 `POST`）携带 `?api_key=`
- **THEN** 中间件忽略查询参数，仅按 `X-API-Key` 请求头鉴权（无有效头则 401）

### Requirement: CORS 响应头 MUST 按需收窄
当配置了跨域来源时，系统 SHALL 仅允许实际使用的方法与请求头，SHALL NOT 使用通配 `*` 的方法/头集合（在 `allow_credentials` 生效场景下尤其如此）。（服务端约束，Established by change: `fix-session-review-2026-07`）

#### Scenario: 允许的方法与头
- **WHEN** 浏览器对已配置来源发起预检（OPTIONS）
- **THEN** 响应仅通告实际使用的方法（GET/POST/DELETE/OPTIONS）与请求头（X-API-Key、Content-Type）

### Requirement: 健康探针依赖探测 MUST 限频
系统 SHALL 对 `/healthz`、`/readyz` 的 DB/Redis 探测结果做短 TTL 缓存，避免高频探针对依赖造成放大负载；`/healthz` SHALL 保持存活语义（进程在线即 200），依赖降级信息在响应体中体现。（服务端约束，Established by change: `fix-session-review-2026-07`）

#### Scenario: 探测结果在 TTL 内复用
- **WHEN** 在缓存 TTL 窗口内连续多次调用 `/healthz`
- **THEN** 仅首次实际探测 DB/Redis，后续复用缓存结果，且响应始终 200
