# Service / Web 实测问题修复方案（2026-07-30）

> 来源：2026-07-30 前后端全量实测（镜像内单测 180+49 全绿；实况测试发现 5 个问题）。
> 本方案按严重度排序，P1~P4 为本次修复范围，P5 为可选后续项（建议走 openspec）。
> 所有验证严格遵循仓库规则《测试必须基于已有镜像》：宿主机只用 docker/docker compose/curl。

---

## 问题清单与优先级

| # | 严重度 | 问题 | 影响 |
|---|---|---|---|
| P1 | 🔴 高 | `docker compose up api` 路径下 worker 缺 `-Q high,normal,low`，且镜像内 supervisord 无 beat | 任务永远卡 `queued`；丢失任务回收 / 过期清理定时任务不运行 |
| P2 | 🟡 中 | `ApiKeyInput` 组件存在但 `App.tsx` 未渲染 | 多 key 鉴权模式下用户无法在 UI 填 key，前端不可用 |
| P3 | 🟡 中 | `store.tsx` 用 `requestAnimationFrame` 批量刷新，后台标签页 rAF 冻结 | 切到后台再回来前 UI 与内部状态脱节 |
| P4 | 🟢 低 | 越界 Range 返回 206 钳位末字节，RFC 7233 要求 416 | 协议符合性问题，实际浏览器场景影响小 |
| P5 | 🟢 低(可选) | 无任务列表端点（`GET /v1/videos` → 405），前端刷新后历史任务丢失 | 体验缺失，属新功能，单独立项 |

---

## P1：worker 队列错配 + beat 缺失（后端，最高优先级）

### 根因链

1. 调度器 `service/app/workers/scheduler.py` 按任务 priority 把消息投到 **`high` / `normal` / `low`** 三个命名队列（`queue_for_priority()`）。
2. e2e 入口 `oh-role`（`docker-compose.e2e.yml` 用）正确启动：`celery worker ... -Q "${OH_WORKER_QUEUES:-high,normal,low}"` → e2e 一直是好的。
3. 但 `docker compose up api` 走 `oh-serve` → supervisord 读 `/etc/supervisor/conf.d/oh-service.conf`。该文件由主 `Dockerfile:170` 的 `COPY docker/supervisord.conf` 烧录：
   - **当前镜像**（`v0.1.9_v0.7.77_v1.4_v2.1`）是用**旧版 conf** 构建的：worker 无 `-Q`（只听默认 `celery` 队列）、**无 `[program:beat]`**；
   - **仓库现版** `docker/supervisord.conf`：已有 beat，但 worker 仍然**缺 `-Q`**。
4. 结果：消息全在 `normal` 队列积压，worker 只订阅 `celery`，任务永卡 `queued`；`recover_lost_tasks`（30s）与 `cleanup_expired_tasks`（每日）也无人调度。

### 修改内容

**① 修 `docker/supervisord.conf`（仓库源头）——env fallback 方案（不硬编码）**

`[program:worker]` 的 command 改用 `bash -c` 包装，通过 shell 默认值展开实现「可覆盖 + 安全兜底」，与 `oh-role` 的 fallback 语义逐字对齐：

```ini
[program:worker]
command=/bin/bash -c 'exec /root/.openharness-venv/bin/celery -A app.workers.celery_app.celery_app worker -l info -c "${OH_CELERY_CONCURRENCY:-4}" -Q "${OH_WORKER_QUEUES:-high,normal,low}"'
```

方案取舍（对应评审意见：优先 env/entrypoint fallback，不硬编码）：
- ❌ supervisord 原生 `%(ENV_OH_WORKER_QUEUES)s`：env 缺失时 supervisord 解析失败直接拒启，无默认值语法；
- ❌ program 段 `environment=OH_WORKER_QUEUES="..."`：supervisord 的 environment 优先于容器继承 env，会**反向屏蔽** compose 传入的运行时覆盖；
- ❌ 纯硬编码 `-Q high,normal,low`（初版方案）：稳但与 `app/config.py::worker_queues`、`oh-role` 的 `OH_WORKER_QUEUES` 可配置语义分叉，部署方改 env 时 oh-serve 路径静默失效；
- ✅ `bash -c` + `${VAR:-default}`：容器 env 透传、缺失时兜底默认值，与 `oh-role` 完全同构，且 `exec` 保证信号直达 celery 主进程（supervisord stop/restart 语义不变）。

其他说明：
- `[program:beat]` 仓库版已存在，无需改；beat 的两个周期任务均幂等（代码注释已声明多副本安全），api 多副本下不会双重回收。
- compose 的 `api` 服务可选透传 `OH_WORKER_QUEUES` / `OH_CELERY_CONCURRENCY`（不传则兜底生效，非必需改动）。

**①' 新增部署契约测试（防再次漂移）**

新增 `service/tests/test_deployment_contract.py`，在镜像内随全量 pytest 执行（测试本身就跑在主镜像衍生层里，`/etc/supervisor/conf.d/oh-service.conf` 即为**实际部署产物**，直接断言镜像真实状态而非仓库文本）：

1. `test_worker_subscribes_priority_queues`：解析 conf 的 `[program:worker]` command，断言含 `-Q`，且队列集合 ⊇ `set(settings.worker_queues.split(","))`（与 `app/config.py` 单一事实源对齐，两者任一漂移即红）；兼容 env-fallback 写法（断言 `OH_WORKER_QUEUES:-<默认值>` 中的默认值）。
2. `test_beat_program_present`：断言 conf 存在 `[program:beat]`。
3. `test_scheduler_queue_names_covered`：断言 `scheduler.queue_for_priority()` 值域（high/normal/low）全部包含在 worker 订阅集合内（投递侧与消费侧的契约闭环）。

conf 路径通过 `OH_SUPERVISORD_CONF` env 可覆盖（默认 `/etc/supervisor/conf.d/oh-service.conf`）；文件不存在时 `pytest.skip`（仅防非镜像环境误报，按仓库规则正式跑法永远在镜像内、不会 skip）。注意：该测试在**未打补丁的现有镜像**上会失败，这是预期行为（先红后绿，驱动 P1-②③落地）。

**② 修 `Dockerfile.fix`（补丁层刷新现有镜像，不重建）**

`Dockerfile.fix` 现在只 COPY skills / service 代码，不含 supervisord conf。在「烧录后端服务代码」块（`COPY service /opt/oh-service` 附近）追加一行：

```dockerfile
# ---- 刷新 supervisord 配置（worker -Q 队列订阅 + beat，见 plans 2026-07-30）----
COPY docker/supervisord.conf /etc/supervisor/conf.d/oh-service.conf
```

**③ 打补丁镜像（同 tag 覆盖，遵循 Dockerfile.fix 既有用法）**

```bash
docker build -f Dockerfile.fix \
  --build-arg BASE_IMAGE=openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1 \
  -t openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1 .
```

### 验证（全部镜像内 / curl）

0. 契约测试：打补丁镜像后重建 `oh-e2e`/`oh-e2e-test` 衍生层（仅叠加层，非重建基础镜像），跑 `test_deployment_contract.py` 由红转绿。
1. 静态确认：`docker run --rm --entrypoint cat <镜像> /etc/supervisor/conf.d/oh-service.conf`，检查 worker 行含 `-Q "${OH_WORKER_QUEUES:-high,normal,low}"` 且存在 `[program:beat]`。
2. `docker compose up -d --force-recreate api`，容器内 `ps aux` 应看到 worker（订阅 3 队列，可从 worker-stdout.log 的 `[queues]` 段确认 high/normal/low）+ beat 进程。
3. 实况：curl 建任务（临时 key 用 `scripts/manage_api_keys.py` 创建，测完 deactivate），确认状态**离开 `queued`**（无 LLM key 时进入 `running`→`failed` 即证明消费链路通了）；`redis-cli llen normal` 归零。
4. 回归：`oh-e2e-test` 镜像 + 挂载 `service/` 跑全量 pytest（本次改动不触碰 service 代码，应保持 180 passed）。

---

## P2：App.tsx 渲染 ApiKeyInput（前端）

### 修改内容

[web/src/App.tsx](../web/src/App.tsx)：

1. 增加导入：`import { ApiKeyInput } from "./components/ApiKeyInput";`
2. 在 sidebar 中、`<Composer />` **之上**渲染 `<ApiKeyInput />`（key 是使用前提，应先于提交入口出现）：

```tsx
<div className="sidebar">
  <ApiKeyInput />
  <Composer />
  ...
```

组件本身零改动（已实现 localStorage `oh_api_key` 读写、密码框、保存/清除、状态提示；`api.ts` 已从同一 storage key 取值注入 `X-API-Key` / `?api_key=`）。样式类 `card apikey` 已存在于组件，若 `styles.css` 无 `.apikey` 特有样式则沿用 `.card` 通用样式即可，不新增 CSS。

### 测试（含真实链路用例）

1. `web/src/__tests__/App.test.tsx` 增加一条断言：渲染 App 后能找到 `API Key（X-API-Key）` label（防止再次静默丢失该入口）。
2. **新增真实链路测试** `web/src/__tests__/ApiKeyFlow.test.tsx`（输入 key → localStorage → 请求头，端到端穿起三层）：
   - 用例 A：渲染 App → `userEvent.type` 在 API Key 输入框填入 `sk-test-e2e` → 点击「保存」→ 断言 `localStorage.getItem(API_KEY_STORAGE) === "sk-test-e2e"`；
   - 用例 B（接着 A）：mock `fetch`，在 Composer 提交一个 prompt → 断言 `POST /v1/videos` 的请求头含 `X-API-Key: sk-test-e2e`；
   - 用例 C：mock `EventSource` 构造函数 → 断言 SSE 订阅 URL 携带 `api_key=sk-test-e2e` 查询参数（/events 回退通道）；
   - 用例 D：点击「清除」→ 断言 localStorage 已删、后续请求不再携带 `X-API-Key` 头。
3. 跑镜像内流水线：`WEB_IMAGE=openharness_hyperframes_web:v0.1.9_v0.7.42_v1.4_v2.1 bash e2e/run-web-docker-tests.sh`（lint + vitest 在 build 镜像 `--target test` 阶段；冒烟复用已有 runtime 镜像）。
4. 发布：确认通过后按需用 `WEB_NEW_TAG` 打新 runtime tag，`docker compose up -d web` 生效。

---

## P3：store.tsx rAF 批量刷新在后台标签页冻结（前端）

### 根因

[web/src/store.tsx](../web/src/store.tsx) L113-140：`setTasks` 把更新写进 `pendingRef`，用 `requestAnimationFrame(flush)` 合帧提交。页面隐藏（`document.hidden`）时浏览器**无限期不触发 rAF**，`pendingRef` 有数据但 `setTasksState` 永不执行 → SSE/轮询照常更新内部 ref，UI 冻结在旧状态。

### 修改内容（去掉 rAF，统一为单一 trailing timer）

**复杂度评估结论（对应评审意见 4）：不保留 rAF。**

- rAF 的唯一收益是「与渲染帧对齐」，只对动画类逐帧更新有意义；SSE/轮询的任务状态更新是低频离散事件，晚 16〜32ms 提交对体验零影响；
- 真正防 setState 交错竞态的机制是 **ref-based pending 缓冲**（`pendingRef` 合并 + 单次 `setTasksState` 提交），与调度通道无关，完整保留；
- 双通道（rAF+timer）+ `visibilitychange` 监听方案需维护两套句柄、三段取消逻辑和一个全局监听器；统一 timer 后单代码路径、无监听器，vitest fake timers 直接可测（rAF 在 jsdom 下还要额外 stub）；
- 后台标签页行为：浏览器对隐藏页 `setTimeout` 节流到 ≥1s/次，但**不会冻结**（rAF 是无限期挂起）——页面不可见时 1s 内提交完全可接受，切回前台时 state 已是最新，无需 `visibilitychange` 补刷。

修改点：

1. `rafRef` 改为 `flushTimerRef`（`ReturnType<typeof setTimeout> | null`）；`setTasks` 里的 `requestAnimationFrame(flush)` 替换为：

```tsx
const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const scheduleFlush = useCallback(() => {
  if (flushTimerRef.current != null) return; // 已排程，trailing 合并
  flushTimerRef.current = setTimeout(() => {
    flushTimerRef.current = null;
    flush();
  }, 32);
}, [flush]);
```

   - `flush` 本体不变（仍从 `pendingRef` 合并提交）；32ms 窗口内的多次更新自然合批，与原 rAF 的合帧效果等价；
2. 卸载清理处（现有 cleanup effect）改为 `clearTimeout(flushTimerRef.current)`，并删除所有 rAF 相关句柄与 `cancelAnimationFrame` 调用；
3. **不新增** `visibilitychange` 监听（相比初版方案减少一个全局副作用点）。

### 测试

`web/src/__tests__/store.test.tsx` 新增用例（fake timers，无需 stub rAF/visibilityState）：
1. 触发一次任务更新 → `vi.advanceTimersByTime(32)` → 断言 UI state 已提交（后台冻结回归：不依赖 rAF 即可刷新）；
2. 32ms 窗口内连续多次 `setTasks` → 断言 `setTasksState` 仅提交一次且为合并后终态（合批行为回归）；
3. 卸载 Provider 后推进时间 → 断言无 setState 告警（清理回归）。

跑法同 P2（`e2e/run-web-docker-tests.sh`）。

---

## P4：越界 Range 应返回 416（后端）

### 根因

[service/app/routers/videos.py](../service/app/routers/videos.py) L305：`start = max(0, min(start, end))` 把越界 start（如 `bytes=999999-` 于 2325B 文件）钳位到末字节，返回 `206 bytes 2324-2324/2325`。RFC 7233 §4.4：首字节位置 ≥ 文件长度时范围不可满足，应 `416 + Content-Range: bytes */{size}`。

### 修改内容

在 L299-301 解析出 `start`/`end` 之后、L305 钳位之前，插入不可满足判定（仅对显式 start 范围；suffix 范围 `bytes=-N` 按 RFC 钳到文件头，不属于 416 场景，`bytes=-0` 除外）：

```python
    # RFC 7233 §4.4: first-byte-pos beyond EOF (or empty suffix) is unsatisfiable.
    if size and range_header and range_header.startswith("bytes=") and start >= size:
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{size}"},
        )
```

注意点：
- 放在 `try/except (ValueError, IndexError)` 之外——解析失败仍走现行「忽略 Range 全量返回」的宽容路径，不改变既有行为；
- `bytes=-0` 会产生 `start = max(0, size-0) = size`，天然落入同一判定，无需特判；
- `416` 抛出前需先关闭已打开的 `fileobj`（L277 `storage.open` 在 Range 解析之前）——实现时把 `raise` 包在 `try/finally` 或将 416 判定提前到 `storage.open` 之前（推荐后者：解析 Range 只需 `size`，可先 `storage.stat`/复用 open 返回的 size 再决定；以最小改动为准，允许实现时微调顺序，语义不变）。

### 测试

`service/tests/test_streaming.py` 新增 3 条：
1. `Range: bytes={size}-` → 416 + `Content-Range: bytes */{size}`；
2. `Range: bytes=-0` → 416；
3. 回归：合法 `bytes=0-1023` 仍 206、suffix `bytes=-100` 仍 206（防钳位逻辑被误伤）。

跑法：`docker run --rm --entrypoint /root/.openharness-venv/bin/python -v $PWD/service:/opt/oh-service -w /opt/oh-service oh-e2e-test:latest -m pytest tests/test_streaming.py -q`（注意必须覆盖 entrypoint，镜像默认入口是 supervisord）。

---

## P5（可选，单独立项）：任务列表端点 + 前端历史任务

**不在本次修复范围**，涉及 API 面扩张，建议走 openspec change（`openspec-propose`）。要点备忘：

- 后端：`GET /v1/videos?limit=&offset=&status=`，租户内 `created_at desc`，复用 `004_task_list_index` 已建索引；响应复用 `VideoTaskResponse`，外加 `total`。
- 前端：`store.tsx` 在挂载及 API key 变更时拉取一次列表水合 `tasksState`；终态任务不再建 SSE。
- 配套：限流沿用现有 token bucket；`API_DOCUMENTATION.md` 同步。

---

## 实施顺序与提交切分

| 顺序 | 内容 | 涉及文件 | 验证入口 |
|---|---|---|---|
| 1 | P1 | `docker/supervisord.conf`、`Dockerfile.fix` | 补丁镜像 + compose 实况 curl + 后端全量 pytest 回归 |
| 2 | P4 | `service/app/routers/videos.py`、`service/tests/test_streaming.py` | oh-e2e-test 镜像 pytest（源码挂载，无需动镜像） |
| 3 | P2+P3（同一前端提交） | `web/src/App.tsx`、`web/src/store.tsx`、`__tests__/App.test.tsx`、`__tests__/store.test.tsx` | `e2e/run-web-docker-tests.sh`（WEB_IMAGE 复用现有 runtime 镜像） |

回滚策略：P1 镜像同 tag 覆盖前先 `docker tag` 备份旧镜像（如 `:pre-fix-20260730`）；P2~P4 均为纯源码改动，git revert 即可。

## 全局验收清单

- [ ] 补丁镜像内 conf 含 `-Q high,normal,low` + beat；compose 拉起后任务可离开 queued
- [ ] service 全量 pytest 绿（180 + 新增 3 条 Range 用例）
- [ ] web lint + vitest 绿（49 + 新增 2 条用例）
- [ ] 冒烟：页面可见 API Key 输入框；填 key → 建任务 → SSE 日志 → 终态，全程正常
- [ ] 遗留清理：测试用 api key deactivate、备份 tag 按需删除
