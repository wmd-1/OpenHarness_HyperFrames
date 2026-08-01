# Delta: web-front-end（Phase 3）

> Phase 3 = P2 API Key 入口挂载 + 真实链路测试；P3 批量刷新去 rAF。均为新增关注点，以 ADDED 形式补充（不改动 WF5–WF8 既有文本）。

## ADDED Requirements

### Requirement: WF9 — API Key 管理入口与鉴权链路

前端 SHALL 在主界面（sidebar，Composer 之上）挂载 API Key 管理入口（`ApiKeyInput` 组件）：用户可输入并保存 API Key 至浏览器本机存储（`oh_api_key`）、查看已配置状态、一键清除。保存后的 key SHALL 被所有后端请求自动携带——`fetch` 请求经 `X-API-Key` 头，`EventSource`（SSE `/events`）与 `/file` 链接经 `?api_key=` 查询参数回退。清除后 SHALL 立即停止携带（后续请求无 `X-API-Key` 头、无 `api_key` 参数）。该链路（输入 → 本机存储 → 请求头/查询参数 → 清除）SHALL 有自动化测试覆盖，且主界面存在该入口本身 SHALL 有断言防止再次静默丢失。

#### Scenario: 入口在主界面可用
- **WHEN** 用户打开 SPA
- **THEN** sidebar 中可见 API Key 输入区（label `API Key（X-API-Key）`），可输入、保存、清除

#### Scenario: 保存的 key 注入请求头
- **WHEN** 用户在输入框保存 key 后提交一个生成任务
- **THEN** `POST /v1/videos` 请求携带 `X-API-Key: <key>` 头，且 key 已持久化在本机存储

#### Scenario: SSE 订阅携带查询参数回退
- **WHEN** 已保存 key 的用户打开某任务的进度流
- **THEN** `EventSource` 的订阅 URL 携带 `api_key=<key>` 查询参数

#### Scenario: 清除后不再携带凭据
- **WHEN** 用户点击「清除」
- **THEN** 本机存储中的 key 被删除，后续请求不含 `X-API-Key` 头与 `api_key` 参数

### Requirement: WF10 — 状态批量刷新调度不得依赖页面可见性

前端任务状态的批量刷新调度 SHALL 使用在后台标签页仍会触发的调度原语（trailing `setTimeout`，约 32ms 合并窗口），SHALL NOT 依赖 `requestAnimationFrame` 等仅在页面可见时触发的原语——页面隐藏时状态提交允许被浏览器节流延迟（≥1s），但不得无限期推迟。合并窗口内的多次更新 SHALL 经 pending 缓冲合并为单次 state 提交（防 setState 交错竞态）；组件卸载时 SHALL 清理未决的调度句柄。

#### Scenario: 后台标签页状态不冻结
- **WHEN** 页面处于隐藏状态（后台标签页）期间任务状态经 SSE/轮询发生变化
- **THEN** UI state 仍在有限时间内（受浏览器 timer 节流约束，秒级）完成提交，切回前台时展示的即为最新状态，无需额外补刷

#### Scenario: 合并窗口内多次更新只提交一次
- **WHEN** 32ms 合并窗口内连续到达多次任务更新
- **THEN** 仅发生一次 state 提交，内容为全部更新合并后的终态

#### Scenario: 卸载后无悬挂调度
- **WHEN** 状态 Provider 卸载后调度窗口到期
- **THEN** 不产生对已卸载组件的 setState（无 React 告警）
