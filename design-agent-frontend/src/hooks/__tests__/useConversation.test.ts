// useConversation REST 兜底测试（task 4.6 F2）：WS 不可用时经
// submitTurnRest 提交，成功落地助手消息并同步补发基准（A6），
// 失败时结束轮次并写入错误消息。

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation } from '../useConversation';
import { submitTurnRest } from '../../api/sessions';
import { useConversationStore } from '../../store/conversationStore';
import { useWsStore } from '../../store/wsStore';
import { useWebSocket } from '../../ws/useWebSocket';
import type { UseWebSocketResult } from '../../ws/useWebSocket';
import type { TurnResponse } from '../../types/api';

vi.mock('../../ws/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('../../api/sessions', () => ({ submitTurnRest: vi.fn() }));

const SID = 's1';
const mockedUseWebSocket = vi.mocked(useWebSocket);
const mockedSubmitTurnRest = vi.mocked(submitTurnRest);

/** WS 桩：submit 可控（false 触发 REST 兜底）。 */
function stubWs(submitResult: boolean): UseWebSocketResult {
  return {
    status: submitResult ? 'ready' : 'idle',
    reconnectAttempt: 0,
    submit: vi.fn(() => submitResult),
    interrupt: vi.fn(() => true),
    approve: vi.fn(() => true),
    retry: vi.fn(),
    addFrameListener: vi.fn(() => () => undefined),
  };
}

function turnResponse(overrides: Partial<TurnResponse> = {}): TurnResponse {
  return {
    turn_id: 't1',
    turn_index: 3,
    status: 'completed',
    prompt: 'hello',
    assistant_text: 'world',
    error_message: null,
    has_artifact: false,
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:00:01Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ conversations: {} });
  useWsStore.setState({ status: {}, lastMessageAt: {}, reconnectAttempt: {}, lastTurnIndex: {} });
});

describe('useConversation REST 兜底', () => {
  it('WS 就绪时直接走 WS，不调用 REST', () => {
    const ws = stubWs(true);
    mockedUseWebSocket.mockReturnValue(ws);
    const { result } = renderHook(() => useConversation(SID));
    let ok = false;
    act(() => {
      ok = result.current.submit('hello');
    });
    expect(ok).toBe(true);
    expect(ws.submit).toHaveBeenCalledWith('hello');
    expect(mockedSubmitTurnRest).not.toHaveBeenCalled();
  });

  it('WS 不可用时 REST 提交：成功后落地助手消息并同步 lastTurnIndex', async () => {
    mockedUseWebSocket.mockReturnValue(stubWs(false));
    mockedSubmitTurnRest.mockResolvedValue(turnResponse({ has_artifact: true }));
    const { result } = renderHook(() => useConversation(SID));
    act(() => {
      expect(result.current.submit('hello')).toBe(true);
    });
    // 乐观记录用户消息 + 输入历史
    const before = useConversationStore.getState().conversations[SID];
    expect(before.messages[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(before.inputHistory).toEqual(['hello']);
    expect(mockedSubmitTurnRest).toHaveBeenCalledWith(SID, 'hello');

    await waitFor(() => {
      const conv = useConversationStore.getState().conversations[SID];
      expect(conv.turnActive).toBe(false);
    });
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages[1]).toMatchObject({
      kind: 'assistant',
      text: 'world',
      turnIndex: 3,
      streaming: false,
      hasArtifact: true,
    });
    // 同步补发基准，避免 WS 重连重复补发该轮次（A6）
    expect(useWsStore.getState().lastTurnIndex[SID]).toBe(3);
  });

  it('REST 提交失败：结束轮次并写入错误系统消息', async () => {
    mockedUseWebSocket.mockReturnValue(stubWs(false));
    mockedSubmitTurnRest.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useConversation(SID));
    act(() => {
      expect(result.current.submit('hello')).toBe(true);
    });
    await waitFor(() => {
      const conv = useConversationStore.getState().conversations[SID];
      expect(conv.turnActive).toBe(false);
    });
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages.at(-1)).toMatchObject({
      kind: 'system',
      level: 'error',
      text: 'network down',
    });
  });

  it('REST 兜底遇 409（会话未在本节点 live）：明确提示会话未激活（F3.6）', async () => {
    mockedUseWebSocket.mockReturnValue(stubWs(false));
    mockedSubmitTurnRest.mockRejectedValue({
      response: new Response(JSON.stringify({ detail: 'Session not live on this node' }), {
        status: 409,
      }),
    });
    const { result } = renderHook(() => useConversation(SID));
    act(() => {
      expect(result.current.submit('hello')).toBe(true);
    });
    await waitFor(() => {
      const conv = useConversationStore.getState().conversations[SID];
      expect(conv.turnActive).toBe(false);
    });
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages.at(-1)).toMatchObject({
      kind: 'system',
      level: 'error',
      text: '会话未激活，请等待 WS 连接就绪后重试',
    });
  });

  it('清理后为空的输入不提交', () => {
    const ws = stubWs(true);
    mockedUseWebSocket.mockReturnValue(ws);
    const { result } = renderHook(() => useConversation(SID));
    let ok = true;
    act(() => {
      ok = result.current.submit('   \x07  ');
    });
    expect(ok).toBe(false);
    expect(ws.submit).not.toHaveBeenCalled();
    expect(mockedSubmitTurnRest).not.toHaveBeenCalled();
  });
});
