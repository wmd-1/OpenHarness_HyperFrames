# Design Agent Video Module Specification

**Component:** `design-agent-frontend/src/modules/video/`（文本生成视频能力域，GA）
**Established by change:** `add-design-agent-frontend` (2026-07-31)
**上游契约：** `session-service` 基线规格 `session-rest-api`、`session-ws-protocol`、`session-history-switch`、`session-auth`、`session-frontend-history-switch`（本规格为其在设计智能体平台的消费方）

视频能力域完整消费 session-service 现有 REST + WebSocket 契约，融合 demo 交互真实化，提供多会话对话、模型切换、产物预览与下载能力。

---

## Requirements

### Requirement: session-service 契约消费
视频模块 SHALL 完整消费 session-service 现有契约且不要求任何后端修改：REST（POST/GET/DELETE /v1/sessions、GET/POST /turns、GET /turns/{idx}/artifact、GET /workspace/files[/{path}]、/healthz、/readyz）与 WS（/v1/sessions/{sid}/ws）。认证一律 `X-API-Key` 头，仅产物/工作区直链与 WS 额外使用 `?api_key=` 查询参数；密钥存 localStorage（`da.*` 前缀）。错误语义 MUST 按契约处理：401 清 key 回认证页、403 每日配额 fatal 横幅、429 读 Retry-After 提示、503 容量提示（建会话场景就地提示不弹全局横幅）。

#### Scenario: 401 清除密钥
- **WHEN** 任一 REST 请求返回 401
- **THEN** 前端清除已存密钥并回到 API Key 认证页

#### Scenario: 建会话容量满就地提示
- **WHEN** POST /v1/sessions 返回 429 或 503
- **THEN** 在新建会话对话框内就地提示，不弹全局横幅

### Requirement: WS 流式对话与重连
视频模块 WS 通道 MUST 实现：`delta.final=true` 携带 `full_text` 时整体覆盖（非追加）；重连携带只增不减的 `last_turn_index`，对 `turn_complete(replayed=true)` 幂等处理；准入失败按机器可解析常量（TENANT_QUOTA_EXCEEDED/CAPACITY_FULL/SESSION_UNAVAILABLE）分支而非文案；未知帧透传不报错；心跳 30s ping、连续 3 次无 pong 主动断连重连。关闭码策略：正常断连指数退避 1s→30s 最多 10 次；4400/4401/4403/4404 不重连；4429 每 60s 重试 2 次；4430 等待手动重试；4503 固定 15s×4；4500 有界 2 次。

#### Scenario: 断线重连不重复渲染
- **WHEN** 对话中 WS 断连后自动重连并携带 last_turn_index
- **THEN** 服务端补发的 replayed 轮次不产生重复消息渲染

#### Scenario: 租户并发配额满不自动重连
- **WHEN** WS 收到 error 帧 code=TENANT_QUOTA_EXCEEDED 且以 4430 关闭
- **THEN** 前端不自动重连，展示配额提示并提供手动重试入口

### Requirement: session-frontend 核心功能保留
视频模块 MUST 逐项保留 session-frontend 的核心功能清单：API Key 认证、会话列表（服务端权威分页）、新建会话（permission_policy + extra_oh_args 白名单）、历史会话切换（列表判定 → turns 回显 → WS 带 last_turn_index 补发去重；COLD 会话由服务端自动 resume）、WS 流式对话、工具调用卡片、TODO 面板、审批流三弹窗（permission/edit_diff/question）、中断、REST 兜底提交、产物播放/下载、工作区文件浏览/下载、Chat/Terminal 双模式、错误横幅、关闭会话、主题切换、输入历史与斜杠命令、健康探针徽标。

#### Scenario: 历史会话切换回显并续聊
- **WHEN** 选中列表中 `resumable=true` 的历史会话
- **THEN** 历史轮次回显（含 has_artifact 标记）且可继续对话

### Requirement: OpenHarness 主 agent 模型切换（双通道）
模型切换的对象 SHALL 是 OpenHarness 主 agent 的模型（`oh --model` 的 alias 或完整模型 ID），以双通道实现且不要求后端修改：① 新建会话时经 `extra_oh_args: ["--model", "<name>"]` 设定初始模型；② 会话空闲态经 WS `submit` 通道发送文本命令 `/model <name>` 完成运行时切模，命令回执以系统消息展示，前端乐观更新下拉显示态并校验回执。轮次进行中（busy）MUST 禁用模型切换入口。选中值持久化于本地（`da.*` 前缀）并在新建会话时注入；模型候选列表由前端常量维护。

#### Scenario: 建会话注入初始模型
- **WHEN** 模型下拉选择了非默认模型后新建会话
- **THEN** 创建请求的 extra_oh_args 包含 `--model <name>`

#### Scenario: 会话中途运行时切模
- **WHEN** 会话空闲态在模型下拉选择新模型
- **THEN** 前端经 WS 提交 `/model <name>`，消息区展示切换回执，下拉显示态同步更新

#### Scenario: busy 期间禁用切换
- **WHEN** 轮次进行中（busy）
- **THEN** 模型切换入口禁用

### Requirement: demo 交互真实化
视频模块 MUST 融合 demo 交互并真实化：会话区（chat-header/消息区/输入区）左右各 10% 留白，预览面板展开时归零，640px 以下降为固定 16px；视频预览面板默认收起、可展开至 50%（min 360px），`turn_complete.has_artifact=true` 时自动展开并加载该轮产物；自定义播放器提供 demo 全套控制（进度含缓冲、seek、播放/暂停、音量、0.5x–2x 倍速、时间显示、3s 自动隐藏），播放走 `?mode=stream` 网关流式（Range/206），下载走直链（跟随 S3 302）；Enter 发送 / Shift+Enter 换行；一个会话多轮产物时提供轮次切换条。上传文档按钮保留交互但 MUST 明示「暂不支持」且不做假上传。

#### Scenario: 产物轮次完成自动展开预览
- **WHEN** 收到 `turn_complete.has_artifact=true`
- **THEN** 预览面板自动展开并以 stream 模式加载该轮产物可播放

#### Scenario: 会话区留白与预览联动
- **WHEN** 预览面板从收起切换为展开
- **THEN** 中栏 10% 左右留白归零，布局与 demo 行为一致
