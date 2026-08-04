# 任务清单：stub 租户并发上限 429 调整

> 状态：**DRAFT（未实现）** · 独立 issue，不阻塞 Change3 归档，不修改全局 stub profile。

## 1. 决策
- [ ] 1.1 明确 E2E 并发 429 的复现方式：为并发用例起低 `OH_TENANT_MAX_CONCURRENT` 的临时租户/栈，或经故障注入点显式触发 429。
- [ ] 1.2 记录决策：保持全局 stub `OH_TENANT_MAX_CONCURRENT=12` 不变（常规 E2E 不限流）。

## 2. 实现（test-infra）
- [ ] 2.1 并发容量类 E2E 改用可控 429 通道，断言恢复有效。
- [ ] 2.2 确保改动不触碰 `docker-compose.stub.yml` 全局并发放宽。

## 3. 验收
- [ ] 3.1 并发用例在可控 429 下断言通过，且常规 E2E 仍不限流。
- [ ] 3.2 全局 stub profile diff 为空（未静默修改）。

## 备注
- 与 `2026-08-04-e2e-chromium-new-headless-bfcache`、`2026-08-04-test-infra-startup-failure-hook` 同属 test-infra/后续 change，互不依赖。
