# Design Agent Space Module Specification

**Component:** `design-agent-frontend/src/modules/space/`（个人空间聚合视图）
**Established by change:** `add-design-agent-frontend` (2026-07-31)
**上游契约：** `session-service` 基线规格 `session-rest-api`（产物聚合的数据源）、平台规格 `design-agent-platform`（AgentRegistry + ArtifactProvider）

个人空间是各能力域 ArtifactProvider 的聚合呈现层，不自建数据源。真实产物与演示数据混合呈现，数据源可替换。

---

## Requirements

### Requirement: 产物聚合视图
个人空间 SHALL 是各 ArtifactProvider 聚合视图的呈现，不自建数据源。布局为标题区 + 三 tab（原型页面设计 / Drawio 设计 / 文本生成视频，带计数徽标）+ 卡片网格 + 分页（每页 6 条），默认激活「文本生成视频」tab。视频 tab 的真实产物 MUST 由现有契约派生：分页拉取会话列表后逐会话读取轮次并筛选 `has_artifact === true`（含已关闭/过期会话），按 `finished_at` 倒序展示；聚合实现 MUST 做并发限制与缓存（按 sid+turn_count 失效），聚合期间展示骨架屏、无数据展示空态。

#### Scenario: 视频产物展示与操作
- **WHEN** 租户内存在含产物的会话（含已关闭会话）并打开视频 tab
- **THEN** 产物卡片按完成时间倒序展示，每张卡片可预览（内嵌播放器，stream 模式）与下载（直链）

#### Scenario: 聚合期间骨架屏
- **WHEN** 视频 tab 聚合请求进行中
- **THEN** 展示骨架屏；聚合完成后无产物时展示空态样式

### Requirement: 真实与演示数据混合呈现
个人空间的 ui/drawio tab SHALL 渲染 demo 静态演示数据，保留 tab 切换、分页与占位下载交互，卡片 MUST 带「演示数据」标识；视频 tab 为真实数据不带该标识。

#### Scenario: 演示 tab 完整呈现
- **WHEN** 切换到 ui 或 drawio tab 并翻页
- **THEN** demo 数据完整呈现且每张卡片带演示标识

### Requirement: 数据源可替换性
视频产物聚合 MUST 封装在 ArtifactProvider 的 `aggregate()` 内；未来后端暴露产物列表 API 时，仅替换 provider 内部实现，个人空间页面呈现与分页语义 MUST 保持不变。

#### Scenario: provider 替换不影响页面
- **WHEN** 以契约测试将聚合数据源从前端 N+1 聚合替换为模拟的后端产物列表 API
- **THEN** 页面呈现与分页语义不变
