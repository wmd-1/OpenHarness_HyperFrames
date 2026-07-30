# Design: fix-service-web-test-findings

## Context

- 2026-07-30 实况测试报告：`docs/service-web-test-report-2026-07-30.md`；评审后修复方案：`plans/Service_Web_Test_Fixes_Plan_2026-07-30.md`（本 design 是其 OpenSpec 化，方案文档为实现细节的权威来源）。
- 当前状态：
  - 镜像内 `/etc/supervisor/conf.d/oh-service.conf` 的 `[program:worker]` 缺 `-Q`（只消费默认 `celery` 队列），且构建时的旧版 conf 无 `[program:beat]`；调度器 `queue_for_priority()` 投递到 `high/normal/low` → oh-serve 路径任务永卡 `queued`。e2e 的 `oh-role` 入口是正确写法（`-Q "${OH_WORKER_QUEUES:-high,normal,low}"`）。
  - `web/src/components/ApiKeyInput.tsx` 组件完整（localStorage `oh_api_key` 读写，`api.ts` 已消费该 key）但 `App.tsx` 未渲染。
  - `web/src/store.tsx` 用 `requestAnimationFrame` 调度批量刷新，后台标签页 rAF 无限期挂起 → UI 冻结。
  - `service/app/routers/videos.py` L305 `start = max(0, min(start, end))` 把越界 Range 钳位返回 206，违反 RFC 7233 §4.4。
- 约束：仓库规则「测试必须基于已有镜像」——禁止宿主机跑测试、禁止重建基础镜像，用 `Dockerfile.fix` 打补丁层、源码 volume 挂载。

## Goals / Non-Goals

**Goals:**

- oh-serve 部署形态下任务能被消费（worker 订阅全部优先级队列 + beat 存在）。
- 部署配置有契约测试守护，投递侧（scheduler）与消费侧（supervisord conf）漂移即红。
- 前端 API Key 入口可用，且 key 全链路（输入→存储→请求头/SSE 参数→清除）有测试。
- 后台标签页任务状态不冻结；批量合并（防 setState 竞态）行为保留。
- 越界 Range 返回 416，合法 Range/suffix 行为不变。

**Non-Goals:**

- P5 任务列表端点（`GET /v1/videos`）与前端历史任务水合——另行立项。
- `?api_key=` 明文查询参数替换为签名令牌（WF6 已记录为中期项）。
- 重建基础镜像、升级依赖、改动 `oh-role` 入口（已是正确实现）。

## Decisions

### D1（Phase 1）：worker 队列用 `bash -c` + env-fallback，不硬编码

`[program:worker]` command 改为：

```ini
command=/bin/bash -c 'exec /root/.openharness-venv/bin/celery -A app.workers.celery_app.celery_app worker -l info -c "${OH_CELERY_CONCURRENCY:-4}" -Q "${OH_WORKER_QUEUES:-high,normal,low}"'
```

备选对比：

| 方案 | 结论 | 原因 |
|---|---|---|
| supervisord `%(ENV_OH_WORKER_QUEUES)s` | ❌ | env 缺失时解析失败直接拒启，无默认值语法 |
| program 段 `environment=` 写死 | ❌ | supervisord env 优先于容器继承 env，反向屏蔽 compose 运行时覆盖 |
| 纯硬编码 `-Q high,normal,low` | ❌ | 与 `app/config.py::worker_queues`、`oh-role` 的可配置语义分叉，改 env 时 oh-serve 静默失效 |
| `bash -c` + `${VAR:-default}` | ✅ | env 透传 + 兜底，与 `oh-role` 同构；`exec` 保证信号直达 celery 主进程 |

### D2（Phase 1）：部署契约测试直接断言镜像内产物

`service/tests/test_deployment_contract.py` 解析 `/etc/supervisor/conf.d/oh-service.conf`（路径可由 `OH_SUPERVISORD_CONF` 覆盖，缺失时 skip 仅防非镜像环境误报）。因为测试本身跑在主镜像衍生层里，断言对象就是**实际部署产物**而非仓库文本——镜像与代码期望任一漂移即红。三条断言：worker 订阅集合 ⊇ `settings.worker_queues`；`[program:beat]` 存在；`queue_for_priority()` 值域 ⊆ worker 订阅集合（投递/消费契约闭环）。在未打补丁的现有镜像上预期先红，驱动补丁落地后转绿。

### D3（Phase 1）：镜像更新走 `Dockerfile.fix` 补丁层，同 tag 覆盖

`Dockerfile.fix` 追加 `COPY docker/supervisord.conf /etc/supervisor/conf.d/oh-service.conf`，以现有主镜像为 `BASE_IMAGE` 构建、同 tag 覆盖（构建前打 `-backup-20260730` 备份 tag 供回滚）。不重建基础镜像；`oh-e2e`/`oh-e2e-test` 仅重建衍生叠加层。

### D4（Phase 2）：416 判定置于 Range 解析成功之后、钳位之前

仅对显式 first-byte-pos ≥ size（含 `bytes=-0` 推导出的 start=size）返回 `416 + Content-Range: bytes */{size}`；Range 头解析失败仍走现行「忽略 Range 全量 200」宽容路径；suffix `bytes=-N`（N>0）照旧钳到文件头 206。实现时把判定提前到 `storage.open` 之前（或确保 416 抛出前关闭已开 fileobj），避免句柄泄漏——以最小改动为准，语义以 spec 为准。

### D5（Phase 3）：批量刷新去 rAF，统一 trailing `setTimeout(32ms)`

rAF 的「合帧」收益仅对动画有意义；防 setState 交错的真正机制是 ref-based pending 缓冲（保留）。统一 timer 后：单代码路径、无 `visibilitychange` 全局监听、vitest fake timers 直接可测。后台标签页 timer 被节流到 ≥1s 但不会冻结，页面不可见时 1s 内提交可接受。备选「rAF+隐藏时降级 timer+visibilitychange 补刷」因需两套句柄、三段取消逻辑被否决（评审意见 4）。

### D6（Phase 3）：ApiKeyInput 挂载位置与真实链路测试

`App.tsx` sidebar 中 `<Composer />` 之上渲染 `<ApiKeyInput />`，组件与样式零改动。真实链路测试在 vitest/jsdom 层完成（`userEvent` 输入→断言 localStorage→mock `fetch` 断言 `X-API-Key` 头→mock `EventSource` 断言 `?api_key=`→清除后断言不携带），不引入 playwright（web/ 无 e2e 基建，jsdom 已覆盖三层链路）。

## Risks / Trade-offs

- [同 tag 覆盖镜像可能影响其他在跑容器] → 构建前打备份 tag；`docker compose up -d --force-recreate api` 灰度单服务；回滚 = retag 备份。
- [`bash -c` 包装使 supervisord 管理 bash 子进程] → `exec` 替换进程后 celery 即主进程，信号/退出码语义与直启一致。
- [契约测试在旧镜像上红，可能阻塞无关 CI] → 属预期"先红后绿"；Phase 1 内一次性完成补丁 + 衍生层重建，不跨 Phase 悬置。
- [416 改变越界 Range 的既有响应（206→416）] → RFC 标准行为，主流客户端原生处理；新增回归用例保证合法 Range 不受影响。
- [后台标签页状态提交延迟最长约 1s（timer 节流）] → 页面不可见时无人观看，切回前台时已是最新；相比现状（无限期冻结）严格改善。
- [jsdom 层链路测试非真实浏览器] → 请求头/localStorage/EventSource URL 三层断言已覆盖回归目标；真实浏览器链路已由 2026-07-30 实况测试人工验证过一次。

## Migration Plan

1. Phase 1：改 conf + `Dockerfile.fix` → 备份 tag → 补丁构建同 tag → 重建 `oh-e2e`/`oh-e2e-test` 衍生层 → 契约测试转绿 → `docker compose up -d --force-recreate api` → 实况验证任务离开 `queued`。
2. Phase 2：改 `videos.py` + 新增用例 → 镜像内 pytest 全量回归（挂载 `service/`，无需动镜像）。
3. Phase 3：改 `App.tsx`/`store.tsx` + 新增测试 → `e2e/run-web-docker-tests.sh`（lint+vitest 在 `--target test` 阶段）→ 按需 `WEB_NEW_TAG` 发布 → `docker compose up -d web`。

回滚：镜像 retag 备份；代码 revert 对应提交；三个 Phase 相互独立可单独回滚。

## Open Questions

（无——评审调整 1-4 已在方案文档中定案。）
