// useCloseSession 单测（F1.8）：确认后乐观置 closed，成功后 patch 只读态保留在列表并触发列表刷新；
// DELETE 失败回滚原状态并弹错误横幅；取消不触发请求。

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCloseSession } from '../useCloseSession';
import { closeSession } from '../../api/sessions';
import { requestSessionListRefresh } from '../useSessionList';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';

vi.mock('../../api/sessions', () => ({
  closeSession: vi.fn(),
}));

// 隔离列表刷新副作用（避免真实 listSessions 请求）
vi.mock('../useSessionList', () => ({
  requestSessionListRefresh: vi.fn(),
}));

const SID = 's1';

const liveSession: Session = {
  session_id: SID,
  status: 'live',
  permission_policy: 'interactive',
  turn_count: 0,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
};

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({
    sessions: { [SID]: { ...liveSession } },
    order: [SID],
    currentId: SID,
    loading: false,
  });
  useUiStore.setState({ banner: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCloseSession', () => {
  it('requestClose 打开确认，confirmClose 后关闭成功 patch 只读态并保留在列表（F1.8）', async () => {
    vi.mocked(closeSession).mockResolvedValue(undefined as never);
    const { result } = renderHook(() => useCloseSession());

    act(() => result.current.requestClose(SID));
    expect(result.current.pendingSid).toBe(SID);
    // 仅请求确认，尚未真正关闭
    expect(closeSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SID].status).toBe('live');

    await act(async () => result.current.confirmClose());
    expect(result.current.pendingSid).toBeNull();
    expect(closeSession).toHaveBeenCalledWith(SID);
    // 保留在列表中只读回看，不 removeSession
    const state = useSessionStore.getState();
    expect(state.order).toContain(SID);
    expect(state.sessions[SID]).toMatchObject({
      status: 'closed',
      read_only: true,
      resumable: false,
    });
    // 刷新触发③：关闭成功后同步服务端列表
    expect(requestSessionListRefresh).toHaveBeenCalled();
    expect(useUiStore.getState().banner).toBeNull();
  });

  it('DELETE 失败：回滚原状态并弹错误横幅（不再吞错）', async () => {
    vi.mocked(closeSession).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useCloseSession());

    act(() => result.current.requestClose(SID));
    await act(async () => result.current.confirmClose());

    expect(useSessionStore.getState().sessions[SID].status).toBe('live');
    expect(requestSessionListRefresh).not.toHaveBeenCalled();
    expect(useUiStore.getState().banner).toEqual({
      level: 'error',
      text: '关闭会话失败，请重试',
      closable: true,
    });
  });

  it('cancelClose 关闭确认框且不发请求', () => {
    const { result } = renderHook(() => useCloseSession());

    act(() => result.current.requestClose(SID));
    act(() => result.current.cancelClose());

    expect(result.current.pendingSid).toBeNull();
    expect(closeSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SID].status).toBe('live');
  });
});
