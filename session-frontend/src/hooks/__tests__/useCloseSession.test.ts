// useCloseSession 单测（task 3.5 A5）：确认后乐观置 closed，
// DELETE 失败回滚原状态并弹错误横幅；取消不触发请求。

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCloseSession } from '../useCloseSession';
import { closeSession } from '../../api/sessions';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';

vi.mock('../../api/sessions', () => ({
  closeSession: vi.fn(),
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
  it('requestClose 打开确认，confirmClose 后乐观置 closed 并调用 DELETE', async () => {
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
    expect(useSessionStore.getState().sessions[SID].status).toBe('closed');
    expect(useUiStore.getState().banner).toBeNull();
  });

  it('DELETE 失败：回滚原状态并弹错误横幅（不再吞错）', async () => {
    vi.mocked(closeSession).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useCloseSession());

    act(() => result.current.requestClose(SID));
    await act(async () => result.current.confirmClose());

    expect(useSessionStore.getState().sessions[SID].status).toBe('live');
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
