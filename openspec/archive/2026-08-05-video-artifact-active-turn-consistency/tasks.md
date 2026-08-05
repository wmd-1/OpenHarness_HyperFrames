# 任务清单：多轮产物预览轮次一致性（activeTurn 单一权威）

关联方案：`proposal.md`；设计：`design.md`。**openspec 已按评审更新（根因升格为「派生状态对来源时序敏感」、明确派生优先级、新增 spec invariant 与乱序收敛回归用例），并已实现完成。**

## 验收（实现后须全部满足，用户指定）

- [x] 1. 第 2 轮 tab `aria-selected="true"` 时，`video` `src` **必须**为 `turns/1/artifact`。
- [x] 2. 多轮 artifact 场景下默认选中最新轮（第 N 轮完成后预览聚焦第 N 轮，不滞留第 1 轮）。
- [x] 3. `tab selected` 与 `video src` 在任意时刻一致（二者同源 `activeTurn`，满足 spec invariant）。
- [x] 4. **E2E 回归 PASS**：`design-agent-frontend/e2e/real-multiturn-artifact.spec.ts` 在 `openharness-design-frontend:e2e` 镜像内跑通（原 FAIL 翻 PASS）。
- [x] 5. 组件/单元回归新增并通过（`__tests__/videoPreviewActiveTurn.test.tsx`，含乱序到达收敛用例）。

## 实现任务（最小、不改 session-service）

### A. 状态机收敛
- [x] A.1 `VideoModulePage.tsx`：抽取纯函数 `resolveActiveTurn(current, artifactTurns, pinned)`（默认最新轮、钉选优先、空数组返回 null），便于单测。
- [x] A.2 替换时序敏感 effect：以 `artifactTurns`/`latestArtifact` 为权威驱动 `activeTurn`，**不再对 turn lifecycle 与 artifact 两个异步来源的到达时序敏感**；首次可播放默认最新轮；新轮完成且未钉选旧轮则推进到最新。解析遵循 proposal「派生优先级」（用户钉选 > 首屏最新 > 新 artifact 自动最新）。
- [x] A.3 保留 `currentId` 变化时 `activeTurn=null` 既有逻辑。
- [x] A.4 `VideoPreviewPanel` 保持现状（tab/src 同源 `activeTurn`，无需改渲染，满足 spec invariant）。

### B. 契约更新
- [x] B.1 `openspec/specs/design-agent-video.md`：合并本 change 的 `specs/design-agent-video/spec.md` delta（ADDED 多轮产物预览轮次一致性要求 + 派生优先级 + Invariant + 乱序收敛 scenario）。

### C. 回归测试
- [x] C.1 新增 `design-agent-frontend/src/modules/video/__tests__/videoPreviewActiveTurn.test.tsx`：
  - `resolveActiveTurn` 单测：artifactTurns=[0,1]、pinned=false → 1；pinned=true&current=0 → 0；空→null。
  - **乱序到达收敛用例**：`resolveActiveTurn(current=0, artifactTurns=[0,1], pinned=false)` → **1**（模拟 turn_complete 与 artifactTurns 更新乱序、历史派生曾停在首轮，仍必须收敛到最新 artifact）。锁定「乱序下 activeTurn 仍指向最新」不变量。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=1` → `video` src 含 `turns/1/artifact`、`第 2 轮` tab selected、`第 1 轮` 非 selected（锁定契约）。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=0` → src `turns/0/artifact`、第 1 轮 selected（sanity）。
- [x] C.2 复用 E2E `real-multiturn-artifact.spec.ts` 作验收回归（修复后 PASS）。**实现中发现并修正测试选择器歧义**：聊天消息气泡（`MessageBubble`→`VideoPlayer`）也会渲染各自轮次视频，DOM 顺序排在预览面板之前，原 `page.locator('video').first()` 误命中消息气泡视频；已将断言限定到 `aside[aria-label="视频预览面板"] video`。

### D. 验证与依赖
- [x] D.1 在既有前端镜像内跑 `videoPreviewActiveTurn.test.tsx`（8/8 通过）与 `real-multiturn-artifact.spec.ts`（E2E 镜像，1 passed）全绿。
- [x] D.2 **不标记 J5 完成**；仅解除 frontend blocker。
- [x] D.3 回头将 `2026-08-05-ws-multiturn-submit-lifecycle` tasks.md #5 由 BLOCKED 翻为「后端已验证 + 待本 frontend change」→ 待本 change 合并且 E2E PASS 后，由该 change 收尾将 J5 标 completed（非本次操作）。
