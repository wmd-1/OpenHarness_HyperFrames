// useWebSocket Hook（task 6.3）：封装连接生命周期，把服务端帧分发到
// conversationStore / wsStore；delta 帧走 StreamBuffer 批量 flush
// （50ms 或 384 字符，design D6）。

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { requestSessionListRefresh } from '../hooks/useSessionList';
import { useAuthStore } from '../store/authStore';
import { useConversationStore } from '../store/conversationStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { useWsStore } from '../store/wsStore';
import { canConnectSession } from '../types/session';
import type { ApprovalReply, ServerFrame, WsStatus } from '../types/ws';
import {
  STREAM_FLUSH_CHAR_THRESHOLD,
  STREAM_FLUSH_INTERVAL_MS,
  WS_ADMISSION_MESSAGES,
  WS_CLOSE_CODES,
  WS_CLOSE_MESSAGES,
} from '../utils/constants';
import { WebSocketClient, type WebSocketClientOptions } from './WebSocketClient';

/** delta 批量 flush 缓冲：50ms 定时或 384 字符阈值先到先 flush。 */
class StreamBuffer {
  private buf = '';
  private turnIndex = -1;
  private timer: number | null = null;

  constructor(private readonly onFlush: (turnIndex: number, text: string) => void) {}

  push(turnIndex: number, text: string): void {
    if (this.turnIndex !== -1 && this.turnIndex !== turnIndex) {
      // 轮次切换：立即 flush 旧轮次
      this.flush();
    }
    this.turnIndex = turnIndex;
    this.buf += text;
    if (this.buf.length >= STREAM_FLUSH_CHAR_THRESHOLD) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = window.setTimeout(() => this.flush(), STREAM_FLUSH_INTERVAL_MS);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buf && this.turnIndex >= 0) {
      this.onFlush(this.turnIndex, this.buf);
    }
    this.buf = '';
  }

  dispose(): void {
    this.flush();
  }
}

export interface UseWebSocketResult {
  status: WsStatus;
  reconnectAttempt: number;
  submit: (text: string) => boolean;
  interrupt: () => boolean;
  approve: (requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string) => boolean;
  /** 达到最大重连次数后手动重试。 */
  retry: () => void;
  /** 额外帧监听（Terminal Mode 桥接用）。返回取消函数。 */
  addFrameListener: (listener: (frame: ServerFrame) => void) => () => void;
}

export function useWebSocket(sessionId: string | null): UseWebSocketResult {
  const apiKey = useAuthStore((s) => s.apiKey);
  // 建连准入（F1.5）：canConnectSession（resumable=false 或终态回退 → 不建连，
  // 状态翻转时自动断开）；store 中暂无该会话时按旧行为放行（兼容直连场景）
  const canConnect = useSessionStore((s) => {
    if (!sessionId) return false;
    const session = s.sessions[sessionId];
    return session ? canConnectSession(session) : true;
  });
  const status = useWsStore((s) => (sessionId ? (s.status[sessionId] ?? 'idle') : 'idle'));
  const reconnectAttempt = useWsStore((s) =>
    sessionId ? (s.reconnectAttempt[sessionId] ?? 0) : 0,
  );
  const clientRef = useRef<WebSocketClient | null>(null);
  const listenersRef = useRef(new Set<(frame: ServerFrame) => void>());

  useEffect(() => {
    if (!sessionId || !apiKey || !canConnect) return;
    const sid = sessionId;
    // 注意：store 动作统一 getState() 现取现用，不在 effect 顶部快照（D6）

    // 同一次准入失败「error 帧 + close 码」只出一条提示（以 error 帧为准，F3.3）
    let admissionNotified = false;

    const streamBuffer = new StreamBuffer((turnIndex, text) => {
      useConversationStore.getState().appendAssistantText(sid, turnIndex, text);
    });

    const handleFrame = (frame: ServerFrame) => {
      const conv = useConversationStore.getState();
      useWsStore.getState().markMessage(sid);
      switch (frame.type) {
        case 'session_ready': {
          // 唤醒/就绪：patch 本地 status→live（仅展示同步，不参与判定，F3.4）；
          // 触发列表刷新——旧会话可能已让位变 cold（F3.5/F1.3-④）
          const session = useSessionStore.getState().sessions[sid];
          if (session && session.status !== 'live') {
            useSessionStore.getState().patchSession(sid, { status: 'live' });
          }
          requestSessionListRefresh();
          break;
        }
        case 'delta':
          streamBuffer.push(frame.turn_index, frame.text);
          if (frame.final) streamBuffer.flush();
          break;
        case 'turn_complete': {
          streamBuffer.flush();
          conv.completeTurn(sid, frame.turn_index, {
            interrupted: frame.interrupted,
            replayedText: frame.replayed ? frame.assistant_text : null,
            hasArtifact: frame.has_artifact ?? false,
          });
          useWsStore.getState().setLastTurnIndex(sid, frame.turn_index);
          // 轮次计数同步到会话卡片
          const session = useSessionStore.getState().sessions[sid];
          if (session && session.turn_count <= frame.turn_index) {
            useSessionStore.getState().patchSession(sid, {
              turn_count: frame.turn_index + 1,
              last_active_at: new Date().toISOString(),
            });
          }
          break;
        }
        case 'tool_start':
          streamBuffer.flush();
          conv.addToolStart(sid, frame.turn_index, frame.tool_name ?? 'unknown', frame.tool_input);
          break;
        case 'tool_end':
          conv.addToolEnd(
            sid,
            frame.turn_index,
            frame.tool_name ?? 'unknown',
            frame.output,
            frame.is_error ?? false,
          );
          break;
        case 'todo':
          conv.setTodo(sid, frame.todo_markdown ?? '');
          break;
        case 'approval_request': {
          // full_auto 策略下忽略审批帧（后端自动处理，spec session-approval）；
          // policy 缺失（detail 懒加载未完成，F1.4）时保守按 interactive 处理
          const session = useSessionStore.getState().sessions[sid];
          if (session?.permission_policy !== 'full_auto' && frame.modal) {
            conv.setPendingApproval(sid, frame);
          }
          break;
        }
        case 'busy':
          conv.addSystemMessage(sid, 'warning', '当前有轮次正在执行，请等待完成');
          break;
        case 'error': {
          // F3.3 契约优先：按 code 查准入文案映射，message 原文仅入 console 调试；
          // 命中时打一次性标志，随后的 close 码处理发现已消费则跳过
          const admissionMsg = frame.code ? WS_ADMISSION_MESSAGES[frame.code] : undefined;
          if (admissionMsg) {
            admissionNotified = true;
            console.warn(`[ws] admission error ${frame.code}:`, frame.message);
            conv.addSystemMessage(sid, 'error', admissionMsg);
          } else {
            conv.addSystemMessage(sid, 'error', frame.message);
          }
          break;
        }
        case 'turn_error': {
          streamBuffer.flush();
          conv.addSystemMessage(sid, 'error', frame.message);
          conv.setTurnActive(sid, false);
          // 审批超时优先按结构化 code 判定（A4，后端已下发 code=approval_timeout）；
          // 文案匹配仅作无 code 旧后端的回退，待后端全量升级后可移除
          const approvalTimeout =
            frame.code === 'approval_timeout' ||
            (frame.code === undefined &&
              (frame.message.includes('approval') || frame.message.includes('审批')));
          if (approvalTimeout) {
            conv.setPendingApproval(sid, null);
          }
          break;
        }
        case 'pong':
        case 'event':
          break;
      }
      for (const listener of listenersRef.current) listener(frame);
    };

    const handleStatus: WebSocketClientOptions['onStatus'] = (nextStatus, detail) => {
      useWsStore.getState().setStatus(sid, nextStatus);
      if (detail?.attempt !== undefined) {
        useWsStore.getState().setReconnectAttempt(sid, detail.attempt);
      }
      if (nextStatus === 'auth_failed') {
        useAuthStore.getState().markAuthExpired();
      } else if (nextStatus === 'session_closed') {
        useSessionStore.getState().patchSession(sid, { status: 'closed' });
      } else if (nextStatus === 'session_not_found') {
        useUiStore.getState().showBanner('error', WS_CLOSE_MESSAGES[4404]);
        useSessionStore.getState().removeSession(sid);
      } else if (nextStatus === 'rate_limited') {
        useUiStore.getState().showBanner('warning', '连接已被限流，60 秒后自动重试');
      } else if (nextStatus === 'quota_exceeded') {
        // 4430：不自动重连；error 帧已出提示则去重（F3.2/F3.3）
        if (!admissionNotified) {
          useUiStore.getState().showBanner('warning', WS_ADMISSION_MESSAGES.TENANT_QUOTA_EXCEEDED);
        }
        admissionNotified = false;
      } else if (nextStatus === 'failed' && detail?.closeCode === WS_CLOSE_CODES.CAPACITY_FULL) {
        if (!admissionNotified) {
          useUiStore.getState().showBanner('error', '服务容量已满，多次重试仍失败，请稍后再试');
        }
        admissionNotified = false;
      } else if (nextStatus === 'failed' && detail?.closeCode === WS_CLOSE_CODES.SERVER_ERROR) {
        if (!admissionNotified) {
          useUiStore.getState().showBanner('error', WS_ADMISSION_MESSAGES.SESSION_UNAVAILABLE);
        }
        admissionNotified = false;
      }
    };

    const client = new WebSocketClient({
      sessionId: sid,
      getApiKey: () => useAuthStore.getState().apiKey,
      getLastTurnIndex: () => useWsStore.getState().lastTurnIndex[sid] ?? null,
      onFrame: handleFrame,
      onStatus: handleStatus,
    });
    clientRef.current = client;
    client.connect();

    return () => {
      streamBuffer.dispose();
      client.dispose();
      clientRef.current = null;
      useWsStore.getState().setStatus(sid, 'idle');
    };
  }, [sessionId, apiKey, canConnect]);

  const submit = useCallback(
    (text: string): boolean => {
      if (!sessionId) return false;
      const ok = clientRef.current?.submit(text) ?? false;
      if (ok) {
        const conv = useConversationStore.getState();
        conv.addUserMessage(sessionId, text);
        conv.pushInputHistory(sessionId, text);
      }
      return ok;
    },
    [sessionId],
  );

  const interrupt = useCallback((): boolean => {
    return clientRef.current?.interrupt() ?? false;
  }, []);

  const approve = useCallback(
    (requestId: string, allowed: boolean, reply?: ApprovalReply, answer?: string): boolean => {
      if (!sessionId) return false;
      const ok = clientRef.current?.approve(requestId, allowed, reply, answer) ?? false;
      if (ok) {
        useConversationStore.getState().setPendingApproval(sessionId, null);
      }
      return ok;
    },
    [sessionId],
  );

  const retry = useCallback(() => {
    clientRef.current?.retry();
  }, []);

  const addFrameListener = useCallback((listener: (frame: ServerFrame) => void) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  return useMemo(
    () => ({ status, reconnectAttempt, submit, interrupt, approve, retry, addFrameListener }),
    [status, reconnectAttempt, submit, interrupt, approve, retry, addFrameListener],
  );
}
