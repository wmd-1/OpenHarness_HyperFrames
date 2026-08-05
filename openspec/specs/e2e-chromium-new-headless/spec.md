# e2e-chromium-new-headless Specification

## Purpose
设计前端 E2E 运行环境基线：提供完整 chromium + new headless 镜像变体（`openharness-design-frontend:e2e-chromium`，`PW_USE_NEW_HEADLESS=1` 选用）用于 BFCache 诊断与对照；BF3 验收口径为方向②（离开/返回会话页 → REST 重水合 + WS 重连 + 对话可继续），因 Playwright 默认 `--disable-back-front-cache` 且移除后亦不可自动化驱动 BFCache 唤醒，`pageshow.persisted===true` 在 Playwright 下恒不可达，降级为信息性记录。
## Requirements
### Requirement: E2E 运行环境 MUST 提供完整 chromium + new headless 镜像变体用于 BFCache 诊断
设计前端 E2E 运行环境 MUST 提供以完整 chromium 运行于 new headless 的镜像变体（`openharness-design-frontend:e2e-chromium`，经 `PW_USE_NEW_HEADLESS=1` 选用），用于 BFCache 相关诊断与对照；其余用例默认仍用 `chrome-headless-shell` old headless 镜像。

#### Scenario: 完整 chromium 镜像变体可用
- **WHEN** 以 `PW_USE_NEW_HEADLESS=1` 运行 E2E
- **THEN** 测试在完整 chromium + new headless 中执行（非 headless-shell）
- **AND** `E2E_BFCACHE=1` 可临时移除 Playwright 默认注入的 `--disable-back-forward-cache` 作为诊断开关（默认关闭，避免冻结页干扰 Playwright 的 reload/inspect）

### Requirement: BFCache 唤醒用例 MUST 验证可自动化保证（方向②），不依赖 pageshow.persisted
依赖 BFCache 的 Playwright 用例 MUST 验证用户侧真实可自动化保证（离开/返回会话页 → REST 重水合 + WS 重连可用 + 对话可继续）；`pageshow.persisted===true` 在 Playwright 下恒不可达（根因见 `docs/bfcache-e2e-investigation-2026-08-04.md`），MUST 降级为信息性记录，不得作为硬断言或 skip 门控。

#### Scenario: 离开/返回会话页后恢复可用
- **WHEN** 用例在真实后端栈中进入会话、离开页面再返回（Playwright 默认下为整页 reload）
- **THEN** 应用经 REST 重水合会话、WS 重连并建立可用连接、第二轮对话可继续
- **AND** `pageshowEvents` / `wokeFromBFCache` 作为 test annotation 记录，不阻断用例

#### Scenario: 静态控制组作为负向对照
- **WHEN** 运行静态 HTTP 控制组（无 vite/HMR/WS）
- **THEN** 默认（Playwright `--disable-back-forward-cache`）`backPersisted=false`，并打印 Chromium 真实进程 argv 与 `notRestoredReasons` 佐证根因
- **AND** 不因此类环境限制静默 skip BFCache 相关验证

