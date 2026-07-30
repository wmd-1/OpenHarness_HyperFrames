// 轮次历史回显编排（F2.1/F2.2/F2.4）：
// 触发判定「本地消息为空 + turn_count>0 + 未 hydrate 过」→ 一页拉全（limit=200，
// while 兜底后端上限调整）→ 三步串行①hydrateHistory ②setLastTurnIndex，
// hydrated=true 后 SessionWorkspace 才放行 WS 建连（③，禁止并行优化）。

import { useCallback, useEffect, useState } from 'react';
import { extractErrorDetail } from '../api/client';
import { listTurns } from '../api/sessions';
import { useConversationStore } from '../store/conversationStore';
import { useSessionStore } from '../store/sessionStore';
import { useWsStore } from '../store/wsStore';
import type { TurnResponse } from '../types/api';

/** 单页上限（对齐后端 OH_MAX_TURNS_PER_SESSION=200，一页即可拉全）。 */
const TURNS_PAGE_LIMIT = 200;

export interface UseTurnHistoryResult {
  /** hydration 完成或无需 hydrate（WS 建连门控，F2.4 第③步前提）。 */
  hydrated: boolean;
  /** 拉取进行中（ChatView 骨架条）。 */
  loading: boolean;
  /** 拉取失败信息（ChatView 重试条）。 */
  error: string | null;
  retry: () => void;
}

/** 拉全轮次历史：一页拉全 + items.length < total 时 while 续拉兜底（F2.2）。 */
async function fetchAllTurns(sid: string): Promise<TurnResponse[]> {
  const turns: TurnResponse[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (turns.length < total) {
    const afterIndex = turns.length > 0 ? turns[turns.length - 1].turn_index : -1;
    const resp = await listTurns(sid, { after_index: afterIndex, limit: TURNS_PAGE_LIMIT });
    total = resp.total;
    if (resp.items.length === 0) break;
    turns.push(...resp.items);
  }
  return turns;
}

export function useTurnHistory(sessionId: string | null): UseTurnHistoryResult {
  const turnCount = useSessionStore((s) =>
    sessionId ? (s.sessions[sessionId]?.turn_count ?? 0) : 0,
  );
  const hydratedAt = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.hydratedAt ?? null) : null,
  );
  const messageCount = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.messages.length ?? 0) : 0,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 触发判定（F2.1）：本地为空 + 有历史轮次 + 未 hydrate 过
  const needHydrate =
    sessionId !== null && messageCount === 0 && turnCount > 0 && hydratedAt === null;

  // 切换会话时清残留错误态
  useEffect(() => {
    setError(null);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    if (!needHydrate || !sessionId) return;
    const sid = sessionId;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const turns = await fetchAllTurns(sid);
        if (cancelled) return;
        // 三步串行①→②（F2.4 强约束）：先整体替换历史，再写 WS 补发基准
        useConversationStore.getState().hydrateHistory(sid, turns);
        if (turns.length > 0) {
          useWsStore.getState().setLastTurnIndex(sid, turns[turns.length - 1].turn_index);
        }
      } catch (err) {
        if (cancelled) return;
        setError((await extractErrorDetail(err)) || '加载历史消息失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needHydrate, sessionId, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return {
    // hydrate 成功后 hydratedAt 非空 → needHydrate 翻转 false → 放行建连
    hydrated: sessionId !== null && !needHydrate,
    loading,
    error,
    retry,
  };
}
