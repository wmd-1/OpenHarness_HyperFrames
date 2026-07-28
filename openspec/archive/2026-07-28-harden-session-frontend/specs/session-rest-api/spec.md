# Spec Delta: session-rest-api (harden-session-frontend)

**Baseline:** `openspec/specs/session-rest-api.md`（由 `session-service-frontend` 建立，2026-07-27）
**Change ID:** `harden-session-frontend`
**Affects:** `session-frontend/src/api/**`、`session-frontend/src/hooks/useConversation.ts`、`session-frontend/src/components/Artifact/**`、`session-service/app/main.py`（认证中间件）、`session-service/app/schemas.py`

> 本 delta 扩展产物下载认证方式（artifact GET 支持 `?api_key=` 直链，A2/C1）、为 REST 兜底提交补 `has_artifact` 与 `last_turn_index` 同步（A1/A6）、为会话关闭补失败回滚场景（A5）。来源：`session-frontend/CODE_REVIEW_REPORT.md`、`plans/Session_Frontend_Fix_Plan_2026-07-28.md`。其余要求（会话创建、会话查询、API Key 自动注入、统一错误拦截）不变。

---

## MODIFIED Requirements

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
