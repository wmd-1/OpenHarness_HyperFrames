# Tasks: session-acceptance-hardening

优先级顺序：1（P0-1）→ 2（P1-2）→ 3（P1-3）→ 4（P1-4）；3 与 4 可并行。全部验证遵循「已有镜像 + 挂载源码」规则。

## 1. P0-1 assistant 事件契约与重复修复（后端）

- [x] 1.1 `session-service/app/session/protocol.py`：docstring 写入 assistant 事件契约（delta=增量、complete=权威最终覆盖；WS 的 delta+full_text 仅为兼容 envelope），更新 `EVENT_TO_FRAME` 中 `assistant_complete` 的注释
- [x] 1.2 `session-service/app/session/supervisor.py::_map_event`：`assistant_complete` 分支改为整体替换 `_assistant_buf`，帧改发 `text: ""` + `final: true` + `full_text`
- [x] 1.3 后端单测：stub 式同文双发（delta"X"+complete"X"）→ `assistant_text == "X"`；多 delta+complete 覆盖（"a","b"+"ab"）→ `"ab"`；complete 映射帧字段断言（text 空/final/full_text）
- [x] 1.4 镜像内跑 pytest 全量回归：`docker run --rm -v $PWD/session-service:/opt/oh-session-service oh-session-test:latest tests/ -q`

## 2. P0-1 assistant 事件契约与重复修复（前端）

- [x] 2.1 `session-frontend/src/types/ws.ts`：`DeltaFrame` 增加可选 `full_text?: string`
- [x] 2.2 streamBuffer 增加 `replace(turnIndex, text)`；`src/ws/useWebSocket.ts` delta 分支：`final && full_text != null` 时整体替换后 flush，否则维持追加
- [x] 2.3 `TerminalBridge.ts`：维护本轮累计文本 `turnBuf`；final+full_text 时：turnBuf 为 full_text 前缀→只补写缺失尾部（无丢帧时零重复）；非前缀→换行后 dim `[resync]` 标注重放全文；final 后重置 turnBuf
- [x] 2.4 前端单测：streamBuffer.replace、useWebSocket final/full_text 分支、无 full_text 的旧后端兼容分支、TerminalBridge 三分支（无丢帧零重复/丢帧补尾/非前缀 resync 重放）
- [x] 2.5 `session-frontend/e2e/mock-backend.mjs` 按新契约发 final 帧；既有流式回复 Playwright 用例增加"气泡文本无重复"断言
- [x] 2.6 前端全流水线回归：`bash e2e/run-session-frontend-docker-tests.sh`

## 3. P1-2 配置漂移治理与启动校验

- [x] 3.1 新增 `docker-compose.stub.yml`（仅覆盖 session 的 `OH_OH_BIN` 指向 stub 与 `OH_IDLE_GRACE_SECONDS`），`docker-compose.yml` 顶部注释与 `.env.example` 补充用法说明
- [x] 3.2 `session-service/app/main.py` lifespan：`OH_OH_BIN` 三条语义校验（①无空白字符，含空白提示改用 wrapper；②存在且为普通文件；③`os.access(X_OK)`），process 运行时 fail-fast（日志含当前值与修复提示），container 运行时 WARN
- [x] 3.3 启动校验单测：路径不存在→启动失败；含空白（误配 command）→启动失败且提示 wrapper；可执行→通过；container→仅告警
- [x] 3.4 实况验证：故意配错 `OH_OH_BIN` 起容器，确认启动即失败且日志可定位；用 override 组合起 stub 模式，确认连带 recreate 不漂移

## 4. P1-3 镜像版本管理与可观测

- [x] 4.1 `docker-compose.yml`：session-frontend image 改为 `${SESSION_FRONTEND_VERSION:-v0.1.0}` 插值；`.env.example` 登记变量与 bump 约定；`docker compose config` 校验
- [x] 4.2 `session-frontend/Dockerfile`：build args（APP_VERSION/GIT_SHA/BUILD_TIME）生成 `dist/version.json`，参数缺省时字段为 unknown；APP_VERSION 以 `package.json` 的 `version` 为 source of truth
- [x] 4.2b `session-frontend/nginx.conf.template`：新增 `/version.json` 专用 location，`Cache-Control: no-store` + 重复声明安全响应头（对齐 `location = /index.html` 模式）
- [x] 4.3 `e2e/run-session-frontend-docker-tests.sh`：smoke 阶段断言 `/version.json` 字段完整且 `Cache-Control` 含 no-store；本地全新构建时比对 git_sha 与 HEAD（复用镜像模式跳过）
- [x] 4.4 后端 healthz 增加 `version`/`oh_bin`/`runtime` 字段（与 3.2 同 PR），更新 `tests/test_health.py`
- [x] 4.5 镜像内回归：后端 pytest 全量 + 前端流水线（复用 4.2 产物镜像）

## 5. P1-4 实况验收自动化

- [x] 5.1 新增总入口 `e2e/run-session-live-acceptance.sh`：stub override 拉起 + healthz 等待 + 临时租户 key 签发 + 依次调用子脚本聚合退出码 + trap 清理（revoke key、DELETE 会话）+ PASS/FAIL 汇总与 `E2E_REPORT` 落盘；新增 `e2e/session-acceptance/lib.sh`（公共断言/计数/报告函数）
- [x] 5.2 `e2e/session-acceptance/rest.sh`（可独立执行，入参经 BASE_URL/API_KEY/API_KEY_B）：401/create 201/list/turn+has_artifact/turns/artifact 200+Range 206/穿越 400/404/422/跨租户 404/配额 429；含 assistant_text 无重复断言（`Stub reply to:` 恰出现一次，锚定任务 1）
- [x] 5.3 `e2e/session-acceptance/ws.sh`（复用 `scripts/ws_e2e_driver.py`）：turn→cold 驱逐→archive 读→resume（turn_count 连续）→DELETE 软关闭后 turns 仍可读
- [x] 5.4 `e2e/session-acceptance/frontend.sh`：5174 的 `/`、`/healthz` 200；`/version.json` 可访问且 Cache-Control 含 no-store（镜像缺失该文件时记 WARN 不 FAIL）
- [x] 5.5 全量执行一次作为验收基线，报告归档到 `e2e/`；验证子脚本可独立执行（环境就绪时单跑 rest.sh）

## 6. 收尾

- [x] 6.1 更新 `openspec/specs/session-ws-protocol.md`（同步 delta）并归档本变更
- [x] 6.2 在 `docs/session-e2e-test-report-2026-07-30.md` 追加“修复完成”备注（引用验收基线报告）
