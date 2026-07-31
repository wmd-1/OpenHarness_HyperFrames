// 视频产物轮次派生（spec design-agent-video：多轮产物切换条 + 自动展开预览）。

import type { Message } from '../../types/conversation';

/** 从消息列表提取已完成且携带产物的轮次索引（升序去重）。 */
export function extractArtifactTurns(messages: Message[]): number[] {
  const turns = new Set<number>();
  for (const m of messages) {
    if (m.kind === 'assistant' && m.hasArtifact && !m.streaming && m.turnIndex >= 0) {
      turns.add(m.turnIndex);
    }
  }
  return [...turns].sort((a, b) => a - b);
}
