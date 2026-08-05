# 任务清单：后端启动失败 hook

> 状态：**已归档（2026-08-05）** · 实现完成、验收已完成（既有镜像内隔离验证）；spec 已同步主 specs（`openspec/specs/test-infra-startup-failure-hook/spec.md`）。

## 1. 设计
- [x] 1.1 明确「启动失败」判定：容器进入终态（exited/dead/removing）→ 立即失败；否则 healthz 在宽限 `STARTUP_READY_TIMEOUT`(默认120s) 内未 200 → 失败；容器仍 running 视为「启动慢」继续等，不误判。
- [x] 1.2 明确诊断输出：容器 id/status/exit_code、日志尾部 50 行（脱敏 `*_API_KEY`/`X-API-Key`/`Authorization: Bearer`/`"api_key"`）、端口占用（`ss -ltn`）、最近一次 healthz 探测（≤500B）。

## 2. 实现（test-infra）
- [x] 2.1 新增共享库 `e2e/startup-failure-hook.sh`（`wait_for_backend_ready`/`diagnose_backend_failure`/`redact_secrets`），接入 `e2e/run-design-frontend-real-backend-tests.sh` 与 `e2e/run-session-live-acceptance.sh` 起栈后；未 ready 早失败。
- [x] 2.2 与既有 `healthz` 含 `oh_backend_stub` 校验共存：hook 只负责就绪/失败检测，既有 stub override 断言保持不变，无重复。

## 3. 验收
- [x] 3.1 故意制造后端启动失败（如错误镜像/端口冲突），hook 早失败且诊断可读。已用 busybox 立即退出容器隔离验证：检测到 `status=exited exit_code=1` 早失败，诊断块含 cid/status/exit_code、脱敏日志尾部、端口占用、最近 healthz 探测。
- [x] 3.2 正常起栈下 hook 不误报、不拖慢。已用 busybox 起 httpd 提供 /healthz 200 隔离验证：命中即返回 0，无误报、无拖慢。

## 备注
- 与 `2026-08-04-e2e-chromium-new-headless-bfcache` 同属 test-infra，互不依赖。
- 已补 `specs/test-infra-startup-failure-hook/spec.md` 增量，`openspec validate --all` 不再报 DRAFT/缺失 delta。
- 脱敏逻辑自带 `run_startup_hook_selftest`（直接 `bash e2e/startup-failure-hook.sh` 可跑，无需 docker）。

## 备注
- 与 `2026-08-04-e2e-chromium-new-headless-bfcache` 同属 test-infra，互不依赖。
