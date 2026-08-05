/**
 * 多轮产物预览「当前预览轮次」派生规则（activeTurn 单一权威）。
 *
 * `activeTurn` 由 **turn lifecycle**（conversation.turnActive）与 **artifactTurns**
 * （latestArtifact）两个异步来源推导，但本纯函数**不依赖两者的到达时序**，对任意
 * 输入稳定收敛到正确轮次——这是修复「乱序到达导致 activeTurn 停在首轮」的核心：
 *
 *   1. 无产物轮（artifactTurns 空）            → null（预览占位）
 *   2. 用户在当前 artifact 集合下主动钉选某轮   → 保持该轮（pinned）
 *   3. 否则（首屏 / 未钉选 / 新产物轮到达后解除钉选）→ 最新轮（artifactTurns 末位）
 *
 * 派生优先级（高 → 低，详见 design.md §3）：
 *   用户主动选择历史轮次 > 首屏默认最新 > 新 artifact 自动最新。
 *
 * @param current        当前 activeTurn（可能为 null 或用户钉选的历史轮）
 * @param artifactTurns  所有带产物的轮次索引（升序）
 * @param pinned         用户是否在「当前 artifact 集合」下主动钉选了某历史轮
 */
export function resolveActiveTurn(
  current: number | null,
  artifactTurns: number[],
  pinned: boolean,
): number | null {
  if (artifactTurns.length === 0) return null;
  if (pinned && current !== null && artifactTurns.includes(current)) return current;
  return artifactTurns[artifactTurns.length - 1];
}
