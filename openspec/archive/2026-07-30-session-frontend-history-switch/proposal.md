# Proposal: session-frontend-history-switch

> 设计源：`plans/Session_Frontend_History_Switch_Plan_2026-07-30.md`（rev2 已冻结，Q1-Q4 已裁决）。本 change 是该计划的 OpenSpec 落成，实现细节以计划为准，本文只固化 why / what / 能力边界。

## Why

后端 `session-service` 已交付历史会话切换全套契约（`GET /v1/sessions` 列表含 `title`/`resumable`/`read_only`、`GET /{sid}/turns` 轮次回显、WS 准入关闭码 4430/4503/4500 + error 帧 `code`、workspace 归档文件 API），但前端 `session-frontend` 完全未对接：会话列表仍用 localStorage 缓存 ID（换设备即丢）、切换会话零历史回显、容器池准入失败一律按网络断线无限重连、前端自行解读 `status` 枚举违反后端「只依赖 `resumable`/`read_only`」契约、归档文件不可见。「历史会话切换」目前只完成了后端一半。

## What Changes

- 会话列表切换到服务端权威源（分页 + 标题 + 业务字段驱动交互），**废弃** localStorage 会话 ID 缓存（`sf.sessionIds`）。
- 新增轮次历史回显（hydration）：选中任意会话回显完整历史（含 closed/expired 只读回看），与 WS `last_turn_index` 补发严格串行去重（hydrate 完成 → 写 last_turn_index → 建 WS，强约束不可并行）。
- 状态判断解耦为语义谓词 `canConnectSession`/`isReadonlySession`/`canResumeSession`（`isSessionTerminal` 职责不再扩大）；WS 建连唯一经 `canConnectSession` 门控。
- WS 准入失败差异化：4430 不自动重连、4503 有界 15s×4、4500 有界 2 次；错误归因**后端契约优先**（close code / error 帧 code / REST code），`status` 仅作展示辅助；cold 唤醒等待态与让位可视化。
- 创建会话容器池错误映射（429 双语义 / 403 每日配额 / 503+Retry-After 倒计时）。
- 新增工作区文件面板：live/archive/none 双源列表 + `stale` 提示 + `?api_key=` 直链下载（平铺 + prefix 过滤，本期不做目录树）。
- 关闭会话语义修正：**BREAKING（前端行为）** 关闭后不再从列表移除，改为保留只读态（不清历史、不建连、workspace/artifact 仍可访问）。
- 不改后端任何代码/契约；维持单 WS 连接架构；测试全部在既有镜像内执行。

## Capabilities

### New Capabilities

- `session-frontend-history-switch`: 前端历史会话切换能力——服务端权威会话列表（分页/标题/业务字段）、轮次历史 hydration 与补发去重时序、语义谓词状态解耦、切换编排、WS 准入失败差异化处理（4430/4503/4500）、cold 唤醒等待态、创建会话容器池错误映射。
- `session-frontend-workspace-files`: 前端工作区文件面板——live/archive/none 双源列表呈现、stale 提示、分页/prefix 过滤、单文件直链下载（presigned 302 跟随）。

### Modified Capabilities

- `session-ui-shell`: 「会话列表侧栏」需求变化——卡片增加 `title` 主行与只读/不可恢复徽标三态（可恢复/只读/置灰）、列表分页「加载更多」与刷新触发；关闭会话从「移除」改为「保留只读」（关闭确认文案随之调整）。

## Impact

- **代码**：仅 `session-frontend/src/**`（types/api/store/ws/hooks/components 约 20 个文件，详见计划 §4）+ `e2e/mock-backend.mjs` + Playwright 用例；无后端改动、无新依赖、无镜像 base 变更。
- **契约依赖**：`session-service/API_DOCUMENTATION.md` §2.6-2.9、§3.1-3.2（均已交付上线）；对应后端规格 `session-history-switch`、`session-workspace-archive`、`session-pool-scheduling`。
- **兼容性**：旧后端（无列表接口）降级为空列表 + 「后端版本过旧」banner，不回退 localStorage；`SessionSummary` 缺 `permission_policy` 由前端选中时补 detail GET 消解（Q1 裁决）。
- **测试**：vitest 单测 + Playwright E2E 全部走 `e2e/run-session-frontend-docker-tests.sh` 镜像内流水线（test-on-existing-images 规则）。
