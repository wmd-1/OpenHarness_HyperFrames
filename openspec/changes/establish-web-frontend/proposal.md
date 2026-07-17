# Proposal: 建立 Web 前端能力（establish-web-frontend）

**Change ID:** `establish-web-frontend`
**Created:** 2026-07-17
**Status:** Draft

---

## Problem Statement

`web/` 前端当前是一个可用的 MVP（单页「视频工厂」控制台：提交 prompt → 通过 SSE 接收进度日志 → 轮询任务状态 → 成功播放 / 失败报错 / 取消删除），并已有生产镜像（`web/Dockerfile` 多阶段 Vite→nginx + `web/nginx.conf` 同源反代到 `api:8000`）。但：

- 前端**未作为 OpenSpec 受追踪的能力**存在——其架构、与后端的集成契约（反向代理）、构建/容器化约定都散落在代码与 README，没有规格锚点；
- 后续前端工作（任务列表、多任务管理、鉴权 UI、自动化测试/CI）**没有计划与验收基准**；
- `create-monorepo-openharness-hyperframes`（活跃）只覆盖了「目录布局 + 开发代理 + 生产 CORS」，**没有**覆盖前端的 SPA 架构、生产反向代理细节（SSE 关闭 buffering、Range 透传）、构建镜像与 dev/prod 一致性。

本提案把前端建立为第一等的 OpenSpec 能力，沉淀现有契约，并给出到生产就绪的分阶段计划。

## Proposed Solution

- 引入 `web-frontend` 能力规格（delta → 基线），固化：SPA 架构、同源反向代理集成契约（免 CORS）、多阶段构建/容器镜像、dev/prod 一致性、任务生命周期 UI 基线。
- 通过 `tasks.md` 给出分阶段路线图：① 奠定规格与工具链；② 核心 UI 硬化（任务列表/多任务/状态/错误空态）；③ 验证集成契约（compose 反代路径 + 冒烟测试）；④ 鉴权与打磨（X-API-Key、i18n、文档、CI）。
- 与 `create-monorepo-openharness-hyperframes` 的关系：后者覆盖布局/开发代理/生产 CORS；本提案覆盖前端专属能力，互不重复。

## Scope

### In Scope
- `web-frontend` 能力规格（架构 + 集成契约 + 构建镜像 + dev/prod 一致性 + MVP 生命周期 UI）。
- 前端工具链基座（tsc/vite 类型检查、lint、单测脚手架、CI 构建校验）。
- 核心 UI 硬化与集成契约验证（计划，分阶段落地）。

### Out of Scope
- 后端 service 逻辑（已由 `video-service-hardening` 系列覆盖）。
- OpenHarness 框架内部（已由 `OpenHarness/` 覆盖）。
- 多租户后端（已由 `phase3-multitenancy-temporal-lease` 覆盖）；前端仅预留 tenant-aware UI 钩子，不实现后端多租户。
- 鉴权后端实现（X-API-Key 校验在 service 侧）。

## Impact Analysis

| Component | Change Required | Details |
|-----------|-----------------|---------|
| Database | No | 前端不直连 DB |
| API | No | 仅消费现有 `/v1`、`/healthz`、SSE、文件端点 |
| State | No | 前端本地 React state（任务态在内存） |
| UI | Yes | 新增/硬化 `web/src` 组件与页面；引入规格锚点 |

## Architecture Considerations

- 沿用既有模式：SPA 同源反代到 `api:8000`（`web/nginx.conf`），`VITE_API_BASE` 默认空走相对路径，**免 CORS**；dev 仍走 Vite proxy（见 `create-monorepo`）。
- 新引入模式：前端作为独立 OpenSpec 能力；任务列表/多任务态需要在前端引入轻量状态管理（如 React context 或 zustand），但保持最小依赖。
- 依赖：仅 React/Vite/TS 既有栈；不引入重框架。

## Success Criteria

- [ ] `web-frontend` 规格进入基线（归档后 `openspec/specs/web-frontend.md` 存在）。
- [ ] `tsc -b && vite build` 在 CI 中通过（现有已可本地通过）。
- [ ] 任务列表/多任务管理/错误空态落地并有冒烟测试。
- [ ] 集成契约冒烟测试覆盖 SSE 与文件 Range 透传。
- [ ] README 与规格同步。

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| 前端状态管理过度设计 | Med | Med | 保持最小依赖，先做单任务增强再上列表 |
| SSE/Range 反代在浏览器行为偏差 | Low | Med | 用冒烟测试锁契约（见 tasks Phase 3） |
| 与 `create-monorepo` 规格重叠 | Low | Low | 本提案专注前端专属，开发代理/CORS 引用前者 |
