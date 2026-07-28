// 对话交互 Hook（task 8.10）：组合 useWebSocket 与 conversationStore，
// 暴露 submit / interrupt / approve；WS 不可用时 REST 兜底提交。
// 注意：每个会话只能调用一次（连接由 useWebSocket 建立），
// 在 SessionWorkspace 层调用后向下传 props。

import { useCallback } from 'react';
import { submitTurnRest } from '../api/sessions';
import { extractErrorDetail } from '../api/client';
import { useConversationStore } from '../store/conversationStore';
import type { PendingApproval } from '../store/conversationStore';
import { useWsStore } from '../store/wsStore';
import type { Message } from '../types/conversation';
import { sanitizeUserInput } from '../utils/sanitize';
import { useWebSocket } from '../ws/useWebSocket';
import type { UseWebSocketResult } from '../ws/useWebSocket';

// 稳定的空值引用（避免 selector 每次返回新对象导致重渲染循环）
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_HISTORY: string[] = [];

export interface UseConversationResult {
  messages: Message[];
  turnActive: boolean;
  todoMarkdown: string;
  pendingApproval: PendingApproval | null;
  inputHistory: string[];
  ws: UseWebSocketResult;
  /** 清理后提交；WS 断开时回退 REST（阻塞式）。返回是否已受理。 */
  submit: (rawText: string) => boolean;
  interrupt: () => boolean;
  approve: UseWebSocketResult['approve'];
  clearMessages: () => void;
}

export function useConversation(sessionId: string | null): UseConversationResult {
  const ws = useWebSocket(sessionId);

  const messages = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const turnActive = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.turnActive ?? false) : false,
  );
  const todoMarkdown = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.todoMarkdown ?? '') : '',
  );
  const pendingApproval = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.pendingApproval ?? null) : null,
  );
  const inputHistory = useConversationStore((s) =>
    sessionId ? (s.conversations[sessionId]?.inputHistory ?? EMPTY_HISTORY) : EMPTY_HISTORY,
  );

  const submit = useCallback(
    (rawText: string): boolean => {
      if (!sessionId) return false;
      const text = sanitizeUserInput(rawText);
      if (!text) return false;
      if (ws.submit(text)) return true;

      // REST 兜底：WS 未就绪时阻塞式提交（design：REST 是兜底通道）
      const conv = useConversationStore.getState();
      conv.addUserMessage(sessionId, text);
      conv.pushInputHistory(sessionId, text);
      void submitTurnRest(sessionId, text)
        .then((turn) => {
          const store = useConversationStore.getState();
          if (turn.assistant_text) {
            store.appendAssistantText(sessionId, turn.turn_index, turn.assistant_text);
          }
          store.completeTurn(sessionId, turn.turn_index, {
            interrupted: turn.status === 'interrupted',
            hasArtifact: turn.has_artifact ?? false,
          });
          // 同步补发基准，避免后续 WS 重连重复补发该轮次（A6）
          useWsStore.getState().setLastTurnIndex(sessionId, turn.turn_index);
          if (turn.error_message) {
            store.addSystemMessage(sessionId, 'error', turn.error_message);
          }
        })
        .catch(async (err: unknown) => {
          const store = useConversationStore.getState();
          store.setTurnActive(sessionId, false);
          store.addSystemMessage(sessionId, 'error', (await extractErrorDetail(err)) ?? '提交失败');
        });
      return true;
    },
    [sessionId, ws],
  );

  const clearMessages = useCallback(() => {
    if (sessionId) useConversationStore.getState().clearMessages(sessionId);
  }, [sessionId]);

  return {
    messages,
    turnActive,
    todoMarkdown,
    pendingApproval,
    inputHistory,
    ws,
    submit,
    interrupt: ws.interrupt,
    approve: ws.approve,
    clearMessages,
  };
}
