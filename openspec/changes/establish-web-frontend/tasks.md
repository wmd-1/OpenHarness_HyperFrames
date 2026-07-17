# Implementation Tasks: 建立 Web 前端能力

**Change ID:** `establish-web-frontend`

---

## Phase 1: 规格与工具链基座 (Foundation)

- [ ] 1.1 落地本提案 delta → 基线 `openspec/specs/web-frontend.md`（`/openspec-archive` 时）
- [ ] 1.2 前端工具链：确保 `tsc -b` 类型检查、`vite build` 在 `web/` 通过；加入 `npm run lint`（eslint）与 `npm run test`（vitest）脚本骨架
- [ ] 1.3 单测脚手架：为 `api.ts` 客户端与 `App.tsx` 关键交互补最小单测（mock fetch / EventSource）

**Quality Gate:**
- [ ] `tsc -b` 通过
- [ ] `vite build` 通过

---

## Phase 2: 核心 UI 硬化 (Core UI)

- [ ] 2.1 引入轻量前端状态（React context / zustand），支持多任务态
- [ ] 2.2 任务列表视图：展示最近任务（id/状态/创建时间），点击进入详情
- [ ] 2.3 任务详情：复用 SSE 进度 + 状态轮询 + 成功播放/失败报错 + 取消/删除
- [ ] 2.4 错误态与空态：网络错误、无任务、任务不存在的统一处理
- [ ] 2.5 状态徽标与加载态打磨

**Quality Gate:**
- [ ] 类型检查通过
- [ ] 关键交互单测通过

---

## Phase 3: 集成契约验证 (Integration)

- [ ] 3.1 在 `docker compose up` 下验证 `web` 反代：`/v1`、`/healthz` 到达 `api:8000`
- [ ] 3.2 冒烟测试：SSE `/v1/videos/{id}/events` 进度流（nginx `proxy_buffering off` 生效）
- [ ] 3.3 冒烟测试：文件 `/v1/videos/{id}/file` Range/If-Range 透传（断点续传）
- [ ] 3.4 dev/prod 一致性校验：同一 `api.ts` 在 dev(Vite proxy) 与 prod(nginx) 表现一致

**Quality Gate:**
- [ ] 集成冒烟测试通过
- [ ] 反代路径与基线 WF2 一致

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

---

## Completion Checklist

- [ ] 所有阶段完成
- [ ] 所有质量门通过
- [ ] 文档同步
- [ ] 就绪于 `/openspec-archive establish-web-frontend`
