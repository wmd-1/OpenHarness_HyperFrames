// useTurnHistory 单测（F2.1/F2.2/F2.4）：触发判定（跳过场景）、一页拉全 + while 续拉兜底、
// 失败重试、①hydrateHistory → ②setLastTurnIndex 的显式顺序断言。

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTurnHistory } from '../useTurnHistory';
import { listTurns } from '../../api/sessions';
import { useConversationStore } from '../../store/conversationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useWsStore } from '../../store/wsStore';
import type { TurnResponse } from '../../types/api';
import type { Session } from '../../types/session';

vi.mock('../../api/sessions', () => ({
  listTurns: vi.fn(),
}));

const SID = 's1';

const makeSession = (patch: Partial<Session> = {}): Session => ({
  session_id: SID,
  status: 'live',
  permission_policy: 'interactive',
  turn_count: 2,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
  ...patch,
});

const makeTurn = (turnIndex: number, patch: Partial<TurnResponse> = {}): TurnResponse => ({
  turn_id: `t${turnIndex}`,
  turn_index: turnIndex,
  status: 'completed',
  prompt: `prompt-${turnIndex}`,
  assistant_text: `answer-${turnIndex}`,
  error_message: null,
  started_at: '2026-01-01T00:00:00Z',
  finished_at: '2026-01-01T00:00:10Z',
  ...patch,
});

function setupSession(patch: Partial<Session> = {}) {
  useSessionStore.setState({
    sessions: { [SID]: makeSession(patch) },
    order: [SID],
    currentId: SID,
  });
}

beforeEach(() => {
  useSessionStore.setState({ sessions: {}, order: [], currentId: null });
  useConversationStore.setState({ conversations: {} });
  useWsStore.setState({ status: {}, lastMessageAt: {}, reconnectAttempt: {}, lastTurnIndex: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTurnHistory 触发判定（F2.1）', () => {
  it('sessionId 为 null：不拉取，hydrated=false（无会话不放行建连）', () => {
    const { result } = renderHook(() => useTurnHistory(null));
    expect(listTurns).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(false);
  });

  it('turn_count=0（新会话）：跳过拉取，hydrated=true 直接放行', () => {
    setupSession({ turn_count: 0 });
    const { result } = renderHook(() => useTurnHistory(SID));
    expect(listTurns).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(true);
  });

  it('本地已有消息：跳过拉取（进行中的会话不覆盖）', () => {
    setupSession();
    useConversationStore.getState().addUserMessage(SID, 'hello');
    const { result } = renderHook(() => useTurnHistory(SID));
    expect(listTurns).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(true);
  });

  it('已 hydrate 过（hydratedAt 非空）：切走切回不重复拉取', () => {
    setupSession();
    useConversationStore.getState().hydrateHistory(SID, []);
    const { result } = renderHook(() => useTurnHistory(SID));
    expect(listTurns).not.toHaveBeenCalled();
    expect(result.current.hydrated).toBe(true);
  });
});

describe('useTurnHistory 拉取与三步串行（F2.2/F2.4）', () => {
  it('一页拉全：after_index=-1 起拉，①hydrateHistory 后②setLastTurnIndex（顺序显式断言）', async () => {
    setupSession();
    vi.mocked(listTurns).mockResolvedValue({
      items: [makeTurn(0), makeTurn(1)],
      total: 2,
    });
    // 记录 ①② 调用顺序（用 setState 替换动作，避免 spy 泄漏到后续用例）
    const calls: string[] = [];
    const origHydrate = useConversationStore.getState().hydrateHistory;
    const origSetIndex = useWsStore.getState().setLastTurnIndex;
    useConversationStore.setState({
      hydrateHistory: (sid, turns) => {
        calls.push('hydrateHistory');
        origHydrate(sid, turns);
      },
    });
    useWsStore.setState({
      setLastTurnIndex: (sid, turnIndex) => {
        calls.push('setLastTurnIndex');
        origSetIndex(sid, turnIndex);
      },
    });

    const { result } = renderHook(() => useTurnHistory(SID));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // 还原动作，防止污染后续用例
    useConversationStore.setState({ hydrateHistory: origHydrate });
    useWsStore.setState({ setLastTurnIndex: origSetIndex });

    expect(listTurns).toHaveBeenCalledTimes(1);
    expect(listTurns).toHaveBeenCalledWith(SID, { after_index: -1, limit: 200 });
    // F2.4 强约束：先整体替换历史，再写 WS 补发基准
    expect(calls).toEqual(['hydrateHistory', 'setLastTurnIndex']);
    expect(useWsStore.getState().lastTurnIndex[SID]).toBe(1);
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.hydratedAt).not.toBeNull();
    // 2 轮 × (user + assistant)
    expect(conv.messages).toHaveLength(4);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('while 续拉兜底：items.length < total 时按最后一条 turn_index 续拉', async () => {
    setupSession({ turn_count: 3 });
    vi.mocked(listTurns)
      .mockResolvedValueOnce({ items: [makeTurn(0), makeTurn(1)], total: 3 })
      .mockResolvedValueOnce({ items: [makeTurn(2)], total: 3 });

    const { result } = renderHook(() => useTurnHistory(SID));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(listTurns).toHaveBeenCalledTimes(2);
    expect(listTurns).toHaveBeenNthCalledWith(1, SID, { after_index: -1, limit: 200 });
    expect(listTurns).toHaveBeenNthCalledWith(2, SID, { after_index: 1, limit: 200 });
    expect(useWsStore.getState().lastTurnIndex[SID]).toBe(2);
    expect(useConversationStore.getState().conversations[SID].messages).toHaveLength(6);
  });

  it('total>0 但返回空页：break 兜底不死循环，空历史也打 hydratedAt 标记', async () => {
    setupSession({ turn_count: 1 });
    vi.mocked(listTurns).mockResolvedValue({ items: [], total: 1 });

    const { result } = renderHook(() => useTurnHistory(SID));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(listTurns).toHaveBeenCalledTimes(1);
    // 无轮次时不写补发基准
    expect(useWsStore.getState().lastTurnIndex[SID]).toBeUndefined();
    expect(useConversationStore.getState().conversations[SID].hydratedAt).not.toBeNull();
  });

  it('拉取失败：error 落地不放行建连，retry 重拉成功后 hydrated=true', async () => {
    setupSession();
    vi.mocked(listTurns)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ items: [makeTurn(0)], total: 1 });

    const { result } = renderHook(() => useTurnHistory(SID));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // 失败时不放行建连、不写基准
    expect(result.current.hydrated).toBe(false);
    expect(useWsStore.getState().lastTurnIndex[SID]).toBeUndefined();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.error).toBeNull();
    expect(useWsStore.getState().lastTurnIndex[SID]).toBe(0);
  });
});
