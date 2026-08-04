# E2E：stub 租户并发上限 429 调整

> 状态：**已归档（2026-08-04 验收通过）** · 原日期：2026-08-04
> 独立 issue：stub profile 放宽 `OH_TENANT_MAX_CONCURRENT=12` 导致 E2E 并发断言前提不成立。不修改 stub profile 静默带过，作为后续 change 显式登记与决策。

> ✅ **已归档**：2026-08-04 真实后端 E2E 验收通过（`OH_E2E_429_PROFILE=1 bash e2e/run-design-frontend-real-backend-tests.sh real-tenant-429` → C1 在 `docker-compose.stub.429.yml`(limit=2) 下稳定复现并发 429；默认 12 profile 未动、无回归）。

## Why

已确认事实（真实后端验收栈）：

1. `docker-compose.stub.yml` 将 stub 租户 `OH_TENANT_MAX_CONCURRENT` 放宽到 **12**，避免正常 E2E 被限流。
2. 但部分并发/容量类 E2E 断言**依赖「达到并发上限即 429」**这一前提；在 `=12` 下该前提不成立，断言失效或误判。
3. 用户已拍板：429 问题保持**独立 issue**，**不修改 stub profile** 蒙混过关。

## What Changes

- 显式决策并记录：E2E 中并发容量类断言如何拿到**可控的 429**（例如为并发测试单独起一个低 `OH_TENANT_MAX_CONCURRENT` 的临时租户/栈，或在故障注入点显式触发 429），而非改动全局 stub profile。
- 保持全局 stub profile 的放宽不变，确保常规 E2E 不被限流干扰。

## Capabilities

### New Capabilities
- `e2e-stub-429-concurrency`：E2E 中可控复现租户并发 429 的能力（独立于全局 stub 放宽）。

## Impact

- **范围**：E2E 起栈/租户配置与并发用例；不改 `session-service` 限流语义、不改生产 `OH_TENANT_MAX_CONCURRENT`。
- **风险**：若误改全局 stub profile，会让常规 E2E 重新被限流——严禁。

## Non-goals

- 不改生产租户并发/容量语义。
- 不修复产品侧限流文案（属其他范畴，如需另立 change）。
