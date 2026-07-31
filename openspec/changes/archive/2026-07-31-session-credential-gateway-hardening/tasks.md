# Tasks: session-credential-gateway-hardening

> 实现基线：`plans/Session_Tenant_Credential_Isolation_Fix_Plan_2026-07-31.md`（rev2）。
> 所有测试在已有镜像容器内执行（仓库规则《测试必须基于已有镜像》），不重建镜像。

## 1. 配置与 seed 派生（tenant_store）

- [x] 1.1 `app/config.py`：新增 `oh_global_settings_path: Path`（env `OH_GLOBAL_SETTINGS_PATH`，默认 `~/.openharness/settings.json`）
- [x] 1.2 `app/session/tenant_store.py`：删除静态 `_SETTINGS_SEED`，实现 `settings_seed()` —— 读全局 settings → 递归 denylist 剥离（`api_key`/`*_key`/`*_token`/`*_secret`/`token`/`secret`/`password` 等整键删除，`credential_slot` 置 null）→ 序列化后全键名断言；文件缺失/坏 JSON 回退 `"{}"` + warning
- [x] 1.3 `_stage_in_sync()` 首见租户 seed 切换到 `settings_seed()`；更新模块 docstring（node-level credential gateway、bucket/staging 永不落 secret）

## 2. credential resolver 与注入（credentials + supervisor）

- [x] 2.1 新增 `app/session/credentials.py`：`resolve_provider_credential() -> tuple[str, str] | None` —— env var 名按 `profiles[active_profile].auth_source` 判定（`openai_api_key`→`OPENAI_API_KEY`，`anthropic_api_key`→`ANTHROPIC_API_KEY`），回退顶层 `api_format`，无法判定返回 None + warning
- [x] 2.2 在 2.1 中实现四级优先级链（`OH_PROVIDER_API_KEY` > 映射出的 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` 进程 env > 全局 settings.json `api_key` > none），全部经 `os.environ` 实时读取，**无任何缓存**；文件读/解析失败按层级缺失降级
- [x] 2.3 `supervisor._tenant_env()`：追加 credential 注入（`cred is not None` 时并入返回 dict）；确认 `OhBackendProcess._build_env()` 的 overrides 覆盖顺序不变
- [x] 2.4 `app/main.py` lifespan：启动时 `resolve_provider_credential() is None` 打 warning（不阻断启动）

## 3. spawn 生命周期硬失败 + CREATING 收敛（supervisor + main）

- [x] 3.1 `supervisor._await_ready()`：EOF → 取 exit code 后 raise `BackendProcessError(f"backend exited during startup (exit={code})")`；timeout → `kill_group()` 后 raise；ready 正常路径与启动突发 drain 不变
- [x] 3.2 `supervisor._spawn()`：`_await_ready` 抛错时清理 —— `live.state=FAILED`、`SESSIONS_LIVE.dec()`、`_cancel_helpers(live)`、`kill_group()`（幂等）、`pool.release(live.sid)`（幂等）、异常向上传播
- [x] 3.3 `supervisor.create_session()` 异常路径：已提交的 CREATING 行 best-effort 更新为 `SessionStatus.FAILED` 并 commit（失败仅 log，不吞原异常）
- [x] 3.4 `app/main.py` lifespan：启动一次性 sweep —— 所有 `status=CREATING` 行标 `FAILED`；代码注释注明 single-node 语义与 multi-node 演进点

## 4. 存量修复脚本

- [x] 4.1 新增 `scripts/repair_tenant_settings_seed.py`（参考 `tenant_bucket_ls.py` 接线）：遍历 `tenants/*/openharness/settings.json`，三分类 `empty_seed`（严格 `{}` → 覆盖为 `settings_seed()`，bucket + 本地 staging 同步）/ `invalid`（坏 JSON / 缺 provider 关键字段 / 含 denylist 键 → 脱敏报告不修改）/ `ok`（跳过）；默认 `--dry-run`，`--apply` 落盘；输出 `repaired/skipped_ok/invalid/failed` 计数与明细

## 5. 测试（默认 pytest，stub backend）

- [x] 5.1 `tests/test_credential_isolation.py`：seed 派生保留非敏感字段 + 递归无 denylist 键（全键名扫描断言）；文件缺失/坏 JSON 回退 `{}`；fake-MinIO stage_in 首见租户 seed 为派生副本且无 secret
- [x] 5.2 同文件：优先级链四层用例（`OH_PROVIDER_API_KEY` 胜出 / 映射 env 胜文件 / 文件兜底 / 全空 None）+ auth_source→env var 四象限映射
- [x] 5.3 同文件：`test_resolver_is_uncached`（改写全局文件后二次 resolve 取新值）；`test_env_credential_not_overridable_by_settings_file`（seed 无 credential 键 + `_build_env` overrides 胜出）
- [x] 5.4 `tests/test_supervisor.py`：spawn 前退出 stub → `BackendProcessError`、会话不在 `_sessions`、DB 行 FAILED（非 CREATING）、池槽/gauge 复原；ready timeout stub → 同断言 + 进程组已 kill；startup sweep 用例（预置 CREATING 行 → FAILED）；回归现有 stub 用例（如有依赖静默超时的用例一并修正）
- [x] 5.5 `tests/test_repair_seed_script.py`（fake-MinIO）：三分类行为 + dry-run 不写
- [x] 5.6 镜像内全量 pytest 绿：`docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`

## 6. 门控契约测试（真实 backend）

- [x] 6.1 新增 `tests/test_real_backend_contract.py`：`OH_REAL_BACKEND_TEST=1` 门控（缺省整文件 skip）；正向 —— scrubbed CONFIG_DIR + resolver 注入 env → 真实 `oh --backend-only` 15s 内 `ready` 且 `auth_status=configured`、provider/base_url 与全局配置一致；反向 —— 同 CONFIG_DIR 清除全部 credential env → 非零退出且输出含 no-API-key 错误
- [x] 6.2 镜像内运行门控测试并通过

## 7. 文档与配置样例

- [x] 7.1 `session-service/README.md`：新增「Provider credential 模型」小节（node-level credential gateway、四级优先级链、两个新 env、secret 红线、rotation 语义、修复脚本用法）；更新日期注释
- [x] 7.2 根 `.env.example`：追加 `OH_PROVIDER_API_KEY`、`OH_GLOBAL_SETTINGS_PATH`（注释默认值，均可缺省）

## 8. 部署与实况验收

- [x] 8.1 存量修复：容器内 `--dry-run` 核对三分类清单（invalid 逐条人工确认）→ `--apply`
- [x] 8.2 `docker compose restart session`
- [x] 8.3 前端真实对话验收：session-frontend（:5174）新建会话 → 一轮真实对话收到流式回复与 `turn_complete`；后端日志无 `WriteUnixTransport` / `No API key configured`
- [x] 8.4 坏路径验收：`OH_GLOBAL_SETTINGS_PATH` 指向空文件 + 清除 credential env 重启 → 创建会话显式 5xx 且 DB 行 FAILED（非 CREATING）；验毕还原
- [x] 8.5 rotation 验收：不重启 service，全局 settings 改无效 key → 新会话失败为鉴权错误形态；改回 → 立即恢复
- [x] 8.6 E2E 回归：`e2e/run-session-live-acceptance.sh` + `e2e/run_e2e.sh`
- [x] 8.7 验证结果回填 `plans/Session_Tenant_Credential_Isolation_Fix_Plan_2026-07-31.md` 的「验证记录」
