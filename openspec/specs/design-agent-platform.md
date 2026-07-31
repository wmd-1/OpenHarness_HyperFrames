# Design Agent Platform Specification

**Component:** `design-agent-frontend/`（设计智能体平台前端）
**Established by change:** `add-design-agent-frontend` (2026-07-31)
**视觉基准：** `demo/设计智能体平台.html`

设计智能体平台以「平台 + 能力域」架构承载多个设计类智能体。平台抽象层定义统一的四域契约，AgentRegistry 作为能力域清单的唯一来源，主页/路由/个人空间均由注册表派生。能力域成熟度分 ga/demo/stub，demo 域数据统一带「演示」标识。

---

## Requirements

### Requirement: AgentRegistry 驱动的能力域清单
系统 SHALL 以 AgentRegistry 作为唯一的能力域清单，每个能力域由 `AgentDescriptor` 声明（含 `id`、`maturity`（ga/demo/stub）、`route`、`theme`、`artifactMediaTypes`、`providers`、`capabilities`）。主页模块卡片、路由表、个人空间 tab MUST 派生自注册表，禁止在模块内硬编码兄弟模块的存在。

#### Scenario: 主页/路由/个人空间与注册表一致
- **WHEN** AgentRegistry 注册了 video-generation(ga)、ui-prototype(demo)、drawio-diagram(demo) 三个能力域并渲染主页、路由与个人空间 tab
- **THEN** 三处呈现的模块清单与注册表完全一致，且代码中不存在硬编码的模块清单

#### Scenario: 新增能力域不改既有模块
- **WHEN** 向注册表新增一个能力域描述符（含 providers 实现）
- **THEN** 主页卡片、路由、个人空间 tab 自动出现该能力域，且既有模块代码零修改

### Requirement: 演示成熟度标识
`maturity !== 'ga'` 的能力域，其所有对外展示的产物与数据 MUST 携带「演示」标识。

#### Scenario: demo 能力域数据带演示标识
- **WHEN** ui-prototype 或 drawio-diagram（maturity=demo）的数据出现在任何页面（含个人空间 tab 与卡片）
- **THEN** 该数据带有「演示数据」角标或等效标识

### Requirement: 四域抽象接口
呈现层 SHALL 只消费平台抽象层接口，不直接触碰后端：`SessionProvider`（list/create/get/close/listTurns/openChannel）、`TurnStream`（submit/interrupt/approve/on/close/state）、`ArtifactProvider`（listBySession/aggregate/streamUrl/downloadUrl）、`WorkspaceProvider`（listFiles/fileUrl）。后端差异（真实 session-service / demo 内存模拟 / 未来新服务）MUST 由契约适配层吸收。

#### Scenario: 呈现层不直连后端
- **WHEN** 审查任一模块页面/组件代码
- **THEN** 其数据访问均经由 provider 接口，不出现对 REST 路径或 WS 帧的直接引用

### Requirement: TurnStream 事件模型同构
demo 能力域的 TurnStream（DemoAdapter 内存模拟）与真实能力域的 TurnStream（SessionServiceAdapter）MUST 暴露一致的事件类型集合（ready/delta/tool/todo/approval/complete/error/closed），保证能力域从 demo 转 GA 时呈现层零改动。

#### Scenario: 事件类型集合一致
- **WHEN** 以类型系统或契约测试比对 DemoAdapter 与 SessionServiceAdapter 的 TurnStream 事件类型
- **THEN** 两者事件类型集合一致

### Requirement: 会话可交互性判定
前端 MUST 只依赖 `resumable`/`read_only` 业务字段判定会话可交互性，不解读后端内部状态枚举；`canResumeSession ≡ resumable === true && !readOnly` 为唯一判定谓词。

#### Scenario: 只读会话仅可查阅
- **WHEN** 选中 `read_only=true` 的会话
- **THEN** 历史轮次可回显查阅，输入区禁用并展示只读标识
