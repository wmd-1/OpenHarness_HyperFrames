## ADDED Requirements

### Requirement: 多轮产物预览轮次一致性（activeTurn 单一权威）

视频模块 MUST 以 `activeTurn` 作为「当前预览产物轮次」的**单一权威状态**，且 MUST NOT 因 `turn_complete` 帧与 artifact 消息的提交顺序而停留在非最新轮。当用户未手动钉选某个历史轮次时，预览 MUST 默认选中并播放**最新产物轮**（即 `artifactTurns` 的最后一个元素）；当用户在切换条显式点击某轮时，预览 MUST 切换到该轮。

`VideoPreviewPanel` 的轮次切换条 MUST 保证「选中 tab」与「视频源」在任意时刻一致：选中第 N 轮 tab（`aria-selected="true"`）时，视频 `src` MUST 为 `turns/{N}/artifact`（`artifactStreamUrl(sid, N)`），二者 MUST 同源派生自 `activeTurn`（即 `aria-selected={turn === activeTurn}` 与 `src={artifactStreamUrl(sid, activeTurn)}`）。

本要求仅约束前端状态管理，MUST NOT 要求任何 session-service 修改。

#### Scenario: 多轮完成后默认聚焦最新轮
- **WHEN** 单会话连续完成两轮且均 `has_artifact=true`
- **THEN** 第二轮 `turn_complete` 后预览自动选中第 2 轮、视频 `src` 为 `turns/1/artifact`，且不滞留于第 1 轮

#### Scenario: 选中第 N 轮 tab 时视频源一致
- **WHEN** 切换条中第 N 轮 tab 处于 `aria-selected="true"`
- **THEN** 视频 `src` 为 `turns/{N}/artifact`，且其他轮次 tab 不为 `aria-selected`

#### Scenario: 用户点击历史轮次可钉选
- **WHEN** 用户在切换条点击某个较早轮次（如第 1 轮）
- **THEN** 预览切换到该轮（视频 `src` 为 `turns/{更早轮}/artifact`、该 tab 选中）

#### Scenario: 无产物轮不选中
- **WHEN** 会话尚无任何带产物轮次（`artifactTurns` 为空）
- **THEN** `activeTurn` 为 `null`，预览展示占位而非任意轮次视频
