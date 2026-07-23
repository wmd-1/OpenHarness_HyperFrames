# `web` 前端代码审查报告

> **审查对象**：`web/`（Vite + React 18 + TypeScript SPA，「HyperFrames 视频工厂」控制台）
> **参考基线**：`openspec/archive/establish-web-frontend/`（规格 WF1–WF5）
> **审查范围**：源码、状态管理、API 客户端、测试、构建/容器化、nginx 反代、CI
> **审查日期**：2026-07-23

---

## 整体评价

这是一个 **结构清晰、职责分层良好的高质量 MVP**，与归档规格 WF1–WF5 高度吻合（SPA 架构、同源反代、独立镜像、dev/prod 一致、任务生命周期 UI 均已落地）。代码风格统一，类型严格（`strict: true`），无重依赖。

主要问题集中在三个方面：

- **安全加固**：API Key 泄漏面（URL query 传递）+ 缺失安全响应头；
- **运行时逻辑缺陷**：轮询无法停止、取消语义错误、无状态持久化、SSE 断线不重连；
- **测试覆盖与可维护性细节**。

无会导致构建/类型失败的阻塞性缺陷。

---

## 1. 代码结构和组织分析

分层规范，符合规格 WF1「API 客户端集中 / 类型集中」：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `main.tsx` → `App.tsx` | 挂载 + 布局骨架 |
| 状态 | `store.tsx` | React Context，多任务态（tasks/order/logs/activeId/health/busy）+ SSE + 轮询 |
| API | `api.ts` | 统一 `fetch` 封装 + `fileUrl`/`eventsUrl` |
| 类型 | `types.ts` | 后端契约类型（小写枚举） |
| 组件 | `components/*` | `Composer`/`TaskList`/`TaskDetail`/`StatusBadge`/`HealthBadge`/`ApiKeyInput` |
| 测试 | `__tests__/*` | vitest（api 客户端 + App 交互） |
| 构建/部署 | `Dockerfile`/`nginx.conf.template`/`docker-entrypoint.sh` | 独立多阶段镜像 + 同源反代 |

**优点**：单向数据流清晰；组件均为纯展示 + `useTasks()` 消费；容器化文档详尽；CI（`web.yml`）覆盖 lint/test/build/image。

**结构性问题**：仓库内提交了编译产物 `vite.config.js` 与 `vite.config.d.ts`（源文件 `vite.config.ts` 的构建产物）。它们虽在 `.dockerignore` 中排除，但已进入版本库，属噪音且易与源文件产生歧义（详见 M4）。`web/` 目录也缺少自己的 `.gitignore`。

---

## 2 & 3 & 4. 问题清单（含位置、描述、严重程度）

> 严重程度：🔴 高 / 🟠 中 / 🟡 低 / 🔵 提示

### 🔴 安全类

#### S1 — API Key 通过 URL 查询参数传递，存在多路径泄漏 · 🔴 高
**位置**：`src/api.ts` L69–L79（`fileUrl`/`eventsUrl`）
`fileUrl`/`eventsUrl` 把 `?api_key=<key>` 拼进 URL。虽然 README 解释了「浏览器 SSE/文件下载无法自定义头」的技术限制，但 URL 中的密钥会落入：nginx `access_log`、上游代理日志、浏览器历史、`<video src>` 的 DOM、以及 `Referer` 头（跳转/外链时）。当前 `nginx.conf.template` 未做任何日志脱敏。

#### S2 — nginx 缺失基础安全响应头 · 🟠 中（结合鉴权部署偏高）
**位置**：`nginx.conf.template`（全文）
未设置 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options`/`frame-ancestors`、`Referrer-Policy`。SPA 暴露于点击劫持、MIME 嗅探；缺 CSP 放大 S3 的 XSS 影响面，并使 S1 的 API Key 更易经 `Referer` 外泄。

#### S3 — API Key 存于 `localStorage`（XSS 可窃取）· 🟡 低-中
**位置**：`src/api.ts` L11–L17、`src/components/ApiKeyInput.tsx`
`localStorage` 不隔离、无过期，任何 XSS 都可读取。当前 React 默认转义且无 `dangerouslySetInnerHTML`，风险可控，但配合缺失的 CSP（S2）需警惕。属公认权衡，建议至少加 CSP 与文档告警。

### 🔴 / 🟠 逻辑与 Bug 类

#### B1 — 轮询失败后无法停止，持续每 2s 报错 · 🔴 高
**位置**：`src/store.tsx` L113–L121
`setInterval` 里 `getVideo` 抛错只 `setError`，**不停止轮询、无退避**。若任务被删/鉴权失效/后端 404，将每 2 秒无限刷错误横幅并持续打网络请求，直到组件卸载。资源泄漏 + UX 破坏。

#### B2 — “取消任务”语义错误：把运行中的任务从 UI 彻底删除 · 🟠 中
**位置**：`src/components/TaskDetail.tsx` L44–L46、`src/store.tsx` L159–L181
非终态时按钮显示「取消任务」，但 `remove()` 会调用 `deleteVideo` 后**从本地 state 删除该任务**。用户「取消」运行中任务后，任务从列表消失、无法再观察最终状态。规格 WF5 期望「取消 → CANCELED 提示」，即应保留任务并更新状态，而非移除。

#### B3 — 刷新页面即丢失全部任务（无持久化 / 无重水合）· 🟠 中
**位置**：`src/store.tsx` L62–L69
`tasks/order` 仅存内存，且启动时不从后端拉取已知任务。刷新后列表清空，即便后端仍有运行中/已完成任务也无法恢复。规格允许「任务态在内存」，但对默认 600s 的长耗时视频任务控制台，这是明显可用性缺口。

#### B4 — SSE `error` 处理关闭 EventSource，禁用浏览器原生自动重连 · 🟠 中
**位置**：`src/store.tsx` L107–L112
EventSource 的 `error` 事件在网络抖动时也会触发（且它是 `Event` 而非 `MessageEvent`，`(e as MessageEvent).data` 通常为 `undefined`）。这里无条件 `es.close()`，导致临时断线后**日志流永久中断**（后续只能靠轮询看状态，看不到日志）。类型断言亦具误导性。

#### B5 — 超时输入无校验，可提交 0 / NaN · 🟡 低
**位置**：`src/components/Composer.tsx` L27–L31
`Number(e.target.value)`，清空输入时得 `0`，异常输入得 `NaN`，直接透传给 `createVideo`。缺 `min`/`max`/`NaN` 兜底。

#### B6 — HealthBadge 只在挂载时探测一次，永不刷新 · 🟡 低
**位置**：`src/store.tsx` L85–L89、`src/components/HealthBadge.tsx`
`getHealth` 单次调用，后端后续宕机/恢复不反映；且 `ok = health === "ok"`，而 `HealthResponse.status` 是自由字符串，字段契约较弱。

#### B7 — 同一 `error` 在 Composer 与 TaskDetail 同时渲染两份 · 🟡 低
**位置**：`src/components/Composer.tsx` L42–L46、`src/components/TaskDetail.tsx` L34–L38
两处读同一全局 `error`，并列展示同一条错误横幅。

### 🟠 性能类

#### P1 — 日志追加 O(n²) 且全量渲染，无虚拟化 · 🟠 中
**位置**：`src/store.tsx` L96–L102、`src/components/TaskDetail.tsx` L51–L57
每条 `log` 事件 `[...(prev[id] ?? []), line]` 复制整个数组；`<pre>` 全量渲染 `<div>`。长任务日志上千行时明显卡顿，且无上限截断。

#### P2 — Context value 因 `logs`/`tasks` 频繁变化触发全体消费者重渲染 · 🟡 低
**位置**：`src/store.tsx` L185–L201
`value` 依赖 `logs`，每来一条日志整个 context 变化，`TaskList`、`HealthBadge` 等无关组件全部重渲染。可拆分 context 或用 selector。

#### P3 — SSE 与 2s 轮询并存，状态信息冗余双通道 · 🔵 提示
**位置**：`src/store.tsx` L93–L123
`startStreams` 同时开 SSE 和状态轮询。若 SSE 已能携带终态，可减少一半请求量。属设计权衡，非缺陷。

### 🟠 可访问性（A11y）

#### A1 — `<label>` 未与输入控件关联 · 🟡 低
**位置**：`src/components/Composer.tsx`、`src/components/ApiKeyInput.tsx`
所有 `<label>` 均为独立文本，无 `htmlFor`/`id` 或包裹关系，屏幕阅读器无法关联。

#### A2 — 可点击 `<li>` 与错误横幅缺少键盘可达性 · 🟡 低
**位置**：`src/components/TaskList.tsx` L18–L23、错误横幅 `<div onClick>`
`<li onClick>` 无 `role="button"`/`tabIndex`/键盘事件；错误横幅用 `<div onClick>` 关闭，键盘用户无法操作。

### 🟡 可维护性 / 代码风格

- **M1 — `TERMINAL` 重复定义**：`store.tsx` L21（`TaskStatus[]`）与 `TaskDetail.tsx` L4（未类型化 `string[]`）两份，易漂移。应抽到 `types.ts` 单一来源。
- **M2 — `http` 的 headers 合并用 `as unknown as` 双重断言**：`api.ts` L21–L23，脆弱且绕过类型系统。可用 `Headers` 或收窄 `HeadersInit`。
- **M3 — 接口不对称 / 魔法数字**：Context 只暴露 `fileUrlFor` 不暴露 `eventsUrl`；`2000`（轮询）、`600`（默认超时）、`2000`（保存提示）、`slice(0,8)` 等魔法数字散落，宜集中为常量。
- **M4 — 提交了编译产物** `vite.config.js` / `vite.config.d.ts`；且 `web/` 缺 `.gitignore`。
- **M5 — 无 `AbortController`**：`http` 无法取消在途请求，卸载/切换时可能状态更新到已卸载组件。
- **M6 — lint 门禁被削弱**：`package.json` L10 用 `--max-warnings 9999` 实际关闭 warning 门禁，掩盖了 `store.tsx` 触发的 `react-refresh/only-export-components` 警告（同文件既导出组件 `TasksProvider` 又导出 hook `useTasks`）。ESLint 9 flat config 下 `--ext ts,tsx` 亦冗余。

### 🟡 测试

- **T1 — 覆盖面窄**：仅 `api.ts`（9）+ `App` happy path（2）。**未覆盖**：`store` 关键逻辑（终态停轮询、`remove`、SSE 日志累积、`stopAll` 清理）、`TaskList`/`TaskDetail`/`StatusBadge`/`HealthBadge`/`ApiKeyInput`。
- **T2 — 无失败/取消/删除路径测试**，无 SSE `done`/`error` 事件测试，无轮询终态停止的回归测试（正是 B1 所需护栏）。

---

## 5. 改进建议与修复方案（可操作摘要）

> 详细分阶段实施步骤见 `plans/Web_Frontend_Fix_Plan_2026-07-23.md`。

| 编号 | 修复方向 |
| --- | --- |
| S1/S2 | nginx 日志脱敏含 `api_key` 的请求行；`server` 块统一加 `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy: no-referrer`/CSP；中期推动后端签名令牌替代明文 `?api_key=` |
| B1 | 轮询 `catch` 中连续失败计数 → 达阈值 `stopStreams` 并置错误；或指数退避 |
| B2 | 拆分 `cancel`（置 `canceled` 保留列表 + 停流）与 `remove`（终态才真正删除），按钮据 `terminal` 分派 |
| B3 | `order` + 任务 `task_id` 持久化到 `localStorage`；挂载时逐个 `getVideo` 重水合，非终态重开流 |
| B4 | 仅在终态或 `CLOSED` 才关闭 SSE，否则交原生重连或带退避手动重连；修正错误分支类型断言 |
| B5 | `Math.max(1, Number(v) || 600)` 兜底 + `<input min max>` |
| B6 | `getHealth` 放入 30s 轮询并卸载清理 |
| P1 | 日志保留上限（如最近 2000 行）+ 虚拟化/截断渲染 |
| M1/M2/M3/M5 | 常量收敛到 `types.ts`/`constants.ts`；headers 用 `Headers`；接入 `AbortController` |
| M4 | 删除编译产物、新增 `web/.gitignore` |
| M6 | 拆分 `store.tsx`（context/hook 独立文件）消除警告，恢复 `--max-warnings 0` |
| A1/A2 | `<label htmlFor>` + 控件 `id`；可点击项改 `<button>` 或加 `role/tabIndex/onKeyDown` |
| T1/T2 | 补 `store` 行为测试与纯组件测试 |

---

## 6. 最佳实践建议

- **单一来源常量**：轮询间隔、默认超时、ID 截断长度、日志上限集中到 `constants.ts`。
- **URL 构造**：`api.ts` 用 `URL`/`URLSearchParams` 替代字符串拼接，避免编码遗漏。
- **请求可取消**：`http` 接入 `AbortController`，组件卸载时中止。
- **Context 拆分**：把「不变的动作（create/select/remove）」与「高频变化的数据（logs）」拆成两个 context，减少无关重渲染（对应 P2）。
- **测试金字塔补齐**：为 `store` 写行为测试（终态停轮询、取消保留、SSE 累积、清理），给纯组件加交互测试。
- **CSP/安全头纳入镜像契约**：安全响应头应作为 WF2/WF3 反代契约的一部分被冒烟测试锁定。
- **删除编译产物、补 `web/.gitignore`**。

---

## 7. 总结与优先级排序

代码质量整体良好，与归档规格一致性高；无阻塞性缺陷。风险主要在安全泄漏面与运行时健壮性。建议按下列顺序处理：

**P0（尽快，安全 + 资源泄漏）**
1. 🔴 **B1** 轮询失败无法停止 → 加停止/退避
2. 🔴 **S1** API Key URL 泄漏 → nginx 日志脱敏 + `Referrer-Policy`
3. 🟠 **S2** 补齐 nginx 安全响应头（含 CSP）

**P1（功能正确性 + 可用性）**
4. 🟠 **B2** 取消语义修正（取消 ≠ 删除）
5. 🟠 **B4** SSE 断线重连
6. 🟠 **B3** 任务持久化 / 刷新重水合
7. 🟠 **P1** 日志上限 + 渲染优化

**P2（可维护性 + 质量门）**
8. 🟡 **M4** 删除编译产物、补 `.gitignore`
9. 🟡 **M6** 拆分 store 消除 react-refresh 警告并恢复 `--max-warnings 0`
10. 🟡 **T1/T2** 补 store 与组件测试
11. 🟡 **M1/M2/M3/M5**、**B5/B6/B7**、**A1/A2** 逐项清理
