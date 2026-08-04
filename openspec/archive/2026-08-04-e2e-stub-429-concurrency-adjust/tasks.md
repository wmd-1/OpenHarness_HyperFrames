# 任务清单：stub 租户并发上限 429 调整

> 状态：**已归档（2026-08-04 验收通过）** · 独立 issue，不阻塞 Change3 归档，不修改全局 stub profile。
> 用户锁定边界：保持默认 stub 配置 `OH_TENANT_MAX_CONCURRENT=12` 不变，通过测试专用 profile 覆盖验证 429，不影响其他 E2E。

## 1. 决策（已锁定）
- [x] 1.1 默认 stub profile `OH_TENANT_MAX_CONCURRENT=12` 保持不变；429 验证通过独立覆盖文件 `docker-compose.stub.429.yml`（OH_TENANT_MAX_CONCURRENT=2）+ 运行脚本 `OH_E2E_429_PROFILE=1` 门控。
- [x] 1.2 确认 `docker-compose.stub.yml` 未改动（diff 为空）。

## 2. 实现（test-infra）
- [x] 2.1 新增 `docker-compose.stub.429.yml`：仅覆盖 session 服务 `OH_TENANT_MAX_CONCURRENT=2`。
- [x] 2.2 新增专用用例 `real-tenant-429.spec.ts`（C1），由 `OH_E2E_429_PROFILE=1` 门控；`real-boundary.spec.ts` B4 改造为同门控，不再依赖默认 12 的脆弱断言。
- [x] 2.3 运行脚本 `run-design-frontend-real-backend-tests.sh`：`OH_E2E_429_PROFILE=1` 时向 compose 组合追加 `docker-compose.stub.429.yml`。
- [x] 2.4 `_helpers.ts` `tryCreateSessionViaApi` 返回 `data`，供 429 用例校验响应体非空。

## 3. 验收
- [x] 3.1 429 profile 下运行 `real-tenant-429`：status 429 + 201 混合，且 429 有响应体（真实配额拒绝）。✅ 已验证（2026-08-04）
- [x] 3.2 默认 suite 下 B4/C1 均 skip，确认不影响其他 E2E。✅ 已验证（2026-08-04）

## 备注
- 与 `e2e-chromium-new-headless-bfcache`、`test-infra-startup-failure-hook` 同属 test-infra/后续 change，互不依赖。
