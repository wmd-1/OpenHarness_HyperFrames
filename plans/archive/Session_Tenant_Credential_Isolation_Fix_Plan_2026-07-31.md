# Session 租户配置隔离 + Provider Credential 注入修复方案（rev2，2026-07-31）

> 来源：2026-07-31 session-frontend 实测 —— 第一轮对话即报
> `turn failed: unable to perform operation on <WriteUnixTransport closed=True …>; the handler is closed`。
> 已在主镜像容器内逐步复现并确认根因（§1）。
> rev2 修订：credential 优先级链固化、resolver 去缓存（spawn 时实时解析）、存量修复增加
> invalid 配置分类输出、真实 backend 启动链路契约验证、CREATING 状态不允许长期滞留。
> 本方案确认后再生成 OpenSpec；当前不产出 OpenSpec 工件。
> 所有验证严格遵循仓库规则《测试必须基于已有镜像》：宿主机只用 docker / docker compose / curl；
> `session-service/` 源码为 volume 挂载，改码后重启容器即生效，无需重建镜像。

---

## 0. Credential 模型声明（实现说明必须注明）

本方案采用 **node-level credential gateway** 模型：

- Provider credential（LLM API key）是**节点级资产**，由 session-service（gateway）在拉起
  `oh --backend-only` 子进程时**通过进程 env 注入**；
- 租户侧（MinIO bucket、`/tenants/{tid}/` staging、`settings.json`）**永不保存任何 secret**
  —— 不引入 tenant secret persistence；
- 租户 `settings.json` 只承载**非敏感 provider 配置**（model / base_url / api_format /
  profiles / active_profile 等），保证 `oh` 启动时能解析出正确的 provider profile；
- credential 在 **每次 backend spawn 时实时 resolve**（不缓存具体 credential），支持
  运行期 rotation（改全局 settings.json 后新 spawn 立即生效，无需重启 session-service）；
- 未来若演进为 per-tenant credential，只需替换 credential 解析层（`credentials.py`），
  seed / 注入管线不变。

## 1. 根因链（已在容器内复现验证）

1. WS-B 租户隔离：`supervisor._tenant_env()` 把子进程的 `OPENHARNESS_CONFIG_DIR`
   重定向到 `/tenants/{tid}/openharness`（`tenants_root` 默认 `/tenants`）。
2. `tenant_store._SETTINGS_SEED` 是**空对象 `{}`**（首见租户 seed 进 bucket，再镜像到 staging）。
3. `oh` 读到空配置 → 回退默认 anthropic profile（`auth_source=anthropic_api_key`）→
   找不到凭据 → **启动即打印 `Error: No API key configured.` 并 exit=1**。
4. `_await_ready()` 收到 EOF（events 队列 `None`）后**静默 return**，会话仍被标为
   LIVE、`conv.status=LIVE`；坏状态被掩盖。
5. 第一轮 turn `adapter.submit_line()` 写已关闭的 stdin →
   `RuntimeError: WriteUnixTransport closed …` → 前端收到 `turn_error`。

容器内实测矩阵（`docker exec openharness-session …`）：

| 配置组合 | 结果 |
|---|---|
| 无 `OPENHARNESS_CONFIG_DIR`（读全局 `~/.openharness/settings.json`，内含 api_key） | ✅ ready |
| staging 空 `{}` 配置 | ❌ `No API key configured`（anthropic 默认） |
| staging 空 `{}` 配置 + `--api-key` | ❌ 同上（`--api-key` 不被 provider profile 认可） |
| 剥离 api_key 的全局配置副本 + `--api-key` | ❌ `No credentials found for auth source 'openai_api_key'` |
| **剥离 api_key 的全局配置副本 + env `OPENAI_API_KEY`** | ✅ **ready（deepseek provider）** |

结论：`--api-key` CLI 参数对 provider profile 无效；**必须走 env（`OPENAI_API_KEY` /
`ANTHROPIC_API_KEY`），且租户 settings.json 必须携带非敏感 provider 配置**。

---

## 2. 修改范围

### ① `tenant_store.py`：seed 从全局 settings 派生非敏感配置

- 删除静态 `_SETTINGS_SEED = "{}"`，新增：
  - `Settings.oh_global_settings_path: Path`（env `OH_GLOBAL_SETTINGS_PATH`，默认
    `Path.home() / ".openharness" / "settings.json"`）；
  - `def settings_seed() -> str`：读取全局 settings.json → **递归剥离 secret** → 序列化。
    全局文件缺失 / JSON 损坏时回退 `"{}"` 并 `logger.warning`（行为与现状等价，不新增故障面）。
- **secret 剥离规则（denylist，递归作用于所有层级，含 `profiles.*`）**：
  - 键名（大小写不敏感）等于或以其结尾即整键删除：
    `api_key`、`token`、`access_token`、`refresh_token`、`auth_token`、`secret`、
    `client_secret`、`password`；模式：`*_key` / `*_token` / `*_secret`；
  - `credential_slot` 强制置 `null`（槽位名非 secret，但避免跨租户泄露槽位绑定）；
  - 剥离后再断言一次：序列化结果中不得出现以上任何键（双保险，测试同款断言）。
- seed 的两个消费点同步切换：`_stage_in_sync()` 首见租户 put_object 时、以及
  ④ 的存量修复脚本。
- 更新模块 docstring 第 17-19 行：注明「seed 为全局配置的无凭据派生副本；credential
  经 gateway env 注入（node-level credential gateway），bucket/staging 永不落 secret」。

### ② 新增 `app/session/credentials.py`：spawn 时实时 resolve，固化优先级链

新模块 `credentials.py`（node-level credential gateway 的唯一实现点）：

- `resolve_provider_credential() -> tuple[str, str] | None`，返回 `(env_var, key)`。
- **无任何模块级/进程级缓存**：每次调用（即每次 backend spawn）实时读
  `os.environ` + 全局 settings.json（一次 ≤ 数 KB 文件读，spawn 频率下开销可忽略）。
  运行期 credential rotation（改全局 settings.json）对**下一次 spawn** 即时生效，
  无需重启 session-service。
- **env_var 判定**（决定注入 `OPENAI_API_KEY` 还是 `ANTHROPIC_API_KEY`）：
  取全局 settings 的 `profiles[active_profile].auth_source`：
  - `openai_api_key` → `OPENAI_API_KEY`
  - `anthropic_api_key` → `ANTHROPIC_API_KEY`
  - active_profile 缺失 / auth_source 不在上表 → 回退顶层 `api_format`
    （`openai` → `OPENAI_API_KEY`，`anthropic` → `ANTHROPIC_API_KEY`）；
  - 仍无法判定 → 返回 `None` 并 `logger.warning`。
- **key 取值优先级（固化契约，逐级 fallback，全部经 `os.environ` 实时读取）**：

  ```
  OH_PROVIDER_API_KEY（显式网关级覆盖，最高优先）
      > OPENAI_API_KEY / ANTHROPIC_API_KEY（service 进程 env 中已有的同名变量）
      > 全局 settings.json 顶层 api_key
      > none（不注入；依赖 oh 自身的 env 继承/文件回退，并打 warning）
  ```

  说明：第 2 级读取的是**上一步判定出的 env_var 同名变量**在 service 进程 env 中的值
  （部署方直接给容器传 `OPENAI_API_KEY` 的场景）；`OH_PROVIDER_API_KEY` 经
  `os.environ` 直读而非 pydantic `Settings` 快照，与「不缓存」语义一致。
- app startup（`main.py` lifespan 现有校验处）追加启动告警：
  `resolve_provider_credential() is None` 时 log warning「backend 将依赖继承 env 或
  全局配置文件中的凭据」，不阻断启动（stub/e2e 场景无凭据是合法的）。

`supervisor._tenant_env()` 修改：

```python
env = {
    "OPENHARNESS_CONFIG_DIR": str(tenant_store.local_config_dir(tenant_id)),
    "OPENHARNESS_DATA_DIR": str(tenant_store.local_data_dir(tenant_id)),
}
cred = credentials.resolve_provider_credential()   # 每次 spawn 实时解析
if cred is not None:
    env[cred[0]] = cred[1]
return env
```

**env credential 不可被 settings.json 覆盖（契约并测试固化）**：

- `oh` 侧：auth_source 的凭据查找 **env 优先于 settings.json**（§1 矩阵第 5 行已实证）；
  且 seed 剥离后租户 settings.json **物理上不含任何 credential 键**，无从覆盖；
- service 侧：`OhBackendProcess._build_env()` 现为 `os.environ` 副本再 `update(env_overrides)`
  —— **overrides（含注入的 credential）覆盖继承 env**，此顺序保持不变并加测试锁定。

### ③ 会话创建失败语义：硬失败 + 不允许 CREATING 滞留

**③-a `_await_ready` 硬失败**（`supervisor._await_ready()`，现第 391-434 行）：

- **EOF**（`event is None`）→ `await live.process.wait(timeout=1.0)` 取 exit code，
  raise `BackendProcessError(f"backend exited during startup (exit={code})")` ——
  覆盖 credential 缺失 / 配置损坏导致 `oh` 启动即退（exit != 0）的全部场景；
- **timeout**（15s 无 `ready`）→ `await live.process.kill_group()` 后
  raise `BackendProcessError("backend produced no ready event within timeout")`；
- 收到 `ready` 的正常路径不变（启动突发 drain 逻辑原样保留）。

**③-b `_spawn()` 配套清理**（`_await_ready` 抛错时，对齐 `_handle_crash` 的清理集合）：

```python
try:
    await self._await_ready(live)      # 现第 389 行
except BaseException:
    live.state = SessionState.FAILED   # CREATING→FAILED 为合法迁移（lifecycle.py:37）
    SESSIONS_LIVE.dec()
    await self._cancel_helpers(live)   # heartbeat/log task 取消（复用现有 helper）
    await live.process.kill_group()    # 幂等；EOF 场景进程已死
    await self.pool.release(live.sid)  # 幂等；释放 WS-D 槽位
    raise
```

**③-c DB 状态收敛：CREATING 不允许长期滞留**（rev2 新增）：

- `create_session()` 的 `except BaseException` 块（现第 290-294 行）追加 best-effort
  DB 收敛：`conv` 行已提交（status=CREATING）时，将其更新为 `SessionStatus.FAILED`
  并 commit（失败仅 log，不吞原异常；`FAILED` 可恢复 —— routers 已把
  COLD/FAILED 视为 resumable，不会砖化该行）；`conv` 尚未入库的更早期失败无残留，维持现状。
- **启动对账**：app startup（lifespan）新增一次性 sweep —— 将 DB 中所有
  `status=CREATING` 的行标记为 `FAILED`。依据：live 会话与进程绑定，服务重启后
  不可能存在合法的 CREATING 行。当前部署为单节点；多节点演进时此 sweep 需按
  node 路由归属过滤（在代码注释中注明，本次不实现多节点过滤）。
- 三条 spawn 调用路径的既有兜底闭环维持不变：
  - `create_session()`：pool.release（幂等）+ ③-c 标 FAILED + raise → router 5xx；
  - `register_live_session()/rehydrate()`：弹出占位 LiveSession + raise（WS 建连失败）；
    DB 行本就处于 COLD/FAILED，无 CREATING 滞留问题；
  - `create_session_from_existing()`：向上抛，WS 建连失败；该路径行状态为原状态
    （非 CREATING），由 `_spawn` 内 `live.state=FAILED` + `_persist_status` 对齐。

从此坏子进程（spawn 失败 / ready timeout / credential 缺失）在所有路径上都表现为
显式 5xx / WS 拒绝 + DB 行 FAILED，而不是假 LIVE 或永久 CREATING。

### ④ 存量租户 stage 修复脚本（只修 `{}`，invalid 分类报告）

新增 `session-service/scripts/repair_tenant_settings_seed.py`（参考现有
`tenant_bucket_ls.py` 的 MinIO 接线方式）：

- 遍历 bucket `tenants/*/openharness/settings.json`，按内容三分类：
  1. **`empty_seed`**：`json.loads == {}`（旧空 seed，容忍空白差异）→ 覆盖写入
     `tenant_store.settings_seed()`（唯一自动修复类）；
  2. **`invalid`**（rev2 新增，只报告不修改）：JSON 解析失败；或解析成功但缺失
     backend 启动所需关键字段（`api_format` 与 `active_profile`/`provider` 均缺失）；
     或包含 denylist secret 键（历史泄漏检测）—— 逐条输出
     `tid + 分类原因 + 内容摘要（secret 值脱敏）`，供后续人工排查；
  3. **`ok`**：非空且含 provider 配置 → 跳过（**绝不自动覆盖非空配置**）。
- 同步刷新本地 staging：对 `empty_seed` 命中的 tid，若
  `/tenants/{tid}/openharness/settings.json` 存在也同样覆盖（防止「bucket 已修、
  下次 stage_out 又把旧 `{}` 推回去」的回写竞态；脚本在 service 重启前运行，无并发 stage_out）；
- `--dry-run` 默认开启，`--apply` 才落盘；结束输出
  `repaired / skipped_ok / invalid / failed` 四类计数与明细清单。
- 运行方式（容器内、已有镜像）：
  `docker compose exec session python /opt/oh-session-service/scripts/repair_tenant_settings_seed.py [--apply]`

### ⑤ 文档同步

- `session-service/README.md`（含日期注释规范）：新增「Provider credential 模型」小节 ——
  node-level credential gateway、四级优先级链、`OH_PROVIDER_API_KEY` /
  `OH_GLOBAL_SETTINGS_PATH` 两个新 env、「租户 bucket/staging 永不落 secret」红线、
  rotation 语义（下一次 spawn 生效）、存量修复脚本用法；
- 根 `.env.example` 追加两个新变量（注释默认值即可，均可缺省）。

**涉及文件汇总**：

| 文件 | 动作 |
|---|---|
| `app/session/tenant_store.py` | seed 派生 + docstring |
| `app/session/credentials.py` | 新增（resolver） |
| `app/session/supervisor.py` | `_tenant_env` 注入；`_await_ready` 硬失败；`_spawn` 清理；`create_session` FAILED 收敛 |
| `app/config.py` | 新增 `oh_global_settings_path` |
| `app/main.py` | startup 告警 + CREATING sweep |
| `scripts/repair_tenant_settings_seed.py` | 新增 |
| `tests/test_credential_isolation.py`、`tests/test_supervisor.py`、`tests/test_repair_seed_script.py`、`tests/test_real_backend_contract.py` | 新增/调整（见 §4） |
| `session-service/README.md`、`.env.example` | 文档 |

---

## 3. 风险

| 风险 | 缓解 |
|---|---|
| ③ 使原本「带病可过」的路径显式失败，可能暴露其他环境配置缺陷 | 预期行为（fail-fast）；报错带 exit code；FAILED 可恢复不砖化 |
| resolver 去缓存后每次 spawn 读文件，settings.json 被并发改写时读到半截 | 读失败/解析失败按「该文件层级缺失」处理，落到上一级 env 或 none；spawn 级重试即自愈 |
| 启动 sweep 误伤多节点场景下其他节点正在创建的行 | 当前单节点部署无此问题；代码注释注明多节点需按路由归属过滤（演进项） |
| 全局 settings.json 结构未来变化导致 seed 派生字段漂移 | denylist 是键名模式而非字段白名单，新增非敏感字段天然透传；测试锁定 secret 不泄露 |
| `oh` 未来改变 auth_source→env 契约导致注入失效 | ⑥ 真实 backend 契约测试（§4-D）在镜像内直接验证 ready，回归即红 |
| 修复脚本误改存量租户配置 | 只覆盖严格等于 `{}` 的文件；invalid 只报告；默认 dry-run |
| 回滚 | 纯代码层改动（无 DB migration）：git revert + `docker compose restart session`；bucket 内新 seed 对旧代码同样可读（旧代码不读其内容） |

---

## 4. 测试计划（全部在主镜像容器内执行）

### A. 单元：seed 派生与 secret 剥离（`tests/test_credential_isolation.py`）

1. `test_seed_derives_from_global_settings`：monkeypatch `oh_global_settings_path`
   指向含 api_key/token/secret 的临时全局配置 → `settings_seed()` 保留
   model/base_url/api_format/profiles/active_profile，**递归不含任何 denylist 键**
   （对序列化文本做全键名扫描断言）；
2. `test_seed_falls_back_to_empty_on_missing_or_bad_file`：文件缺失 / 坏 JSON → `"{}"`；
3. `test_stage_in_seeds_scrubbed_settings`：走现有 tenant_store 测试的 fake-MinIO 夹具，
   首见租户 stage_in 后 bucket/staging 内 settings.json 为派生 seed 且无 secret。

### B. 单元：credential resolver 优先级链（同文件）

4. `test_priority_oh_provider_api_key_wins`：四层同时给值 → 取 `OH_PROVIDER_API_KEY`；
5. `test_priority_named_env_over_file`：无 `OH_PROVIDER_API_KEY`、有 `OPENAI_API_KEY`
   env 且文件含不同 api_key → 取 env 值；
6. `test_priority_file_fallback`：仅文件含 api_key → 取文件值；
7. `test_priority_none`：三层皆空 → `None`（并验证 `_tenant_env` 不注入多余键）；
8. `test_env_var_mapping`：auth_source `openai_api_key`/`anthropic_api_key`/未知回退
   `api_format`/完全无法判定 四象限映射；
9. `test_resolver_is_uncached`：首次 resolve 后**改写**临时全局 settings.json 的
   api_key → 第二次 resolve 返回新值（rotation 不需重启，锁定去缓存语义）；
10. `test_env_credential_not_overridable_by_settings_file`（优先级锁定，两段）：
    a. `settings_seed()` 输出不含任何 credential 键（settings.json 物理上无从覆盖 env）；
    b. `OhBackendProcess._build_env()`：`os.environ` 与 `env_overrides` 冲突时
    overrides 胜出（锁定现有顺序，防未来回归）。

### C. 单元/集成：创建失败语义（`tests/test_supervisor.py`）

11. `test_spawn_fails_when_backend_exits_before_ready`：`oh_bin` 指向
    「打印一行错误即 exit 1」的临时 stub → `create_session()` raise
    `BackendProcessError`，会话不在 `_sessions`、**DB 行 status=FAILED（非 CREATING）**、
    池槽已释放（容量计数复原）；
12. `test_spawn_fails_on_ready_timeout`：stub sleep 超过（monkeypatch 调小的）
    ready 超时 → 同上断言 + 进程组已被 kill；
13. `test_startup_sweep_marks_stale_creating_failed`：预置一条 CREATING 行 →
    触发 startup sweep → 行变 FAILED；
14. 存量用例回归：现有 stub `scripts/oh_backend_stub.py` 正常发 `ready`，③ 对其无影响；
    若个别用例依赖「_await_ready 超时静默通过」需随本项一并修正。

### D. 契约：真实 backend 启动链路（`tests/test_real_backend_contract.py`，rev2 新增）

防止未来 `oh` 的 auth_source / env 注入契约回归。用**真实 `oh` 二进制**（主镜像内
`/root/.local/bin/oh`），以 env `OH_REAL_BACKEND_TEST=1` 门控（未设置时整文件 skip，
不影响 stub 单测流水线）：

15. `test_real_backend_ready_with_scrubbed_settings_and_env_credential`（全链路正向）：
    临时目录构造 `settings_seed()` 产物为 CONFIG_DIR → `resolve_provider_credential()`
    注入 env → spawn 真实 `oh --backend-only` → 断言 15s 内收到 `ready` 事件，且
    `state.auth_status == "configured"`、provider/base_url 与全局配置一致；
16. `test_real_backend_fails_without_credential`（反向）：同样的 scrubbed CONFIG_DIR、
    **不注入** credential env（并清除继承的同名 env）→ 断言进程非零退出、stdout 含
    `No API key configured` / `No credentials found`（锁定 §1 矩阵的失败形态）。

运行入口：`docker compose run --rm --entrypoint bash session -c
"cd /opt/oh-session-service && OH_REAL_BACKEND_TEST=1 python -m pytest tests/test_real_backend_contract.py -x -q"`。

### E. 修复脚本（`tests/test_repair_seed_script.py`，fake-MinIO）

17. 旧 `{}` → 被覆盖为派生 seed；非空合法配置 → `skipped_ok`；坏 JSON / 缺关键字段 /
    含 secret 键 → 归入 `invalid` 且内容未被修改；`--dry-run` 全程不写。

---

## 5. 实施与验收标准（按序执行，全部满足才算完成）

1. **单测全绿**（镜像内）：
   `docker compose run --rm --entrypoint bash session -c "cd /opt/oh-session-service && python -m pytest tests/ -x -q"`；
2. **真实 backend 契约测试通过**（§4-D，`OH_REAL_BACKEND_TEST=1`）；
3. **存量修复**：容器内先 `--dry-run` 核对三分类清单（`invalid` 类逐条人工确认），
   再 `--apply`；输出计数与预期一致；
4. **重启生效**：`docker compose restart session`；
5. **前端真实对话**：浏览器打开 session-frontend（:5174）→ 新建会话 → 发送一轮真实
   对话 → 收到流式回复与 `turn_complete`；后端日志无 `WriteUnixTransport` /
   `No API key configured`；
6. **坏路径验收**：临时把 `OH_GLOBAL_SETTINGS_PATH` 指向空文件并清除 credential env
   后重启 → 创建会话得到显式 5xx，**DB 行为 FAILED 而非 CREATING**；验毕还原；
7. **rotation 验收**：修改全局 settings.json 的 api_key（改成无效值）→ 不重启 service，
   新建会话失败且报错为 provider 鉴权失败形态；改回有效值 → 新建会话即恢复
   （证明 resolver 无缓存）；
8. **既有 E2E 回归**：`e2e/run-session-live-acceptance.sh`（真实 oh 路径）+
   `e2e/run_e2e.sh`（stub 路径，确认 ③ 未破坏 stub 时序）；
9. 上述结果（pytest 输出摘要 + 实测日志摘录）回填本文件末尾「验证记录」。

## 验证记录（实施后回填）

- [x] 镜像内 pytest：`docker run --rm -v $PWD/session-service:/opt/oh-session-service oh-session-test:latest tests/ -q`
  → **286 passed, 9 skipped**（skip 均为 `OH_TEST_MINIO_ENDPOINT` 门控的 MinIO 集成用例）。
  新增：`test_credential_isolation.py`（13 用例：seed 递归剥离/回退、stage_in 首见派生、
  resolver 四级优先级/无缓存/env 不可被租户覆盖）、`test_supervisor.py` +3（exit-1 收敛
  FAILED、ready 超时 kill 进程组、sweep_stale_creating）、`test_repair_seed_script.py`
  （dry-run 三分类/apply 只修 empty_seed/global 缺失保护/无 MinIO 退出码）。
- [x] 真实 backend 契约测试：`OH_REAL_BACKEND_TEST=1` + 挂载 `openharness-config:ro`
  → **2 passed**（正向：scrubbed CONFIG_DIR + resolver 注入 env → 15s 内 ready 且
  `auth_status=configured`、base_url/model 与全局一致；反向：清 credential env →
  非零退出 + no-API-key 错误）；无门控时 2 skipped。
  注：ready 事件的 `provider` 是按 base_url 归一化的显示名，与全局顶层 `provider`
  语义不同，断言以 base_url/model 为准。
- [x] 存量修复脚本：dry-run → `repaired=35 skipped_ok=0 invalid=0 failed=0`（35 个
  历史租户全部为 empty_seed，无 invalid 需人工确认）→ `--apply` 同计数；抽查
  `live-smoke` bucket seed：完整非敏感 provider 配置、递归扫描无任何 denylist 键。
  后续 credtest-84（坏路径期间首见产生的 `{}` seed）再跑一次 `--apply` → `repaired=1`。
- [x] 前端真实对话：session-frontend（:5174）新建会话 `650c5463-b59d-...` → LIVE →
  「用一句话介绍你自己」→ 收到流式回复并正常 turn_complete；后端日志 10 分钟窗口
  无 `WriteUnixTransport` / `No API key configured` / `turn failed`。
  过程记录：初跑发现全局 settings.json 的 deepseek key 已在上游失效（401，与本次
  改动无关），经用户确认切换 provider 至阿里云 MaaS 端点
  （`https://ws-yivbyk62whpmimlx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，
  model=qwen3.7-max，原文件备份为 `settings.json.bak-cred-hardening`），并把 36 个
  租户 seed 重写为新派生 seed 后通过。
- [x] 坏路径 FAILED 验证：临时 override `OH_GLOBAL_SETTINGS_PATH` → 空文件并重启 →
  lifespan 出现 `credential_env_var_undetermined` + no-credential warning；创建会话
  显式 **HTTP 500**，DB 行 **failed**（非 CREATING），日志
  `backend exited during startup (exit=1)` 硬失败；验毕删除 override 与空文件、
  重启还原，warning 消失、resolver 恢复。
- [x] rotation 免重启验证：不重启 service，全局 api_key 改为无效值 → resolver 即时
  读到新值，新会话创建即硬失败（500 + FAILED）；改回有效 key（仍不重启）→ 新会话
  201 → WS 一轮 `turn_complete`。证明 resolver 无缓存、轮换免重启。
- [x] E2E 回归：`run-session-live-acceptance.sh` → **PASS**（rest 13 + ws 13 +
  frontend 8 全过）；`run_e2e.sh` → 18 pass / 1 fail，唯一失败为 `service/`（视频）
  的 `GET /file` presigned 302 断言（本次 change 未触碰 service/，属既有问题，
  与 credential gateway 无关）。session 相关断言全部通过；验毕已还原真实 backend
  模式并吊销临时租户 key。

