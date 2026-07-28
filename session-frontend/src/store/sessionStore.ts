// 会话列表状态（design D8）：后端暂无列表 API，
// 本地 localStorage 缓存会话 ID 列表，启动时逐个 GET 恢复详情。

import { create } from 'zustand';
import type { Session } from '../types/session';
import { STORAGE_KEYS } from '../utils/constants';
import { useConversationStore } from './conversationStore';
import { useWsStore } from './wsStore';

interface SessionState {
  /** session_id -> Session */
  sessions: Record<string, Session>;
  /** 展示顺序（新会话在前）。 */
  order: string[];
  currentId: string | null;
  /** 启动恢复（批量 GET）进行中。 */
  loading: boolean;
  addSession: (session: Session) => void;
  updateSession: (session: Session) => void;
  patchSession: (sid: string, patch: Partial<Session>) => void;
  removeSession: (sid: string) => void;
  selectSession: (sid: string | null) => void;
  setLoading: (loading: boolean) => void;
  /** 清空全部（清除 API Key 时用）。 */
  reset: () => void;
}

export function loadCachedSessionIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessionIds);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function persistSessionIds(order: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.sessionIds, JSON.stringify(order));
  } catch {
    // ignore
  }
}

/** 从 localStorage 缓存即时剔除已失效（404）的会话 ID（A10）。 */
export function pruneCachedSessionIds(staleIds: string[]): void {
  if (staleIds.length === 0) return;
  persistSessionIds(loadCachedSessionIds().filter((id) => !staleIds.includes(id)));
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: {},
  order: [],
  currentId: null,
  loading: false,
  addSession: (session) =>
    set((state) => {
      const sid = session.session_id;
      const order = [sid, ...state.order.filter((id) => id !== sid)];
      persistSessionIds(order);
      return { sessions: { ...state.sessions, [sid]: session }, order };
    }),
  updateSession: (session) =>
    set((state) => {
      const sid = session.session_id;
      if (!state.order.includes(sid)) {
        const order = [...state.order, sid];
        persistSessionIds(order);
        return { sessions: { ...state.sessions, [sid]: session }, order };
      }
      return { sessions: { ...state.sessions, [sid]: session } };
    }),
  patchSession: (sid, patch) =>
    set((state) => {
      const existing = state.sessions[sid];
      if (!existing) return state;
      return { sessions: { ...state.sessions, [sid]: { ...existing, ...patch } } };
    }),
  removeSession: (sid) => {
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sid];
      const order = state.order.filter((id) => id !== sid);
      persistSessionIds(order);
      return {
        sessions,
        order,
        currentId: state.currentId === sid ? null : state.currentId,
      };
    });
    // 级联清理对话与 WS 残留状态，避免删除后内存泄漏（A9）
    useConversationStore.getState().removeConversation(sid);
    useWsStore.getState().clear(sid);
  },
  selectSession: (sid) => set({ currentId: sid }),
  setLoading: (loading) => set({ loading }),
  reset: () => {
    persistSessionIds([]);
    set({ sessions: {}, order: [], currentId: null, loading: false });
  },
}));
