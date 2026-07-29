# Web 前端修复计划（Web_Frontend_Fix_Plan）

**Created:** 2026-07-23
**关联报告:** `web/CODE_REVIEW_REPORT.md`
**关联基线:** `openspec/archive/establish-web-frontend/`（WF1–WF5）
**范围:** `web/`（Vite + React 18 + TypeScript SPA）

---

## 目标与原则

- 覆盖审查报告中**全部问题**（S1–S3、B1–B7、P1–P3、A1–A2、M1–M6、T1–T2）。
- 每项修复给出：**位置 → 方案 → 验收标准 → 回归测试**。
- 分三个阶段（P0/P1/P2）交付，每阶段结束跑质量门：`npm run lint`（恢复后 0 warning）、`npm run test`、`npm run build`。
- 不引入重依赖；保持 dev/prod 同一 `api.ts` 契约（WF4）。

## 阶段总览

| 阶段 | 主题 | 问题项 | 退出门 |
| --- | --- | --- | --- |
| **Phase 0** | 安全 + 资源泄漏（阻断风险） | B1, S1, S2, S3 | 轮询可停 + 安全头就位 + 无密钥入日志 |
| **Phase 1** | 功能正确性 + 可用性 | B2, B4, B3, P1, B5, B6, B7 | 取消/重连/持久化/日志上限达标 |
| **Phase 2** | 可维护性 + 质量门 + 测试 | M1–M6, P2, P3, A1, A2, T1, T2 | lint `--max-warnings 0`、覆盖率提升 |

---

## Phase 0 — 安全与资源泄漏（P0）

### 任务 0.1 · B1 轮询失败无法停止 🔴
- **位置:** `src/store.tsx` `startStreams` 的 `setInterval`（L113–L121）。
- **方案:**
  1. 在 `StreamHandles` 增加 `failCount`（或在闭包内用 `let fail = 0`）。
  2. `catch` 分支：`fail += 1; setError(String(err));`；当 `fail >= MAX_POLL_FAILURES`（建议 3）时调用 `stopStreams(id)` 停止轮询与 SSE。
  3. 成功分支重置 `fail = 0`。
  4. 可选增强：失败后按 `2s → 4s → 8s` 退避（用 `setTimeout` 递归替代 `setInterval`）。
- **验收:** 后端持续 404/500 时，最多重试 3 次后停止；不再无限刷错误横幅与网络请求。
- **回归测试:** 新增 `store` 测试：mock `getVideo` 连续 reject，断言 `stopStreams` 被触发、轮询停止（`clearInterval` 调用）。

### 任务 0.2 · S1 API Key URL 泄漏 — nginx 日志脱敏 + Referrer-Policy 🔴
- **位置:** `nginx.conf.template`。
- **方案:**
  1. 定义脱敏 `log_format` 并对 `events`/`file` location 用它，或对含查询串的媒体/SSE location 设 `access_log off;`。示例：
     ```nginx
     # http 或 server 级
     map $request_uri $clean_uri {
         "~^(?<p>[^?]*)"  $p;   # 去掉 ?api_key=... 查询串
     }
     log_format clean '$remote_addr - [$time_local] "$request_method $clean_uri" '
                      '$status $body_bytes_sent';
     ```
     在 `server` 块设 `access_log /var/log/nginx/access.log clean;`。
  2. `server` 块统一加 `add_header Referrer-Policy "no-referrer" always;`（切断 Key 经 `Referer` 外泄；与 0.3 合并落地）。
- **验收:** 访问 `/v1/videos/{id}/file?api_key=xxx` 后，`access.log` 不含 `api_key=`；响应带 `Referrer-Policy: no-referrer`。
- **回归测试:** 扩展现有 Docker 契约桩冒烟脚本（参照归档 Phase 3 证据），断言日志行无 `api_key` 子串、响应头含 `Referrer-Policy`。
- **中期项（记录，不在本阶段实现）:** 推动后端以短时签名令牌/一次性 token 替代明文 `?api_key=`；前端 `eventsUrl`/`fileUrl` 改为先换取 token。列入后端 backlog。

### 任务 0.3 · S2 nginx 安全响应头 🟠
- **位置:** `nginx.conf.template` `server` 块。
- **方案:** 统一添加（`always` 确保错误响应也带上）：
  ```nginx
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Content-Security-Policy
      "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" always;
  ```
  注意 `media-src` 需允许视频播放；`connect-src 'self'` 覆盖 fetch/EventSource（同源反代场景）。若部署使用 `VITE_API_BASE` 跨源，需把该源加入 `connect-src`/`media-src`。
- **验收:** 首页与 API 响应均带上述头；SPA 正常渲染、视频可播、SSE 正常。
- **回归测试:** 冒烟脚本断言四个响应头存在；手动/自动验证 CSP 不阻断 `<video>` 与 `EventSource`。

### 任务 0.4 · S3 API Key 存储加固（文档 + CSP 兜底）🟡
- **位置:** `src/components/ApiKeyInput.tsx`、`web/README.md`。
- **方案:** 维持 `localStorage`（浏览器 SSE/文件限制下的既有权衡），但：
  1. 依赖 0.3 的 CSP 降低 XSS 面。
  2. `README.md` 增补安全说明：Key 仅存本机、公共设备请「清除」、部署方应启用 HTTPS 与 CSP。
  3. 可选：`ApiKeyInput` 增加「仅本会话保存（`sessionStorage`）」开关。
- **验收:** 文档更新；CSP 生效。
- **回归测试:** N/A（文档 + 依赖 0.3）。

**Phase 0 退出门:** `lint`/`test`/`build` 全绿；B1 回归测试通过；Docker 冒烟脚本验证日志脱敏 + 4 个安全头。

---

## Phase 1 — 功能正确性与可用性（P1）

### 任务 1.1 · B2 取消语义修正（取消 ≠ 删除）🟠
- **位置:** `src/store.tsx`（`remove`）、`src/components/TaskDetail.tsx`（按钮）。
- **方案:**
  1. `store` 新增 `cancel(id)`：调用 `deleteVideo(id)`（后端取消），**保留任务**并置 `status: "canceled"`，`stopStreams(id)`；不从 `tasks/order` 删除。
  2. 保留 `remove(id)` 仅用于终态任务的真正删除（从列表移除）。
  3. `TaskDetail` 按钮据 `terminal` 分派：非终态 →「取消任务」调 `cancel`；终态 →「删除任务」调 `remove`。
- **验收:** 取消运行中任务后，任务仍在列表且状态显示「已取消」；对已取消/失败/成功任务点「删除」才移除。符合 WF5「取消 → CANCELED 提示」。
- **回归测试:** `store` 测试：`cancel` 后任务仍存在且 `status==="canceled"`、流已停；`remove` 后任务消失。

### 任务 1.2 · B4 SSE 断线重连 + 类型修正 🟠
- **位置:** `src/store.tsx` `startStreams` 的 `error` 监听（L107–L112）。
- **方案:**
  1. 不再无条件 `es.close()`。区分：任务已终态或 `es.readyState === EventSource.CLOSED` → 关闭；否则保留浏览器原生重连，或实现带退避（2s→4s→8s，上限 30s）的手动重连。
  2. 修正类型：`error` 事件按 `Event` 处理，不再断言 `MessageEvent.data`；仅在确有 `data` 时 `setError`。
- **验收:** 模拟临时断线后 SSE 能恢复接收 `log` 事件；终态时正确关闭不再重连。
- **回归测试:** `store` 测试用 FakeEventSource 触发 `error`（非终态）→ 断言未永久关闭 / 触发重连逻辑；终态 → 断言关闭。

### 任务 1.3 · B3 任务持久化与刷新重水合 🟠
- **位置:** `src/store.tsx`。
- **方案:**
  1. 持久化最小信息：`order`（`task_id[]`）到 `localStorage`（键如 `oh_tasks`）。每次 `create`/`remove` 后同步。
  2. 挂载 `useEffect`：读取持久化 `order`，对每个 id 调 `getVideo` 重水合 `tasks`；对非终态任务 `startStreams` 重开流。失败（404）的 id 从持久化清理。
  3. 注意与 B1 的失败停止逻辑协同（重水合失败不应触发无限重试）。
- **验收:** 刷新页面后任务列表恢复；运行中任务恢复日志/状态流；已删任务不复现。
- **回归测试:** `store` 测试：预置 `localStorage` order + mock `getVideo`，断言挂载后 `tasks` 重建、非终态重开流。

### 任务 1.4 · P1 日志上限 + 渲染优化 🟠
- **位置:** `src/store.tsx`（append）、`src/components/TaskDetail.tsx`（render）。
- **方案:**
  1. append 时截断：保留最近 `MAX_LOG_LINES`（建议 2000）行，超出丢弃头部（`slice(-MAX_LOG_LINES)`）。
  2. 渲染：超长时提示「仅显示最近 N 行」；如需要进一步优化再引入轻量虚拟列表（保持最小依赖，先做截断）。
- **验收:** 注入上万行日志时页面不卡死；内存与渲染受控。
- **回归测试:** `store` 测试：append 超过上限后数组长度被限制在 `MAX_LOG_LINES`。

### 任务 1.5 · B5 超时输入校验 🟡
- **位置:** `src/components/Composer.tsx` L27–L31。
- **方案:** `onChange` 用 `setTimeoutSeconds(Math.max(1, Number(e.target.value) || DEFAULT_TIMEOUT))`；`<input type="number" min={1} max={7200}>`。
- **验收:** 清空/非法输入不再提交 0/NaN。
- **回归测试:** 组件测试：清空输入后提交，断言 `createVideo` 收到合法秒数。

### 任务 1.6 · B6 健康检查周期刷新 🟡
- **位置:** `src/store.tsx` L85–L89、`HealthBadge`。
- **方案:** `getHealth` 放入 `setInterval`（`HEALTH_POLL_MS`，建议 30s），卸载清理；沿用 `ok = status === "ok"`（可在 `types.ts` 收紧 `HealthResponse.status` 为已知字面量联合 + 兜底 string）。
- **验收:** 后端宕机/恢复在 ≤30s 内反映到徽标。
- **回归测试:** `store` 测试：advance timers 后 `getHealth` 再次被调用、`health` 更新。

### 任务 1.7 · B7 错误横幅去重 🟡
- **位置:** `Composer.tsx` L42–L46、`TaskDetail.tsx` L34–L38。
- **方案:** 全局 `error` 只在一处渲染（建议顶层 `App` 或 `Composer`），`TaskDetail` 仅渲染任务级 `task.error`。
- **验收:** 同一错误不再双份显示。
- **回归测试:** 组件测试：触发全局错误，断言页面仅一处错误横幅。

**Phase 1 退出门:** `lint`/`test`/`build` 全绿；B2/B3/B4/P1 新增回归测试通过；手动验证取消、刷新恢复、断线重连。

---

## Phase 2 — 可维护性、质量门与测试（P2）

### 任务 2.1 · M4 删除编译产物 + 新增 `web/.gitignore` 🟡
- **位置:** `web/vite.config.js`、`web/vite.config.d.ts`；新建 `web/.gitignore`。
- **方案:** 删除两个编译产物；`web/.gitignore` 加入：
  ```
  dist
  coverage
  *.tsbuildinfo
  vite.config.js
  vite.config.d.ts
  node_modules
  .env.local
  ```
- **验收:** 版本库不再含编译产物；`npm run build` 后不再引入脏文件。
- **回归测试:** N/A（`build` 仍通过）。

### 任务 2.2 · M6 拆分 store + 恢复 lint 门禁 🟡
- **位置:** `src/store.tsx`、`package.json` L10。
- **方案:**
  1. 将 `TasksContext`、`useTasks`、类型接口抽到 `src/store-context.ts`；`store.tsx` 仅导出 `TasksProvider` 组件 → 消除 `react-refresh/only-export-components` 警告。
  2. `package.json` lint 脚本去掉冗余 `--ext ts,tsx`，把 `--max-warnings 9999` 改为 `--max-warnings 0`。
- **验收:** `npm run lint` 0 error 0 warning。
- **回归测试:** CI `web.yml` 的 Lint 步骤通过。

### 任务 2.3 · M1/M2/M3/M5 代码整洁化 🟡
- **位置:** `types.ts`、新建 `src/constants.ts`、`api.ts`、`store.tsx`。
- **方案:**
  - **M1:** `export const TERMINAL_STATUSES: TaskStatus[]` 收敛到 `types.ts`，`store.tsx` 与 `TaskDetail.tsx` 共用。
  - **M3:** 新建 `constants.ts` 收敛 `POLL_INTERVAL_MS=2000`、`DEFAULT_TIMEOUT=600`、`SAVE_HINT_MS=2000`、`ID_SLICE=8`、`MAX_LOG_LINES=2000`、`HEALTH_POLL_MS=30000`、`MAX_POLL_FAILURES=3`；context 补充暴露 `eventsUrl`（对称）。
  - **M2:** `api.ts` 用 `new Headers(init?.headers)` 合并，去掉 `as unknown as` 双断言。
  - **M5:** `http` 接入 `AbortController`（可选参数），组件卸载/切换时中止在途请求。
- **验收:** 无重复常量；无双重断言；类型检查通过。
- **回归测试:** 现有 `api.test.ts` 仍通过（headers 断言可能需从对象改为 `Headers` 读取）。

### 任务 2.4 · P2 Context 拆分减少重渲染 🟡
- **位置:** `src/store-context.ts`（2.2 产出）。
- **方案:** 拆两个 context：`TasksActionsContext`（稳定的 create/select/cancel/remove/clearError）与 `TasksStateContext`（tasks/order/logs/activeId/error/health/busy）。组件按需订阅，日志高频更新不再触发动作消费者重渲染。
- **验收:** 日志刷新时 `TaskList`/`HealthBadge` 不重渲染（React DevTools/测试计数验证）。
- **回归测试:** 可加渲染计数测试（可选）。

### 任务 2.5 · P3 SSE/轮询冗余（评估）🔵
- **方案:** 评估让 SSE 承载状态变更（若后端 `done`/状态事件可靠），轮询降级为「仅在 SSE 断开时兜底」。属设计决策，本阶段仅出结论记录，不强制实现。
- **验收:** 决策文档化（本计划勾选或注记）。

### 任务 2.6 · A1/A2 可访问性 🟡
- **位置:** `Composer.tsx`、`ApiKeyInput.tsx`、`TaskList.tsx`、错误横幅。
- **方案:**
  - **A1:** `<label htmlFor="prompt">` + 对应控件 `id`（prompt/timeout/idempotency/apikey）。
  - **A2:** 可点击 `<li>` 改为内部 `<button>` 或加 `role="button" tabIndex={0} onKeyDown`（Enter/Space 触发 `select`）；错误横幅关闭改用 `<button>` 或加键盘处理。
- **验收:** 键盘可完整操作；label 关联正确（axe/手动）。
- **回归测试:** 组件测试用 `getByLabelText` 定位输入；键盘事件触发选择。

### 任务 2.7 · T1/T2 测试补齐 🟡
- **位置:** 新增 `src/__tests__/store.test.tsx` 及组件测试。
- **方案:** 覆盖：
  1. 终态停止轮询（B1 成功路径）+ 连续失败停止（B1 失败路径）。
  2. `cancel` 保留任务 / `remove` 删除任务（B2）。
  3. SSE `log` 累积、`done` 关闭、`error` 重连（B4）。
  4. 刷新重水合（B3）。
  5. 日志上限截断（P1）。
  6. 组件：`StatusBadge` 文案映射、`HealthBadge` ok/bad、`ApiKeyInput` 保存/清除 localStorage、`TaskList` 空态/选择、`TaskDetail` 各状态渲染。
- **验收:** 测试数显著增加，关键逻辑均有护栏；`npm run test` 全绿。
- **回归测试:** 即本任务产出。

**Phase 2 退出门:** `npm run lint`（`--max-warnings 0`）、`npm run test`、`npm run build` 全绿；CI `web.yml` 通过。

---

## 问题 → 任务 映射表

| 问题 | 阶段 | 任务 |
| --- | --- | --- |
| B1 | P0 | 0.1 |
| S1 | P0 | 0.2 |
| S2 | P0 | 0.3 |
| S3 | P0 | 0.4 |
| B2 | P1 | 1.1 |
| B4 | P1 | 1.2 |
| B3 | P1 | 1.3 |
| P1 | P1 | 1.4 |
| B5 | P1 | 1.5 |
| B6 | P1 | 1.6 |
| B7 | P1 | 1.7 |
| M4 | P2 | 2.1 |
| M6 | P2 | 2.2 |
| M1/M2/M3/M5 | P2 | 2.3 |
| P2 | P2 | 2.4 |
| P3 | P2 | 2.5 |
| A1/A2 | P2 | 2.6 |
| T1/T2 | P2 | 2.7 |

## 全局验收（Definition of Done）

- 报告中 S1–S3、B1–B7、P1–P3、A1–A2、M1–M6、T1–T2 全部处理或明确记录决策。
- 质量门：`npm run lint`（`--max-warnings 0`）、`npm run test`、`npm run build` 全绿；CI `web.yml` 通过。
- Docker 冒烟：反代 + SSE + Range 契约仍成立（WF2/WF3），且新增「安全头存在 + 日志无 api_key」断言。
- 无引入重依赖；dev/prod 共用同一 `api.ts` 契约（WF4）不破坏。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| CSP 误伤 `<video>`/SSE | `media-src 'self' blob:`、`connect-src 'self'`；跨源部署时把 `VITE_API_BASE` 源纳入白名单；冒烟验证 |
| 持久化重水合触发无限重试 | 复用 B1 的失败上限；404 即从持久化清理 |
| SSE 重连风暴 | 指数退避 + 上限 + 终态停止 |
| Context 拆分回归 | 先补测试（2.7）再重构（2.4） |
