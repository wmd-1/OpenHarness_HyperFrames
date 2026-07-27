// useWebSocket Hook 集成测试（task 12.5）：mock 全局 WebSocket，
// 验证连接建立、帧分发、断线重连、消息发送、审批流转。

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from '../useWebSocket';
import { useAuthStore } from '../../store/authStore';
import { useConversationStore } from '../../store/conversationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useWsStore } from '../../store/wsStore';
import type { Session } from '../../types/session';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // ---- 测试辅助：模拟服务端行为 ----
  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverFrame(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

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
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.instances = [];
  localStorage.clear();
  useAuthStore.setState({ apiKey: 'test-key', authExpired: false });
  useSessionStore.setState({
    sessions: { [SID]: { ...liveSession } },
    order: [SID],
    currentId: SID,
    loading: false,
  });
  useConversationStore.setState({ conversations: {} });
  useWsStore.setState({ status: {}, lastMessageAt: {}, reconnectAttempt: {}, lastTurnIndex: {} });
  useUiStore.setState({ banner: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWebSocket 连接生命周期', () => {
  it('建连 URL 携带 api_key 与 last_turn_index', () => {
    useWsStore.getState().setLastTurnIndex(SID, 4);
    renderHook(() => useWebSocket(SID));
    expect(MockWebSocket.instances).toHaveLength(1);
    const url = new URL(MockWebSocket.instances[0].url);
    expect(url.pathname).toBe(`/v1/sessions/${SID}/ws`);
    expect(url.searchParams.get('api_key')).toBe('test-key');
    expect(url.searchParams.get('last_turn_index')).toBe('4');
  });

  it('终态会话不建连', () => {
    useSessionStore.getState().patchSession(SID, { status: 'closed' });
    renderHook(() => useWebSocket(SID));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('无 apiKey 不建连', () => {
    useAuthStore.setState({ apiKey: null });
    renderHook(() => useWebSocket(SID));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('session_ready 帧上报 ready 状态', () => {
    const { result } = renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'session_ready' });
    });
    expect(result.current.status).toBe('ready');
    expect(useWsStore.getState().status[SID]).toBe('ready');
  });

  it('卸载后状态归 idle', () => {
    const { unmount } = renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverOpen());
    unmount();
    expect(useWsStore.getState().status[SID]).toBe('idle');
  });
});

describe('useWebSocket 帧分发', () => {
  it('delta 批量缓冲，turn_complete 同步 flush 并推进轮次', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'Hel', turn_index: 0 });
      ws.serverFrame({ type: 'delta', text: 'lo', turn_index: 0 });
    });
    // 50ms flush 定时未到，消息尚未落地
    expect(useConversationStore.getState().conversations[SID]?.messages ?? []).toHaveLength(0);
    act(() => {
      ws.serverFrame({ type: 'turn_complete', turn_index: 0 });
    });
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: false });
    expect(useWsStore.getState().lastTurnIndex[SID]).toBe(0);
    expect(useSessionStore.getState().sessions[SID].turn_count).toBe(1);
  });

  it('tool_start / tool_end 生成工具卡片', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'tool_start', tool_name: 'bash', tool_input: null, turn_index: 0 });
      ws.serverFrame({
        type: 'tool_end',
        tool_name: 'bash',
        output: 'ok',
        is_error: false,
        turn_index: 0,
      });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    if (msg.kind !== 'tool') throw new Error('expected tool message');
    expect(msg.toolCall).toMatchObject({ status: 'success', output: 'ok' });
  });

  it('interactive 策略接收审批帧，approve 后清除并发送回复', () => {
    const { result } = renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({
        type: 'approval_request',
        request_id: 'r1',
        modal: { kind: 'permission' },
        turn_index: 0,
      });
    });
    expect(
      useConversationStore.getState().conversations[SID].pendingApproval?.request_id,
    ).toBe('r1');
    act(() => {
      expect(result.current.approve('r1', true, 'once')).toBe(true);
    });
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      op: 'approval',
      request_id: 'r1',
      allowed: true,
      reply: 'once',
    });
    expect(useConversationStore.getState().conversations[SID].pendingApproval).toBeNull();
  });

  it('full_auto 策略忽略审批帧', () => {
    useSessionStore.getState().patchSession(SID, { permission_policy: 'full_auto' });
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({
        type: 'approval_request',
        request_id: 'r1',
        modal: { kind: 'permission' },
        turn_index: 0,
      });
    });
    expect(
      useConversationStore.getState().conversations[SID]?.pendingApproval ?? null,
    ).toBeNull();
  });
});

describe('useWebSocket 消息发送', () => {
  it('submit 未打开时返回 false 且不记录消息', () => {
    const { result } = renderHook(() => useWebSocket(SID));
    let ok = true;
    act(() => {
      ok = result.current.submit('hi');
    });
    expect(ok).toBe(false);
    expect(useConversationStore.getState().conversations[SID]?.messages ?? []).toHaveLength(0);
  });

  it('submit 打开后发送帧 + 记录用户消息与输入历史', () => {
    const { result } = renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => ws.serverOpen());
    act(() => {
      expect(result.current.submit('hi')).toBe(true);
    });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ op: 'submit', text: 'hi' });
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages[0]).toMatchObject({ kind: 'user', text: 'hi' });
    expect(conv.inputHistory).toEqual(['hi']);
  });
});

describe('useWebSocket 关闭码与重连', () => {
  it('4401 标记认证过期且不重连', () => {
    renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverClose(4401));
    expect(useAuthStore.getState()).toMatchObject({ apiKey: null, authExpired: true });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('4403 同步会话状态为 closed 且不重连', () => {
    renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverClose(4403));
    expect(useSessionStore.getState().sessions[SID].status).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('4404 移除会话并展示错误横幅', () => {
    renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverClose(4404));
    expect(useSessionStore.getState().sessions[SID]).toBeUndefined();
    expect(useUiStore.getState().banner?.level).toBe('error');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('1006 异常断开：1s 指数退避后重建连接', () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverClose(1006));
    expect(useWsStore.getState().status[SID]).toBe('reconnecting');
    expect(useWsStore.getState().reconnectAttempt[SID]).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
