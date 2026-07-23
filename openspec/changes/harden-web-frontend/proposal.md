# Proposal: 前端硬化与健壮性（harden-web-frontend）

**Change ID:** `harden-web-frontend`
**Created:** 2026-07-23
**Status:** Draft
**Capability:** `web-front-end`（既有基线，MODIFY + ADD）
**Repos touched:** `web/`
**Sources:** `web/CODE_REVIEW_REPORT.md`、`plans/Web_Frontend_Fix_Plan_2026-07-23.md`

---

## Why

`establish-web-frontend`（2026-07-17）已把前端建立为一等 OpenSpec 能力并交付 MVP（WF1–WF5）。近期对 `web/` 的全面代码审查发现：基线 MVP 在**安全**、**运行时健壮性**与**质量门**上存在多处缺口，其中两项达 🔴 高危：

- **B1（🔴）**：状态轮询失败后**不停止、无退避**，任务被删/鉴权失效/后端 4xx 时每 2s 无限重试并刷屏报错——资源泄漏 + UX 破坏。
- **S1（🔴）**：API Key 经 `?api_key=<key>` 拼入 URL（`fileUrl`/`eventsUrl`），泄漏进 nginx `access_log`、浏览器历史、`Referer`、DOM；`nginx.conf.template` 无日志脱敏。
- **S2（🟠）**：nginx 缺 `Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`。
- **B2（🟠）**：「取消任务」语义错误——取消运行中任务时把它从 UI 彻底删除，与 WF5「取消 → CANCELED 提示」不符。
- **B3/B4（🟠）**：刷新即丢全部任务（无持久化/重水合）；SSE `error` 无条件 `close()` 禁用了浏览器原生重连，断线后日志流永久中断。
- **P1（🟠）**：日志 append 为 O(n²) 且全量渲染、无上限，长任务卡顿。
- **M4/M6/T1/T2（🟡）**：仓库提交了编译产物 `vite.config.js`/`.d.ts` 且缺 `web/.gitignore`；`--max-warnings 9999` 削弱了 lint 门禁（掩盖 `store.tsx` 的 react-refresh 警告）；`store`/组件测试覆盖缺失。

本变更把这些修复沉淀为规格：**MODIFY WF5**（任务生命周期，修正取消语义/校验/可访问性/单一错误横幅），并**ADD WF6–WF8**（安全加固、任务流健壮性与持久化、质量门与测试基线）。

## What Changes

- **MODIFY WF5 — 任务生命周期 UI**：取消（`cancel`）与删除（`remove`）分离——取消运行中任务后**保留任务并置 `canceled`**，仅终态任务可真正删除；超时输入做 `NaN`/下限兜底；全局错误横幅只渲染一处；可点击列表项与关闭控件键盘可达、`<label>` 与控件关联。
- **ADD WF6 — 前端安全加固**：nginx `server` 块统一下发安全响应头（CSP/nosniff/`X-Frame-Options: DENY`/`Referrer-Policy: no-referrer`）；对含 `api_key` 的请求做 `access_log` 脱敏（去除查询串）；README 补充 API Key 存储告警与「公共设备清除」指引。中期项记录：后端以短时签名令牌替代明文 `?api_key=`（跨仓库 backlog，不在本变更实现）。
- **ADD WF7 — 任务流健壮性与持久化**：轮询失败计数达阈值（默认 3）即停止流（或指数退避）；SSE 仅在终态/`CLOSED` 才关闭，否则保留原生重连或带退避手动重连；`order` + `task_id` 持久化到 `localStorage`，挂载时逐个 `getVideo` 重水合、非终态重开流、404 清理；健康检查周期刷新（~30s）；日志保留最近 `MAX_LOG_LINES`（默认 2000）行并截断头部。
- **ADD WF8 — 前端质量门与测试基线**：删除编译产物并新增 `web/.gitignore`；拆分 `store.tsx`（context/hook 独立文件）消除 react-refresh 警告并把 lint 恢复为 `--max-warnings 0`；补 `store` 行为测试（终态停轮询、失败停轮询、取消保留、SSE 累积/done/error、重水合、日志上限）与纯组件测试。

## Scope

### In Scope
- `web/src/**`（store 拆分与健壮性、组件校验/可访问性、常量收敛）、`web/nginx.conf.template`（安全头 + 日志脱敏）、`web/package.json`（lint 门禁）、`web/.gitignore`（新增）、`web/README.md`（安全说明）、`web/src/__tests__/**`（测试补齐）。

### Out of Scope
- 后端 service 逻辑与鉴权实现（见 `harden-video-service-impl-fixes` / R15）。
- 用签名令牌替代 `?api_key=` 的**后端**实现（本变更仅记录为中期 backlog）。
- 引入重前端框架/状态库或路由（保持最小依赖，WF1 不变）。
- i18n（沿用 `establish-web-frontend` 的 N/A 判定）。

## Impact Analysis

| Component | Change Required | Details |
|---|---|---|
| `web/src/store.tsx` (+ `store-context.ts`) | Yes | 轮询停止/退避、SSE 重连、持久化重水合、健康轮询、日志上限、cancel/remove 分离、context 拆分 |
| `web/src/components/*` | Yes | Composer 超时校验、单一错误横幅、`<label htmlFor>`、可点击项键盘可达、按钮 cancel/remove 分派 |
| `web/src/api.ts` / `types.ts` / `constants.ts` | Yes | `TERMINAL_STATUSES` 收敛、`Headers` 合并去双断言、可选 `AbortController`、常量集中 |
| `web/nginx.conf.template` | Yes | 安全响应头 + `api_key` 日志脱敏 |
| `web/package.json` | Yes | lint 恢复 `--max-warnings 0`、去冗余 `--ext` |
| `web/.gitignore`（新增）、删除 `vite.config.js`/`.d.ts` | Yes | 移除编译产物 |
| `web/README.md` | Yes | API Key 安全说明 |
| `web/src/__tests__/**` | Yes | store 行为 + 组件测试 |
| Backend / DB / API | No | 不改后端；同源反代契约（WF2/WF3/WF4）不破坏 |

## Success Criteria

- [ ] 轮询在连续失败达阈值后停止，不再无限重试刷屏（B1）。
- [ ] nginx 响应含 CSP/nosniff/X-Frame-Options/Referrer-Policy，且 `access_log` 不含 `api_key=`（S1/S2）；SPA 渲染、`<video>` 播放、`EventSource` 均不被 CSP 阻断。
- [ ] 取消运行中任务后任务仍在列表且状态为「已取消」；仅终态任务可删除（B2 / WF5）。
- [ ] 刷新页面后任务列表恢复，非终态任务重开流；SSE 临时断线可恢复日志（B3/B4）。
- [ ] 日志超过 `MAX_LOG_LINES` 时被截断，长任务不卡顿（P1）。
- [ ] `npm run lint`（`--max-warnings 0`）、`npm run test`、`npm run build` 全绿；仓库不再含 `vite.config.js`/`.d.ts`（M4/M6）。
- [ ] `store` 与组件关键路径有测试护栏（T1/T2）。
- [ ] Docker 冒烟仍满足 WF2/WF3（反代 + SSE + Range），新增「安全头存在 + 日志无 api_key」断言。
- [ ] `openspec validate harden-web-frontend --strict` 通过。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| CSP 误伤 `<video>`/SSE | Med | Med | `media-src 'self' blob:`、`connect-src 'self'`；跨源部署把 `VITE_API_BASE` 源纳入白名单；冒烟验证 |
| 持久化重水合触发无限重试 | Low | Med | 复用 WF7 失败上限；404 即从持久化清理 |
| SSE 重连风暴 | Low | Med | 指数退避 + 上限 + 终态停止 |
| Context 拆分回归 | Low | Low | 先补测试（WF8）再重构（P2） |
