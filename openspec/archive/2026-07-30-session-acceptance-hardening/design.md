# Design: session-acceptance-hardening

## Context

- 网关（session-service）通过 OHJSON 行协议 spawn `oh --backend-only` 子进程，事件经 `supervisor._map_event` 映射为 WS 帧，`assistant_text` 由 `_assistant_buf` 拼接后持久化。
- 已核实的事实链（报告 §5-L1）：真 oh `backend_host.py` 的 `assistant_complete.message` 为最终全文（`text.strip()`）；`_map_event` 将其 append 进缓冲并再发一帧全文 delta；前端 `useWebSocket.ts` 对 delta 一律 push（`final` 仅 flush）。三处叠加 → 真后端下持久化与显示均双份。
- 部署侧：`docker-compose.yml` 的 `OH_OH_BIN=${OH_OH_BIN:-…}` 依赖启动 shell 的环境；`session-frontend` 的 `depends_on: [session]` 使任何前端 `up` 都可能连带 recreate 后端并静默复位 env（验收中两次复发）。
- 版本侧：前端镜像 tag 硬编码 `v0.1.0`，无构建元数据；后端 healthz 无版本信息。
- 约束：所有测试基于已有镜像 + 挂载源码（`.qoder/rules/test-on-existing-images.md`）；不引入新基础镜像。

## Goals / Non-Goals

**Goals:**
- assistant 事件语义成文，消除 assistant_text 重复（持久化 + 显示），兼容新旧前后端组合。
- stub/e2e 环境配置进入版本库（override file），`OH_OH_BIN` 失配在启动期暴露。
- 运行版本可在线核对（前端 /version.json、后端 healthz 字段），镜像 tag 单一来源（.env）。
- 人工验收流程脚本化，可重复执行并输出报告。

**Non-Goals:**
- UX 扩展（会话标题、创建进度、配额可视化）——另立变更。
- 修改 stub 或真 oh 的事件发射行为（stub 忠实模拟真 oh，二者均不动）。
- CI 定时挂接、既有 e2e 脚本向 override file 的迁移（列为后续优化）。

## Decisions

### D1 assistant_complete 权威语义：最终覆盖（overwrite），而非增量

- **契约（语义层唯一真相）**：`assistant_delta.message` 为增量（追加）；`assistant_complete.message` 为权威最终全文，语义是**最终覆盖**——整体取代此前累计 delta，禁止追加。写入 `protocol.py` docstring 与 `session-ws-protocol` 规格。
- **与传输层的关系**：WS 线上的 `delta + final + full_text` 帧仅是**兼容 envelope**（见 D2），不是语义本身；后续实现不得据帧型把 complete 理解为"又一条增量"。
- **网关**：`_map_event` 的 complete 分支将 `_assistant_buf` 整体替换为 `[message]`；持久化路径（`"".join(buf)`）不动。
- **备选与否决**：把 complete 当去重后的增量（diff 拼接）——否决，真 oh 的 complete 经过 `strip()`，与 delta 拼接结果存在细微差异，diff 语义脆弱；覆盖语义简单且以权威全文为准。

### D1b stub 与生产事件行为一致性

stub（`oh_backend_stub.py`）必须与生产（真 `oh --backend-only`）保持事件序列行为一致：同样发 `assistant_delta` 流 + 携全文的 `assistant_complete`。**stub 不改**。

- **理由**：stub 的价值在于无 LLM key 环境下忠实复现生产协议路径；本次重复缺陷正是靠 stub 暴露的——若"修 stub"只会掩盖真后端同样存在的缺陷。
- **约束**：后续若真 oh 协议演进（新事件/字段语义变化），stub 必须同步跟进，保持"stub 通过 ≈ 生产协议路径通过"的可信度。

### D2 线协议：兼容 envelope —— final 帧 text 置空 + 新增可选 full_text

发 `{"type":"delta","text":"","final":true,"full_text":<全文>,"turn_index":n}`。该帧是 D1 覆盖语义的**传输层兼容包装**，不是语义定义。

- 为何 text 置空：旧前端是追加逻辑，text 置空使**只升级后端即可消除重复**（部署解耦的关键）。
- 为何加 full_text：新前端用全文整体替换流缓冲，天然纠正 delta 丢帧/乱序造成的显示偏差；重连场景收益明确。
- **备选与否决**：
  - 新帧类型 `assistant_final`——否决：旧前端会走 unknown 帧路径丢弃 final 信号，破坏 flush 时序；复用 delta+final 零迁移成本。
  - 仅后端修（不加 full_text）——否决：丢帧自愈能力免费获得，前端改动极小。
- Chat 前端处理：`final && full_text != null` → streamBuffer 新增 `replace(turnIndex, text)` 后 flush。
- **Terminal 模式处理（支持 full_text 替换，不忽略）**：xterm 无法像 React 状态那样"替换"已打印内容，但丢帧导致的内容不完整必须纠正——TerminalBridge 维护本轮已流式输出的累计文本 `turnBuf`：
  - `turnBuf` 是 `full_text` 前缀 → 只补写缺失尾部（无丢帧时尾部为空，零重复）；
  - 非前缀（丢帧/乱序）→ 换行后以 dim `[resync]` 标注重放全文（回擦多行滚动区不可靠，重放是确定性最强的纠正）；
  - final 处理后重置 `turnBuf`。
- 兼容矩阵：新后端+旧前端不重复；新后端+新前端替换且抗丢帧（Chat 与 Terminal 均是）；旧后端+新前端不劣化（无 full_text 走旧逻辑）。

### D3 stub 模式固化为 compose override 文件

新增 `docker-compose.stub.yml` 仅覆盖 `session` 服务的 `OH_OH_BIN`（指向 stub）与 `OH_IDLE_GRACE_SECONDS`。stub 模式统一 `-f docker-compose.yml -f docker-compose.stub.yml`，禁止裸 shell env 覆盖。

- **理由**：override 文件进版本库，任何人任何 shell 执行结果一致；shell env 插值正是两次故障复发的根因。
- **备选与否决**：写进 `.env`——否决，`.env` 是宿主全局状态，会把 stub 泄漏到正常启动路径；compose profiles——否决，profiles 控制服务启停而非 env 覆盖，语义不符。

### D4 OH_OH_BIN 配置语义与启动校验：process fail-fast，container 降级 WARN

- **配置语义**：`OH_OH_BIN` 是**单一可执行文件路径**（`create_subprocess_exec` 的 argv[0]，已核实 `process.py::build_command`），**不支持带参数的 command 字符串**；需要注入参数/解释器时用带 shebang 的 wrapper 脚本（stub 即此模式）。写入 config.py 注释与 .env.example。
- **校验规则**（lifespan 启动段，与语义对应）：① 值不含空白字符（含空白≈误配成 command，报错提示用 wrapper）；② 路径存在且为普通文件（符号链接解析后）；③ `os.access(X_OK)` 可执行。
- `OH_SESSION_RUNTIME=process` 不满足即抛异常终止（日志含当前值、失败规则与修复提示），`container` 运行时仅 WARN（oh 在会话镜像内，网关不可见，由容器 spawn 兜底）。
- **备选与否决**：支持 command 字符串（shlex 拆分）——否决，扩大注入面且与现有 spawn 路径语义不符；wrapper 脚本模式已覆盖全部需求。spawn `--version` 探活——否决（暂缓），真 oh 无 LLM key 时行为不定，误报风险高。

### D5 版本可观测：静态元数据优先，/version.json 强制 no-cache

- 前端：Dockerfile build args（`GIT_SHA`/`BUILD_TIME`/`APP_VERSION`）→ 构建期生成 `dist/version.json` → nginx 发布 `/version.json`。零运行时开销、CSP 不受影响；git sha 由构建脚本注入（compose 内不执行 git）。
- **no-cache 设计**：`nginx.conf.template` 为 `/version.json` 增加专用 location，`Cache-Control: no-store` + 完整安全头（与 `location = /index.html` 的模式对齐，遵循"location 内 add_header 覆盖父级、安全头必须重复声明"的既有约定）。理由：该文件的存在意义就是实时探测运行版本，任何中间/浏览器缓存都会造成"探到旧版本"假象，与问题②同构。
- 后端：healthz 增加 `version`（importlib.metadata，回退 unknown）、`oh_bin`、`runtime` 三字段；健康判定逻辑不变。

### D5b 版本 source of truth：.env 驱动 tag，package.json 驱动内容版本

- **单一来源链**：`session-frontend/package.json` 的 `version` 是代码版本的 source of truth → 构建时经 `APP_VERSION` build arg 写进 `/version.json` → 镜像 tag 由 `.env` 的 `SESSION_FRONTEND_VERSION` 驱动（`${SESSION_FRONTEND_VERSION:-v0.1.0}`），二者合入时同步 bump。镜像 tag MUST NOT 多处硬编码（遵循既有「tag 经 .env 传入」约定）。
- 漂移检测闭环：冒烟阶段比对 `/version.json` 的 `git_sha` 与当前 HEAD（本地全新构建时），忘记 bump/镜像过期均可被发现。
- **备选与否决**：CI 自动按 git sha 打 tag——否决（本轮），项目无镜像 registry 流水线，本地 compose 场景下 .env 单一来源已消除"多处硬编码 + 不可感知过期"；以 git sha 为 tag——否决，人不可读且与语义化版本断连，sha 已由 version.json 承载。

### D6 验收脚本：总入口聚合 + 可独立执行的分层子脚本

结构：`e2e/run-session-live-acceptance.sh`（总入口：环境拉起 + key 签发 + 依次调用 + 汇总/trap 清理）+ `e2e/session-acceptance/{lib,rest,ws,frontend}.sh`。子脚本入参全部经环境变量（`BASE_URL`/`FRONTEND_URL`/`API_KEY`/`API_KEY_B` 等），各自输出分组 PASS/FAIL 并以退出码上报，不做环境拉起/清理。

- **理由**：单层回归（只改后端时只跑 rest+ws）无需全量重跑；子脚本可指向任意已运行环境（含非 stub 环境的手工诊断）。
- 覆盖内容：rest.sh（401/create/turn/artifact+Range/穿越/404/422/跨租户/配额 429 + assistant_text 无重复锚点）；ws.sh（复用 `ws_e2e_driver.py`：turn/idle→cold/archive/resume/软关闭）；frontend.sh（5174 反代 `/`、`/healthz`、`/version.json` 200 且 Cache-Control 含 no-store，镜像未含时 WARN 不 FAIL）。
- 宿主机仅 docker/curl，基于已有镜像 + stub override（D3）。

## Risks / Trade-offs

- [WS 线协议变更引入 full_text] → 可选字段 + 兼容矩阵（D2）保证任意新旧组合不劣化；回滚 = 还原 `_map_event` 两行与前端分支。
- [fail-fast 阻断 container 运行时既有部署] → runtime 判定降级 WARN（D4）。
- [真 oh 全文与 delta 拼接存在 strip() 级差异] → 采用 complete 全文为权威（覆盖），显示与持久化以全文为准，差异被消化而非放大。
- [验收脚本依赖临时租户 key 残留] → 脚本 trap 清理 + revoke；即使中断残留，key 面向随机租户名，不影响其他租户。
- [SESSION_FRONTEND_VERSION 忘记 bump] → 冒烟阶段 /version.json git_sha 比对（本地全新构建时）暴露漂移；流程上合入即 bump 写入贡献约定。

## Migration Plan

1. 后端 D1/D2/D4/healthz 合入 → 镜像内跑 pytest 全量（源码挂载，无需重建镜像）。
2. 前端 D2/D5 合入 → `run-session-frontend-docker-tests.sh` 全流水线（lint/vitest/Playwright，mock-backend 同步新契约）。
3. 部署文件 D3/D5 tag 参数化 → `docker compose config` 校验插值。
4. D6 脚本落地 → 全量执行一次作为验收基线，报告归档。
5. 回滚：各项独立可回滚；D2 回滚仅还原网关映射与前端分支，不涉数据迁移。

## Open Questions

- 无阻塞项。`OH_GIT_SHA` 后端注入为可选增强，未设时 healthz 省略该子字段即可。
