# Proposal: harden-session-service

**Change ID:** `harden-session-service`
**Created:** 2026-07-27
**Status:** Draft
**Baseline spec:** `openspec/specs/interactive-session.md` (17 Requirements)
**Source:** `session-service/` code review — 18 findings (5 high, 7 medium, 6 low)

---

## Why

对 `session-service/` 后端代码进行全面审查后发现 18 项问题，其中 5 项高严重度（事件循环阻塞、资源泄漏、竞态条件、安全绕过）、7 项中严重度（头注入、非原子操作、封装破坏、鉴权泄露）、6 项低严重度。这些问题在生产负载下可直接导致服务不可用或安全漏洞，需系统性加固。

## What Changes

基于 `interactive-session` spec 基线，对以下领域进行加固：

1. **事件循环安全**：ffprobe/shutil.rmtree 等同步阻塞操作异步化（SS-1, SS-17）
2. **资源管理**：Redis 连接池化、S3 客户端缓存（SS-2, SS-13）
3. **竞态消除**：租户配额 TOCTOU、COLD 重连双重 rehydrate（SS-3, SS-4）
4. **安全加固**：XFF 伪造防护、Content-Disposition 注入、WS API Key 脱敏、ApprovalRequest 枚举验证（SS-5, SS-6, SS-11, SS-15）
5. **原子性保证**：Redis 锁释放、令牌桶限流改为 Lua 脚本原子操作（SS-7, SS-9）
6. **代码质量**：封装修复、DB 依赖统一、异常捕获完善、payload 限制（SS-8, SS-10, SS-14, SS-16）
7. **功能补全**：实现每日配额检查（SS-18）
8. **统一 Redis 客户端**：消除同步/异步混用（SS-12）

## Capabilities

### New
- 无全新 capability，均为现有 `interactive-session` 的加固

### Modified
- `interactive-session`：加固事件循环安全、资源管理、竞态条件、安全防护、原子操作、封装、测试覆盖

## Impact

- **代码范围**：`session-service/app/` 下约 15 个文件
- **风险**：低——均为增量加固，不改变现有 API 契约或协议行为
- **测试**：每个修复配套 TDD 测试，补充 proxy/registry/logs/storage 模块测试
- **部署**：无数据库迁移变更，无新依赖引入

## Architecture Considerations

- **增量加固，非重构**：所有修复均在现有代码结构上进行，不引入新的中间件或基础设施依赖。
- **Lua 脚本原子化**：Redis 操作（锁释放、令牌桶）改为 Lua EVAL，保证原子性且不增加 RTT。
- **异步化策略**：阻塞 I/O（ffprobe、rmtree）通过 `run_in_executor` / `run_in_threadpool` 卸载到线程池，不改变业务逻辑。
- **连接池单例**：Redis 连接池在模块级缓存，避免每次请求创建新 TCP 连接。
- **安全默认**：XFF 仅在配置了可信代理后生效，API Key 在日志中自动脱敏。

## Success Criteria

- [ ] 所有 18 项审查发现（SS-1 至 SS-18）均有对应的 spec delta requirement（MODIFY 或 ADD）及至少一个 GIVEN/WHEN/THEN 场景。
- [ ] ffprobe 和 rmtree 通过 `run_in_executor`/`run_in_threadpool` 异步执行，事件循环不再阻塞。
- [ ] Redis 连接池单例替代每次 `from_url()`；无同步 Redis 调用残留。
- [ ] 租户配额检查在并发创建下不超卖（TOCTOU 消除）。
- [ ] COLD 重连在并发 WS 连接下仅触发一次 rehydrate。
- [ ] XFF 伪造在非可信代理后不生效；Content-Disposition 文件名已 sanitize。
- [ ] Redis 锁释放和令牌桶限流通过 Lua 脚本原子执行。
- [ ] `cd session-service && python -m pytest -q` 全部通过，无回归。

## Risks & Mitigations

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Lua 脚本语法在不同 Redis 版本行为差异 | 低 | 中 | 使用标准 Lua 5.1 语法，测试覆盖 Redis 6.x/7.x |
| `run_in_executor` 线程池耗尽导致异步操作排队 | 低 | 中 | 配置合理的线程池大小；监控线程池使用率 |
| 连接池单例在热重载场景下泄漏 | 低 | 低 | 注册 shutdown hook 显式关闭连接池 |
| XFF 配置错误导致限流 key 退化 | 中 | 低 | 默认不信任 XFF（`OH_TRUSTED_PROXY` 默认空），需显式配置 |
