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
  BACKEND_FAILURE_CODES,
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

  constructor(
    private readonly onFlush: (turnIndex: number, text: string) => void,
    private readonly onReplace: (turnIndex: number, text: string) => void,
  ) {}

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

  /**
   * assistant_complete 最终覆盖（P0-1）：丢弃本轮未 flush 的增量（已被
   * 全文超集覆盖），用权威全文整体替换该轮次的助手文本。
   */
  replace(turnIndex: number, text: string): void {
    if (this.turnIndex !== -1 && this.turnIndex !== turnIndex) {
      // 缓冲里是其他轮次的增量：先正常 flush，不能丢
      this.flush();
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.buf = '';
    this.turnIndex = -1;
    this.onReplace(turnIndex, text);
  }

  dispose(): void {
    this.flush();
  }
}

export interface UseWebSocketResult {
  status: WsStatus;
  reconnectAttempt: number;
  /** 自动重连进行中（BFCache 唤醒或网络抖动），UI 应隐藏「手动重试」按钮（Change3）。 */
  reconnecting: boolean;
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
  // Change3：标记是否处于「重连中」，用于 recovered toast 的判定（仅真正恢复时提示）。
  const wasReconnectingRef = useRef(false);

  useEffect(() => {
    if (!sessionId || !apiKey || !canConnect) return;
    const sid = sessionId;
    // 注意：store 动作统一 getState() 现取现用，不在 effect 顶部快照（D6）

    // 同一次准入失败「error 帧 + close 码」只出一条提示（以 error 帧为准，F3.3）
    let admissionNotified = false;

    const streamBuffer = new StreamBuffer(
      (turnIndex, text) => {
        useConversationStore.getState().appendAssistantText(sid, turnIndex, text);
      },
      (turnIndex, text) => {
        useConversationStore.getState().replaceAssistantText(sid, turnIndex, text);
      },
    );

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
          if (frame.final && frame.full_text != null) {
            // 新后端 final envelope：权威全文整体替换（抗丢帧/零重复）
            streamBuffer.replace(frame.turn_index, frame.full_text);
          } else {
            streamBuffer.push(frame.turn_index, frame.text);
            if (frame.final) streamBuffer.flush(); // 旧后端兼容：final 仅触发 flush
          }
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
          // 提交被后端拒绝（上一轮 turn_task 尚未收尾）：回滚 submit 时的乐观
          // turnActive，否则输入区会永久停留在「轮次执行中」，只能刷新页面恢复。
          conv.setTurnActive(sid, false);
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
          } else if (frame.code && BACKEND_FAILURE_CODES.has(frame.code)) {
            // 后端业务错误码（BACKEND_START_FAILED / RECOVERY_FAILED）：展示 code + message，
            // 并上抛到 toast（Change3：error 状态 → UI toast 接线）。
            const text = `${frame.code}${frame.message ? `：${frame.message}` : ''}`;
            conv.addSystemMessage(sid, 'error', text);
            useUiStore.getState().showToast({
              id: 'ws-backend-error',
              level: 'error',
              message: `后端错误：${frame.code}`,
              detail: frame.message,
              sticky: true,
            });
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

      // Change3：连接状态 → 瞬时 toast 接线（reconnecting / recovered）。
      if (nextStatus === 'reconnecting') {
        wasReconnectingRef.current = true;
        useUiStore.getState().showToast({
          id: 'ws-reconnect',
          level: 'info',
          message: '连接中断，正在重新连接…',
          spinner: true,
          sticky: true,
        });
      } else if (nextStatus === 'ready') {
        if (wasReconnectingRef.current) {
          wasReconnectingRef.current = false;
          useUiStore.getState().dismissToast('ws-reconnect');
          useUiStore.getState().showToast({
            id: 'ws-recovered',
            level: 'success',
            message: '连接已恢复',
            duration: 3000,
          });
        }
      } else if (nextStatus === 'failed') {
        // 重连耗尽：清掉进行中的重连 toast（后端错误码已由 error 帧单独提示）。
        useUiStore.getState().dismissToast('ws-reconnect');
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
    () => ({
      status,
      reconnectAttempt,
      reconnecting: status === 'reconnecting' || status === 'connecting',
      submit,
      interrupt,
      approve,
      retry,
      addFrameListener,
    }),
    [status, reconnectAttempt, submit, interrupt, approve, retry, addFrameListener],
  );
}
