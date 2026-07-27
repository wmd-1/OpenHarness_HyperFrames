// WS 连接状态：连接状态机、最后消息时间、重连次数、last_turn_index。

import { create } from 'zustand';
import type { WsStatus } from '../types/ws';

interface WsState {
  /** session_id -> 连接状态 */
  status: Record<string, WsStatus>;
  lastMessageAt: Record<string, number>;
  reconnectAttempt: Record<string, number>;
  /** 断线重连补发用：每个会话已收到的最大 turn_index。 */
  lastTurnIndex: Record<string, number>;
  setStatus: (sid: string, status: WsStatus) => void;
  markMessage: (sid: string) => void;
  setReconnectAttempt: (sid: string, attempt: number) => void;
  setLastTurnIndex: (sid: string, turnIndex: number) => void;
  clear: (sid: string) => void;
}

export const useWsStore = create<WsState>((set) => ({
  status: {},
  lastMessageAt: {},
  reconnectAttempt: {},
  lastTurnIndex: {},
  setStatus: (sid, status) =>
    set((state) => ({ status: { ...state.status, [sid]: status } })),
  markMessage: (sid) =>
    set((state) => ({ lastMessageAt: { ...state.lastMessageAt, [sid]: Date.now() } })),
  setReconnectAttempt: (sid, attempt) =>
    set((state) => ({ reconnectAttempt: { ...state.reconnectAttempt, [sid]: attempt } })),
  setLastTurnIndex: (sid, turnIndex) =>
    set((state) => {
      const prev = state.lastTurnIndex[sid];
      if (prev !== undefined && prev >= turnIndex) return state;
      return { lastTurnIndex: { ...state.lastTurnIndex, [sid]: turnIndex } };
    }),
  clear: (sid) =>
    set((state) => {
      const omit = <T>(record: Record<string, T>): Record<string, T> => {
        const next = { ...record };
        delete next[sid];
        return next;
      };
      return {
        status: omit(state.status),
        lastMessageAt: omit(state.lastMessageAt),
        reconnectAttempt: omit(state.reconnectAttempt),
        lastTurnIndex: omit(state.lastTurnIndex),
      };
    }),
}));
