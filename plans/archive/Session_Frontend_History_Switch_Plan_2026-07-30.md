# Session Frontend 完善：历史会话切换 + 容器池语义对齐 —— 实现计划

> **立项记录（2026-07-30）** —— 本文件为 `session-frontend/` 对齐 `session-service/` 新 API 契约（`API_DOCUMENTATION.md`）的统一设计源，核心是**历史会话切换**（列表 → turns 回显 → 连目标 WS），并覆盖容器池/多租户带来的全部前端可见语义。
>
> - 上游依据（后端均已交付，接口以 `session-service/API_DOCUMENTATION.md` 为准）：
>   - 《Session_History_Switch_Plan_2026-07-29.md》：`GET /v1/sessions`（含 `resumable`/`read_only`/`title`）、`GET /{sid}/turns`、WS 准入关闭码细化（4430/4503/4500 + error 帧 code）、同租户 IDLE 自动让位。
>   - 《Container_Pool_Multi-Tenancy_Plan_2026-07-29.md》：`tenant_max_concurrent` 默认 1、四段式准入（429/403/503+Retry-After）、容器运行时冷启动延迟。
>   - 《Session_Workspace_MinIO_Archive_Plan_2026-07-29.md》：`GET /{sid}/workspace/files[/{path}]` 双源（live/archive/none）+ `stale` 语义。
> - 全文区分 **已验证事实（VERIFIED）** 与 **设计决策（DECISION，编号 F1-F6）**。
> - **rev1（2026-07-30，用户已裁决）**：Q1-Q4 全部裁决（见 §8），整体方向认可；并按用户反馈补五项修订——①状态判断解耦为语义谓词 `canConnectSession`/`canResumeSession`/`isReadonlySession`，**不再扩大 `isSessionTerminal` 职责**（F1.5）；②唤醒判定 `resumable` 优先、failed 结合 close code/错误码而非仅 status（F3.4）；③「hydrate 完成 → 写 last_turn_index → 建 WS」固化为不可放宽的强约束（F2.4）；④closed 只读保留四不变量进测试验收（§5.1-8/§5.2-2）；⑤容器池错误归因**后端契约优先**总则，status 仅作展示辅助（F3.0）。
> - **rev2（2026-07-30，计划冻结）**：①F3.1 建连门控统一改用 `canConnectSession(session)` 唯一语义入口，不再散判 `resumable`；②补充 `canResumeSession` 语义边界：现行契约下 `read_only=true` 必然不可恢复，若未来出现 `read_only+resumable` 并存态须重新定义该谓词（F1.5）。**自 rev2 起本计划冻结**，后续以 OpenSpec change 形式落成并实施。
> - 本计划仅规划，**实施须经用户确认后另行进行**。

---

## 0. 前端代码核实结论（VERIFIED）

| # | 事实 | 证据位置 |
| - | ---- | -------- |
| 0.1 | 会话列表仍是旧方案：localStorage 缓存会话 ID（`sf.sessionIds`），启动分批 `GET /{sid}` 恢复，注释明写「后端暂无列表 API」——**换浏览器/清缓存即丢列表，且与后端新列表接口重复** | `store/sessionStore.ts:1-2`、`App.tsx:restoreSessions` |
| 0.2 | 对话消息只存在于内存 `conversationStore`，无任何历史回显：选中一个从未在本 tab 交互过的会话（含 cold/closed）→ 消息区为空，仅靠 WS `last_turn_index` 补发（只补 `turn_complete`，不含逐轮完整历史） | `store/conversationStore.ts`、`ws/useWebSocket.ts:195` |
| 0.3 | 单 WS 连接架构已就位：`useConversation` 仅在 `SessionWorkspace` 层对 `currentId` 调一次，切换会话时 React effect 自动断旧连新（`intentionalClose`，不触发重连）——与后端 §3.2「断开当前 WS → 连目标 WS」流程天然一致 | `SessionWorkspace.tsx:84`、`useWebSocket.ts:86-208`、`WebSocketClient.ts:56-60` |
| 0.4 | WS 关闭码仅认识 4400/4401/4403/4404/4429/4500：**4430/4503 未定义**，会落入 default 分支做 10 次指数退避重连（对 4430 是无效打扰）；`ErrorFrame` 类型无 `code` 字段，准入失败的结构化错误帧只当普通错误文案展示 | `utils/constants.ts:26-44`、`WebSocketClient.ts:150-186`、`types/ws.ts:105-108` |
| 0.5 | 是否建连由 `isSessionTerminal(status)`（closed/expired/failed）判定，**直接解读 status 枚举**；后端契约已明确前端应只依赖 `resumable`/`read_only`（快照丢失的 cold 是 `resumable=false` 但非终态，现前端会盲目建连然后收 4500） | `types/session.ts:26-34`、`useWebSocket.ts:74-78` |
| 0.6 | `SessionCard` 无标题（只显示 sid 前 8 位）；关闭会话后 `removeSession` 直接从列表删除并清对话——与「closed 会话仍可只读回看」的新语义冲突 | `SessionCard.tsx:39-41`、`useCloseSession` + `sessionStore.removeSession` |
| 0.7 | 产物下载已有 `?api_key=` 直链 + 302 跟随模式，可直接复用到 workspace 文件下载 | `api/sessions.ts:31-44` |
| 0.8 | 后端 `SessionSummary` **不含** `permission_policy`/`ws_url`/`oh_session_id`（API 文档 §2.6 字段表）；而前端审批 UX（`approval_request` 帧过滤）依赖 `permission_policy` | `API_DOCUMENTATION.md §2.6`、`useWebSocket.ts:139-146` |
| 0.9 | 单会话轮次上限 `OH_MAX_TURNS_PER_SESSION=200`，而 turns 接口单页上限 `limit=200` → **一页即可拉全任意会话的完整历史** | `API_DOCUMENTATION.md §2.7、§7` |
| 0.10 | 测试链路全部镜像内执行：单测/lint 在 `docker build --target test` 阶段、Playwright E2E 在 `--target e2e`（基于 `oh-e2e-test:latest`）+ `e2e/mock-backend.mjs`；宿主机只跑 docker/curl | `e2e/run-session-frontend-docker-tests.sh`、项目规则 `test-on-existing-images.md` |

---

## 1. 问题陈述

1. **无历史会话发现**：后端已提供租户级列表（含标题/可恢复性），前端还在用本地缓存 ID，换设备即丢、也看不到其他入口创建的会话。
2. **无历史消息回显**：切到任何"冷"会话都是空白聊天区，用户无法确认切对了会话；closed/expired 会话更是完全没有只读回看能力。
3. **容器池语义不认识**：4430（配额满不可让位）/4503（容量满）/4500（复活失败）一律按网络断线指数重连，既打扰后端又给不出可操作的提示；cold 会话唤醒（docker run + stage-in，数秒到数十秒）无等待反馈。
4. **状态枚举耦合**：前端自行解读 `status`，违反后端「只依赖 `resumable`/`read_only`」的契约，后端状态机加态即碎。
5. **历史文件不可见**：workspace 归档 API 已上线，前端无任何文件浏览/下载入口，「切回历史会话还能看到当时的文件」只完成了后端一半。

---

## 2. 目标与非目标

### 目标

1. 会话列表切换到服务端权威源（分页、标题、`resumable`/`read_only` 驱动交互），废弃 localStorage ID 缓存。
2. 切换/选中任意会话时回显完整轮次历史（含 closed/expired 只读会话），并与 WS `last_turn_index` 补发机制正确去重。
3. 完整实现后端 §3.2 切换流程与准入失败语义：4430/4503/4500 差异化提示与重试策略、error 帧 `code` 映射、cold 唤醒等待态、切换成功后旧会话"让位为 cold"的列表刷新。
4. REST 侧容器池错误（429 双语义/403 每日配额/503+Retry-After）在创建会话对话框给出可操作反馈。
5. 新增工作区文件面板：live/archive/none 双源列表 + `stale` 提示 + 单文件下载。
6. 全部测试在既有镜像内执行（0.10 流水线），Playwright 覆盖切换主流程。

### 非目标

- 不改后端任何代码/契约（若发现契约缺口只记录到 §8 未决问题）。
- 不做多 WS 并联（同时挂多个会话的连接）——维持单连接架构（0.3），切换即断旧连新。
- 不做 workspace 文件在线预览/编辑，只做列表 + 下载（图片/视频预览另立计划）。
- 不做虚拟滚动等性能改造（既有 C3 结论维持）。
- web/（video-service 前端）不在本计划范围。

---

## 3. 设计决策（DECISION）

### F1 会话列表：服务端权威 + 分页

- **F1.1 数据源替换**：启动/认证成功后调 `GET /v1/sessions?limit=20&offset=0`，替换 `restoreSessions` 的批量 GET；`sessionStore` 的实体改为「summary ∪ detail 合并模型」：

  ```ts
  // types/session.ts
  export interface Session {            // 原字段保留
    session_id: string;
    status: SessionStatus;
    turn_count: number;
    created_at: string;
    last_active_at: string;
    // 列表接口新增（detail 接口不返回 → 合并时保留旧值）
    title?: string | null;
    resumable?: boolean;
    read_only?: boolean;
    // detail 接口独有（summary 不返回 → 懒加载，见 F1.4）
    permission_policy?: PermissionPolicy;
    oh_session_id?: string | null;
    ws_url?: string | null;
  }
  ```

  store 合并规则：`patch` 语义（新数据字段覆盖，未返回字段保留），杜绝 summary 刷新把 `permission_policy` 冲掉。
- **F1.2 分页**：store 记 `total/offset/hasMore`；侧栏底部「加载更多」按钮（offset 递增拼接）；下拉刷新=重置 offset 全量替换第一页并**保序合并**已加载页。不做无限滚动（列表短，按钮足够）。
- **F1.3 刷新触发**（事件驱动为主，不做默认轮询）：①认证成功；②创建会话成功；③关闭会话成功；④切换后收到 `session_ready`（旧会话可能已让位变 cold，见 F3.5）；⑤`window focus`（≥10s 节流）。手动刷新按钮兜底。
- **F1.4 permission_policy 懒加载**（消解 0.8）：选中会话时若 store 内无 `permission_policy` → 补一次 `GET /v1/sessions/{sid}`（merge 进 store）；失败不阻塞切换（audit 帧过滤默认按 `interactive` 保守处理，宁可多弹一次审批弹窗也不漏）。
- **F1.5 交互可达性由业务字段驱动**（消解 0.5；rev1 修订为语义谓词收敛，**废弃**原「isSessionTerminal 判定改造」方案）：
  - `read_only=true` → 可点击，进入只读回看（F2），卡片显示「只读」徽标；
  - `resumable=true` → 可点击并建连（F3）；
  - 两者皆 false（快照丢失的 cold）→ 卡片置灰 + tooltip「会话暂不可恢复（快照缺失）」，点击仅回显历史不建连；
  - **语义谓词收敛（rev1）**：`isSessionTerminal` **保持原实现与原职责不再扩大**（仅服务存量 status 展示逻辑，不新增调用点）；`types/session.ts` 新增三个语义明确的谓词，各用途一一对应：
    - `canConnectSession(session)`：是否允许建立 WS（`resumable === true`；字段缺失——如仅有 detail 数据——回退 `!isSessionTerminal(status)` 兼容）——`useWebSocket` 建连门控的**唯一**入口；
    - `isReadonlySession(session)`：是否只读回看（`read_only === true`；缺失时回退终态 status 判定）——输入栏禁用、只读徽标、`LifecycleNotice` 文案使用；
    - `canResumeSession(session)`：是否可从 cold/failed 唤醒继续对话（`resumable === true && !isReadonlySession(session)`）——卡片可点击性与置灰态、唤醒流程门槛（F3.4）使用。**语义边界（rev2）**：当前后端产品语义下 `read_only=true` 必然不可恢复（closed/expired 均为只读且 `resumable=false`，两字段不会同时为 true），因此 `!isReadonlySession` 一项在现行契约下是防御性冗余；若未来权限模型扩展出 `read_only=true && resumable=true` 并存态（如「只读但可唤醒查看实时状态」），现定义不再适用，**必须重新定义该谓词而非在调用点打补丁**（实现时在谓词处留注释标注此边界）。
    WS 建连、只读展示、终态判断分别走对应谓词，互不复用；后端状态机未来加态（warm/draining 等）时仅调整谓词内部映射，不再散改前端逻辑。
- **F1.6 卡片信息升级**：第一行 `title`（null 回退 sid 前 8 位）、第二行状态徽标 + 轮次数 + 相对时间；`StatusBadge` 增加 `resumable=false` 的「不可恢复」变体。
- **F1.7 localStorage 迁移**：`sf.sessionIds` 停止读写并在启动时清除；新增 `sf.currentSessionId` 持久化选中项（启动后若该 id 在列表中则自动选中，否则选第一项）。
- **F1.8 关闭语义修正**（消解 0.6）：关闭成功后**不再 removeSession**，改为 patch `{status:'closed', read_only:true, resumable:false}` 留在列表中只读；`ConfirmDialog` 文案改为「关闭后不可再对话，历史消息与文件仍可查看」。`removeSession`（连带清对话/WS 状态）仅保留给 4404 场景。

### F2 轮次历史回显（hydration）

- **F2.1 触发时机**：选中会话且满足「本地消息数为 0 且 `turn_count > 0` 且未 hydrate 过」→ 拉历史。切走再切回不重复拉（`hydratedAt` 标记在 conversation state 上）；手动「重新加载历史」入口兜底。
- **F2.2 拉取策略**：单请求 `GET /{sid}/turns?after_index=-1&limit=200` 一页拉全（0.9 保证足够）；仍按 `items.length < total` 写 while 循环兜底（后端上限调整时不坏）。
- **F2.3 转换规则**：`conversationStore` 新增 `hydrateHistory(sid, turns: TurnResponse[])`，每轮映射为：
  - `prompt` → user 消息（turnIndex=该轮 index）；
  - `assistant_text` 非空 → assistant 消息（`streaming:false`、`hasArtifact: turn.has_artifact ?? false`）；
  - `status === 'interrupted'` → system warning「轮次已中断」；`error_message` 非空 → system error；
  - 消息 `createdAt` 取 `started_at/finished_at`（相对时间展示正确）。
  hydrate 是**整体替换**该会话 messages（前提 F2.1 保证此时本地为空），不做插入合并。
- **F2.4 与 WS 补发去重（rev1 固化为强约束，实施期不得放宽）**：切换会话的时序**必须严格串行三步**：① history hydrate 完成（或判定无需 hydrate）→ ② `wsStore.setLastTurnIndex(sid, maxTurnIndex)` 写入 → ③ 才允许 WS 建连。实现上 `useWebSocket` 的 effect 依赖调整为「hydration 完成后才传入 sessionId」（`SessionWorkspace` 层用 `hydrated` 门控）。**禁止任何形式的并行优化**（如 hydrate 与建连并发、先建连再补写 last_turn_index）——即使能缩短首屏几百毫秒也不做，补发重复/乱序的正确性风险不对等。服务端因此不会补发已回显轮次；即使极端竞态下补发到达，`completeTurn` 因同 turnIndex 的 assistant 消息已存在也不会重复建消息（0.2 现有逻辑天然幂等，**仅作兜底而非依赖**）。该三步顺序在单测（§5.1-3）与 E2E（§5.2-1）中均须有显式顺序断言。
- **F2.5 加载/失败态**：ChatView 顶部 hydrating 骨架条；失败 → system error 消息 +「重试」按钮（不阻塞输入——live 会话仍可直接提交新轮次）。
- **F2.6 只读会话**：`read_only=true` 走同一 hydration，随后不建连（F1.5）；`LifecycleNotice` 文案区分「已关闭（可回看历史与文件）」/「已过期」；产物播放/下载按钮照常可用（后端 closed 会话 artifact 仍可读）。

### F3 切换流程与 WS 准入细化

- **F3.0 错误归因契约优先（rev1 新增总则，约束 F3/F4 全部分支）**：容器池/准入类错误的判定**只允许**依据后端机器可解析契约——① WS close code（4430/4503/4500 及既有 44xx）；② error 帧 `code` 常量；③ REST 状态码 + 结构化 `detail.code` + `Retry-After` 头。`status` 字段仅作展示辅助（徽标/提示文案选择），**禁止**用 status 或自然语言 message 推断错误原因、决定重连/重试策略。文案映射表一律按 code 常量键入（`WS_ADMISSION_MESSAGES` 等），未知 code 走通用降级文案 + 原文仅入 console。唯一豁免遗留：`turn_error` 审批超时的文案匹配回退（0.4 既有注释口径），待后端全量下发 code 后移除，不新增同类。
- **F3.1 切换编排**（对齐后端 §3.2，复用 0.3 架构不新增断连代码）：
  `selectSession(sid)` → 旧连接随 effect 卸载（intentional close，服务端旧会话 → IDLE）→ F1.4 detail 懒加载 + F2 hydration → `canConnectSession(session)` 门控通过后建连（带 `last_turn_index`；WS 建连必须经过该唯一语义入口，不直接散判 `resumable`/`read_only`，F1.5 rev1）→ 收 `session_ready` 即就绪。
- **F3.2 关闭码扩展**（`constants.ts` + `WebSocketClient.handleClose`）：

  | code | reason 常量 | 前端策略 |
  | --- | --- | --- |
  | 4430 | `TENANT_QUOTA_EXCEEDED` | **不自动重连**（另一会话正在跑 turn 或别的窗口挂着 WS，重试只会继续 4430）。状态置 `quota_exceeded`，banner：「并发配额已满：另一会话正在执行任务或仍被其他窗口连接，请先等待/中断该会话」+ 手动重试按钮 |
  | 4503 | `CAPACITY_FULL` | 有界自动重试：延迟 15s（对齐后端 `OH_POOL_QUEUE_TIMEOUT`/Retry-After 语义），最多 4 次后转 `failed`，banner 提示稍后再试 |
  | 4500 | `SESSION_UNAVAILABLE` | 从 default 无限指数重连改为**有界 2 次**（覆盖 rehydrate 竞争锁等瞬态），仍失败 → `failed`，提示「会话复活失败，可稍后重试或新建会话」 |

  `WsStatus` 增加 `quota_exceeded`；4503/4500 复用现有 `reconnecting/failed` 通道（attempt 计数展示）。
- **F3.3 error 帧 code 映射**：`ErrorFrame` 增加 `code?: string`；`useWebSocket.handleFrame` 对 `error` 帧优先按 `code` 查 `WS_ADMISSION_MESSAGES`（`TENANT_QUOTA_EXCEEDED`/`CAPACITY_FULL`/`SESSION_UNAVAILABLE` → 中文文案）落 system 消息，`message` 原文仅入 console 调试；同一次准入失败「error 帧 + close 码」只出一条 banner（以 error 帧为准，close 处理时发现 code 已消费则跳过，用一次性标志实现）。
- **F3.4 cold 唤醒等待态（rev1 修订：`resumable` 优先，status 仅选文案）**：是否进入「唤醒中」流程**以 `canResumeSession(session)` 为门槛**（即 `resumable=true`），不以 status 枚举判定；`status ∈ {cold, failed}` 只用于选择提示文案（「正在唤醒会话（拉起容器并恢复数据，可能需要数十秒）…」）。判定细则：
  - `resumable=false` 的 cold/failed 会话在 F1.5 谓词层已拦截建连，**不可能误入唤醒流程**；
  - `resumable=true` 的 failed 会话按后端契约「FAILED 可经 COLD 恢复」正常唤醒；唤醒成败**由 WS close code / error 帧 code 判定**（4500=复活失败、4503=容量满、4430=配额满，各走 F3.2 策略），不用 status 猜原因（F3.0）；
  - 普通业务失败（turn_error、REST 4xx 等）与唤醒流程路径完全分离，互不触碰；
  - 收 `session_ready` 后清除等待态并 patch 本地 status→live（该 patch 仅为展示同步，不参与任何判定）；超过 30s 未就绪追加「仍在排队/冷启动中」文案（纯前端计时，不加接口）。
- **F3.5 让位可视化**：`session_ready` 后触发 F1.3-④ 列表刷新——被让位的旧会话在侧栏自然更新为 `cold`（快照保留、可切回）；无需前端主动 DELETE/断开之外的任何动作（后端 rev2 决策：切换 ≠ 放弃旧会话）。
- **F3.6 REST 兜底提交的保护**：`submitTurnRest` 仅当会话在本节点 live 时可用（后端 409）；`useConversation.submit` 的 REST 回退分支对 409 响应给出明确提示「会话未激活，请等待 WS 连接就绪」，不再静默失败。

### F4 创建会话的容器池错误映射（CreateDialog）

| 响应 | 判定 | UI 行为 |
| --- | --- | --- |
| 429 `Rate limit exceeded` | detail 文本 | 「请求过于频繁，稍后再试」 |
| 429 `Concurrent session quota exceeded` | detail 文本 | 「并发会话已达上限：当前会话正在执行任务时无法新建，请等待完成或关闭它」（注：空闲会话会被自动让位，正常不触发此错） |
| 403 `daily_quota_exceeded` | 结构化 code | 「今日会话创建次数已用完（UTC 日重置）」 |
| 503 + `Retry-After: N` | 响应头 | 「服务容量已满」+ 按 N 秒倒计时的「重试」按钮（倒计时结束自动可点） |

统一收敛在 `api/client.ts` 的错误提取工具（现有 `extractErrorDetail` 扩展出 `extractRetryAfter`），CreateDialog 只消费语义化结果。

### F5 工作区文件面板

- **F5.1 入口与布局**：`SessionDetail` 头部增加「文件」按钮 → 右侧抽屉 `WorkspaceFilesPanel`（移动端全屏覆盖）；仅选中会话时可开。
- **F5.2 列表**：`GET /{sid}/workspace/files?limit=200[&page_token][&prefix]`；渲染 `path/size/mtime`（size 人性化格式、目录前缀分组展示可后续增强，本期平铺 + `prefix` 输入框过滤）；`next_page_token` 驱动「加载更多」。
- **F5.3 双源语义呈现**：
  - `source:"live"` → 角标「实时」；
  - `source:"archive"` → 角标「归档快照」+ `last_synced_at` 相对时间；`stale=true` 追加提示「文件为最近归档快照，可能落后最新一轮」；
  - `source:"none"` → 空态「暂无文件归档」（存量 closed 会话文档口径：归档自上线起生效）。
- **F5.4 下载**：复用 0.7 直链模式新增 `workspaceFileUrl(sid, path)` = `/v1/sessions/{sid}/workspace/files/{encodedPath}?api_key=`，`<a download>` 触发，浏览器自动跟随 presigned 302；`path` 逐段 `encodeURIComponent`（保留 `/` 分隔）。
- **F5.5 刷新**：打开时拉取 + 手动刷新按钮；面板处于打开状态时收到 `turn_complete` 帧 → 自动刷新（该轮可能新增文件，归档为异步 best-effort，提示可能有延迟）。
- **F5.6 错误**：400（page_token 非法）重置分页重拉；404（文件已不存在）toast 提示并刷新列表。

### F6 类型与常量对齐（契约层）

- `types/api.ts`：新增 `SessionSummary`、`SessionListResponse`、`TurnListResponse`、`WorkspaceFileEntry`、`WorkspaceFileListResponse`。
- `types/ws.ts`：`ErrorFrame.code?`；`WsStatus` 增 `quota_exceeded`。
- `utils/constants.ts`：`WS_CLOSE_CODES` 增 `QUOTA_EXCEEDED: 4430`、`CAPACITY_FULL: 4503`；新增 `WS_ADMISSION_MESSAGES`（reason 常量 → 中文文案）、`CAPACITY_RETRY_DELAY_MS = 15_000`、`CAPACITY_MAX_RETRIES = 4`、`UNAVAILABLE_MAX_RETRIES = 2`。
- `api/sessions.ts`：新增 `listSessions(params)`、`listTurns(sid, params)`、`listWorkspaceFiles(sid, params)`、`workspaceFileUrl(sid, path)`。

---

## 4. 文件改动清单

| 文件 | 改动 |
| ---- | ---- |
| `src/types/session.ts` | `Session` 增可选 `title/resumable/read_only`，detail 独有字段转可选；新增 `canConnectSession`/`canResumeSession`/`isReadonlySession` 语义谓词，`isSessionTerminal` 保持原职责不扩大（F1.5 rev1） |
| `src/types/api.ts` | 新增列表/轮次/文件响应类型（F6） |
| `src/types/ws.ts` | `ErrorFrame.code`、`WsStatus.quota_exceeded` |
| `src/utils/constants.ts` | 新关闭码/文案/重试参数；`STORAGE_KEYS` 去 `sessionIds` 增 `currentSessionId` |
| `src/api/sessions.ts` | `listSessions/listTurns/listWorkspaceFiles/workspaceFileUrl`；`extractRetryAfter` 落 `api/client.ts` |
| `src/store/sessionStore.ts` | 列表分页状态、summary/detail merge、`removeSession` 收窄为 4404 专用、closed 保留、currentId 持久化、删除 localStorage ID 缓存函数 |
| `src/store/conversationStore.ts` | `hydrateHistory` + `hydratedAt` 标记 |
| `src/ws/WebSocketClient.ts` | 4430/4503/4500 差异化处理（F3.2），default 分支保持既有网络断线退避 |
| `src/ws/useWebSocket.ts` | error 帧 code 消费与去重（F3.3）、`session_ready` 触发列表刷新（F3.5）、建连门控改用 `canConnectSession`（F1.5 rev1） |
| `src/hooks/useSessionList.ts` | **新增**：列表拉取/分页/刷新触发编排（F1.2/F1.3） |
| `src/hooks/useTurnHistory.ts` | **新增**：hydration 编排，输出 `hydrated/loading/error/retry`（F2） |
| `src/hooks/useWorkspaceFiles.ts` | **新增**：文件面板数据（F5） |
| `src/hooks/useCloseSession.ts` | 关闭成功改 patch 只读态（F1.8） |
| `src/App.tsx` | `restoreSessions` 替换为 `useSessionList` 初始化 + 选中恢复（F1.7） |
| `src/components/Layout/Sidebar.tsx` | 加载更多、刷新按钮、关闭确认文案 |
| `src/components/Session/SessionCard.tsx` | title 主行、只读/不可恢复徽标、置灰态（F1.6） |
| `src/components/Session/StatusBadge.tsx` | 「只读」「不可恢复」变体 |
| `src/components/Session/SessionWorkspace.tsx` | hydration 门控建连（F2.4）、唤醒等待态（F3.4）、read_only 渲染路径（F2.6）、文件抽屉挂载 |
| `src/components/Session/WorkspaceFilesPanel.tsx` | **新增**（F5） |
| `src/components/Session/SessionDetail.tsx` | 「文件」入口按钮 |
| `src/components/Session/CreateDialog.tsx` | F4 错误映射 + Retry-After 倒计时 |
| `src/components/Chat/ChatView.tsx` | hydrating 骨架/失败重试条（F2.5） |
| `e2e/mock-backend.mjs` | 补 `GET /v1/sessions`、`GET /{sid}/turns`、workspace files 两端点、WS 4430/4503 场景开关 |
| `e2e/session-flow.spec.ts` | 切换流程用例（§5.3） |

无后端改动、无新依赖、无镜像 base 变更（仅前端源码，走既有多阶段构建）。

---

## 5. 测试计划（遵循 test-on-existing-images 规则）

统一入口（宿主机只跑 docker/curl）：

```bash
# 单测+lint（node 构建镜像 test 阶段）→ 运行时冒烟 → Playwright E2E（oh-e2e-test 基底）
bash e2e/run-session-frontend-docker-tests.sh
# 复用已有 runtime 镜像做冒烟（避免重建）：
SESSION_FRONTEND_IMAGE=openharness_session_frontend:<现网 tag> bash e2e/run-session-frontend-docker-tests.sh
```

### 5.1 vitest 单测（新增/扩展）

1. `api/__tests__/client.test.ts`：`extractRetryAfter`（有/无头、非法值）。
2. `store/__tests__/stores.test.ts` 扩展：
   - sessionStore：summary/detail merge 不丢字段、分页拼接保序去重、关闭后保留为只读、currentId 持久化；
   - conversationStore：`hydrateHistory` 映射（interrupted/error/has_artifact）、hydrate 后 `completeTurn` 补发同 index 不重复建消息。
3. `hooks/__tests__/useTurnHistory.test.ts`（新增）：turn_count=0 跳过、一页拉全、`total > items` 续拉、失败可重试、成功后 `setLastTurnIndex` 已写入。
4. `ws/__tests__/WebSocketClient.test.ts` 扩展：4430 不重连置 `quota_exceeded`；4503 按 15s 有界重试 4 次后 failed；4500 有界 2 次；default 网络断线行为回归不变。
5. `ws/__tests__/useWebSocket.test.ts` 扩展：error 帧带 code 的文案映射与 close 去重；`resumable=false` 不建连。
6. `hooks/__tests__/useCloseSession.test.ts` 扩展：关闭成功 patch 只读态而非移除。
7. `components`：SessionCard 三态（可恢复/只读/置灰）渲染、WorkspaceFilesPanel 双源角标与空态、CreateDialog 四类错误文案。
8. `types/__tests__/session.test.ts`（新增）：三个语义谓词的真值表（字段齐全/缺失回退/read_only 与 resumable 组合四象限），断言 `isSessionTerminal` 行为与改造前完全一致（职责未扩大）。
9. **closed 只读保留回归（rev1 四不变量）**：对 live 会话执行关闭成功后断言——① `sessionStore` 仍含该会话（不 `removeSession`）；② `conversationStore` 历史消息未被清理；③ `canConnectSession=false` 且 `useWebSocket` 不发起建连；④ `artifactUrl`/`workspaceFileUrl` 仍可生成、文件面板数据 hook 照常发起请求。

### 5.2 Playwright E2E（mock-backend 内实现切换场景）

1. **切换主流程**：mock 两个会话 A（live）/B（cold, resumable, turn_count=3）→ 点 B → 断言历史 3 轮回显 → mock WS 就绪帧 → 输入可用；侧栏 A 变 cold（列表刷新断言）。
2. **只读回看与关闭保留（rev1）**：closed 会话 C → 点击 → 历史可见、输入栏禁用、无 WS 请求发出；另对 live 会话执行关闭 → 会话仍留在侧栏（只读徽标）、历史消息不清空、不再发起 WS 连接、产物下载按钮与文件面板仍可访问（四不变量端到端验证）。
3. **4430 路径**：连 B 时 mock 返回 error 帧(code) + close 4430 → banner 出现且 60s 内无自动重连请求。
4. **不可恢复置灰**：`resumable=false且read_only=false` 的会话卡片不可建连。
5. **文件面板**：archive 源列表 + stale 提示 + 下载链接 href 含 `?api_key=`。
6. 既有用例回归（83 个 vitest + 现有 spec）保持全绿。

### 5.3 冒烟

复用脚本 stage 3（SPA/安全头断言），无新增项。

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| ---- | ---- | ---- | ---- |
| hydration 与 WS 建连竞态导致轮次重复展示 | Med | Med | F2.4 强约束三步串行（禁止并行优化）+ `completeTurn` 幂等仅作兜底 + 单测/E2E 顺序断言 |
| 前端自行解读 status 造成状态机长期耦合（后端加态即碎） | Med | High | rev1：语义谓词收敛（F1.5，建连/只读/终态各走专属谓词）+ 错误归因契约优先总则（F3.0，status 仅展示辅助）；调用点不散落，加态只改谓词映射 |
| summary 刷新覆盖 detail 字段（permission_policy 丢失 → 审批帧误过滤） | Med | High | F1.1 merge 语义（未返回字段保留）+ 单测；F1.4 缺失时按 interactive 保守处理 |
| 旧后端（未部署新接口）联调时列表 404 | Low | Med | `listSessions` 404/405 时降级为空列表 + banner「后端版本过旧」；不再回退 localStorage 方案（代码已删，降级只影响列表可见性） |
| 4503 自动重试与后端队列叠加造成风暴 | Low | Med | 有界 4 次 + 15s 固定间隔（对齐队列超时），非指数放大；重试期间 UI 可手动取消 |
| 关闭会话保留在列表导致列表膨胀 | Med | Low | 服务端分页天然截断；后续可加 status 过滤 chip（本期不做，记 §8） |
| workspace 文件下载 302 跨域（presigned 公网端点） | Med | Low | 浏览器直链导航天然跟随 302（同产物下载 0.7 先例）；CSP `connect-src 'self'` 不受影响（非 fetch） |
| e2e mock-backend 与真实后端契约漂移 | Med | Med | mock 响应结构直接从 `API_DOCUMENTATION.md` 示例复制；后续联调用 `Dockerfile.e2e` 全链路脚本验证 |

---

## 7. 实施阶段（Phases）

| Phase | 内容 | 交付物 | 依赖 |
| ----- | ---- | ------ | ---- |
| P1 | F6 契约层 + F1 列表改造（api/types/constants/sessionStore/Sidebar/SessionCard/App 启动流）+ 单测 | 服务端权威列表可用，localStorage 方案下线 | — |
| P2 | F2 历史回显（hydrateHistory/useTurnHistory/ChatView 加载态/只读回看）+ 单测 | 切换即见完整历史，closed 可回看 | P1 |
| P3 | F3 WS 准入细化 + F4 创建错误映射（WebSocketClient/useWebSocket/CreateDialog/唤醒态/让位刷新）+ 单测 | 容器池语义完整落地 | P2 |
| P4 | F5 工作区文件面板 + 单测 | 历史文件可见可下载 | P1 |
| P5 | mock-backend 扩展 + Playwright 用例 + 全链路镜像流水线跑绿 + `CODE_REVIEW_REPORT.md`/README 增补 | 可验收 | P2-P4 |

P4 与 P2/P3 无耦合可并行。

---

## 8. 已裁决问题（Open Questions，2026-07-30 用户裁决）

| # | 问题 | 裁决 |
| - | ---- | ---- |
| Q1 | `SessionSummary` 不含 `permission_policy`（0.8） | **已裁决：前端选中会话时补一次 detail GET（F1.4）**。暂不修改后端 `SessionSummary` 契约，保持列表接口稳定；未来后端若增加 `permission_policy` 字段，summary/detail merge 模型（F1.1，新数据字段覆盖、未返回字段保留）自然兼容，前端零改动 |
| Q2 | 侧栏 status/只读过滤 chip 与搜索框 | **已裁决：本期不做**。保持列表分页 + 标题展示；后续按实际会话规模评估 |
| Q3 | 会话列表后台轮询 | **已裁决：不轮询**。维持认证成功/创建成功/关闭成功/`session_ready`/window focus 节流五个刷新触发（F1.3） |
| Q4 | 文件面板目录树分组 | **已裁决：本期平铺 + prefix 过滤（F5.2）**，不做目录树 |
