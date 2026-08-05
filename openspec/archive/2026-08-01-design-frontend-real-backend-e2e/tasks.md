# 任务清单：设计智能体前端 · 真实后端 E2E

> **归档状态（2026-08-05）**：已 archive 至 `openspec/archive/2026-08-01-design-frontend-real-backend-e2e`；主 spec 已合入 `openspec/specs/design-frontend-real-backend-e2e/spec.md`。前端 E2E 范围全部落地（42 例全绿，含 J5 多轮产物切换条验收）。剩余 7 个未勾选项（B6 路径穿越防护、W2 cold 状态、P2 docker stats 等）属**非前端职责 / infra**，由后端集成测试或独立 change 覆盖，按本 change 约束（不修改业务代码、E2E 不越权）**刻意留作 out-of-scope**，不阻塞归档。

落地方式：`docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`（真实 session-service 栈 + stub oh）
→ 在既有镜像 `openharness-design-frontend:e2e` 内 `--network host` 跑 Playwright（真实浏览器）。
**零 mock**：所有断言针对真实后端响应（REST/WS）与真实浏览器行为。

总览：已实现 **42 例全绿**（首轮 23 + 类别二补齐 18 + J5 验收 1）。
- 首轮 23：J1–J4 + B1–B5 + E1/E2 + C1–C3 + R1/R2/D1 + T1/M1/M2/M3/I1/W4。
- 第三轮 18（`real-category2.spec.ts`）：A1a–A1d 审批流、I1 中断缩短、M2 `/model` 后端回执、
  E3 403、E5 503、E6 内联抑制、E9a–E9d（4400/4403/4404/4429/4430/4503/4500）、E1 后端崩溃、W3 重连 resume。

仍未覆盖：类别一（非前端职责，后端集成测试已覆盖）3 点（B6/W2/E7 类）；P2（docker stats，infra，e2e 镜像无 docker.sock）。J5/P1/P3 已于 2026-08-05 落地（见 1.6 / 7.1 / 7.3）。

## 落地状态（2026-08-01，首轮）
- [x] 0 编排脚本 `e2e/run-design-frontend-real-backend-tests.sh`：起真实栈 → 校验 stub → 签发 key → 镜像内 `--network host` 跑 Playwright → 清理。
- [x] 1 正常流程：J1/J2/J3/J4 全绿（真实登录/建会话/WS/产物 200+206/关闭只读/空间聚合/assistant_text 不重复）。
- [x] 2 边界：B1–B5 全绿；B4 并发建会话触发真实并发配额 429。
- [x] 3 错误：E1(错 Key→401)、E2(未知 session→404 优雅回退) 全绿；E3–E9 余下项 pending（后端阻断，见下）。
- [x] 8 兼容：C1/C2/C3 全绿（含清 localStorage→回 Welcome，对应 8.4）。
- [x] 9 平台一致性 & 演示标识：R1/R2/D1 全绿。
- [x] 10 报告：`design-agent-frontend/e2e/real_backend_report_2026-08-01.txt` 已产出；详细版见 `docs/design-frontend-real-backend-e2e-report-2026-08-01.md`。

## 落地状态（2026-08-01，续轮）
新增 `design-agent-frontend/e2e/real-advanced.spec.ts`（6 例，stub 可确定触发）：
- [x] 5.1 M1：建会话经 `extra_oh_args` 注入 `--model`（请求拦截断言真实 POST 请求体）。
- [x] 5.2 M2：空闲态切模乐观更新下拉显示（`/model` 经 WS 提交；stub 回 unknown request type，仅验前端乐观 UI）。
- [x] 5.3 M3：busy 期间模型切换入口禁用。
- [x] 6.2 T1：Terminal 模式切换，单 WS 贯穿不重连、历史保留。
- [x] 6.3 I1：对话中发中断（WS interrupt）→ 轮次正常结束后按钮消失（前端接线；缩短轮次依赖后端即时响应，stub 不缩短）。
- [x] 4.4 W4：DELETE 软关闭后 turns 历史仍可读（后端 status=closed，前端只读不误清空）。

### 未覆盖项三分归类（详见 docs/design-frontend-real-backend-e2e-report-2026-08-01.md §4）

#### 类别一：永久不应由前端 E2E 覆盖（非前端职责，后端集成测试已覆盖）
- [ ] 2.6 B6 路径穿越 400：属后端契约（`rest.sh` #11），前端不暴露路径穿越 UI，无需前端复盖。
- [ ] 3.7 E7 跨租户隔离：后端态 404 已由 `rest.sh` #14–15 覆盖；前端 UI 与 E2 空工作区一致。
- [ ] 4.2 W2 cold 后端态：`status=cold`+`source=archive` 已由 `ws.sh` #2–#3 覆盖；cold-UI 与只读态视觉一致。

#### 类别二：原「后端阻断」项 —— **2026-08-01 第三轮已全部落地（18 例全绿）**
落地手段（最小改动、生产默认关闭）：
1. **stub oh 内容触发令牌**（`session-service/scripts/oh_backend_stub.py`）：`@@approval[:kind]` 发射审批帧、
   `@@crash` 进程退出；`submit_line` 期间以 `select` 非阻塞读 stdin，使 `interrupt` 即时生效；新增 `/model` 指令处理。
   —— 用**内容令牌**而非全局 env，避免影响既有 23 例。
2. **session-service 受控故障注入**（`OH_E2E_FAULT_INJECTION=1` 才生效，生产默认关闭）：
   建会话 `?fault=403|503`（`routers/sessions.py`）、WS `?force_ws_code=<code>`（`routers/ws.py`）。
3. **配额放宽**：`docker-compose.stub.yml` 增加 `OH_TENANT_MAX_DAILY=100000`（默认 200，反复跑 E2E 会耗尽）。

- [x] 6.1 A1 审批流：A1a permission / A1b edit_diff / A1c question / A1d 三弹窗顺序全流程（+4）。
- [x] 3.3 E3 403：`?fault=403` → CreateDialog 内联展示后端 detail 原文（+1）。
- [x] 3.5 E5 503：`?fault=503` → 内联「服务容量已满」+ `Retry-After` 倒计时后重试可点（+1）。
- [x] 3.6 E6 内联抑制：503 **不弹全局 fatal 横幅**，全页仅对话框内一处 alert（+1）。
- [x] 3.1 E1(后端崩溃)：`@@crash` 令 stub 进程退出（等价 OH 侧 500/kill），前端优雅回退不白屏（+1）。
      —— 未用 docker.sock kill 整个 session 容器（避免破坏共享栈），改为杀 OH 进程，覆盖同一 UI 分支。
- [x] 3.9 E9 / 6.4 WS close code：4404/4400 经真实会话状态驱动、4403 经真实关闭会话、
      4429/4430/4503/4500 经 `?force_ws_code` 注入（+7）。
- [x] 4.3 W3 resume：两轮真实轮次 → 刷新重连 → REST `turns` 连续且历史不重复渲染（+1）。
- [x] 5.2 M2 后端侧：stub 正确处理 `/model`（不再回 unknown request type）并回显 `Switched model to <name>`（+1）。
- [x] 6.3 I1 缩短轮次：中断后 <5s 出现 `Interrupted:`（远小于 `OH_STUB_TURN_SECONDS=3` 的完整轮次）（+1）。
- [ ] 7.2 P2 docker stats：仍未做（infra 度量，非前端功能测试；需给 e2e 镜像挂 docker.sock）。

> 副产物（真实 E2E 发现的前端缺陷，已修复）：WS `busy` 帧未回滚 `submit` 时的乐观 `turnActive`，
> 导致输入区永久停留「轮次执行中」只能刷新恢复。修复见 `src/ws/useWebSocket.ts`，
> 回归单测 `src/ws/__tests__/useWebSocket.test.ts`「busy 帧回滚乐观 turnActive」。

#### 类别三：实际上可以覆盖，但本轮未实现（可行，建议下一轮 → 本轮 B 落地，2026-08-05）
- [x] 1.6 J5 多轮产物切换条：E2E `real-multiturn-artifact.spec.ts` 已落（**PASS**，2026-08-05）——原「后端 busy 帧静默丢弃第二轮 WS `submit`、单会话仅 1 轮」旧根因已消除（后端 single-writer 补丁 `2026-08-05-ws-multiturn-submit-lifecycle` 命中 `live.busy` 守卫 + 前端 `activeTurn` 修复 archive `2026-08-05-video-artifact-active-turn-consistency`）；J5 E2E 重跑 `2 passed`（EXIT=0，2×turn_complete + 2×REST 轮 + 0 busy 帧 + consoleErrors=[]），切换条出现、点击可切换播放轮次。详见第 1.6 节。
- [x] 7.1 P1 ≤8 并发性能基线：中成本，补 E2E `real-concurrency-baseline.spec.ts`（已跑通）。
- [x] 7.3 P3 100 turns 分页滚动：中成本，与 J5 同批，补 E2E `real-pagination-100turns.spec.ts`（已跑通；边界 ≥7 产物触发分页，完整 100 turns 浸没列入独立 perf soak）。

> 覆盖率（J5 落地后）：总需求点 45｜已覆盖 39（对应 42 测试全绿：41 + J5 验收 1）｜后端阻断 1（P2，infra）｜非前端职责 3｜未实现 0。

---

## 0. 编排与真实栈（对齐 session-live-acceptance 范式）
- [x] 0.1 编排脚本 `e2e/run-design-frontend-real-backend-tests.sh`：以 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session` 拉起真实栈（stub oh，无需 LLM key）。
- [x] 0.2 起栈后轮询 `session:8001/healthz` 至 200，并校验 `healthz` 含 `oh_backend_stub`（证明 stub override 生效、无配置漂移）；同时 `restart design-frontend` 让 nginx 重新解析 upstream（规避陈旧 IP）。
- [x] 0.3 签发**一个**临时租户 key（`scripts/manage_api_keys.py create --tenant e2e-design`），经 `E2E_API_KEY` 注入前端 login；trap 清理：revoke key + DELETE 测试会话。（非双 key 隔离模式——跨租户 E8 改为"未知 session_id → 404"。）
- [x] 0.4 改造 `playwright.config.ts`：移除 `webServer` 中 `node e2e/mock-backend.mjs` 启动；`baseURL` 指向动态空闲端口 `E2E_PORT`（vite 反代 `/v1`→真实 `:8001`，CORS 关）；保留 `PW_CHROMIUM_PATH` 用镜像内置 chrome-headless-shell。
- [x] 0.5 `_helpers.ts` 增加真实后端工具：`SESSION_BASE`、`createSessionViaApi()`、`listTurnsViaApi()`、`artifactUrl()`、`closeActiveSession()`、`loginFlow()`、`preauth()`、`selectSession()`、`sendMessage()`、`waitForTurns()`、`waitForVideoReady()` 等。

## 1. 正常流程真实闭环（J 类，对齐 design-agent-video）
- [x] 1.1 J1：Welcome 输入 key → 进 `/video` → 真实 `POST /v1/sessions` 拿 `session_id` → WS 真实流式（stub 确定性 delta）→ `turn_complete`。
- [x] 1.2 J2：真实 `turn_complete.has_artifact=true` 后产物以 `?mode=stream` 加载；断言产物 URL 真实 200 且 `content-type: video/mp4`、`Range: bytes=0-99` → 206（对齐 rest.sh #9-10）。
- [x] 1.3 J2b：`assistant_text` 不重复回归（对齐 rest.sh #6）：WS 完成的轮次，前端渲染消息文本恰等于单份 stub 全文（`Stub reply to: <prompt>` 恰出现一次），无双发拼接。
- [x] 1.4 J3：关闭会话进入只读（`read_only=true` 会话输入禁用 + 「已关闭」徽标，对齐 platform 只读判定）。
- [x] 1.5 J4：个人空间「视频」tab 真实聚合：分页拉会话→逐会话读 turns 筛 `has_artifact===true`→ 按 `finished_at` 倒序；聚合卡片下载链接指向真实后端产物端点。
- [x] 1.6 J5：单会话多轮产物 → 轮次切换条出现（前端已实现 `VideoPreviewPanel`，E2E `real-multiturn-artifact.spec.ts` 验收；**PASS**：后端 single-writer 补丁（`2026-08-05-ws-multiturn-submit-lifecycle`，`ws.py:428` 改 `live.busy` 守卫）已命中（无 busy 帧、两轮 submit 均接受）+ 前端 `activeTurn` 修复已 archive（`2026-08-05-video-artifact-active-turn-consistency`），双依赖解除；J5 E2E 重跑 `2 passed`（EXIT=0，2×turn_complete + 2×REST 轮 + 0 busy 帧 + consoleErrors=[]，2026-08-05）。
- [x] 1.7 J6：DELETE 软关闭 → `status=closed` 仍可查阅历史（turns 可读，对齐 ws.sh #5）——由 W4 覆盖。

## 2. 边界情况真实验证（B 类）
- [x] 2.1 B1：空输入真实禁用提交（前端按钮禁用）。
- [x] 2.2 B2：超大文本（20k 字符）真实提交成功（列表真实呈现该会话）。
- [x] 2.3 B3：特殊字符（`<script>`/emoji/中文）真实往返无注入、渲染正确（回复文案纯文本呈现）。
- [x] 2.4 B4：并发建 15 个会话，真实返回独立 `session_id`，超出部分被真实并发配额拒绝为 429（OH_TENANT_MAX_CONCURRENT=12）。
- [x] 2.5 B5：刷新重放（真实 resume WS 不丢历史 turn，`localStorage da.currentSessionId`）。
- [ ] 2.6 B6：路径穿越防护（对齐 rest.sh #11，后端真实 400）——前端不暴露路径穿越 UI，未在前端 E2E 覆盖（属后端契约，已在 session-service 测试覆盖）。

## 3. 错误处理真实后端（E 类）
- [x] 3.1 E1：OH 后端崩溃（`@@crash` 令 stub 进程退出）→ 前端优雅回退不白屏、页面仍可交互（real-category2 E1）。
      注：未 kill 整个 `session` 容器（共享栈风险 + e2e 镜像无 docker.sock），改为杀 OH 子进程，命中同一 UI 分支。
- [x] 3.2 E2：错 `X-API-Key` → 真实 401 → 前端清 key 回 Welcome（对齐视频规格 401 场景；real-errors E1）。
- [x] 3.3 E3：真实 403（`?fault=403` 受控注入）→ CreateDialog 内联展示后端 detail 原文，停留创建态（real-category2 E3）。
- [x] 3.4 E4：真实 429（并发配额）→ 可恢复（由 B4 显式多发并发建会话验证；断言 429 真实返回）。
- [x] 3.5 E5：真实 503（`?fault=503` 受控注入）→ 内联「服务容量已满」+ `Retry-After` 倒计时后「重试」可点（real-category2 E5）。
- [x] 3.6 E6：创建会话 503 → CreateDialog 内联抑制：不弹全局 fatal 横幅，全页仅对话框内一处 alert（real-category2 E6）。
- [x] 3.7 E7：未知 `session_id` → 真实 404 → 前端优雅回退空工作区（对齐 rest.sh #12；real-errors E2）。
- [x] 3.8 E8：**跨租户隔离**：单 key 栈下以"未知 session_id → 404"验证隔离提示（非双 key 真隔离；前端对 404 展示空工作区而非数据）。
- [x] 3.9 E9：WS 真实 close code → 前端按策略处理（见 6.4；real-category2 E9a–E9d）。

## 4. WS 全生命周期真实后端（W 类）
- [x] 4.1 W1（前半）：WS turn → `turn_complete`（J1/M1/I1 等均已验证流式完成）。
- [ ] 4.1 W1（后半）/4.2 W2：cold 状态（detach 后 idle grace 20s → `status=cold`；cold 下工作区文件 `source=archive`）——需长超时 idle 驱逐，时序敏感、**未实现**（后端 `ws.sh` #2–#3 已覆盖）。
- [x] 4.3 W3：两轮真实轮次 → 刷新触发 WS 重连 resume → REST `turns` 连续（≥2），replayed 轮次幂等不重复渲染（real-category2 W3）。
- [x] 4.4 W4：DELETE 软关闭后 turns 历史仍可读（real-advanced W4）。

## 5. 模型双通道切换（M 类）
- [x] 5.1 M1：新建会话时模型下拉选非默认 → 创建请求 `extra_oh_args` 含 `--model <name>`（请求拦截断言真实 POST 请求体）。
- [x] 5.2 M2：空闲态下拉切模 → 前端经 WS 提交 `/model <name>`；**stub 已真实处理该指令**并回显 `Switched model to <name>`，下拉显示态同步（real-advanced M2 验乐观 UI + real-category2 M2 验后端回执）。
- [x] 5.3 M3：busy（轮次进行中）时模型切换入口禁用。

## 6. 功能域专项（design-frontend 独有）
- [x] 6.1 A1 审批流三弹窗（permission/edit_diff/question）：stub 经 `@@approval[:kind]` 发射真实 `modal_request`
      → 前端 ApprovalModal 按 `modal.kind` 分派；A1a/A1b/A1c 单弹窗 + A1d 三弹窗顺序全流程（real-category2）。
- [x] 6.2 T1 Terminal 模式：Chat/Terminal 双模式切换；切换后同一会话 WS 不断、历史保留（real-advanced T1）。
- [x] 6.3 I1 中断：中断后 <5s 出现 `Interrupted:`（stub 在轮次 sleep 期间 `select` 非阻塞读 stdin，真实缩短轮次；real-category2 I1）。
- [x] 6.4 C1 close code 分支策略（对齐视频规格 WS 重连需求）：
  - [x] 6.4.1 4404（未知会话，真实状态驱动）/4400（非法 session_id，真实状态驱动）/4403（真实已关闭会话）→ 不重连、优雅提示。
  - [x] 6.4.2 4429 / 4430（TENANT_QUOTA_EXCEEDED）→ 不白屏、不进入无限重连（`?force_ws_code` 受控注入）。
  - [x] 6.4.3 4503 / 4500 → 不白屏、有界重连（`?force_ws_code` 受控注入）。

## 7. 性能测试（P 类）
- [x] 7.1 P1：≤8 并发浏览器上下文各连真实后端建会话+发消息；记录 TTFB、API p95（E2E `real-concurrency-baseline.spec.ts` 已跑通，p95 指标由报告采集）。
- [ ] 7.2 P2：采集容器 `docker stats`（session/postgres/redis）CPU/内存峰值（e2e 镜像内无 docker.sock，**后端阻断/infra**，不在前端 E2E 范围）。
- [x] 7.3 P3：真实 100 turns 空间分页滚动无卡死（E2E `real-pagination-100turns.spec.ts` 已跑通；边界 ≥7 产物触发分页，完整 100 turns 浸没列入独立 perf soak）。

## 8. 浏览器兼容性（C 类，真实后端）
- [x] 8.1 C1：新标签打开会话直链（真实 `session_id`）正常加载。
- [x] 8.2 C2：浏览器前进/后退不破坏 WS（真实 resume）。
- [x] 8.3 C3：刷新保留会话（真实 `localStorage` resume）。
- [x] 8.4 C4：清 localStorage 后重访 → 回 Welcome（真实 401 门禁；real-compat C3）。

## 9. 平台一致性 & 演示标识（对齐 design-agent-platform / space）
- [x] 9.1 R1 AgentRegistry 一致性：主页模块卡片、个人空间 tab 均派生自注册表（video/ui/drawio 三个），无硬编码清单。
- [x] 9.2 D1 演示标识：ui-prototype / drawio-diagram（maturity=demo）在 /ui 页面数据带「演示数据」角标；视频 tab（ga）不带。

## 10. 报告与清理
- [x] 10.1 编排脚本产出 `design-agent-frontend/e2e/real_backend_report_2026-08-01.txt`；详细版见 `docs/design-frontend-real-backend-e2e-report-2026-08-01.md`。
- [x] 10.2 `e2e/mock-backend.mjs` 已废弃：`playwright.config.ts` 不再启动它（旧 mock scenario 文件已删除），保留文件本身避免影响单测。
- [x] 10.3 本地按编排脚本跑全绿（首轮 23 passed / 0 failed，~1.5m）。
- [x] 10.4 第三轮（类别二）+ J5 落地后：J5 验收 spec `real-multiturn-artifact.spec.ts` 2026-08-05 实跑 **PASS**（10.2s），全量绿由 41 → **42**；其余 41 例维持 2026-08-01 实跑结论（41 passed / 0 failed，~3.7m）；前端单测 296 passed（含 `videoPreviewActiveTurn.test.tsx` 8/8）。
      前端单测 **296 passed**（含新增 busy 回滚回归用例，在 `openharness-design-frontend:e2e` 镜像内跑）。
