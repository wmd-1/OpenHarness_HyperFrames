// 会话列表状态：服务端权威列表（GET /v1/sessions 分页）+ summary ∪ detail 合并模型。
// merge 为 patch 语义（新数据字段覆盖、未返回字段保留），杜绝 summary 刷新
// 冲掉 permission_policy 等 detail 独有字段（F1.1）；localStorage 只持久化选中项（F1.7）。

import { create } from 'zustand';
import type { SessionSummary } from '../types/api';
import type { Session } from '../types/session';
import { STORAGE_KEYS } from '../utils/constants';
import { useConversationStore } from './conversationStore';
import { useWsStore } from './wsStore';

interface SessionState {
  /** session_id -> Session（summary ∪ detail 合并实体） */
  sessions: Record<string, Session>;
  /** 展示顺序（服务端 created_at 倒序 + 本地新建在前）。 */
  order: string[];
  currentId: string | null;
  /** 列表首屏拉取进行中。 */
  loading: boolean;
  /** 加载更多（下一页）进行中。 */
  loadingMore: boolean;
  /** 服务端过滤条件下的总条数（分页用）。 */
  total: number;
  /** 已加载条数（下一页 offset）。 */
  offset: number;
  hasMore: boolean;
  addSession: (session: Session) => void;
  /** patch 合并单个会话（新字段覆盖、未返回字段保留）；不存在则追加。 */
  updateSession: (session: Session) => void;
  patchSession: (sid: string, patch: Partial<Session>) => void;
  /**
   * 应用列表分页响应（F1.2）：
   * - replace（刷新/首屏）：第一页顺序为准，已加载的其余会话保序拼后；
   * - append（加载更多）：新增 ID 追加到尾部保序。
   */
  applyListPage: (
    items: SessionSummary[],
    meta: { total: number; offset: number },
    mode: 'replace' | 'append',
  ) => void;
  /** 仅限会话已不存在（4404）场景：移除并级联清理对话/WS 状态。 */
  removeSession: (sid: string) => void;
  selectSession: (sid: string | null) => void;
  setLoading: (loading: boolean) => void;
  setLoadingMore: (loading: boolean) => void;
  /** 清空全部（清除 API Key 时用）。 */
  reset: () => void;
}

/** 启动时恢复持久化的选中会话 ID（F1.7）。 */
export function loadPersistedCurrentId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.currentSessionId);
  } catch {
    return null;
  }
}

function persistCurrentId(sid: string | null): void {
  try {
    if (sid) localStorage.setItem(STORAGE_KEYS.currentSessionId, sid);
    else localStorage.removeItem(STORAGE_KEYS.currentSessionId);
  } catch {
    // ignore
  }
}

/** patch 合并：undefined 字段不覆盖已有值（summary 刷新不丢 detail 字段）。 */
function mergeSession(existing: Session | undefined, incoming: Partial<Session>): Session {
  const base: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) base[key] = value;
  }
  return base as unknown as Session;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: {},
  order: [],
  currentId: null,
  loading: false,
  loadingMore: false,
  total: 0,
  offset: 0,
  hasMore: false,
  addSession: (session) =>
    set((state) => {
      const sid = session.session_id;
      return {
        sessions: { ...state.sessions, [sid]: mergeSession(state.sessions[sid], session) },
        order: [sid, ...state.order.filter((id) => id !== sid)],
      };
    }),
  updateSession: (session) =>
    set((state) => {
      const sid = session.session_id;
      const sessions = {
        ...state.sessions,
        [sid]: mergeSession(state.sessions[sid], session),
      };
      if (!state.order.includes(sid)) {
        return { sessions, order: [...state.order, sid] };
      }
      return { sessions };
    }),
  patchSession: (sid, patch) =>
    set((state) => {
      const existing = state.sessions[sid];
      if (!existing) return state;
      return { sessions: { ...state.sessions, [sid]: mergeSession(existing, patch) } };
    }),
  applyListPage: (items, meta, mode) =>
    set((state) => {
      const sessions = { ...state.sessions };
      for (const summary of items) {
        sessions[summary.session_id] = mergeSession(sessions[summary.session_id], summary);
      }
      const pageIds = items.map((s) => s.session_id);
      const order =
        mode === 'replace'
          ? [...pageIds, ...state.order.filter((id) => !pageIds.includes(id))]
          : [...state.order, ...pageIds.filter((id) => !state.order.includes(id))];
      const offset = mode === 'replace' ? items.length : meta.offset + items.length;
      return {
        sessions,
        order,
        total: meta.total,
        offset,
        hasMore: offset < meta.total,
      };
    }),
  removeSession: (sid) => {
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sid];
      const currentId = state.currentId === sid ? null : state.currentId;
      if (currentId !== state.currentId) persistCurrentId(currentId);
      return {
        sessions,
        order: state.order.filter((id) => id !== sid),
        currentId,
      };
    });
    // 级联清理对话与 WS 残留状态，避免删除后内存泄漏（A9）
    useConversationStore.getState().removeConversation(sid);
    useWsStore.getState().clear(sid);
  },
  selectSession: (sid) => {
    persistCurrentId(sid);
    set({ currentId: sid });
  },
  setLoading: (loading) => set({ loading }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),
  reset: () => {
    persistCurrentId(null);
    set({
      sessions: {},
      order: [],
      currentId: null,
      loading: false,
      loadingMore: false,
      total: 0,
      offset: 0,
      hasMore: false,
    });
  },
}));
