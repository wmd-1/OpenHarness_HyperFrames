# 设计智能体平台前端架构设计 v2

- 日期：2026-07-31
- 状态：待评审（架构层设计；暂不进入 OpenSpec）
- 文档关系：
  - 本文（v2）是**架构主体**：平台层抽象、API 契约、长期演进、OpenSpec 边界与验收标准，是未来 OpenSpec 变更的素材来源。
  - [v1 实施方案](./Design_Agent_Frontend_Four_Modules_Plan_2026-07-31.md) 中的 src 目录结构、组件拆分、样式令牌等内容降级为**实施参考**，不作为 OpenSpec 主体。

---

## 1. 架构总览

### 1.1 分层视图

```
┌────────────────────────────────────────────────────────────────────┐
│  呈现层（Presentation）                    —— 实施细节，不进 OpenSpec  │
│  主页 / 视频模块 / 原型设计 / Drawio / 个人空间 的页面与组件            │
├────────────────────────────────────────────────────────────────────┤
│  平台抽象层（Design Agent Platform Layer）    —— OpenSpec 主体 ★      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌────────┐ │
│  │ Agent    │ │ Session  │ │ Conversation │ │ Artifact │ │Workspace│ │
│  │ Registry │ │ Provider │ │ /TurnStream  │ │ Provider │ │Provider │ │
│  └──────────┘ └──────────┘ └──────────────┘ └──────────┘ └────────┘ │
├────────────────────────────────────────────────────────────────────┤
│  契约适配层（Contract Adapters）              —— OpenSpec 主体 ★      │
│  SessionServiceAdapter（REST + WS，真实）  │  DemoAdapter（内存，演示） │
├────────────────────────────────────────────────────────────────────┤
│  后端（不改动）：session-service /v1 REST + WS │  （未来）ui/drawio 服务 │
└────────────────────────────────────────────────────────────────────┘
```

核心原则：

1. **呈现层不直接触碰后端**：所有页面只消费平台抽象层接口；后端差异（真实 / demo / 未来新服务）被适配层吸收。
2. **注册表驱动**：四大模块（及未来新模块）由 AgentRegistry 声明式驱动——主页卡片、路由、个人空间 tab、能力开关均派生自注册表，新增能力域不改既有模块代码。
3. **契约优先**：前端只依赖 §3 契约中声明的字段与语义（如 `resumable`/`read_only`、`has_artifact`、close code 常量），不解读后端内部状态枚举。

### 1.2 能力域状态矩阵

| 能力域（Agent） | Session Provider | Artifact Provider | 成熟度 | 说明 |
| --- | --- | --- | --- | --- |
| `video-generation` | SessionServiceAdapter（真实） | SessionServiceArtifacts（真实） | **GA** | 对接 session-service 全量契约 |
| `ui-prototype` | DemoAdapter（内存） | DemoArtifacts（静态） | **demo** | 交互演示，接口 stub 预留 |
| `drawio-diagram` | DemoAdapter（内存） | DemoArtifacts（静态） | **demo** | 同上 |
| （个人空间） | —— 非能力域，是 Artifact Provider 的聚合视图 | 聚合全部 provider | 混合 | video tab 真实、其余 demo |

---

## 2. 平台层抽象（域模型）

> 以下接口签名为**契约级**定义（描述职责与不变量），非组件实现。

### 2.1 Agent（能力域）

一个 Agent 是一种设计能力单元的声明式描述：

```ts
interface AgentDescriptor {
  id: 'video-generation' | 'ui-prototype' | 'drawio-diagram';  // 稳定标识，路由/存储 key 派生于此
  maturity: 'ga' | 'demo' | 'stub';           // 决定 UI 是否标注「演示」、个人空间是否接真实数据
  route: string;                              // /video、/ui、/drawio
  theme: AgentTheme;                          // 模块主题色/图标（demo 视觉令牌）
  artifactMediaTypes: string[];               // 产物类型：['video/mp4'] / ['text/html'] / ['image/svg+xml']
  providers: {
    session: SessionProvider;                 // 会话生命周期实现
    artifact: ArtifactProvider;               // 产物读取实现
    workspace?: WorkspaceProvider;            // 可选：工作区文件（当前仅 video 有）
  };
  capabilities: AgentCapabilities;            // 能力开关，见下
}

interface AgentCapabilities {
  realtimeStream: boolean;      // 是否有真实流式通道（video=true，demo=false 走模拟）
  modelSelection: 'initial' | 'runtime' | 'none';  // 切换对象为 OpenHarness 主 agent 模型；video=runtime（见 §3.4 G2）
  fileUpload: boolean;          // 当前全部 false（后端无 API，§3.4）
  approvalFlow: boolean;        // 审批流（video=true）
  terminalMode: boolean;        // 终端模式（video=true）
  workspaceFiles: boolean;      // 工作区文件浏览（video=true）
}
```

**不变量**：
- AgentRegistry 是唯一的能力域清单；主页、路由表、个人空间 tab 由其派生，禁止在模块内硬编码兄弟模块的存在。
- `maturity !== 'ga'` 的能力域，其所有对外产物/数据必须带「演示」标识。

### 2.2 Session（会话域）

统一会话生命周期抽象，语义对齐 session-service 现契约：

```ts
interface SessionProvider {
  list(page: PageQuery): Promise<Page<SessionSummary>>;   // 服务端权威分页
  create(req: CreateSessionRequest): Promise<SessionRef>; // 含 permission_policy、模型注入
  get(sid: string): Promise<SessionDetail>;
  close(sid: string): Promise<void>;                      // 关闭后 turn 历史仍可读
  listTurns(sid: string, after?: number): Promise<TurnRecord[]>;  // 历史回显（含 has_artifact）
  openChannel(sid: string, opts: ChannelOptions): TurnStream;     // 交互通道（见 2.3）
}

interface SessionSummary {
  sessionId: string;
  title: string | null;
  turnCount: number;
  resumable: boolean;     // ★ 前端可交互性判定的唯一依据
  readOnly: boolean;      // ★ 只读=仅可查历史
  createdAt: string;
  lastActiveAt: string;
}
```

**不变量**（继承 session-history-switch 既有规范）：
- 前端**只**依赖 `resumable`/`read_only` 业务字段决策，不解读后端内部 `status` 枚举。
- `canResumeSession ≡ resumable === true && !readOnly`；若未来后端允许两者并存，必须重构该谓词而非在调用点打补丁。
- 历史切换标准流程：列表判定 → `listTurns` 回显 → `openChannel(last_turn_index)` 去重补发；COLD 会话由服务端自动 resume，前端无感知。

### 2.3 Conversation / TurnStream（交互域）

将 WS 协议抽象为与传输无关的事件流：

```ts
interface TurnStream {
  submit(text: string): void;
  interrupt(): void;
  approve(requestId: string, decision: ApprovalDecision): void;
  on(event: TurnStreamEvent): void;   // ready | delta | tool | todo | approval | complete | error | closed
  close(): void;
  readonly state: ChannelState;       // idle/connecting/ready/reconnecting/…（含配额/容量失败态）
}
```

- **传输策略**：主通道 = WS（含重连/心跳/补发契约，§3.2）；兜底 = REST 同步提交（`POST /turns`）。传输选择对呈现层透明。
- **demo 能力域**的 TurnStream 由 DemoAdapter 以内存模拟实现（固定延迟回复），事件类型与真实通道一致——保证未来接真实后端时呈现层零改动。

### 2.4 Artifact（产物域）

```ts
interface ArtifactRef {
  agentId: string;            // 归属能力域
  sessionId: string;
  turnIndex: number;
  name: string;               // 展示名（会话 title / prompt 派生）
  mediaType: string;          // video/mp4 等
  createdAt: string;
  demo?: boolean;             // 演示数据标识
}

interface ArtifactProvider {
  listBySession(sid: string): Promise<ArtifactRef[]>;       // 由 turns.has_artifact 派生（现契约）
  aggregate(page: PageQuery): Promise<Page<ArtifactRef>>;   // 个人空间聚合视图
  streamUrl(ref: ArtifactRef): string;                      // 内嵌播放（Range 流式）
  downloadUrl(ref: ArtifactRef): string;                    // 直链下载（跟随 S3 302）
}
```

**不变量**：
- 个人空间 = 各 ArtifactProvider 聚合视图的呈现，**不自建数据源**；provider 数据源替换（前端聚合 → 后端产物列表 API）不改变个人空间接口（§4.3）。
- 产物 URL 认证走 `?api_key=` 查询参数（`<video>`/`<a>` 无法带头），该路径的 access log 必须关闭（nginx 层保证）。

### 2.5 Workspace（工作区域）

```ts
interface WorkspaceProvider {
  listFiles(sid: string, q: { prefix?: string; pageToken?: string }): Promise<Page<WorkspaceFile>>;
  fileUrl(sid: string, path: string): string;   // presigned 302 或网关流式
}
```

覆盖 live/archive 双源语义（会话存活期与归档后均可读），来源差异由后端处理，前端不感知。

---

## 3. Frontend ↔ session-service API 契约

> 本节是对现有 session-service 契约的**正式化摘录 + 前端依赖声明**，后端不做任何修改。作为未来 OpenSpec `design-agent-video` 能力 spec 的契约基线。

### 3.1 REST 契约

| # | 方法/路径 | 前端用途 | 关键请求/响应字段 | 前端依赖的语义 |
| --- | --- | --- | --- | --- |
| R1 | `POST /v1/sessions` | 新建会话 | req: `permission_policy`(full_auto/interactive), `extra_oh_args`(白名单，含 `--model` —— OpenHarness 主 agent 初始模型) | 201 返回 `session_id`+`ws_url`；429/503 就地提示不弹全局横幅 |
| R2 | `GET /v1/sessions` | 会话列表 | `limit/offset` 分页；resp: `SessionSummary[]`+`total` | created_at 倒序；`resumable/read_only` 为决策唯一依据 |
| R3 | `GET /v1/sessions/{sid}` | 会话详情 | resp 含 `ws_url` | 跨租户返回 404（等同不存在） |
| R4 | `DELETE /v1/sessions/{sid}` | 关闭会话 | —— | 关闭后 R6 仍可读（历史保留） |
| R5 | `POST /v1/sessions/{sid}/turns` | REST 兜底提交 | req: `text`；阻塞至轮次完成 | 仅 WS 不可用时使用；无超时（timeout: false） |
| R6 | `GET /v1/sessions/{sid}/turns` | 历史回显 | `after_index` 游标；resp: `TurnRecord[]`（含 `has_artifact`） | closed/expired 会话仍可读；`has_artifact` 缺失按 false |
| R7 | `GET /v1/sessions/{sid}/turns/{idx}/artifact` | 产物播放/下载 | `?mode=stream` 强制网关流式（Range/206）；默认可 302 至 S3 presigned | 认证支持 `?api_key=`；内嵌播放必须用 stream 模式避免 302 CORS |
| R8 | `GET /v1/sessions/{sid}/workspace/files` | 工作区列表 | `page_token` 游标 + `prefix` 过滤 | live/archive/none 三源，前端不感知来源 |
| R9 | `GET /v1/sessions/{sid}/workspace/files/{path}` | 工作区下载 | —— | 同 R7 的直链认证模式 |
| R10 | `GET /healthz` `/readyz` | 健康徽标 | —— | 免认证 |

**认证契约**：REST 一律 `X-API-Key` 头；仅 R7/R9（及 WS）额外接受 `?api_key=` 查询参数。密钥存前端 localStorage（`da.*` 前缀），401 清除并回认证页。

**错误语义契约**（客户端统一拦截层职责）：

| 状态码 | 语义 | 前端行为 |
| --- | --- | --- |
| 401 | 密钥无效/过期 | 清 key → 回认证页 |
| 403 | 每日配额耗尽 | fatal 横幅（不可关闭） |
| 429 | 限流 | 读 `Retry-After` 提示；建会话场景就地提示 |
| 503 | 节点容量满 | 容量横幅 + 建会话就地提示 |

### 3.2 WebSocket 契约

- **端点**：`WS /v1/sessions/{sid}/ws?api_key=…&last_turn_index=N`（accept 前鉴权）。
- **客户端帧**：`submit{text}` / `interrupt` / `approval{request_id, allowed, reply?, answer?}` / `ping`。
- **服务端帧**：`session_ready` / `delta{text, turn_index, final?, full_text?}` / `turn_complete{turn_index, interrupted?, replayed?, has_artifact?}` / `tool_start` / `tool_end` / `todo` / `approval_request{request_id, modal}` / `busy` / `pong` / `error{message, code?}` / `turn_error{message, code?}` / 未知帧透传为 `event`。
- **关键语义**（前端强依赖）：
  1. `delta.final=true` 且携带 `full_text` 时为**整体覆盖**（权威全文），非追加。
  2. `last_turn_index` 只增不减；重连时服务端据此补发 `turn_complete(replayed=true)`，前端幂等处理。
  3. 准入失败：先发 `error` 帧携带机器可解析常量 `TENANT_QUOTA_EXCEEDED` / `CAPACITY_FULL` / `SESSION_UNAVAILABLE`，随后 close；前端依据常量（而非文案）分支。
  4. 未知帧类型必须透传不报错（协议前向兼容）。
  5. 单条后端事件超 1 MiB 不下发（前端对缺帧容忍）。
- **关闭码与重连策略契约**：

| Close code | 语义 | 重连策略 |
| --- | --- | --- |
| 正常断连 | 网络抖动 | 指数退避 1s→30s，最多 10 次 |
| 4400/4401/4403/4404 | 参数/鉴权/权限/不存在 | 不重连 |
| 4429 | 限流 | 每 60s 有界重试 2 次 |
| 4430 | 租户并发配额满 | 不自动重连，等待手动重试 |
| 4503 | 容量满 | 固定 15s × 4 次 |
| 4500 | 服务端错误 | 有界 2 次 |
| （心跳） | 30s ping，连续 3 次无 pong | 主动 close 触发重连 |

### 3.3 多租户契约

- 认证层将 API key 解析为 `tenant_id`；会话行级隔离（跨租户 404）、MinIO 按 `tenants/{tid}/` 前缀隔离、租户并发/每日配额准入。
- **前端假定**：单 key ↔ 单租户，无租户切换 UI；后端从单 key 演进到多 key 映射时（认证层已预留），前端零改动。

### 3.4 契约缺口清单（现状处置 + 未来契约预留）

| # | 缺口 | 当前前端处置 | 未来契约预留（演进触发点） |
| --- | --- | --- | --- |
| G1 | 无模型列表 API（OpenHarness 主 agent 合法模型集无查询入口） | 模型候选前端常量维护（OH 主 agent 模型 alias/ID）；下拉选择存本地 | `GET /v1/models` → 下拉数据源切换，接口形态：`{ models: [{id, label, default?}] }` |
| G2 | 运行时切模无**结构化**契约：现有能力为文本命令通道——WS `submit` 发 `/model <name>`，经 backend_host `handle_line` → OpenHarness `/model` 命令 handler 完成主 agent 运行时切模，回执为非结构化系统消息 | 双通道：建会话 `--model` 设初始模型 + 会话中 `/model` 运行时切换；前端乐观更新下拉显示态并校验回执；busy 期间禁用 | 后端新增结构化 `set_model` 客户端帧或会话 PATCH + `model_changed` 回执帧 → 前端丢弃文案校验逻辑，改订阅结构化事件 |
| G3 | 无产物元数据列表 API（ArtifactResponse schema 未暴露路由） | ArtifactProvider 前端聚合（R2+R6 派生，限并发+缓存） | 后端暴露 `GET /v1/artifacts?limit&offset` → 替换 provider 数据源，聚合视图接口不变 |
| G4 | 无文件上传 API | 上传交互保留但明示「暂不支持」，stub 预留 | 后端新增 `POST /v1/sessions/{sid}/workspace/files` → capabilities.fileUpload=true |
| G5 | 无会话重命名/删除历史 API | 不提供该入口 | 后端就绪后在会话列表补充操作 |

---

## 4. 模块长期演进设计

### 4.1 能力域扩展路径（Registry 驱动）

新增设计能力（如「PPT 生成」）的标准步骤，且**不修改**任何既有模块代码：

1. 注册 `AgentDescriptor`（id/route/theme/mediaTypes/capabilities）；
2. 实现三个 Provider 接口（或先挂 DemoAdapter 以 demo 成熟度上线）；
3. 主页卡片、路由、个人空间 tab 自动派生。

### 4.2 ui-prototype / drawio-diagram：demo → GA 演进路径

| 阶段 | Session/TurnStream | Artifact | 前端改动面 |
| --- | --- | --- | --- |
| 现在（demo） | DemoAdapter 内存模拟 | 静态演示数据 | —— |
| 阶段一（后端就绪） | 新建同构适配器（推荐后端复用 session-service 协议形态：REST /v1/sessions + WS 帧集，仅产物 mediaType 不同） | `has_artifact` 派生 | 仅替换 registry 中 providers 指向 + maturity 改 `ga`；呈现层零改动 |
| 阶段二（差异能力） | ui 预览需要 HTML 产物实时渲染 → 扩展 `delta` 或新增 `artifact_preview` 帧（走未知帧透传通道灰度） | HTML/SVG 产物走同一 ArtifactProvider 契约 | 预览面板按 mediaType 分发渲染器 |

> 关键设计：**demo 与真实通道共享同一 TurnStream 事件模型**，这是演进成本趋近于零的前提；也是为什么 v2 把 TurnStream 列为 OpenSpec 主体而组件拆分不列。

### 4.3 个人空间演进

- 数据面：G3 缺口闭环后，`aggregate()` 从「前端 N+1 聚合」切到后端产物列表 API，一次 provider 内部替换，页面与分页语义不变。
- 能力面：ui/drawio tab 随 §4.2 转 GA 自动切换真实数据（registry.maturity 驱动，去除「演示」角标），无个人空间侧代码改动。
- 远期：跨能力域统一检索/收藏，作为独立 OpenSpec 变更立项，不在本期范围。

### 4.4 认证与多租户演进

单 key（tenant=default）→ 多 key 租户映射：后端认证层替换即生效（下游隔离逻辑已就位），前端契约（X-API-Key / ?api_key= / 401 处理）完全不变。远期若引入用户体系（登录态/OIDC），仅替换认证适配层与欢迎页，平台抽象层不动。

### 4.5 兼容与版本化策略

- WS 未知帧透传 + 可选字段缺省语义（`has_artifact` 缺失按 false 等）= 后端可先行灰度新能力。
- 前端能力开关集中于 `AgentCapabilities`，后端能力上线只翻开关不动逻辑。
- runtime 镜像 `version.json` 版本戳保留，供部署核对。

---

## 5. OpenSpec 边界

### 5.1 纳入 OpenSpec 的内容（能力级）

未来立项时建议拆为一个 change、四份能力 spec（delta）：

| Spec | 内容来源 | 核心 requirement 主题 |
| --- | --- | --- |
| `design-agent-platform` | 本文 §1–§2 | AgentRegistry 驱动、四域抽象接口与不变量、demo/GA 成熟度语义、能力开关 |
| `design-agent-video` | 本文 §3 + v1 §3 功能清单 | session-service 契约依赖（REST/WS/错误/重连/多租户）、session-frontend 核心功能保留清单、demo 交互真实化（模型/播放器/留白布局） |
| `design-agent-space` | 本文 §2.4/§4.3 + v1 §4 | 产物聚合视图、真实/演示混合呈现、G3 演进兼容 |
| `design-agent-demo-modules` | v1 §5 + 本文 §4.2 | ui/drawio demo 交互保全、api stub 预留形态、TurnStream 同构约束 |

### 5.2 不纳入 OpenSpec 的内容（实施细节，归 v1 与实现期决策）

- src 目录结构、组件文件拆分、store 划分、hooks 命名；
- CSS 设计令牌取值、响应式断点像素值、动画参数；
- Dockerfile 阶段写法、nginx 模板细节、compose 端口（遵循既有项目构建规范即可）；
- 测试用例组织（遵循「测试必须基于已有镜像」规则即可）。

### 5.3 与既有 spec 的关系

- 不修改 `openspec/specs/` 下任何 `session-*` spec；`design-agent-video` 以**引用**方式依赖其契约（session-history-switch、canResumeSession 语义等），避免复制产生双源。
- 新前端不改后端，故本 change 无 session-service 侧 delta。

---

## 6. 验收标准（能力级）

> 面向未来 OpenSpec 的 Scenario 素材，GIVEN/WHEN/THEN 形式；组件级断言下沉到实施期测试计划。

### AC-1 平台抽象

1. GIVEN AgentRegistry 注册了 video(ga)/ui(demo)/drawio(demo)，WHEN 渲染主页/路由/个人空间 tab，THEN 三者清单与注册表一致，无硬编码模块清单。
2. GIVEN 某能力域 maturity=demo，WHEN 其数据出现在任何页面，THEN 均带「演示」标识。
3. GIVEN demo 能力域与 video 能力域，WHEN 呈现层消费 TurnStream，THEN 两者事件类型集合一致（同构性可由类型系统与契约测试证明）。

### AC-2 视频模块（真实链路）

1. GIVEN 有效 API Key，WHEN 新建会话并提交文本，THEN 经 WS 收到流式 delta 并以 `turn_complete` 结束；期间断连可自动重连且凭 `last_turn_index` 不重复渲染。
2. GIVEN `turn_complete.has_artifact=true`，WHEN 轮次结束，THEN 预览面板自动展开并可经 stream 直链播放（支持 Range seek）、经下载直链落盘。
3. GIVEN 列表中 `resumable=true` 的历史会话，WHEN 切换选中，THEN 历史轮次回显且可继续对话；GIVEN `read_only=true`，THEN 仅可查阅，输入区禁用且有只读标识。
4. GIVEN 模型下拉选择了非默认模型（OpenHarness 主 agent 模型），WHEN 新建会话，THEN 创建请求包含 `--model` 白名单参数；WHEN 在会话空闲态切换模型，THEN 经 WS 提交 `/model <name>` 并在消息区展示切换回执，下拉显示态同步更新；WHEN 轮次进行中（busy），THEN 模型切换入口禁用。
5. GIVEN 401/403/429/503/4430/4503 各错误场景（mock 后端注入），WHEN 触发，THEN 前端行为与 §3.1/§3.2 契约表逐项一致。
6. session-frontend 核心功能保留清单（v1 §3.2 全部 17 项）逐项可用。

### AC-3 个人空间

1. GIVEN 租户内存在含产物的会话（含已关闭会话），WHEN 打开视频 tab，THEN 产物卡片按完成时间倒序展示，可预览与下载。
2. GIVEN ui/drawio tab，WHEN 切换与分页，THEN demo 数据完整呈现且带演示标识。
3. GIVEN 未来后端产物列表 API 替换数据源（契约测试模拟），THEN 页面呈现与分页语义不变（provider 可替换性验证）。

### AC-4 演示模块（ui/drawio）

1. demo 页面的全部交互（设备切换/源码视图/SVG 缩放/适应/下载/全屏/模拟对话/新建会话）在对应模块中逐项可复现。
2. GIVEN 各模块 `api.ts` stub，WHEN 审查，THEN 接口签名与 §4.2 演进路径兼容且集中标注 TODO。

### AC-5 隔离性与工程红线

1. `git status` 验证 `session-frontend/`、`web/`、`session-service/`、`service/` 零变更。
2. 新前端与 session-frontend 同源部署时无 localStorage 键冲突（`da.*` 前缀）。
3. 所有测试在 Docker 镜像内执行（遵循项目既定测试规则），lint + 单测 + e2e + runtime 冒烟全绿。

---

## 7. 后续动作

1. 本 v2 评审通过后，v1 + v2 共同作为实施依据（v2 定契约与边界，v1 定实施细节）。
2. 若决定进入 OpenSpec，按 §5.1 的 change/spec 拆分立项，requirement 直接取材 §2/§3 不变量与 §6 验收标准。
