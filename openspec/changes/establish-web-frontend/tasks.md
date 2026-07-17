# Implementation Tasks: 建立 Web 前端能力

**Change ID:** `establish-web-frontend`

---

> **前置基线（已建立，commit `2a3ed3a`）：前端独立镜像已落地。**
> - 构建文件：`web/Dockerfile`（多阶段 `node:22-alpine` 构建 `dist/` → `nginx:1.27-alpine` 伺服）、`web/nginx.conf.template`（同源反代）、`web/docker-entrypoint.sh`、`web/.dockerignore`。
> - 编排：`docker-compose.yml` 的 `web` 服务 `build: ./web` → 镜像 `openharness_hyperprames_web:<tag>`、`5173:80`、`depends_on api`。
> - 即「双镜像」中的**前端镜像**（另一镜像是 OpenHarness+后端 根 `Dockerfile`）。
> - 本计划在其之上做 UI 硬化与集成验证，不重复"新建镜像"，但 Phase 3 会显式验证镜像可构建且反代生效。

## Phase 1: 规格与工具链基座 (Foundation)

- [x] 1.1 落地本提案 delta → 基线 `openspec/specs/web-front-end.md`（`/openspec-archive` 时）
- [x] 1.2 前端工具链：确保 `tsc -b` 类型检查、`vite build` 在 `web/` 通过；加入 `npm run lint`（eslint flat config + typescript-eslint/react-hooks）与 `npm run test`（vitest）脚本骨架
- [x] 1.3 单测脚手架：为 `api.ts` 客户端（fetch 封装 / fileUrl / eventsUrl / 各端点）与 `App` 关键交互（空 prompt 拦截、提交调用 createVideo、SSE 流开启）补最小单测（mock fetch / EventSource）

**Quality Gate:** PASSED (2026-07-17)
- [x] `tsc -b` 通过
- [x] `vite build` 通过
- [x] `npm run test`（`vitest run`）通过 — 9 passed（api 7 + App 2）
- [x] `npm run lint` 通过 — 0 errors（仅 1 个 react-refresh 提示性 warning）

---

## Phase 2: 核心 UI 硬化 (Core UI)

- [x] 2.1 引入轻量前端状态（`web/src/store.tsx` React context，无新增重依赖），支持多任务态（tasks / order / logs / activeId）
- [x] 2.2 任务列表视图（`web/src/components/TaskList.tsx`）：展示最近任务（id 前 8 位 / 状态徽标 / 创建时间），点击进入详情
- [x] 2.3 任务详情（`web/src/components/TaskDetail.tsx`）：复用 store 的 SSE 进度 + 状态轮询 + 成功播放 / 失败报错 + 取消(队列中) / 删除(终态)
- [x] 2.4 错误态与空态：提交错误横幅（点击关闭）、无任务提示、任务不存在提示
- [x] 2.5 状态徽标（`StatusBadge`）与加载态打磨（submit busy、`HealthBadge`）

**Quality Gate:** PASSED (2026-07-17)
- [x] 类型检查通过（`tsc -b`）
- [x] 关键交互单测通过（App.test：空 prompt 拦截 + 提交建任务并开 SSE 流）
- [x] `vite build` 通过

---

## Phase 3: 集成契约验证 (Integration)

- [ ] 3.0 构建前端镜像：`docker compose build web` 产出 `openharness_hyperprames_web` 镜像（多阶段 `web/Dockerfile`，产物 `dist/` 由 nginx 伺服），确认镜像内 `nginx -t` 通过
- [ ] 3.1 在 `docker compose up` 下验证 `web` 反代：`/v1`、`/healthz` 到达 `api:8000`
- [ ] 3.2 冒烟测试：SSE `/v1/videos/{id}/events` 进度流（nginx `proxy_buffering off` 生效）
- [ ] 3.3 冒烟测试：文件 `/v1/videos/{id}/file` Range/If-Range 透传（断点续传）
- [ ] 3.4 dev/prod 一致性校验：同一 `api.ts` 在 dev(Vite proxy) 与 prod(nginx) 表现一致

**Quality Gate:**
- [ ] 集成冒烟测试通过
- [ ] 反代路径与基线 WF2 一致

> **Deferred（本环境无 Docker daemon，无法 `docker compose build/up` 端到端）：** Phase 3 的 3.0–3.4 留待具备 Docker 的 CI/本地环境执行；反代配置（WF2）与多阶段构建（WF3）已随 `web/Dockerfile` + `nginx.conf.template` + `docker-compose.yml` 落地，配置层经 `docker compose config` 校验通过。`nginx -t` 与 SSE/Range 冒烟需容器运行时。

---

## Phase 4: 鉴权与打磨 (Auth & Polish)

- [ ] 4.1 前端 X-API-Key 输入/本地存储（调用现有 `X-API-Key` 头；后端校验见 `video-service-hardening` R15）
- [ ] 4.2 tenant-aware UI 钩子（仅预留，后端多租户见 `phase3-multitenancy-temporal-lease`）
- [ ] 4.3 i18n 字符串（如适用）
- [ ] 4.4 文档同步：`web/README.md` 与 `OpenHarness/docs/hyperframes-skill-openharness-patches.md` §前端镜像 同步
- [ ] 4.5 CI：构建镜像 + `tsc -b && vite build` + 单测

**Quality Gate:**
- [ ] 所有测试通过
- [ ] 代码分析干净
- [ ] 文档同步

> **Deferred（部分）：** 4.1 的 X-API-Key 后端校验（R15）需在 `service` 侧落 `api_key` 鉴权中间件后方可联调，属后端范围；4.3 i18n / 4.5 CI 为可选打磨。本实现已具备 4.4 所需的 README 骨架；4.1–4.3 留待后续。

---

## Completion Checklist

- [x] Phase 1 完成（工具链 + 单测脚手架 + lint 骨架）
- [x] Phase 2 完成（任务列表 / 多任务 / 状态 / 错误空态）
- [ ] Phase 3 完成（集成契约验证 — 待 Docker 环境）
- [ ] Phase 4 完成（鉴权与打磨 — 部分待后端 R15）
- [x] Phase 1–2 质量门通过
- [ ] 就绪于 `/openspec-archive establish-web-frontend`（建议 Phase 3–4 完成后归档）
