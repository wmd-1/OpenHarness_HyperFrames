# Tasks: harden-web-frontend

**Change ID:** `harden-web-frontend`
**Spec delta:** `openspec/changes/harden-web-frontend/specs/web-front-end/spec.md`
**Repo:** `web/`
**Sources:** `web/CODE_REVIEW_REPORT.md`、`plans/Web_Frontend_Fix_Plan_2026-07-23.md`

> 每阶段结束跑质量门：`cd web && npm run lint && npm run test && npm run build`。
> TDD 优先：先补失败测试 → 实现 → 转绿。保持 dev/prod 同一 `api.ts` 契约（WF4）不破坏。
> 问题编号沿用审查报告（S/B/P/A/M/T）。

---

## Phase 0: 安全与资源泄漏（P0）

- [x] 0.1 **轮询失败停止/退避（B1）** — `store` 轮询 `catch` 增加连续失败计数，达 `MAX_POLL_FAILURES`（默认 3）调用 `stopStreams(id)`；成功分支重置计数；可选指数退避（2s→4s→8s，上限 30s）。
  - Files: `web/src/store.tsx`（L113–L121 区域）、`web/src/constants.ts`（新增）
  - Spec: ADDED WF7 · Scenario「轮询连续失败后停止」

- [x] 0.2 **nginx `api_key` 日志脱敏（S1）** — 定义去查询串的 `log_format`（或对含查询的 SSE/文件 location `access_log off`），使访问日志不含 `api_key` 明文。
  - Files: `web/nginx.conf.template`
  - Spec: ADDED WF6 · Scenario「访问日志脱敏 API Key」

- [x] 0.3 **nginx 安全响应头（S2）** — `server` 块统一 `add_header`（`always`）下发 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Content-Security-Policy`（`default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`）。
  - Files: `web/nginx.conf.template`
  - Spec: ADDED WF6 · Scenario「响应携带安全头」「CSP 不阻断核心功能」

- [x] 0.4 **API Key 存储文档告警（S3）** — `README.md` 增补本机存储风险与「公共设备清除」指引；依赖 0.3 的 CSP 兜底。（可选：`ApiKeyInput` 增加 sessionStorage 开关。）
  - Files: `web/README.md`、（可选）`web/src/components/ApiKeyInput.tsx`
  - Spec: ADDED WF6

**Quality Gate (Phase 0):**
- [x] `store` 测试：`getVideo` 连续 reject 达阈值后 `stopStreams` 被触发、轮询停止
- [x] Docker 冒烟：响应含 4 个安全头；`access_log` 不含 `api_key=`；SPA/`<video>`/`EventSource` 不被 CSP 阻断
- [x] `lint` / `test` / `build` 全绿

---

## Phase 1: 功能正确性与可用性（P1）

- [x] 1.1 **取消/删除分离（B2）** — `store` 新增 `cancel(id)`：调用 `deleteVideo` + `stopStreams`，置任务 `status:"canceled"` 并**保留**在 `tasks/order`；`remove(id)` 仅用于终态删除。`TaskDetail` 按钮据 `terminal` 分派（取消/删除）。
  - Files: `web/src/store.tsx`、`web/src/components/TaskDetail.tsx`
  - Spec: MODIFIED WF5 · Scenario「取消运行中任务保留任务并置为 canceled」「删除仅对终态任务生效」

- [x] 1.2 **SSE 断线重连 + 类型修正（B4）** — `error` 分支仅在终态或 `es.readyState === CLOSED` 时关闭，否则保留原生重连或带退避手动重连；`error` 事件按 `Event` 处理，不再断言 `MessageEvent.data`。
  - Files: `web/src/store.tsx`（L107–L112 区域）
  - Spec: ADDED WF7 · Scenario「SSE 临时断线可恢复」

- [x] 1.3 **任务持久化与重水合（B3）** — 持久化 `order`（`task_id[]`）到 `localStorage`；挂载 `useEffect` 逐个 `getVideo` 重建 `tasks`、对非终态 `startStreams`、对 404 从持久化清理（复用 0.1 失败上限，避免无限重试）。
  - Files: `web/src/store.tsx`、`web/src/constants.ts`
  - Spec: ADDED WF7 · Scenario「刷新后重建任务列表」

- [x] 1.4 **日志上限截断（P1）** — append 时 `slice(-MAX_LOG_LINES)`（默认 2000）；`TaskDetail` 超限提示「仅显示最近 N 行」。
  - Files: `web/src/store.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/constants.ts`
  - Spec: ADDED WF7 · Scenario「日志超上限被截断」

- [x] 1.5 **超时输入校验（B5）** — `Composer` `onChange` 用 `Math.max(1, Number(v) || DEFAULT_TIMEOUT)`；`<input type="number" min={1} max={7200}>`。
  - Files: `web/src/components/Composer.tsx`
  - Spec: MODIFIED WF5 · Scenario「超时输入非法时回退默认值」

- [x] 1.6 **健康检查周期刷新（B6）** — `getHealth` 放入 `setInterval`（`HEALTH_POLL_MS` 默认 30s），卸载清理；`types.ts` 收紧 `HealthResponse.status`。
  - Files: `web/src/store.tsx`、`web/src/types.ts`、`web/src/constants.ts`
  - Spec: ADDED WF7 · Scenario「健康状态周期刷新」

- [x] 1.7 **错误横幅去重（B7）** — 全局 `error` 只在单一位置渲染（顶层或 `Composer`）；`TaskDetail` 仅渲染任务级 `task.error`。
  - Files: `web/src/components/Composer.tsx`、`web/src/components/TaskDetail.tsx`
  - Spec: MODIFIED WF5 · Scenario「键盘可操作与标签关联」相邻的单一错误展示要求

**Quality Gate (Phase 1):**
- [x] `store` 测试：`cancel` 后任务保留且 `canceled`、流停止；`remove` 后任务消失
- [x] `store` 测试：SSE `error`（非终态）不永久关闭；重水合从持久化重建；日志 append 超限被截断
- [x] 手动验证：取消、刷新恢复、断线重连、超时非法回退
- [x] `lint` / `test` / `build` 全绿

---

## Phase 2: 可维护性、质量门与测试（P2）

- [x] 2.1 **删除编译产物 + `.gitignore`（M4）** — 删除 `web/vite.config.js`、`web/vite.config.d.ts`；新增 `web/.gitignore`（`dist`、`coverage`、`*.tsbuildinfo`、`vite.config.js`、`vite.config.d.ts`、`node_modules`、`.env.local`）。
  - Files: `web/.gitignore`（新增）、删除两个编译产物
  - Spec: ADDED WF8 · Scenario「仓库不含编译产物」

- [x] 2.2 **拆分 store + 恢复 lint 门禁（M6）** — 抽 `TasksContext`/`useTasks`/类型到 `web/src/store-context.ts`，`store.tsx` 仅导出 `TasksProvider`；`package.json` lint 去 `--ext ts,tsx`、`--max-warnings 9999` → `0`。
  - Files: `web/src/store-context.ts`（新增）、`web/src/store.tsx`、`web/package.json`
  - Spec: ADDED WF8 · Scenario「Lint 门禁零告警」

- [x] 2.3 **代码整洁化（M1/M2/M3/M5）** — `TERMINAL_STATUSES` 收敛到 `types.ts`（`store.tsx`/`TaskDetail.tsx` 共用）；`constants.ts` 收敛魔法数字并暴露 `eventsUrl`；`api.ts` 用 `new Headers(...)` 去双断言；`http` 可选接入 `AbortController`。
  - Files: `web/src/types.ts`、`web/src/constants.ts`、`web/src/api.ts`、`web/src/store.tsx`
  - Spec: 支撑 WF8（可维护性）；不改变对外行为

- [x] 2.4 **Context 拆分减重渲染（P2，可选）** — 拆 `TasksActionsContext` 与 `TasksStateContext`，日志高频更新不再触发动作消费者重渲染。先补测试（2.6）后重构。
  - Files: `web/src/store-context.ts`、`web/src/store.tsx`、消费组件
  - Spec: 支撑 WF7/WF8（健壮性/质量）

- [x] 2.5 **SSE/轮询冗余评估（P3）** — 评估让 SSE 承载状态、轮询降级为兜底；本任务仅记录决策，不强制实现。
  - Spec: 记录性（不产生新场景）

- [x] 2.6 **可访问性（A1/A2）** — `<label htmlFor>` + 控件 `id`；可点击 `<li>` 改 `<button>` 或加 `role="button" tabIndex onKeyDown`；错误横幅关闭键盘可达。
  - Files: `web/src/components/Composer.tsx`、`ApiKeyInput.tsx`、`TaskList.tsx`、错误横幅
  - Spec: MODIFIED WF5 · Scenario「键盘可操作与标签关联」

- [x] 2.7 **测试补齐（T1/T2）** — 新增 `web/src/__tests__/store.test.tsx` 覆盖：终态停轮询、失败停轮询、cancel 保留/remove 删除、SSE 累积/`done`/`error` 重连、刷新重水合、日志上限；组件测试：`StatusBadge`/`HealthBadge`/`ApiKeyInput`/`TaskList`/`TaskDetail`。
  - Files: `web/src/__tests__/**`
  - Spec: ADDED WF8 · Scenario「关键路径有测试护栏」

**Quality Gate (Phase 2):**
- [x] `npm run lint`（`--max-warnings 0`）0 error 0 warning
- [x] `npm run test` 全绿且覆盖 WF8 所列关键路径
- [x] `npm run build` 通过；仓库不含编译产物
- [x] CI `.github/workflows/web.yml` 通过

---

## Completion Checklist

- [x] Phase 0 完成（B1 停轮询 + S1 日志脱敏 + S2 安全头 + S3 文档）
- [x] Phase 1 完成（B2 取消语义 + B4 重连 + B3 持久化 + P1 日志上限 + B5/B6/B7）
- [x] Phase 2 完成（M4/M6/M1/M2/M3/M5 + P2/P3 + A1/A2 + T1/T2）
- [x] 三阶段质量门全部通过
- [x] Docker 冒烟：WF2/WF3 反代 + SSE + Range 仍成立，新增安全头/日志脱敏断言
- [x] `openspec validate harden-web-frontend --strict` 通过
- [x] 就绪于 `/openspec-archive harden-web-frontend`（届时把 WF5 修订与 WF6–WF8 并入 `openspec/specs/web-front-end.md` 基线）

---

## 问题 → 任务映射

| 问题 | 严重度 | 任务 | Spec |
|---|---|---|---|
| B1 | 🔴 | 0.1 | WF7 |
| S1 | 🔴 | 0.2 | WF6 |
| S2 | 🟠 | 0.3 | WF6 |
| S3 | 🟡 | 0.4 | WF6 |
| B2 | 🟠 | 1.1 | WF5 |
| B4 | 🟠 | 1.2 | WF7 |
| B3 | 🟠 | 1.3 | WF7 |
| P1 | 🟠 | 1.4 | WF7 |
| B5 | 🟡 | 1.5 | WF5 |
| B6 | 🟡 | 1.6 | WF7 |
| B7 | 🟡 | 1.7 | WF5 |
| M4 | 🟡 | 2.1 | WF8 |
| M6 | 🟡 | 2.2 | WF8 |
| M1/M2/M3/M5 | 🟡 | 2.3 | WF8 |
| P2 | 🟡 | 2.4 | WF7/WF8 |
| P3 | 🔵 | 2.5 | — |
| A1/A2 | 🟡 | 2.6 | WF5 |
| T1/T2 | 🟡 | 2.7 | WF8 |
