# Design: session-frontend-history-switch

> 权威设计源为已冻结的 `plans/Session_Frontend_History_Switch_Plan_2026-07-30.md`（rev2）。本文是其 OpenSpec 落成的浓缩决策记录：只固化决策与理由，实现细节（字段映射、文件清单、文案）以计划 F1-F6/§4 为准，冲突时以计划 rev2 为准。

## Context

- 后端 `session-service` 三个已归档变更（history-switch / container-pool / workspace-archive）交付了完整前端契约：`GET /v1/sessions`（`title`/`resumable`/`read_only`）、`GET /{sid}/turns`（游标分页，单页上限 200 = `OH_MAX_TURNS_PER_SESSION`，一页可拉全）、WS 准入关闭码 4430/4503/4500 + 结构化 error 帧 `code`、workspace files 双源 API。契约权威源：`session-service/API_DOCUMENTATION.md`；对应基线规格：`session-history-switch`、`session-workspace-archive`、`session-pool-scheduling`。
- 前端 `session-frontend` 现状（计划 §0 VERIFIED）：列表用 localStorage 缓存 ID；对话仅存内存、零历史回显；单 WS 连接架构已就位（`SessionWorkspace` 层唯一调 `useConversation`，切换即断旧连新）；WS 关闭码不认识 4430/4503；`isSessionTerminal(status)` 直接解读枚举违反契约；关闭会话直接 `removeSession`。
- 约束：不改后端；维持单 WS 架构；测试全部镜像内执行（`test-on-existing-images` 规则）。

## Goals / Non-Goals

**Goals:**

1. 会话列表服务端权威化（分页/标题/业务字段），废弃 localStorage ID 缓存。
2. 轮次历史 hydration（含 closed/expired 只读回看），与 WS 补发严格去重。
3. 容器池准入语义完整落地：4430/4503/4500 差异化、cold 唤醒等待态、让位可视化、创建错误映射。
4. 工作区文件面板（双源 + stale + 下载）。
5. 状态判断与后端枚举解耦（语义谓词层）。

**Non-Goals:**

- 不改后端任何代码/契约；不做多 WS 并联；不做文件预览/编辑与目录树；不做虚拟滚动；不做列表过滤 chip/搜索/后台轮询（Q2/Q3 裁决）；`web/` 前端不涉及。

## Decisions

### D1 列表数据模型：summary ∪ detail 合并（patch 语义）

`Session` 实体同时承载列表 summary 字段（`title`/`resumable`/`read_only`）与 detail 独有字段（`permission_policy`/`ws_url` 等，转为可选）。store 合并规则为 patch（新数据字段覆盖、未返回字段保留），防止 summary 刷新冲掉 `permission_policy`。`permission_policy` 缺失时选中会话补一次 detail GET（Q1 裁决：不改后端契约；未来后端加字段 merge 模型零改动兼容）。替代方案「双实体分开存」被否：切换/审批/展示处处要跨查，合并模型调用面最小。

### D2 状态解耦：语义谓词收敛（rev1/rev2 核心修订）

不扩大 `isSessionTerminal` 职责（保持原实现、不新增调用点）。新增三个谓词各司其职、互不复用：

- `canConnectSession`（`resumable===true`，字段缺失回退 `!isSessionTerminal`）——WS 建连门控**唯一**入口，切换编排（F3.1）统一走它，不散判 `resumable`/`read_only`；
- `isReadonlySession`（`read_only===true`）——输入禁用/只读徽标/文案;
- `canResumeSession`（`resumable && !isReadonlySession`）——卡片可点击性、唤醒流程门槛。**语义边界（rev2）**：现行契约下 `read_only=true` 必然 `resumable=false`，`!isReadonlySession` 是防御性冗余；若未来出现 `read_only+resumable` 并存态必须重新定义该谓词而非在调用点打补丁（谓词处留注释标注）。

理由：后端契约明确「加内部状态不破坏业务字段语义」，谓词层让加态只改一处映射。

### D3 hydration 与 WS 补发去重：三步严格串行（强约束）

切换会话必须串行：① hydrate 完成（或判定无需）→ ② `wsStore.setLastTurnIndex(sid, maxTurnIndex)` → ③ 才允许 WS 建连（`SessionWorkspace` 用 `hydrated` 门控传入 sessionId）。**禁止任何并行优化**（即使省几百毫秒首屏）。`completeTurn` 同 turnIndex 幂等仅作兜底而非依赖。拉取策略：`after_index=-1&limit=200` 一页拉全 + `items.length < total` while 兜底。hydrate 为整体替换（触发前提保证本地消息为空）。

### D4 错误归因：后端契约优先总则

准入/容器池错误判定只依据机器可解析契约：WS close code、error 帧 `code` 常量、REST 状态码 + `detail.code` + `Retry-After`。`status` 仅作展示辅助（选文案/徽标），禁止用它推断错误原因或决定重连策略。策略表：4430 不自动重连（置 `quota_exceeded` + 手动重试）；4503 有界 15s×4；4500 有界 2 次；default 分支保持既有网络断线退避不变。同一次失败「error 帧 + close 码」用一次性标志去重只出一条 banner。唤醒流程以 `canResumeSession` 为门槛，成败由 close/error code 判定。唯一豁免遗留：`turn_error` 审批超时文案匹配（待后端下发 code 后移除，不新增同类）。

### D5 关闭语义：保留只读而非移除

关闭成功后 patch `{status:'closed', read_only:true, resumable:false}` 留在列表；`removeSession` 收窄为 4404 专用。四不变量（不移除/不清历史/不建连/workspace+artifact 可访问）进单测与 E2E 验收。理由：对齐后端「closed 会话 turns/artifact 仍可读」契约。

### D6 文件面板与下载

右侧抽屉平铺列表 + `prefix` 过滤（Q4 裁决，不做目录树）；双源角标（live「实时」/archive「归档快照」+`last_synced_at`+`stale` 提示/none 空态）；下载复用产物 `?api_key=` 直链先例（`path` 逐段 encode，浏览器直链导航天然跟随 presigned 302，不受 CSP `connect-src` 影响）。面板打开时收 `turn_complete` 自动刷新。

### D7 列表刷新：事件驱动，不轮询（Q3 裁决）

五个触发：认证成功/创建成功/关闭成功/`session_ready`（让位可视化——旧会话变 cold）/window focus（≥10s 节流），手动刷新兜底。

## Risks / Trade-offs

- [hydration 与建连竞态致轮次重复] → D3 三步串行强约束 + 幂等兜底 + 单测/E2E 顺序断言。
- [status 长期耦合，后端加态即碎] → D2 谓词收敛 + D4 契约优先，加态只改谓词映射。
- [summary 刷新冲掉 detail 字段致审批帧误过滤] → D1 patch 语义 + 缺失时按 `interactive` 保守处理。
- [旧后端无列表接口] → 404/405 降级空列表 + 「后端版本过旧」banner，不回退 localStorage。
- [4503 重试与后端队列叠加] → 有界 4 次固定 15s（对齐队列超时），非指数放大，可手动取消。
- [关闭会话保留致列表膨胀] → 服务端分页截断；过滤 chip 留待后续（Q2）。
- [mock-backend 与真实契约漂移] → mock 结构从 `API_DOCUMENTATION.md` 示例复制；联调走 `Dockerfile.e2e` 全链路。

## Migration Plan

按计划 §7 五阶段：P1 契约层+列表 → P2 历史回显 → P3 WS 准入+创建错误 → P4 文件面板（可与 P2/P3 并行）→ P5 mock/E2E/流水线跑绿。纯前端源码变更，回滚即回退前端镜像 tag；localStorage `sf.sessionIds` 启动时清除、新增 `sf.currentSessionId`（无数据迁移风险）。

## Open Questions

无——Q1-Q4 已于 2026-07-30 全部裁决（见 proposal 与计划 §8），计划已冻结（rev2）。
