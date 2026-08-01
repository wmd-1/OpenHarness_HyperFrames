## ADDED Requirements

### Requirement: 真实后端栈作为 E2E 唯一后端来源
E2E 测试必须以 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 拉起的真实 `session-service` 栈（FastAPI + Postgres + Redis + WS + stub oh）为唯一后端，禁止使用 `e2e/mock-backend.mjs` 假后端驱动功能/错误类用例。

#### Scenario: 后端真实在线且可建会话
- **WHEN** 编排脚本启动真实栈且 `session:8001/healthz` 返回 200
- **THEN** Playwright 用例能经真实 `POST /v1/sessions`（带 `X-API-Key: test-key`）获得真实 `session_id`
- **AND** 该 `session_id` 可用于真实 `GET /v1/sessions/{id}` 与 WS `/v1/sessions/{id}/ws`

#### Scenario: 禁止假后端驱动
- **WHEN** 运行 E2E
- **THEN** `playwright.config.ts` 的 `webServer` 不自动启动 `node e2e/mock-backend.mjs`
- **AND** 报告中对每条用例标注真实后端 URL（非 `localhost:8001` 的 mock 桩标识）

### Requirement: 错误处理场景由真实后端返回
429/503/403/500/401/404 与 WS 关闭码必须由真实 `session-service` 或 stub oh 注入真实返回，前端据此展示对应 banner / 重连 / 回 Welcome。

#### Scenario: 限流 429 真实触发
- **WHEN** 用例经真实后端提交携带 `fault=rate_limit` 的请求
- **THEN** 后端真实返回 429 且含 `Retry-After` 头
- **AND** 前端展示可恢复 banner（非 CreateDialog 内联抑制场景外）

#### Scenario: 后端不可用 500/断连
- **WHEN** 用例 kill `session` 容器或提交 `fault=server_error`
- **THEN** 前端展示 fatal banner 且不清空会话列表（仅在 401 才清 key 回 Welcome）

#### Scenario: WS 掉线重连
- **WHEN** 用例断开 WS（kill oh / 关闭 socket）
- **THEN** 前端依据 close code（4400–4503）真实重连，且在测试超时内恢复流式

### Requirement: 5 类真实场景覆盖
E2E 必须覆盖正常流程、边界、错误处理、性能、浏览器兼容性五类，且均以真实浏览器走真实通道。

#### Scenario: 正常流程真实闭环
- **WHEN** 用例完成 Welcome → 建会话 → WS 流式 → turn_complete 真实产物 → 下载直链 → 历史切换 → 个人空间聚合
- **THEN** 每个断言对应真实后端响应（session_id / turn delta / artifact_url 200 / aggregated sessions）

#### Scenario: 性能指标采集
- **WHEN** 用例以 ≤8 并发浏览器上下文连真实后端
- **THEN** 报告记录页面加载 TTFB、API p95、容器 CPU/内存（docker stats）

### Requirement: 镜像内执行约束
所有 E2E 必须在既有 `oh-e2e-test:latest` 镜像内执行，宿主机仅运行 `docker compose` 与编排脚本。

#### Scenario: 镜像内真实浏览器
- **WHEN** 运行 `e2e/run-design-frontend-real-backend-tests.sh`
- **THEN** Playwright 经 `PW_CHROMIUM_PATH` 使用镜像内置 `chrome-headless-shell`
- **AND** 宿主机不直跑 `npx playwright test`

### Requirement: 跨租户隔离真实验证
用例 SHALL 签发两个临时租户 key（A/B），验证真实后端对跨租户访问的隔离：租户 B 持自身 key 访问租户 A 会话 → 真实 404，且 B 的会话列表不可见 A 的会话。

#### Scenario: 跨租户不可见
- **WHEN** 租户 B 以自身 key 请求租户 A 的会话详情与会话列表
- **THEN** 详情真实返回 404、列表 200 但不含 A 的会话；前端对 404 展示隔离提示而非残留数据

### Requirement: assistant_text 不重复回归
WS 完成的轮次，前端渲染消息文本 SHALL 恰等于单份 stub 全文（`Stub reply to: <prompt>` 恰出现一次），无双发拼接（对齐 session-live-acceptance 的 rest.sh 回归锚点）。

#### Scenario: 单份全文渲染
- **WHEN** 真实后端完成一个 turn 并经 WS 推流
- **THEN** 前端消息区该轮文本恰出现一次，无重复拼接

### Requirement: 产物下载与路径穿越防护
E2E SHALL 验证真实产物直链：下载 → 200 且 `content-type: video/mp4`；`Range: bytes=0-99` → 206；工作区文件路径穿越（`..%2f`、`%2f` 绝对）→ 后端真实 400，前端不泄露/不崩溃。

#### Scenario: 流式与范围下载
- **WHEN** 经真实产物 URL 下载并带 Range 头
- **THEN** 分别得到 200(video/mp4) 与 206，前端播放器以 stream 模式可播放

#### Scenario: 路径穿越被拒
- **WHEN** 请求工作区文件 `..%2fetc%2fpasswd` 与 `%2fetc%2fpasswd`
- **THEN** 后端真实返回 400，前端工作区浏览器安全失败

### Requirement: WS 全生命周期真实验证
E2E SHALL 经真实浏览器验证 WS 全生命周期：turn → `turn_complete`；detach 后 idle grace 到期 → `status=cold`；cold 下工作区文件 `source=archive`（live 为 `source=live`）；WS 重连 resume 后 `turn_count` 连续且 replayed 轮次幂等不重复渲染；DELETE 软关闭后 `turns` 历史仍可读。

#### Scenario: live→cold→resume→closed
- **WHEN** 依次执行 WS turn、detach 等待驱逐、读取归档文件、WS 重连再 turn、DELETE 会话
- **THEN** 状态依次为 live→cold（archive 可读）→live（turn_count 连续）→closed（历史仍可读），各步断言通过

### Requirement: 模型双通道切换真实验证
E2E SHALL 验证 OpenHarness 主 agent 模型切换双通道：新建会话时经 `extra_oh_args:["--model",<name>]` 注入初始模型；空闲态经 WS `submit` 发送 `/model <name>` 运行时切模（回执系统消息 + 下拉显示同步）；busy 期间模型切换入口禁用（对齐 design-agent-video 模型切换需求）。

#### Scenario: 建会话注入初始模型
- **WHEN** 模型下拉选择了非默认模型后新建会话
- **THEN** 创建请求的 extra_oh_args 包含 `--model <name>`

#### Scenario: 空闲态运行时切模
- **WHEN** 会话空闲态在模型下拉选择新模型
- **THEN** 前端经 WS 提交 `/model <name>`，消息区展示切换回执，下拉显示态同步更新

#### Scenario: busy 期间禁用切换
- **WHEN** 轮次进行中（busy）
- **THEN** 模型切换入口禁用

### Requirement: 功能域专项真实验证
E2E SHALL 覆盖 design-frontend 独有功能：审批流三弹窗（permission/edit_diff/question，经 WS 工具调用/审批帧）、Chat/Terminal 双模式切换（切换后同会话 WS 不断）、中断/REST 兜底提交。

#### Scenario: Terminal 模式切换保会话
- **WHEN** 在 Chat 模式对话中切换到 Terminal 模式
- **THEN** 同一会话 WS 连接保持，历史轮次保留可查

### Requirement: WS close code 分支策略真实验证
前端 WS 重连 SHALL 按 design-agent-video 规格的 close code 策略真实行为：4400/4401/4403/4404 不重连；4429 每 60s 重试 2 次；4430（TENANT_QUOTA_EXCEEDED）不自动重连并展示配额提示 + 手动重试；4503 固定 15s×4；4500 有界 2 次；正常断连指数退避 1s→30s 最多 10 次。

#### Scenario: 配额满不自动重连
- **WHEN** WS 以 4430 关闭（TENANT_QUOTA_EXCEEDED）
- **THEN** 前端不自动重连，展示配额提示并提供手动重试入口

### Requirement: 平台一致性与演示标识
E2E SHALL 验证：主页模块卡片 / 路由 / 个人空间 tab 均派生自 AgentRegistry（video/ui/drawio 三域），无硬编码清单；demo 成熟度（ui/drawio）数据在任何页面带「演示数据」标识，ga 视频域不带（对齐 design-agent-platform / space）。

#### Scenario: 演示标识
- **WHEN** ui-prototype 或 drawio-diagram（demo）数据出现在个人空间 tab 或卡片
- **THEN** 该数据带「演示数据」角标；视频 tab 真实数据不带
