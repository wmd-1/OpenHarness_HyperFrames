# 任务清单：后端启动失败 hook

> 状态：**DRAFT（未实现）** · 后续 change，不阻塞 Change3 归档。

## 1. 设计
- [ ] 1.1 明确「启动失败」判定：退出码非 0 / 健康检查连续 N 次失败 / 端口在宽限期内未监听；区分「启动慢」。
- [ ] 1.2 明确诊断输出：进程日志尾部（脱敏 `*_API_KEY`/`X-API-Key`）、退出码、端口占用、最近一次健康检查错误。

## 2. 实现（test-infra）
- [ ] 2.1 在起栈 runner（`e2e/run-*.sh` 或等效）起栈后插入 startup-failure hook，未 ready 早失败。
- [ ] 2.2 与既有 `healthz` 含 `oh_backend_stub` 校验共存，不重复。

## 3. 验收
- [ ] 3.1 故意制造后端启动失败（如错误镜像/端口冲突），hook 早失败且诊断可读。
- [ ] 3.2 正常起栈下 hook 不误报、不拖慢。

## 备注
- 与 `2026-08-04-e2e-chromium-new-headless-bfcache` 同属 test-infra，互不依赖。
