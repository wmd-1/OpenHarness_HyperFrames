# 设计：session_id 生命周期契约对齐（方案 A）

关联方案：`proposal.md`。状态：**DRAFT（确认后实现）**。

## 1. 代码级改动清单

### 1.1 主修复（必做）

文件：`OpenHarness/src/openharness/ui/runtime.py`

定位：`run_repl` 函数起始处，原 `session_id = uuid4().hex[:12]`（约 `:377`）。

```diff
-    session_id = uuid4().hex[:12]
+    # Opt-in stable identity: session-service injects OH_SESSION_ID (= derive_oh_session_id(cwd))
+    # so that snapshots persist under the same id used for `--resume`, keeping RESUME lossless.
+    session_id = os.environ.get("OH_SESSION_ID") or uuid4().hex[:12]
```

约束：
- `os` 已在模块顶部导入（确认；若未导入则补 `import os`）。
- 不改 `save_snapshot` 调用点（`runtime.py:689/720/753/764` 的 `session_id=bundle.session_id` 自然沿用新 `session_id`）。
- 不改 `run_repl` 的 `restore` 分支：`session_id` 在进程启动时一次性确定，首次与 resume 运行均取 env id，快照连续。
- 全仓 `OpenHarness/src` grep `OH_SESSION_ID` = 0（修复前），仅 runtime 读取该变量；session-service 早已注入。

### 1.2 注释误判修正（建议，不改逻辑）

文件：`session-service/app/session/supervisor.py:566-568`

将「Real OpenHarness ignores the extra var; harmless to production」改为说明 `OH_SESSION_ID` 已被真实 `oh` 用于稳定快照身份，RESUME 依赖该契约。

### 1.3 迁移脚本（必做，独立构件）

文件：`OpenHarness/src/openharness/tools/migrate_session_snapshots.py`（standalone，`__main__`，随 `-v src:/app/src` 挂载进 `openharness-session`）。

- 遍历 `<data_dir>/sessions/<dir>/`，对每个 dir：
  - 若 `session-<dir>.json` 存在且 `latest.json.session_id == dir` → 跳过（幂等）。
  - 否则原子改写 `latest.json.session_id = dir`；把 `session-<old>.json` 重命名为 `session-<dir>.json` 并改写其内 `session_id = dir`（若目标已存在，以 mtime 较新者为准）。
- CLI：`--data-dir <path>`（必填）、`--dry-run`（预览不改）。
- 失败：单个 dir 的 `latest.json` 损坏 → 告警并跳过，不终止整体。
- 幂等：`rekey_data_dir` 重复调用结果一致。

详见 `proposal.md §5.3 / §6.2`。

### 1.4 sandbox 长度闸门（前置验证，非默认代码路径）

- rollout 前 `docker exec openharness-session env | grep -i sandbox` 确认无 `OPENHARNESS_SANDBOX_ENABLED=1`。
- `settings.sandbox.enabled` 默认 `False`（`config/settings.py:107`），session-service 未注入该 env（grep = 0），当前栈不触发容器名长度问题。
- 若启用 sandbox：在 `docker_backend.py:72` 对 `_container_name` 本地截断（保持 runtime 内 `session_id == OH_SESSION_ID` 不变）。本 change 默认不实现该截断。

## 2. 数据流（修复后）

```
session-service _spawn
  └─ derive_oh_session_id(cwd) = "<cwd.name>-<sha1[:12]>"   (unchanged)
  └─ env["OH_SESSION_ID"] = "<cwd.name>-<sha1[:12]>"         (unchanged)
  └─ oh --resume "<cwd.name>-<sha1[:12]>" --backend-only      (unchanged)

oh (runtime.py:377)  session_id = OH_SESSION_ID or uuid4()
  └─ save_snapshot(session_id=bundle.session_id)
       ├─ sessions/<cwd.name>-<sha1[:12]>/session-<cwd.name>-<sha1[:12]>.json
       └─ sessions/<cwd.name>-<sha1[:12]>/latest.json  ("session_id" == <cwd.name>-<sha1[:12]>)

下次 RESUME: oh --resume "<cwd.name>-<sha1[:12]>"
  └─ load_session_by_id(cwd, "<cwd.name>-<sha1[:12]>")
       └─ 命中 session-<cwd.name>-<sha1[:12]>.json  ✅  (或 latest.json session_id 匹配)
```

## 3. 边界与风险核对

| 检查项 | 结论 |
|---|---|
| `session_id` 在 runtime 内用途 | snapshot 文件名 / event metadata / logging·tracing / bridge ingress WS / session memory 路径 / sandbox 容器名（§2.3 全量枚举），均为不透明字符串消费，无「必须 12hex」假设 ✅ |
| `oh_session_id` 字符集可作文件名？ | `{cwd.name}-{sha1[:12]}` 仅字母数字与 `-`，安全 ✅ |
| `session_storage` 对 `session_id` 有格式校验？ | 仅 `sid = session_id or uuid4()`，无长度/正则校验 ✅ |
| 原生用户未设 `OH_SESSION_ID`？ | 走 `or uuid4()`，行为不变 ✅ |
| 唯一性 / 并发冲突？ | 每 conversation 独立 cwd + busy 守卫，无同 cwd 并发；原生用户各自随机 ✅ |
| 安全（id 可预测）？ | cwd.name 为 uuid，路径不可外部猜得；安全边界是 API key 而非 id 熵，无实质回归（低）✅ |
| sandbox 容器名长度（69 > 63）？ | 当前栈 sandbox 默认关闭（settings.py:107），session-service 未注入 → 不触发；启用时需本地截断（§1.4）⚠️ 闸门 |
| 修复后既有 `test_supervisor.py:345`？ | 仍通过（`--resume` 入参逻辑未变）✅ |

## 4. 部署与验证步骤（实现后）

1. 改 `runtime.py:377`（+ 注释修正 + 迁移脚本 `tools/migrate_session_snapshots.py`）。
2. **验证闸门**：`docker exec openharness-session env | grep -i sandbox` 确认 sandbox 未启用。
3. `docker restart openharness-session`（后端 `-v src:/app/src` 挂载，刷新源码，**不 `--build`**）。
4. 执行 `proposal.md §7.1` 单元/契约测试（在既有镜像内）：T1 env id 落盘、T2 命中、T3 回退随机、T6 迁移幂等。
5. 对既存旧随机 id 快照执行 M1 迁移（一次性，`--dry-run` 预览 → 实跑）：验证 `410d1bc7-...` 等历史会话可正常 RESUME。
6. 执行 `proposal.md §7.4` 真实 OpenHarness E2E（禁用 stub）：创建→turn→restart→RESUME→第 2 轮 turn→断言快照 `session_id == oh_session_id`。
7. 执行 `proposal.md §8.1` 正常 RESUME 验收 + `§8.2` 旧格式快照失败/兼容验收。
