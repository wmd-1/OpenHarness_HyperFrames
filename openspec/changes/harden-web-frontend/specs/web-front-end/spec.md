# Spec Delta: web-front-end (harden-web-frontend)

**Baseline:** `openspec/specs/web-front-end.md`（WF1–WF5，由 `establish-web-frontend` 建立）
**Change ID:** `harden-web-frontend`
**Affects:** `web/src/**`, `web/nginx.conf.template`, `web/package.json`, `web/.gitignore`, `web/README.md`, `web/src/__tests__/**`

> 本 delta 修正任务生命周期 UI 的取消语义与健壮性缺口（MODIFY WF5），并新增前端安全加固（WF6）、任务流健壮性与持久化（WF7）、质量门与测试基线（WF8）。来源：`web/CODE_REVIEW_REPORT.md`、`plans/Web_Frontend_Fix_Plan_2026-07-23.md`。WF1–WF4 不变。

---

## MODIFIED Requirements

### Requirement: WF5 — 任务生命周期 UI（基线 MVP）

前端 SHALL 提供任务生命周期交互基线：提交 prompt（含超时、可选幂等键）→ 通过 SSE 接收进度日志 → 周期轮询任务状态 → 终态处理（`succeeded` 播放视频 / `failed` 显示错误 / `canceled` 提示）。**取消**与**删除**为两个独立动作：非终态任务提供「取消」，终态任务提供「删除」。取消 SHALL 停止该任务的 SSE/轮询流并把任务标记为 `canceled` 且**保留在任务列表**中；删除 SHALL 仅对终态任务生效，将其从列表移除。提交表单 SHALL 校验超时输入（非法/空值回退到默认值且不小于 1 秒），空 prompt SHALL 被拦截。全局提交错误 SHALL 只在界面的单一位置展示。交互控件（可点击任务项、错误横幅关闭）SHALL 键盘可达，表单 `<label>` SHALL 与其输入控件关联。

#### Scenario: 提交到播放闭环
- **Given** 用户输入非空 prompt 并提交
- **When** 后端返回 `task_id` 且任务最终 `succeeded`
- **Then** 前端展示进度日志、状态徽标，并渲染 `<video>` 播放器（src 取自 `file` 链接）

#### Scenario: 失败态展示错误
- **Given** 任务最终 `failed`
- **When** 轮询拿到终态
- **Then** 前端停止 SSE/轮询并展示 `error` 字段

#### Scenario: 空 prompt 被拦截
- **Given** prompt 为空
- **When** 点击「生成视频」
- **Then** 不发起请求，展示「请输入 prompt」提示

#### Scenario: 取消运行中任务保留任务并置为 canceled
- **Given** 一个非终态（`queued`/`running`）任务处于活动状态
- **When** 用户点击「取消任务」
- **Then** 前端调用取消接口、停止该任务的 SSE/轮询，并把任务状态更新为 `canceled`，任务**仍保留在任务列表**中可被查看

#### Scenario: 删除仅对终态任务生效
- **Given** 一个终态（`succeeded`/`failed`/`canceled`）任务
- **When** 用户点击「删除任务」
- **Then** 前端调用删除接口并将该任务从列表移除

#### Scenario: 超时输入非法时回退默认值
- **Given** 用户清空或输入非数字的超时值
- **When** 提交任务
- **Then** 前端使用不小于 1 秒的默认超时，不会向后端提交 `0` 或 `NaN`

#### Scenario: 键盘可操作与标签关联
- **Given** 仅使用键盘的用户
- **When** 通过 Tab/Enter/Space 在任务列表项与错误横幅关闭控件间操作
- **Then** 可选择任务、可关闭错误横幅；屏幕阅读器能将每个 `<label>` 关联到对应输入控件

---

## ADDED Requirements

### Requirement: WF6 — 前端安全加固

前端交付物 SHALL 降低凭据泄漏与常见 Web 攻击面：nginx `server` 块 SHALL 对所有响应下发安全头 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`（或等效 `frame-ancestors 'none'`）、`Referrer-Policy: no-referrer`，以及一个允许 SPA 正常运行的 `Content-Security-Policy`（至少 `default-src 'self'`，并放行 `<video>` 媒体与同源 `EventSource`/`fetch`）。当鉴权 API Key 经 URL 查询参数 `?api_key=` 传递时，nginx `access_log` SHALL 对其脱敏（记录中不出现 `api_key` 的明文值）。`web/README.md` SHALL 说明 API Key 存于浏览器本机存储的风险与「公共设备请清除」的指引。

> 中期项（记录，不在本变更实现）：推动后端以短时签名令牌 / 一次性 token 替代明文 `?api_key=`，从根本上消除 URL 泄漏面。

#### Scenario: 响应携带安全头
- **Given** `web` 容器已启动
- **When** 浏览器请求 SPA 首页或任一 API 路径
- **Then** 响应包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 与 `Content-Security-Policy` 头

#### Scenario: CSP 不阻断核心功能
- **Given** 安全头已生效
- **When** 前端渲染页面、播放 `<video>`、打开 `EventSource` 进度流
- **Then** 上述功能均正常，未被 CSP 阻断

#### Scenario: 访问日志脱敏 API Key
- **Given** 请求 `/v1/videos/{id}/file?api_key=<secret>` 或 `/events?api_key=<secret>`
- **When** nginx 记录访问日志
- **Then** 日志行中不出现 `api_key=<secret>` 的明文值

---

### Requirement: WF7 — 任务流健壮性与持久化

前端任务流 SHALL 在异常与刷新场景下保持健壮：状态轮询在连续失败达到阈值（可配置，默认 3 次）后 SHALL 停止该任务的轮询与 SSE（或采用带上限的指数退避），不得无限重试刷屏。SSE 连接在遇到 `error` 事件时 SHALL 仅在任务已进入终态或连接已 `CLOSED` 时关闭，否则 SHALL 保留浏览器原生重连或执行带退避的手动重连，使临时断线后仍能恢复日志流。前端 SHALL 将任务清单（`order` 及各 `task_id`）持久化到浏览器本机存储，并在页面加载时对每个已知任务重新拉取状态以重建列表；对非终态任务重新打开进度流；对后端已不存在（404）的任务从持久化中清理。健康检查 SHALL 周期性刷新（约 30 秒）而非仅在挂载时探测一次。单任务日志 SHALL 设置保留上限（可配置，默认 2000 行），超出时截断最旧行，避免长任务下的内存与渲染退化。

#### Scenario: 轮询连续失败后停止
- **Given** 某任务的状态轮询连续失败（如后端返回 4xx/5xx 或任务已被删除）
- **When** 失败次数达到阈值
- **Then** 前端停止该任务的轮询与 SSE，不再周期性重试与刷屏报错

#### Scenario: SSE 临时断线可恢复
- **Given** 一个非终态任务的 SSE 连接因网络抖动触发 `error`
- **When** 连接尚未进入终态
- **Then** 前端不永久关闭该流，断线恢复后可继续接收 `log` 事件

#### Scenario: 刷新后重建任务列表
- **Given** 用户在有若干任务时刷新页面
- **When** 页面重新加载
- **Then** 前端从本机存储读取任务清单并逐个拉取状态重建列表，对非终态任务重新打开进度流，对 404 任务清理

#### Scenario: 健康状态周期刷新
- **Given** 页面持续打开
- **When** 后端健康状态发生变化（宕机或恢复）
- **Then** 健康徽标在约 30 秒内反映最新状态

#### Scenario: 日志超上限被截断
- **Given** 一个长时间运行的任务产生超过保留上限的日志
- **When** 新日志持续到达
- **Then** 前端仅保留最近的上限行数，截断最旧的日志

---

### Requirement: WF8 — 前端质量门与测试基线

前端仓库 SHALL 维持干净的构建产物与可执行的质量门：版本库 SHALL NOT 包含由源文件编译产生的构建产物（如 `vite.config.js`、`vite.config.d.ts`），并 SHALL 通过 `web/.gitignore` 忽略此类产物。`npm run lint` SHALL 以 `--max-warnings 0` 运行且通过（不得用超大 `--max-warnings` 阈值掩盖告警）；为此 `store` 的 Provider 组件与 hook/context SHALL 拆分到不同模块以消除 `react-refresh/only-export-components` 告警。前端 SHALL 为状态层（`store`）关键路径与纯组件提供自动化测试护栏。

#### Scenario: 仓库不含编译产物
- **Given** 检出仓库
- **When** 检查 `web/` 目录
- **Then** 不存在 `vite.config.js` / `vite.config.d.ts` 等编译产物，且 `.gitignore` 忽略之

#### Scenario: Lint 门禁零告警
- **Given** 执行 `npm run lint`（`--max-warnings 0`）
- **When** 检查前端源码
- **Then** 通过且无告警（包含无 `react-refresh/only-export-components`）

#### Scenario: 关键路径有测试护栏
- **Given** 执行 `npm run test`
- **When** 运行测试套件
- **Then** 覆盖 `store` 的终态停轮询、失败停轮询、取消保留任务、SSE 累积/`done`/`error`、刷新重水合、日志上限，以及关键纯组件行为，且全部通过

---

## REMOVED Requirements

（无）
