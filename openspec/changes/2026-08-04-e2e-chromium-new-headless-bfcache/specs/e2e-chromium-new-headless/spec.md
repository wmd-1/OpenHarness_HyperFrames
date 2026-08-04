## ADDED Requirements

### Requirement: E2E 运行环境 MUST 提供支持 BFCache 的浏览器
设计前端 E2E 运行环境 MUST 使用完整 chromium 运行于 new headless（而非 `chrome-headless-shell` old headless），以确保页面在前进/后退/切后台时被冻结并维护 BFCache，使 `pageshow.persisted` 在恢复时为真。

#### Scenario: BFCache 在未归档的 E2E 环境中可用
- **WHEN** 测试在固定 tag 的 e2e 镜像中启动并导航后执行前进/后退
- **THEN** 恢复事件的 `pageshow.persisted` 为真
- **AND** 浏览器不为 old headless 静默跳过 BFCache 相关用例

#### Scenario: 能力不足时 fail-fast
- **WHEN** e2e 镜像回退到不支持 BFCache 的浏览器二进制
- **THEN** 启动自检暴露 `BFCACHE_SUPPORTED=false` 或直接在 BFCache 用例上 fail-fast
- **AND** MUST NOT 静默 `test.skip` 掩盖能力缺失

### Requirement: BFCache 相关用例 MUST 按能力门控而非无条件跳过
依赖 BFCache 的 Playwright 用例 MUST 依据运行时能力探测决定是否执行，并在能力具备时真实验证唤醒路径。

#### Scenario: 能力具备时真实验证
- **WHEN** 运行环境 `BFCACHE_SUPPORTED` 为真
- **THEN** BFCache 唤醒用例真实执行并断言 WS probe/reconnect 与对话可继续

#### Scenario: 能力缺失时明确跳过
- **WHEN** 运行环境 `BFCACHE_SUPPORTED` 为假
- **THEN** BFCache 用例以带明确原因的 `test.skip` 挂起
- **AND** 非 BFCache 用例（后端失败 1011 等）不受影响照常运行
