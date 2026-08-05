# design-agent-video Specification

## Purpose
TBD - created by archiving change 2026-08-05-video-artifact-active-turn-consistency. Update Purpose after archive.
## Requirements
### Requirement: 多轮产物预览轮次一致性（activeTurn 单一权威）

视频模块 MUST 以 `activeTurn` 作为「当前预览产物轮次」的**单一权威状态**。`activeTurn` 由 **turn lifecycle**（`conversation.turnActive`）与 **artifactTurns**（`latestArtifact`）两个异步来源推导，但 MUST NOT 对这两个来源的到达时序敏感——即在**任意到达顺序**下 MUST 收敛到正确轮次（MUST NOT 因 `turn_complete` 帧与 artifact 消息乱序而停留在非最新轮）。

**派生优先级（高 → 低）**：
1. 用户显式点击历史轮次（pinned）→ `activeTurn` = 该轮，不被自动逻辑覆盖；
2. 会话首屏（无手动钉选）→ `activeTurn` = `artifactTurns` 最后元素（最新产物轮）；
3. 新 artifact 到达且用户未 pinned → `activeTurn` 自动收敛到最新轮。

**Invariant（核心不变量）**：切换条的「选中 tab」与「视频源」MUST 由**同一个 `activeTurn`** 派生——`aria-selected={turn === activeTurn}` 且 `src={artifactStreamUrl(sid, activeTurn)}`，二者 MUST 永远一致，MUST NOT 出现「selected tab 与 video src 由不同状态决定」的情况。

当用户未手动钉选某个历史轮次时，预览 MUST 默认选中并播放**最新产物轮**（即 `artifactTurns` 的最后一个元素）；当用户在切换条显式点击某轮时，预览 MUST 切换到该轮。

本要求仅约束前端状态管理，MUST NOT 要求任何 session-service 修改。

#### Scenario: 多轮完成后默认聚焦最新轮
- **WHEN** 单会话连续完成两轮且均 `has_artifact=true`
- **THEN** 第二轮 `turn_complete` 后预览自动选中第 2 轮、视频 `src` 为 `turns/1/artifact`，且不滞留于第 1 轮

#### Scenario: 选中第 N 轮 tab 时视频源一致
- **WHEN** 切换条中第 N 轮 tab 处于 `aria-selected="true"`
- **THEN** 视频 `src` 为 `turns/{N}/artifact`，且其他轮次 tab 不为 `aria-selected`

#### Scenario: 用户点击历史轮次可钉选
- **WHEN** 用户在切换条点击某个较早轮次（如第 1 轮）
- **THEN** 预览切换到该轮（视频 `src` 为 `turns/{更早轮}/artifact`、该 tab 选中），且不被后续自动推进覆盖

#### Scenario: 新 artifact 到达且未钉选则自动切换最新
- **WHEN** 用户未钉选任何历史轮次，且出现新的带产物轮次（如第 3 轮完成）
- **THEN** 预览自动收敛到最新轮（`activeTurn` = 最新轮，`src` = `turns/{最新}/artifact`），不滞留旧轮

#### Scenario: 异步来源乱序到达仍收敛最新轮
- **WHEN** `turn_complete` 帧与 artifactTurns 更新以任意顺序到达（模拟 turn lifecycle 与 artifact 两个异步来源乱序）
- **THEN** `activeTurn` 仍 MUST 收敛到 latest artifact 所指的最新产物轮（如第 2 轮），MUST NOT 因到达顺序不同而滞留于首轮

#### Scenario: 无产物轮不选中
- **WHEN** 会话尚无任何带产物轮次（`artifactTurns` 为空）
- **THEN** `activeTurn` 为 `null`，预览展示占位而非任意轮次视频

