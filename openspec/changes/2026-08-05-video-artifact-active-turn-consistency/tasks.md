# 任务清单：多轮产物预览轮次一致性（activeTurn 单一权威）

关联方案：`proposal.md`；设计：`design.md`。**DRAFT：仅 openspec，待用户确认后实现。**

## 验收（实现后须全部满足，用户指定）

- [ ] 1. 第 2 轮 tab `aria-selected="true"` 时，`video` `src` **必须**为 `turns/1/artifact`。
- [ ] 2. 多轮 artifact 场景下默认选中最新轮（第 N 轮完成后预览聚焦第 N 轮，不滞留第 1 轮）。
- [ ] 3. `tab selected` 与 `video src` 在任意时刻一致（二者同源 `activeTurn`）。
- [ ] 4. **E2E 回归 PASS**：`design-agent-frontend/e2e/real-multiturn-artifact.spec.ts` 在 `openharness-design-frontend:e2e` 镜像内跑通（原 FAIL 翻 PASS）。
- [ ] 5. 组件/单元回归新增并通过（`__tests__/videoPreviewActiveTurn.test.tsx`）。

## 实现任务（最小、不改 session-service）

### A. 状态机收敛
- [ ] A.1 `VideoModulePage.tsx`：抽取纯函数 `resolveActiveTurn(current, artifactTurns, pinned)`（默认最新轮、钉选优先、空数组返回 null），便于单测。
- [ ] A.2 替换 `:183-193` 的脆弱 effect：以 `artifactTurns`/`latestArtifact` 为权威驱动 `activeTurn`（不再依赖 `turnActive` 提交顺序）；首次可播放默认最新轮；新轮完成且未钉选旧轮则推进到最新。
- [ ] A.3 保留 `currentId` 变化时 `activeTurn=null` 既有逻辑（`:148-152`）。
- [ ] A.4 `VideoPreviewPanel` 保持现状（tab/src 同源 `activeTurn`，无需改渲染）。

### B. 契约更新
- [ ] B.1 `openspec/specs/design-agent-video.md`：合并本 change 的 `specs/design-agent-video/spec.md` delta（ADDED 多轮产物预览轮次一致性要求，明确 activeTurn 单一权威、默认最新轮、tab↔src 一致）。

### C. 回归测试
- [ ] C.1 新增 `design-agent-frontend/src/modules/video/__tests__/videoPreviewActiveTurn.test.tsx`：
  - `resolveActiveTurn` 单测（[0,1]/pinned=false→1；pinned=true&current=0→0；空→null）。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=1` → `video` src 含 `turns/1/artifact`、`第 2 轮` tab selected、`第 1 轮` 非 selected。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=0` → src `turns/0/artifact`、第 1 轮 selected（sanity）。
- [ ] C.2 复用 E2E `real-multiturn-artifact.spec.ts` 作验收回归（修复后须 PASS）。

### D. 验证与依赖
- [ ] D.1 在既有前端镜像内跑 `videoPreviewActiveTurn.test.tsx` 与 `real-multiturn-artifact.spec.ts`（E2E 镜像）全绿。
- [ ] D.2 **不标记 J5 完成**；仅解除 frontend blocker。
- [ ] D.3 回头将 `2026-08-05-ws-multiturn-submit-lifecycle` tasks.md #5 由 BLOCKED 翻为「后端已验证 + 待本 frontend change」→ 待本 change 合并且 E2E PASS 后，由该 change 收尾将 J5 标 completed（非本次操作）。
