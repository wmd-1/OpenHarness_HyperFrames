# Proposal: 多轮产物预览轮次一致性（activeTurn 单一权威）

- **Change:** `2026-08-05-video-artifact-active-turn-consistency`
- **状态:** DRAFT（仅落 openspec，待用户确认后实现）
- **能力域:** `design-agent-video`（design-agent-frontend 视频模块）
- **依赖：** `2026-08-05-ws-multiturn-submit-lifecycle`（session-service 后端修复，已落地）。本 change 不修改 session-service。

## 背景

后端 change `2026-08-05-ws-multiturn-submit-lifecycle` 已修复 ws.py busy 守卫，J5 E2E 现可稳定产生**两个带产物轮次**（诊断探针 `real-multiturn-artifact-diag.spec.ts` 已证明：2×`turn_complete`、2 REST 轮、`secondTurnArrived=true`、0 busy 帧）。

但 J5 验收 spec `real-multiturn-artifact.spec.ts` 仍 FAIL：第 2 轮产物完成后，预览面板停留在**第 1 轮**产物（`video` `src=turns/0/artifact`），而契约期望默认选中**最新轮（第 2 轮）**且 `tab selected ↔ video src` 一致。用户已确认此为**独立前端 defect**，不回填到 session-service change。

## 问题概述

`VideoModulePage` 用 `activeTurn` 作为「当前预览轮次」的单一状态；`VideoPreviewPanel` 的 tab `aria-selected={turn === activeTurn}` 与 `src={artifactStreamUrl(sid, activeTurn)}` 都从 `activeTurn` 派生。问题在于 `activeTurn` 在多轮场景下**不可靠地停在首轮索引（0）**，导致：

- 第 2 轮产物存在时，预览仍播第 1 轮（`turns/0/artifact`）；
- 「默认选中最新轮」「tab selected 与 video src 一致」契约被破坏。

根因见 `design.md` §2：`VideoModulePage.tsx:183-193` 的自动选中 effect 依赖 `[conversation.turnActive, latestArtifact]`，其 `else-if` 守卫 `latestArtifact !== turnStartArtifactRef.current` 在 `turnActive=false` 与 artifact 消息两笔提交顺序不确定时会被旧值「吃掉」，致 `activeTurn` 未推进到最新轮。

## IN scope（仅前端，最小）

1. 修复 `activeTurn` 与预览产物源（`artifactStreamUrl(sid, activeTurn)`）不一致——确保 `activeTurn` 可靠指向最新产物轮。
2. 多轮 artifact 切换时**默认选中最新轮**（首轮完成后默认第 1 轮；次轮完成后默认推进到第 2 轮；历史回显/切会话不强制重置）。
3. 保证 tab `aria-selected`（第 N 轮）与 `video` `src`（`turns/{N}/artifact`）在任意时刻一致——二者本就同源于 `activeTurn`，故修复点为让 `activeTurn` 成为「单一权威且必然等于最新/被钉选轮」。

## OUT scope（明确不做）

- **不修改 session-service**（含 `ws.py`、`supervisor.py`、REST/WS 契约）。
- 不改动 `VideoPreviewPanel` 的现有渲染契约（tablist/`aria-label`/`artifactStreamUrl` 用法保持），除非需要透传额外 prop。
- 不做新的后端契约、不做 history-replay 幂等之外的回显逻辑改动。
- 不做 BFCache/重连/审批/模型切换等无关改动。
- **不标记整个 J5 完成**：J5 验收需本 change + 后端 change 二者均落地；本 change 仅解除 frontend blocker。

## 受影响文件

- `design-agent-frontend/src/modules/video/VideoModulePage.tsx`（activeTurn 自动选中逻辑；建议抽取纯函数便于单测）
- `design-agent-frontend/src/modules/video/__tests__/videoPreviewActiveTurn.test.tsx`（**新增** 组件/单元回归）
- `design-agent-frontend/e2e/real-multiturn-artifact.spec.ts`（**复用** 作为 E2E 验收回归，修复后应 PASS）

## 验收目标（用户指定）

- 第 2 轮 tab `aria-selected="true"` 时，`video` `src` **必须**为 `turns/1/artifact`。

## 与 session-service change 的依赖

- `2026-08-05-ws-multiturn-submit-lifecycle` 的 J5 验收（tasks.md #5）**保持 BLOCKED**，直到本 frontend change 完成。完成后由本 change 的 E2E 翻 PASS，再回头将 J5 标 completed（不在本次操作）。
