# 设计智能体前端 · 真实后端 E2E 测试详细报告

- 日期：2026-08-01（第三轮更新：类别二「后端阻断」项已落地）
- 测试对象：`design-agent-frontend`（文本生成视频模块的 Web 前端）
- 结论：**41 passed / 0 failed（约 3.7 分钟）**，全部基于**真实 Session Service + Postgres + Redis + Stub OH 的真实浏览器 E2E**，零 mock。
  - 首轮 23 例（J/B/E/C/R/D/T/M/I/W）
  - 第三轮 +18 例（`real-category2.spec.ts`）：审批流、403/503/内联抑制、WS close code 全谱、后端崩溃、重连 resume、`/model` 后端回执、中断缩短

> 测试边界说明：本 E2E 验证的是「真实浏览器 ↔ 真实 Session Service 网关 ↔ Stub OH」全链路。Stub OH 是**确定性的 OH（OpenHarness）替身**，不接入真实 LLM / Agent 推理，因此**不覆盖真实 LLM/Agent 全链路行为**（如真实 token 流式、真实工具调用、真实审批决策）。真实 OH 行为由 `session-service` 后端集成测试（`session-live-acceptance`）在 stub 模式下基线覆盖。

---

## 1. 执行方式与后端栈

所有测试遵循项目铁律：**必须在既有 Docker 镜像内执行，禁止宿主机直跑、禁止从零重建基础镜像**。

- 后端栈：`docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`
  - 真实 `session-service`（FastAPI :8001）+ Postgres:16-alpine + redis:7-alpine + **stub oh**
  - stub oh（`session-service/scripts/oh_backend_stub.py`）确定性输出、无需 LLM key；`healthz` 含 `oh_backend_stub` 标志证明 override 生效、无配置漂移
- 测试镜像：`openharness-design-frontend:e2e`（FROM `oh-e2e-test:latest`，Node22 + chrome-headless-shell）
  - 以 `--network host` 运行 Playwright，`PW_CHROMIUM_PATH` 指向镜像内置 `chrome-headless-shell`
  - 源码经 volume 挂载进容器（`design-agent-frontend/src`、`e2e` 等），改码无需重建即可测
- 动态空闲端口 `E2E_PORT`：vite dev server 经 `server.proxy` 把 `/v1` 反代到 `localhost:8001`（真实后端），规避固定端口被占用导致的静默挪端口
- 密钥：编排脚本签发临时租户 key（`scripts/manage_api_keys.py create --tenant e2e-design`），经 `E2E_API_KEY` 注入前端；trap 清理时 revoke key + 删除测试会话

编排脚本：`./e2e/run-design-frontend-real-backend-tests.sh`（全量）｜`... real-advanced`（单文件）｜
`... "real-category2 --grep W3"`（单用例）｜`KEEP=1 ...`（跑完保留栈）。

### 1.1 第三轮新增的可控触发能力（生产默认关闭）

为覆盖原「后端阻断」项，引入**三处最小改动**，均不影响既有 23 例：

| 能力 | 位置 | 触发方式 | 生产影响 |
|---|---|---|---|
| 审批帧发射 | `session-service/scripts/oh_backend_stub.py` | 消息内容含 `@@approval[:permission\|edit_diff\|question]` | 无（仅 stub OH，且靠**内容令牌**而非全局 env，不影响其他用例） |
| OH 进程崩溃 | 同上 | 消息内容含 `@@crash` → `os._exit(1)` | 无（仅 stub OH） |
| 中断即时生效 | 同上 | 轮次 `sleep` 期间用 `select` 非阻塞读 stdin，收到 `interrupt` 立即结束 | 无（仅 stub OH，更贴近真实 OH 语义） |
| `/model` 指令 | 同上 | `submit_line` 以 `/model ` 开头 → 回显 `Switched model to <name>` | 无（仅 stub OH） |
| 建会话故障注入 | `session-service/app/routers/sessions.py` | `?fault=403｜503`，**仅当 `OH_E2E_FAULT_INJECTION=1`** | 无（env 未设时代码路径直接跳过） |
| WS close code 注入 | `session-service/app/routers/ws.py` | `?force_ws_code=<code>`，**仅当 `OH_E2E_FAULT_INJECTION=1`** | 无（同上） |
| 每日配额放宽 | `docker-compose.stub.yml` | `OH_TENANT_MAX_DAILY=100000` | 无（仅 stub compose；默认 200，反复跑 E2E 会耗尽导致 `daily_quota_exceeded`） |

---

## 2. 测试清单（41 例，按文件分组）

### 2.1 `real-journey.spec.ts`（正常流程 J 类，4 例）
| 用例 | 断言（真实后端事实） |
|---|---|
| J1 真实登录→建会话→WS 流式→turn_complete 含产物 | Welcome 输 key → `/video` → 真实 `POST /v1/sessions` → WS 真实流式 → `turn_complete`；`assistant_text` 不重复（"Stub reply to:" 恰出现一次） |
| J2 真实产物直链 200 / Range 206 | 直链 `turns/{turn_index}/artifact?api_key=&mode=stream` 返回 **200** 且 `content-type: video/mp4`；带 `Range: bytes=0-99` 返回 **206** |
| J3 关闭会话进入只读 | `/close` 软关闭 → 后端 `read_only=true` → 前端「已关闭」徽标 + 输入框禁用 |
| J4 个人空间视频 tab 真实聚合 | 关闭后 `/space` 聚合真实产物卡片；卡片下载链接 `href` 指向 `v1/sessions/...`（证明来自真实聚合） |

### 2.2 `real-boundary.spec.ts`（边界 B 类，5 例）
| 用例 | 断言 |
|---|---|
| B1 空输入发送禁用 | 消息为空时「发送」按钮 `disabled` |
| B2 超大文本真实提交 | 20k 字符提交成功，回复文案可见 |
| B3 特殊字符往返无注入 | `<script>alert(1)</script> 🚀 中文` 作为纯文本往返，未被当作 HTML 执行 |
| B4 并发建会话触发真实 429 | 并发 15 建会话，`OH_TENANT_MAX_CONCURRENT=12` → 部分 **201**、部分 **429**，且 201 的 `session_id` 互不重复 |
| B5 刷新重放恢复会话 | reload 后 WS resume，历史 turn 不丢，输入框可用 |

### 2.3 `real-errors.spec.ts`（错误处理 E 类，2 例）
| 用例 | 断言（真实后端响应） |
|---|---|
| E1 错 API Key → 401 → 回 Welcome | 错误 `X-API-Key` → 真实 **401** → 前端清 key 回欢迎页重新认证 |
| E2 未知 session_id → 404 → 优雅回退 | 不存在的 `session_id` → 真实 **404** → 前端优雅回退空工作区（无错误文案崩溃） |

### 2.4 `real-compat.spec.ts`（浏览器兼容 C 类，3 例）
| 用例 | 断言 |
|---|---|
| C1 新标签打开会话直链 | `context.newPage()` 打开同 `session_id` 直链正常加载、WS 就绪 |
| C2 前进/后退不破坏会话 | 回首页再 `goBack` → WS resume 不丢会话 |
| C3 清 localStorage 重访回 Welcome | 清空 `localStorage` → 重新出现「API Key」输入框（真实 401 门禁） |

### 2.5 `real-platform.spec.ts`（平台一致性 & 演示标识 R/D 类，3 例）
| 用例 | 断言 |
|---|---|
| R1 首页模块卡片派生自注册表 | 主页可见「原型页面设计 / Drawio设计 / 文本生成视频」三域（无硬编码） |
| R2 个人空间 tab 派生自注册表 | `/space` 三 tab 与注册表一致 |
| D1 demo 域带「演示数据」标识 | `/ui` 页面数据带「演示数据」角标；视频域（ga）不带 |

### 2.6 `real-advanced.spec.ts`（进阶能力，6 例）
| 用例 | 断言（真实后端事实） |
|---|---|
| T1 Terminal 模式切换 | Chat/Terminal 切换：xterm 容器挂载，**单条 WS 贯穿不重连**（`data-ws-status` 保持 `ready`），切回 Chat 历史保留 |
| M1 模型双通道①（建会话注入 --model） | 预置 `da.model` → 建会话请求体经 `extra_oh_args` 含 `--model <name>`（请求拦截断言真实 POST 体） |
| M2 模型双通道②（空闲切模乐观 UI） | 空闲态选模型 → WS 提交 `/model <name>`，下拉显示态**乐观**更新（stub 回 `unknown request type`，仅验前端 UI） |
| M3 模型入口 busy 禁用 | 轮次执行中（`OH_STUB_TURN_SECONDS=3` 窗口）「模型切换」按钮 `disabled` |
| I1 中断控制接线 | busy 期间「中断当前轮次」按钮可见可点（WS `interrupt` 已发），轮次结束后按钮消失 |
| W4 软关闭后历史可读 | DELETE 软关闭 → 后端 `status=closed`、turns 仍可读；前端停留该会话、输入框禁用、不误清空 |

### 2.7 `real-category2.spec.ts`（原「后端阻断」项，18 例）

| 用例 | 断言（真实后端事实） |
|---|---|
| A1a 审批弹窗-permission | `@@approval:permission` → stub 发射真实 `modal_request` → 前端弹「工具执行确认」，点「允许」后 `permission_response` 回程、轮次继续完成 |
| A1b 审批弹窗-edit_diff | `@@approval:edit_diff` → 弹「文件修改确认」，展示 `path`/`+added`/`-removed` diff 摘要，批准后轮次完成 |
| A1c 审批弹窗-question | `@@approval:question` → 弹「需要你的确认」问答，选项来自后端 `modal.options`，回答后 `question_response` 回程 |
| A1d 审批全流程（三弹窗顺序） | `@@approval` → permission → edit_diff → question 顺序出现并逐个处理，最终 `turn_complete` |
| I1 中断真正缩短轮次 | busy 期间点中断 → **<5s** 出现 `Interrupted:`（远小于完整轮次 `OH_STUB_TURN_SECONDS`），后端真实提前 `line_complete` |
| M2 `/model` 后端回执 | 空闲态切模 → WS `submit` `/model <name>`，stub 真实处理并回显（不再是 `unknown request type`），页面出现模型名 |
| E3 建会话 403 | `?fault=403` → 真实 **403** → CreateDialog 内联 `role=alert` 展示后端 detail 原文，停留创建态不误入会话 |
| E5 建会话 503 | `?fault=503` → 真实 **503 + `Retry-After: 1`** → 内联「服务容量已满」，倒计时结束后「重试」按钮恢复可点 |
| E6 503 内联抑制 | 503 **不弹全局 fatal 横幅**（`服务暂不可用，节点容量已满` 计数 0），全页仅对话框内**一处** `role=alert` |
| E9a WS 4404 未知会话 | 打开不存在的 `session_id` → 后端真实 **4404** 关闭 WS → 前端不重连、优雅回退（不白屏） |
| E9b WS 4400 非法 session_id | 畸形 `session_id` → 真实 **4400** → 前端不重连、优雅回退 |
| E9c WS 4403 已关闭会话 | `/close` 后重新连 WS → 真实 **4403** → 只读态、不重连 |
| E9d WS 4429 / 4430 / 4503 / 4500（4 例） | `?force_ws_code=<code>` 注入（`addInitScript` 改写 `window.WebSocket` 追加参数）→ 前端不白屏、不进入无限重连；4430 展示配额提示与手动重试入口 |
| E1 OH 后端崩溃 | `@@crash` 令 stub OH 进程退出 → 前端优雅回退（错误提示或空态），页面仍可交互，不白屏 |
| W3 刷新后 WS 重连 resume | 两轮真实轮次 → reload 触发 resume → REST `turns` 连续（≥2）、历史**幂等不重复渲染**（`Stub reply to: first turn` 恰 1 条） |

> 说明：E9d 的 4429/4430/4503/4500 为**受控注入**（真实浏览器 + 真实后端 WS 关闭帧），
> 但触发源不是自然业务态；4400/4403/4404 则完全由真实会话状态驱动。

---

## 3. 实施中修正的真实后端事实（关键）

1. 真实栈需要签发 API Key，否则建会话返回 401（空表也返回 401，非配置漂移）。
2. 轮次列表端点响应体为 `{ items: [...] }`（非 `turns`）；artifact 直链为 `turns/{turn_index}/artifact?api_key=&mode=stream`。
3. WS 状态属性 `data-ws-status` 实际值为 `ready`（非 `connected`）。
4. 登录需点击「保存」按钮（仅填输入框不会写 key）；关闭会话需用 `/close` 命令（`title="关闭会话"` 在多处歧义）。
5. 首页为静态模块卡片，登录后落在首页而非视频模块；触发 401 需进入 `/video`（首页不发起请求）。
6. 每租户并发配额 `OH_TENANT_MAX_CONCURRENT` 默认 1；E2E 栈放宽至 12 避免顺序测试被误伤，429 由 B4 显式并发验证。
7. Playwright 容器 `--network host` + 动态 `E2E_PORT`，vite 代理 `/v1 → localhost:8001`。
8. ~~stub oh 仅处理 `submit_line`/`interrupt`/…~~ → **第三轮已扩展**：stub 现支持审批帧发射、`/model` 指令、
   sleep 期间即时中断、`@@crash` 进程退出（见 §1.1）。
9. **软关闭为 read_only**：会话仍保留、`da.currentSessionId` 不清空、前端输入框禁用；`has_artifact` 对已关闭会话不可靠（产物登记依赖 session-service 异步扫描）。
10. ~~interrupt 在 stub 下不缩短轮次~~ → **已修**：stub 在轮次 sleep 期间用 `select` 非阻塞读 stdin，
    收到 `interrupt` 立即结束并发 `line_complete`，中断 <5s 生效。

### 3.1 第三轮新增的真实后端事实

11. **每租户每日建会话配额**：`tenant_max_daily` 默认 **200**（`app/config.py`），env `OH_TENANT_MAX_DAILY` 可覆盖。
    反复跑 E2E 会耗尽并返回 `403 daily_quota_exceeded`（**表现为无关用例批量失败**，极易误判为测试 bug）。
12. **`turn_complete` ≠ 后端空闲**：WS 发出 `turn_complete` 后 `turn_task` 仍在收尾，此时立即提交下一轮会被后端
    以 `{"type":"busy"}` 拒绝。前端 UI 已进入可输入态，因此**存在真实竞态窗口**。
13. **CreateDialog 的 503 语义**：后端 `Retry-After` 头会驱动前端「重试（Ns）」倒计时按钮；403 则原样展示后端 `detail`。
14. **建会话 503 的全局横幅抑制**只按请求 **路径** 判定（`isCreateSessionRequest` 看 `pathname === '/v1/sessions'`），
    因此测试用 `route.continue({url})` 追加 query 不会破坏抑制逻辑。

### 3.2 本轮 E2E 发现并修复的前端缺陷

| 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|
| WS `busy` 帧未回滚乐观 `turnActive` | 在 `turn_complete` 后立刻发第二条消息，后端回 `busy`；此后输入区**永久停留「轮次执行中」**，发送按钮被中断按钮取代，只能刷新页面恢复 | `conv.addUserMessage()` 在 `submit` 时乐观置 `turnActive=true`，而 `case 'busy'` 只加了一条 warning 系统消息，未回滚 | `src/ws/useWebSocket.ts` 的 `busy` 分支增加 `conv.setTurnActive(sid, false)`；新增回归单测 `src/ws/__tests__/useWebSocket.test.ts` ▸「busy 帧回滚乐观 turnActive」 |

> 该缺陷仅在「真实后端 + 真实浏览器」下才会暴露（mock 后端不会产生 `busy` 竞态），是本轮真实 E2E 的直接价值产出。

---

## 4. 未覆盖项分类（重要：三类区分）

未覆盖项**不再统一写成"测不了"**，按归属明确分为三类。判定原则：

- **非前端职责**：属于 session-service 自身契约，已由后端集成测试（`e2e/session-acceptance/rest.sh`、`ws.sh`，即 `session-live-acceptance` 范式）覆盖；且前端无专属 UI 行为需额外验证 → **不应由前端 E2E 复盖**。
- **后端阻断（暂无法覆盖）**：前端 E2E 本应验证其 UI 行为，但当前缺少触发所需能力（stub 无注入点 / 编排无 docker.sock / 无真实 OH）→ **最小改动后可覆盖**，标注预计新增测试数。
- **本轮未实现（可行）**：技术上完全可在前端 E2E 覆盖，只是本轮未排期 → 评估成本并给出下一轮建议。

### 4.1 类别一：永久不应由前端 E2E 覆盖（非前端职责，后端集成测试已覆盖）

这些项的断言对象是后端响应/状态契约，且前端没有需单独验证的专属渲染。已在 `session-live-acceptance` 中基线验证，前端复盖属重复且会模糊后端所有权。

| 编号 | 需求 | 后端已有测试（引用） | 为何前端无需复盖 |
|---|---|---|---|
| B6 / 2.6 | 工作区路径穿越 → 400 | `rest.sh` #11（`..%2f`/`%2f` → 400） | 前端不暴露任何路径输入 UI，无专属渲染可验。 |
| E7 后端态 / 3.7 | 跨租户隔离 → 404 | `rest.sh` #14–15（tenant B 读 tenant A → 404） | 前端对"未知/无权限会话"统一走 E2 的空工作区回退，无差异 UI。 |
| W2 后端态 / 4.2 | cold：`status=cold` + 工作区 `source=archive` | `ws.sh` #2–#3（idle grace 后驱逐 + archive 源） | cold 状态语义是后端契约；前端 cold-UI 与只读态视觉一致，无独立判定点。 |
| W4 后端态 / 4.4 | DELETE 软关闭 → `status=closed` + turns 可读 | `ws.sh` #5（soft close 后 history 保留） | 后端状态契约已由 ws.sh 覆盖；前端只读 UI 已由 W4 测试覆盖（属"已覆盖"）。 |
| E4 后端态 / 3.4 | 并发配额 → 429 | `rest.sh` #4（并发建会话 → 429） | 429 原始状态码是后端契约；前端并发 UI 已由 B4 部分覆盖（属"已覆盖"）。 |

> 说明：表中"后端态"项其**前端渲染**若已被其他用例覆盖（如 W4、E4/B4），则归入"已覆盖"，此处仅强调其**后端契约**不必再被前端复盖。

### 4.2 类别二：原「后端阻断」项 —— **本轮已全部落地（+18 例，全绿）**

按上一版列出的最小改动方案实施（见 §1.1），实际新增 **18 例**（原预计 ≈15）。

| 编号 | 需求（前端 UI 行为） | 落地手段 | 实际新增 | 状态 |
|---|---|---|---|---|
| A1 / 6.1 | 审批流三弹窗 → 响应回执 | stub 内容令牌 `@@approval[:kind]` 发射真实 `modal_request` | 4（A1a/b/c/d） | ✅ |
| E3 / 3.3 | 403 → 内联报错 | `?fault=403`（`OH_E2E_FAULT_INJECTION=1` 门禁） | 1 | ✅ |
| E5 / 3.5 | 503 容量满 | `?fault=503` + `Retry-After` | 1 | ✅ |
| E6 / 3.6 | 建会话 503 内联抑制 | 同上，断言全页仅 1 处 alert、无全局 fatal 横幅 | 1 | ✅ |
| E1(崩溃) / 3.1 | 后端不可用 → 优雅回退 | stub 内容令牌 `@@crash`（杀 OH 进程，**不 kill 共享 session 容器**） | 1 | ✅（替代方案） |
| E9 / 6.4 | WS close code 分支策略 | 4400/4403/4404 由真实会话状态驱动；4429/4430/4503/4500 经 `?force_ws_code` 注入 | 7 | ✅ |
| W3 / 4.3 | WS 重连 resume → 轮次连续、幂等 | 两轮真实轮次 + reload；REST `turns` 校验 | 1 | ✅ |
| M2 后端侧 / 5.2 | `/model` 真实回执 | stub 增加 `/model` 处理 | 1 | ✅ |
| I1 缩短轮次 / 6.3 | 中断真正提前结束轮次 | stub sleep 期间 `select` 非阻塞读 stdin | 1 | ✅ |
| P2 / 7.2 | 容器 `docker stats` CPU/内存峰值 | 未做（需给 e2e 镜像挂 `docker.sock`） | 0 | ⬜ infra 度量，非前端功能测试 |

**遗留说明（口径要诚实）**：
- E1 用「杀 OH 子进程」替代「kill session 容器」：共享栈上 kill 容器会波及并行用例，且 e2e 镜像无 `docker.sock`；
  两者命中的是**同一条前端 UI 分支**（后端流中断 → 优雅回退），但**未覆盖**「整个网关不可达 → 恢复后自动重连」。
- 4429/4430/4503/4500 属**受控注入**（真实后端真实关闭帧，但触发源非自然业务态）；
  自然触发需真实打满配额/容量池，有压测风险，未做。
- 「正常断连指数退避 1s→30s 最多 10 次」的**完整退避时序**未做（需分钟级等待），仅验证了「不白屏、不无限重连」。

### 4.3 类别三：实际上可以覆盖，但本轮未实现（可行，建议下一轮）

| 编号 | 需求 | 实现成本评估 | 下一轮建议 |
|---|---|---|---|
| J5 / 1.6 | 单会话多轮产物切换条（轮次间预览/下载） | 低：复用 `waitForTurns` + artifact 直链，发 2 条消息后断言切换条出现 | **建议下一轮**：低成本高价值，补多轮产物 UX |
| P1 / 7.1 | ≤8 并发浏览器上下文性能基线（TTFB/p95） | 中：需在编排内起多 context 并发，跑时较长（~数分钟） | 可选：作为独立性能 job，避免拖慢主回归 |
| P3 / 7.3 | 真实 100 turns 空间分页滚动无卡死 | 中：需在 stub 下批量造 100 轮（可脚本化 `submit_line`×100），再测前端分页 | 可选：与 J5 同批，验证长列表性能 |

**类别三合计预计新增 ≈ 3 个测试/套件**；J5 强烈建议放入下一轮。

### 4.4 覆盖率统计表

| 维度 | 首轮 | **第三轮（当前）** | 说明 |
|---|---|---|---|
| **总需求点**（spec/tasks 叶子项） | 45 | **45** | 见 tasks.md 0–10 节叶子需求 |
| **已覆盖** | 28 | **38** | 对应 **41 个真实浏览器测试**（部分需求由多断言共证），全部 passed |
| **后端阻断（暂无法覆盖）** | 11 | **1** | 仅剩 P2（`docker stats`，infra 度量） |
| **非前端职责（无需覆盖）** | 3 | **3** | 类别一：B6 路径穿越、E7 跨租户、W2 cold 后端态 |
| **未实现（可行）** | 3 | **3** | 类别三：J5、P1、P3 |
| 已实现测试通过率 | 23/23 (100%) | **41/41 (100%)** | 真实 Session Service + Postgres + Redis + Stub OH |
| 前端单元测试 | — | **296 passed** | 在 `openharness-design-frontend:e2e` 镜像内运行（含新增 busy 回滚回归） |

> 计数口径：需求点取自 tasks.md 各节 `[x]`/`[ ]` 叶子项（不含 0.x 编排与 10.x 报告）。
> 第三轮：`已覆盖` 38 + `后端阻断` 1 + `非前端职责` 3 + `未实现` 3 = 45。

---

## 5. 结论

截至第三轮，**基于真实 Session Service + Postgres + Redis + Stub OH 的真实浏览器 E2E** 已覆盖正常闭环、边界、错误、
兼容、平台一致性、Terminal/模型/中断/软关闭，以及本轮补齐的审批流、403/503/内联抑制、WS close code 全谱、
后端崩溃回退、重连 resume —— 合计 **41 个场景，41 passed / 0 failed（约 3.7 分钟）**，零 mock。

**测试边界（精确表述，避免误读）**：本 E2E 验证的是「真实浏览器 ↔ 真实 Session Service 网关 ↔ Stub OH」全链路；**Stub OH 是确定性 OH 替身，不接入真实 LLM/Agent 推理**，因此**不覆盖真实 LLM/Agent 全链路行为**（真实 token 流式、真实工具调用、真实审批决策等）。真实 OH 的服务端契约由 `session-live-acceptance`（rest.sh/ws.sh）在 stub 模式下基线覆盖。

**未覆盖项现状**：
- **非前端职责（3 点）**：路径穿越、跨租户隔离、cold 后端态 —— 后端集成测试已覆盖，前端无专属 UI，不应复盖；
- **后端阻断（1 点）**：仅剩 P2 `docker stats` 资源采集（infra 度量，需给 e2e 镜像挂 `docker.sock`）；
- **未实现（3 点）**：J5 多轮产物切换条、P1 并发性能基线、P3 百轮分页 —— 技术可行、成本低，**建议 J5 放入下一轮**。

**本轮附加价值**：真实后端竞态暴露出前端 `busy` 帧未回滚乐观 `turnActive` 的缺陷（输入区永久卡死），已修复并补回归单测（§3.2）。
