# Session 验收加固修复计划（Assistant 协议 / 配置漂移 / 镜像版本 / 验收自动化）

- 日期：2026-07-30
- 依据：`docs/session-e2e-test-report-2026-07-30.md` §5 遗留问题 L1–L5
- 原则：仅覆盖报告遗留问题，不扩展 UX（L5 仅登记不实施）；所有验证基于已有镜像 + 挂载源码（`.qoder/rules/test-on-existing-images.md`）。

## 优先级总览

| 优先级 | 事项 | 性质 | 对应遗留 |
|---|---|---|---|
| **P0-1** | assistant 事件协议明确化 + assistant_text 重复修复 | 缺陷，必须修复 | L1 |
| **P1-2** | compose/env 配置漂移治理 + OH_OH_BIN 启动校验 | 必须修复 | L2 |
| **P1-3** | 前后端镜像版本管理与运行版本可观测 | 必须修复 | L3 |
| **P1-4** | 人工验收流程沉淀为自动化脚本 | 必须补齐 | L4 |
| **P2** | 优化项（见 §6） | 可选 | L2/L3/L5 |

依赖关系：P1-4 的「stub 环境固化」依赖 P1-2 的 override 文件；P1-4 的「无重复断言」是 P0-1 的回归锚点，建议实施顺序 P0-1 → P1-2 → P1-3 → P1-4（P1-3 可与 P1-4 并行）。

---

## 1. P0-1 assistant 事件协议明确化 + 重复修复（必须）

### 1.1 协议契约（成文，作为唯一语义依据）

写入 `session-service/app/session/protocol.py` 模块 docstring 与 OpenSpec 规格：

- `assistant_delta.message`：**增量**文本，按序追加；
- `assistant_complete.message`：**权威最终全文**（真 oh 为 `event.message.text.strip()`），语义是**最终覆盖（overwrite）**——整体取代此前累计的 delta，禁止追加。这是**语义层的唯一真相**。
- WS 线上的 `delta + final + full_text` 帧**仅是兼容 envelope**（传输层包装），不是语义本身：复用 `delta` 帧型只为让旧前端零迁移，后续任何实现不得据此把 complete 理解为"又一条增量"。

已核实事实（报告 §5-L1）：真 oh `backend_host.py` 的 `assistant_complete` 携带全文；网关与前端目前均按增量追加 → 真后端下持久化与显示双份。**stub 与生产（真 oh）事件行为保持一致**是明确原则：stub 忠实模拟真 oh 的 delta+complete 双发，**stub 不改**，否则会掩盖真后端缺陷。

### 1.2 后端改动（session-service）

- `app/session/supervisor.py::_map_event` 的 `assistant_complete` 分支：
  - `live._assistant_buf` 整体替换为 `[event.message or ""]`（不再 append）；
  - WS 帧改发 `{"type": "delta", "text": "", "final": true, "full_text": <全文>, "turn_index": n}`——`text` 置空保证旧前端（追加逻辑）不再重复；`full_text` 供新前端整体替换（防 delta 丢帧场景显示不全）。
- `app/session/protocol.py`：更新 `EVENT_TO_FRAME` 注释（"final full text; emitted as an empty-text final delta carrying full_text"）。
- 持久化路径 `turn.assistant_text = "".join(_assistant_buf)` 不动——buf 替换后自然等于最终全文。

### 1.3 前端改动（session-frontend）

- `src/types/ws.ts`：`DeltaFrame` 增加可选 `full_text?: string`。
- `src/ws/useWebSocket.ts` `case 'delta'`：`frame.final && frame.full_text != null` 时用 `full_text` **整体替换**该 turn 的流缓冲再 flush；否则维持现状（append + final flush）。streamBuffer 需补一个 `replace(turnIndex, text)` 方法。
- `src/components/Terminal/TerminalBridge.ts`：**支持 final full_text 替换**（不忽略，防 WS 丢帧导致终端内容不完整）——桥内维护本轮已流式输出的累计文本 `turnBuf`；收到 final 帧且携带 `full_text` 时比对：
  - `turnBuf` 是 `full_text` 的前缀 → 只补写缺失尾部（无丢帧时尾部为空，零重复）；
  - 不是前缀（丢帧/乱序）→ 换行后重放 `full_text` 全文（xterm 无法可靠回擦多行滚动区，重放是确定性最强的纠正方式），并以 dim 标注 `[resync]`；
  - final 帧处理后重置 `turnBuf`。

### 1.4 兼容矩阵（决策依据）

| 组合 | 行为 |
|---|---|
| 新后端 + 旧前端 | final 帧 text 为空 → 不重复（核心修复已生效） |
| 新后端 + 新前端 | full_text 整体替换 → 不重复且抗丢帧 |
| 旧后端 + 新前端 | 无 full_text → 走旧追加逻辑，不劣化（重复依旧，属旧后端问题） |

### 1.5 测试（必含，全部镜像内执行）

- 后端单测（`oh-session-test:latest` + 挂载源码）：
  - stub 式事件序列（delta("X") + complete("X")）经 `stream_turn` 后，持久化 `assistant_text == "X"`（恰好一份）；
  - 帧序列断言：complete 映射帧 `text == ""`、`final == true`、`full_text == "X"`；
  - 多 delta + complete 全文覆盖场景（delta "a","b" + complete "ab"）→ `assistant_text == "ab"`。
- 前端单测（`docker build --target test`）：streamBuffer.replace、useWebSocket final/full_text 分支、TerminalBridge 前缀补尾/非前缀 resync 重放分支。
- Playwright E2E：`e2e/mock-backend.mjs` 按新契约发 final 帧（text 空 + full_text），既有"流式回复"用例增加**无重复**断言（气泡文本 === 单份全文）。
- 实况回归锚点：P1-4 验收脚本中对 `turns` 接口 `assistant_text` 做无重复断言。

## 2. P1-2 compose/env 配置漂移治理 + 启动校验（必须）

### 2.1 stub/e2e 覆盖固化为 compose override 文件

- 新增 `docker-compose.stub.yml`（仓库根）：仅覆盖 `session` 服务的
  `OH_OH_BIN=/opt/oh-session-service/scripts/oh_backend_stub.py`、`OH_IDLE_GRACE_SECONDS`（默认 300，脚本可再覆盖）。
- 约定：stub 模式一律 `docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d session`；**禁止**再用裸 shell env 覆盖方式拉起（问题①两次复发的直接诱因）。
- `docker-compose.yml` 顶部使用说明补充该模式；`.env.example` 注明 `OH_OH_BIN` 语义与默认值。

### 2.2 OH_OH_BIN 配置语义与启动校验（fail-fast）

- **配置语义明确化**（写入 config.py 注释与 .env.example）：`OH_OH_BIN` 是**单一可执行文件路径**（作为 `create_subprocess_exec` 的 argv[0]，已核实 `process.py::build_command`），**不支持带参数的 command 字符串**；需要注入参数/解释器时必须使用带 shebang 的 wrapper 脚本（stub 即此模式）。
- 校验规则（`session-service/app/main.py` lifespan 启动段，与语义一一对应）：
  1. 值不含空白字符（含空白 → 大概率误配成 command，直接报错提示用 wrapper）；
  2. 路径存在且为普通文件（含符号链接解析后）；
  3. `os.access(path, X_OK)` 可执行。
- 不满足则记录明确错误日志（含当前值、失败的具体规则与修复提示）并抛异常终止启动——把「第一次 turn 才暴露」提前到启动即失败。
- 容器运行时（`OH_SESSION_RUNTIME=container`）下 oh_bin 位于会话镜像内、网关不可见：校验降级为 WARN 日志（不阻断启动），日志注明将由容器 spawn 路径兜底。
- 单测：路径不存在 → 启动失败；含空白（形如 command）→ 启动失败且提示 wrapper；可执行 → 通过；container 运行时 → 仅告警。

### 2.3 配置可观测

- `GET /healthz` 响应增加 `oh_bin`（当前生效路径）与 `runtime`（process/container）字段，运维一眼核对漂移。健康判定逻辑不变。
- 更新 `tests/test_health.py` 断言新字段。

## 3. P1-3 前后端镜像版本管理（必须）

### 3.1 前端镜像 tag 参数化（.env 单一来源）

- `docker-compose.yml`：`session-frontend.image` 改为 `openharness_session_frontend:${SESSION_FRONTEND_VERSION:-v0.1.0}`；
- `.env.example` 增加 `SESSION_FRONTEND_VERSION`，与 `session-frontend/package.json` 的 `version` 保持一致；流程规范：前端功能变更合入时**必须** bump 两处版本（复用既有约定：tag 经 .env 传入，不多处硬编码）。
- `e2e/run-session-frontend-docker-tests.sh` 默认 tag 同步读取该变量（现有 `SESSION_FRONTEND_IMAGE`/`SESSION_FRONTEND_NEW_TAG` 机制保留）。

### 3.2 构建元数据（部署漂移可检测——问题②的直接对策）

- `session-frontend/Dockerfile`：增加 build args `GIT_SHA`、`BUILD_TIME`、`APP_VERSION`，构建时生成 `dist/version.json`（`{"version","git_sha","build_time"}`），runtime 阶段随静态资源发布为 `/version.json`。
- **no-cache 设计**：`nginx.conf.template` 为 `/version.json` 增加专用 location，`Cache-Control: no-store` + 完整安全头（该文件的用途就是实时探测运行版本，任何缓存都会造成"探测到旧版本"的假象；与 `location = /index.html` 的 no-cache 模式对齐，遵循"location 内 add_header 覆盖父级、安全头必须重复声明"的既有约定）。CSP 不受影响。
- compose build 段传入 `GIT_SHA`（`${SESSION_FRONTEND_GIT_SHA:-unknown}`，由构建脚本注入，避免 compose 内执行 git）。
- 冒烟增强：`run-session-frontend-docker-tests.sh` smoke 阶段断言 `/version.json` 可访问且字段完整；本地全新构建时进一步比对 `git_sha == git rev-parse HEAD`（复用镜像模式跳过该比对）。

### 3.3 后端版本可观测

- `GET /healthz` 增加 `version` 字段：取 `session-service/pyproject.toml` 包版本（`importlib.metadata`，取不到时回退 unknown）；可选 env `OH_GIT_SHA` 注入 git sha。
- 与 §2.3 healthz 扩展合并为一次改动/一组测试。

## 4. P1-4 人工验收流程自动化（必须）

**结构：总入口聚合 + 三个可独立执行的子脚本**（沿用既有 e2e 脚本的 log/ok/bad/REPORT 风格，宿主机仅 docker/curl）：

```
e2e/run-session-live-acceptance.sh        # 总入口：环境拉起 + key 签发 + 依次调子脚本 + 汇总/清理
e2e/session-acceptance/lib.sh             # 公共函数（log/ok/bad、curl 封装、计数器）
e2e/session-acceptance/rest.sh            # REST 断言组（可单独跑：需 BASE_URL + API_KEY/API_KEY_B）
e2e/session-acceptance/ws.sh              # WS 生命周期断言组（可单独跑）
e2e/session-acceptance/frontend.sh        # 前端反代冒烟（可单独跑：需 FRONTEND_URL）
```

子脚本约定：入参全部经环境变量传递（`BASE_URL`/`FRONTEND_URL`/`API_KEY`/`API_KEY_B`/`COMPOSE_FILES`）；各自输出分组 PASS/FAIL 计数并以退出码上报；不做环境拉起与清理（由总入口负责），因此可对任意已运行环境单独回归某一层。

总入口流程：

1. **环境**：`docker compose -f docker-compose.yml -f docker-compose.stub.yml up -d --wait session`（依赖 §2.1；`OH_IDLE_GRACE_SECONDS=5` 由脚本 env 传给 override 插值），等待 healthz=200。
2. **签发临时租户 key**：`compose exec session python scripts/manage_api_keys.py create --tenant live-acc-$RANDOM`（A/B 两租户），导出给子脚本。
3. **rest.sh**（对应报告 §3.1）：无 key 401；create 201；list 含 1 条；REST turn completed + `has_artifact`；turns 列表；artifact 200（video/mp4）+ Range 206；路径穿越 `..%2f`/绝对路径 400；不存在 SID 404；空 text 422；第二租户跨访 404 + list total=0；`tenant_max_concurrent` 超额 429；**assistant_text 无重复断言**（P0-1 回归锚点：`Stub reply to: <prompt>` 恰出现一次）。
4. **ws.sh**（对应报告 §3.2，复用 `scripts/ws_e2e_driver.py`）：WS turn `turn_complete`；detach 后 grace 到期 status=cold；cold 下 workspace files `source=archive`；WS 重连 resume 成功且 turn_count 连续；DELETE 后 status=closed 且 turns 仍可读。
5. **frontend.sh**：`up -d session-frontend` 后经 5174 断言 `/`（SPA 壳）、`/healthz`（反代 200）、`/version.json`（200 且 `Cache-Control` 含 no-store；镜像未含该文件时给 WARN 不 FAIL，保证脚本可先行落地）。
6. **清理**（trap）：revoke 临时 key、DELETE 测试会话；聚合三个子脚本的 PASS/FAIL 汇总与退出码；报告写入 `E2E_REPORT`（默认 /tmp）。

CI 挂接（可选执行位）：`.github/workflows/session-frontend.yml` 后追加 job，或先仅本地/发版前手动执行——本计划按「脚本落地 + 文档注明入口」交付，CI 挂接列为 P2。

## 5. 验证与验收标准

| 项 | 验收命令（全部基于已有镜像） | 通过标准 |
|---|---|---|
| P0-1 后端 | `docker run --rm -v $PWD/session-service:/opt/oh-session-service oh-session-test:latest tests/ -q` | 全量绿，新增用例覆盖替换语义 |
| P0-1 前端 | `bash e2e/run-session-frontend-docker-tests.sh`（复用 runtime 镜像模式） | lint+vitest+Playwright 全绿，含无重复断言 |
| P1-2 | 启动校验单测 + 故意配错 `OH_OH_BIN` 起容器观察 fail-fast 日志 | 启动即失败且日志可定位 |
| P1-3 | smoke 阶段 `/version.json` 断言；healthz 含 version/oh_bin/runtime | 字段齐全、tag 由 .env 驱动 |
| P1-4 | `bash e2e/run-session-live-acceptance.sh`（及各子脚本单独执行） | 全部 PASS，报告落盘 |

## 6. P2 优化项（可选，不阻塞）

- 既有 e2e 脚本（`run-session-container-pool-tests.sh` 等）迁移到 override file 方式（当前 env 方式保留兼容）。
- OH_OH_BIN spawn 探活（启动时 `--version` probe）：语义复杂（真 oh 无 key 时行为不定），暂缓。
- 前端 Settings 面板展示 `/version.json` 内容（运行版本自查入口）。
- Playwright 真实后端 `@live` 套件（对 5174 实况跑浏览器级验收，含历史回放刷新用例）。
- P1-4 脚本挂接 CI 定时任务。
- L5 UX 观察项（会话标题、创建进度提示、配额占用可视化）：**明确不在本轮范围**，另立变更。

## 7. 风险与回滚

- P0-1 涉及 WS 线协议：`full_text` 为**新增可选字段**、final 帧 `text` 置空为行为收敛，兼容矩阵见 §1.4；回滚 = 还原 `_map_event` 两行 + 前端分支。
- P1-2 fail-fast 可能阻断"容器运行时 + 网关无 oh"的既有部署：已用 runtime 判定降级为 WARN 规避。
- P1-3 仅加字段/参数化 tag，无行为变更；`SESSION_FRONTEND_VERSION` 未设时回退 v0.1.0，与现状一致。
- P1-4 为纯新增脚本，零回归面。
