# Session Live Acceptance Specification

**Component:** `e2e/run-session-live-acceptance.sh` / `e2e/session-acceptance/`
**Established by change:** `session-acceptance-hardening` (2026-07-30)

实况验收自动化：将人工验收流程固化为可重复执行的分层脚本（REST / WS 生命周期 / 前端反代），总入口聚合，基于已有镜像 + stub compose override 运行。

---

## Requirements

### Requirement: 实况验收脚本
仓库 SHALL 提供总入口 `e2e/run-session-live-acceptance.sh` 与子脚本目录 `e2e/session-acceptance/`（`lib.sh`、`rest.sh`、`ws.sh`、`frontend.sh`），将人工验收流程固化为可重复执行的自动化断言。总入口 SHALL 负责环境拉起、临时租户 key 签发、依次调用子脚本并聚合退出码、trap 清理；子脚本 SHALL 可独立执行（入参全部经环境变量 `BASE_URL`、`FRONTEND_URL`、`API_KEY`、`API_KEY_B` 传入），并以退出码上报各自断言结果。脚本 SHALL 基于已有镜像 + stub compose override 运行（宿主机仅使用 docker / docker compose / curl），SHALL 输出 PASS/FAIL 汇总与报告文件（`E2E_REPORT`，默认 /tmp），并以非零退出码标识失败。

#### Scenario: 一键执行全量验收
- **WHEN** 执行 `bash e2e/run-session-live-acceptance.sh`
- **THEN** 总入口自动完成环境拉起、临时租户 key 签发，依次调用 rest.sh、ws.sh、frontend.sh 并聚合各自退出码，最终输出 PASS/FAIL 汇总并落盘报告

#### Scenario: 子脚本独立执行
- **WHEN** 环境已就绪时单独执行 `BASE_URL=... API_KEY=... bash e2e/session-acceptance/rest.sh`
- **THEN** 仅运行 REST 断言组并以退出码上报结果，不依赖总入口的环境拉起逻辑

#### Scenario: 环境拉起与就绪等待
- **WHEN** 总入口启动
- **THEN** 以 `-f docker-compose.yml -f docker-compose.stub.yml` 组合拉起 session（stub 后端、短 idle grace），轮询 healthz 至 200 后才开始断言

### Requirement: REST 验收断言组
`e2e/session-acceptance/rest.sh` SHALL 覆盖以下 REST 断言：无 key 请求 → 401；create → 201；list 含新建会话；REST turn → completed 且 `has_artifact=true`；turns 列表可读；artifact 下载 → 200（video/mp4）且 `Range: bytes=0-99` → 206；路径穿越（`..%2f`、绝对路径）→ 400；不存在 SID → 404；空 text → 422；第二租户跨租户访问 → 404 且 list 不可见；超出 `tenant_max_concurrent` → 429。

#### Scenario: 鉴权与隔离断言
- **WHEN** 分别以无 key、租户 A key、租户 B key 访问租户 A 的会话资源
- **THEN** 依次得到 401、200 系列、404，且租户 B 的 list 中看不到租户 A 会话

#### Scenario: 产物与输入校验断言
- **WHEN** 对 turn 产物执行完整下载、Range 下载、穿越路径、非法输入请求
- **THEN** 依次得到 200(video/mp4)、206、400、422/404，全部与断言一致

### Requirement: assistant_text 无重复回归断言
`rest.sh` SHALL 在 turn 完成后读取 turns 接口，断言 `assistant_text` 等于单份 stub 全文（`Stub reply to: <prompt>` 恰出现一次），作为 assistant_complete 最终覆盖语义的实况回归锚点。

#### Scenario: 单份全文断言
- **WHEN** stub 后端完成一个 turn 后查询该轮 `assistant_text`
- **THEN** 回复全文恰出现一次，无重复拼接

### Requirement: WS 生命周期验收断言组
`e2e/session-acceptance/ws.sh` SHALL 复用 `scripts/ws_e2e_driver.py` 覆盖：WS submit → delta 流式 → `turn_complete`；detach 后 idle grace 到期 → status=cold；cold 下 workspace files `source=archive`；WS 重连触发 resume 且 turn_count 连续；DELETE 软关闭后 status=closed 且 turns 仍可读。

#### Scenario: live→cold→resume→closed 全链路
- **WHEN** 依次执行 WS turn、detach 等待驱逐、读取归档文件、WS 重连再 turn、DELETE 会话
- **THEN** 状态依次为 live→cold（archive 可读）→live（turn_count 连续）→closed（历史仍可读），各步断言通过

### Requirement: 前端反代冒烟断言
`e2e/session-acceptance/frontend.sh` SHALL 经 5174 端口断言：`/` 返回 SPA 壳（200）、`/healthz` 反代后端返回 200、`/version.json` 可访问且 `Cache-Control` 含 `no-store`（运行镜像尚未包含该文件时记 WARN 而非 FAIL，允许脚本先于版本元数据能力落地）。

#### Scenario: 反代链路健康
- **WHEN** 前端容器就绪后经 5174 请求 `/` 与 `/healthz`
- **THEN** 两者均返回 200，证明 nginx 反代指向当前 session 容器（无陈旧 IP）

### Requirement: 验收数据清理
总入口结束（含异常中断 trap）SHALL revoke 本次签发的临时租户 key 并 DELETE 测试会话；临时租户名 SHALL 含随机后缀以避免与真实租户冲突。

#### Scenario: 正常结束清理
- **WHEN** 全部断言执行完毕
- **THEN** 临时 key 被 revoke、测试会话被关闭，不在 api_keys / 会话列表中残留可用凭据
