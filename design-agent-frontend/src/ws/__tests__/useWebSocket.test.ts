// useWebSocket Hook 集成测试（task 12.5）：mock 全局 WebSocket，
// 验证连接建立、帧分发、断线重连、消息发送、审批流转。

import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from '../useWebSocket';
import { requestSessionListRefresh } from '../../hooks/useSessionList';
import { useAuthStore } from '../../store/authStore';
import { useConversationStore } from '../../store/conversationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useWsStore } from '../../store/wsStore';
import { WS_ADMISSION_MESSAGES } from '../../utils/constants';
import type { Session } from '../../types/session';

// 隔离 session_ready 触发的列表刷新（F3.5），避免测试中发真实 listSessions 请求
vi.mock('../../hooks/useSessionList', () => ({
  requestSessionListRefresh: vi.fn(),
}));

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
  vi.mocked(requestSessionListRefresh).mockClear();
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

  it('resumable=false 不建连（canConnectSession 门控，resumable 优先于 status，F1.5）', () => {
    useSessionStore.getState().patchSession(SID, { status: 'live', resumable: false });
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

  // P0-1：assistant_complete 最终覆盖 envelope（final + full_text）
  it('新后端 final envelope：full_text 整体替换，同文双发不重复', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'Stub reply to: hi', turn_index: 0 });
      ws.serverFrame({
        type: 'delta',
        text: '',
        turn_index: 0,
        final: true,
        full_text: 'Stub reply to: hi',
      });
      ws.serverFrame({ type: 'turn_complete', turn_index: 0 });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({ kind: 'assistant', text: 'Stub reply to: hi', streaming: false });
  });

  it('丢帧后 final envelope 补齐全文（替换而非拼接）', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'Hello ', turn_index: 0 });
      // 中间增量丢失，final 携带权威全文
      ws.serverFrame({
        type: 'delta',
        text: '',
        turn_index: 0,
        final: true,
        full_text: 'Hello brave new world',
      });
      ws.serverFrame({ type: 'turn_complete', turn_index: 0 });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({ kind: 'assistant', text: 'Hello brave new world' });
  });

  it('旧后端 final 无 full_text：维持追加+flush 行为', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'Hel', turn_index: 0 });
      ws.serverFrame({ type: 'delta', text: 'lo', turn_index: 0, final: true });
    });
    // final 触发同步 flush，无需等 50ms 定时
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
  });

  it('turn_complete 带 has_artifact=true 时标记助手消息产物', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'ok', turn_index: 0 });
      ws.serverFrame({ type: 'turn_complete', turn_index: 0, has_artifact: true });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({ kind: 'assistant', streaming: false, hasArtifact: true });
  });

  it('turn_complete 缺失 has_artifact 字段时按 false 处理（旧后端兼容）', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'delta', text: 'ok', turn_index: 0 });
      ws.serverFrame({ type: 'turn_complete', turn_index: 0 });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({ kind: 'assistant', streaming: false, hasArtifact: false });
  });

  it('断线补发的 turn_complete 携带 has_artifact 与 assistant_text 时补建产物消息', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({
        type: 'turn_complete',
        turn_index: 2,
        replayed: true,
        assistant_text: 'replayed reply',
        has_artifact: true,
      });
    });
    const msg = useConversationStore.getState().conversations[SID].messages[0];
    expect(msg).toMatchObject({
      kind: 'assistant',
      text: 'replayed reply',
      turnIndex: 2,
      hasArtifact: true,
    });
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

describe('useWebSocket 准入错误映射（F3.3/F3.5）', () => {
  it('session_ready：非 live 会话 patch→live 并触发列表刷新（让位可视化）', () => {
    useSessionStore.getState().patchSession(SID, { status: 'cold', resumable: true });
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'session_ready' });
    });
    expect(useSessionStore.getState().sessions[SID].status).toBe('live');
    expect(requestSessionListRefresh).toHaveBeenCalledTimes(1);
  });

  it('error 帧 code 命中准入映射：落中文文案而非 message 原文', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({
        type: 'error',
        message: 'tenant quota exceeded: sess-xxx running',
        code: 'TENANT_QUOTA_EXCEEDED',
      });
    });
    const msg = useConversationStore.getState().conversations[SID].messages.at(-1);
    expect(msg).toMatchObject({
      kind: 'system',
      level: 'error',
      text: WS_ADMISSION_MESSAGES.TENANT_QUOTA_EXCEEDED,
    });
    warnSpy.mockRestore();
  });

  it('error 帧无 code 或 code 未知：仍展示 message 原文（回归）', () => {
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({ type: 'error', message: 'plain failure', code: 'UNKNOWN_REASON' });
    });
    const msg = useConversationStore.getState().conversations[SID].messages.at(-1);
    expect(msg).toMatchObject({ kind: 'system', level: 'error', text: 'plain failure' });
  });

  it('同一次准入失败「error 帧 + close 4430」只出一条提示（去重）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderHook(() => useWebSocket(SID));
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.serverOpen();
      ws.serverFrame({
        type: 'error',
        message: 'quota exceeded',
        code: 'TENANT_QUOTA_EXCEEDED',
      });
      ws.serverClose(4430);
    });
    // error 帧已落 system 消息，close 4430 不再叠加 banner
    expect(useUiStore.getState().banner).toBeNull();
    expect(useWsStore.getState().status[SID]).toBe('quota_exceeded');
    warnSpy.mockRestore();
  });

  it('无 error 帧直接 close 4430：出 warning banner 且不重连', () => {
    renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverClose(4430));
    expect(useUiStore.getState().banner).toMatchObject({
      level: 'warning',
      text: WS_ADMISSION_MESSAGES.TENANT_QUOTA_EXCEEDED,
    });
    expect(useWsStore.getState().status[SID]).toBe('quota_exceeded');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('useWebSocket turn_error 分发（A4）', () => {
  /** 先注入待处理审批，再下发 turn_error，返回会话状态。 */
  function emitTurnError(frame: Record<string, unknown>) {
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
      ws.serverFrame({ type: 'turn_error', turn_index: 0, ...frame });
    });
    return useConversationStore.getState().conversations[SID];
  }

  it('code=approval_timeout 时清除待处理审批（不依赖文案）', () => {
    const conv = emitTurnError({ message: 'timeout', code: 'approval_timeout' });
    expect(conv.pendingApproval).toBeNull();
    expect(conv.turnActive).toBe(false);
    expect(conv.messages.at(-1)).toMatchObject({ kind: 'system', level: 'error', text: 'timeout' });
  });

  it('无 code 时按文案匹配回退（旧后端兼容）', () => {
    const conv = emitTurnError({ message: '审批请求超时' });
    expect(conv.pendingApproval).toBeNull();
  });

  it('携带其他 code 时不清除审批（结构化判定优先，不再嗅探文案）', () => {
    const conv = emitTurnError({ message: 'approval unrelated error', code: 'internal_error' });
    expect(conv.pendingApproval?.request_id).toBe('r1');
  });
});

describe('useWebSocket StrictMode 守护（D1）', () => {
  it('StrictMode 双执行 effect 时无双活连接', () => {
    renderHook(() => useWebSocket(SID), { wrapper: StrictMode });
    // StrictMode 下 effect 执行两次：首个连接必须已被清理关闭
    const live = MockWebSocket.instances.filter((ws) => ws.readyState !== MockWebSocket.CLOSED);
    expect(live).toHaveLength(1);
    act(() => {
      live[0].serverOpen();
      live[0].serverFrame({ type: 'session_ready' });
    });
    expect(useWsStore.getState().status[SID]).toBe('ready');
  });

  it('mount→unmount→mount：旧连接关闭，仅新连接存活', () => {
    const first = renderHook(() => useWebSocket(SID));
    act(() => MockWebSocket.instances[0].serverOpen());
    first.unmount();
    expect(useWsStore.getState().status[SID]).toBe('idle');

    const { result } = renderHook(() => useWebSocket(SID));
    const live = MockWebSocket.instances.filter((ws) => ws.readyState !== MockWebSocket.CLOSED);
    expect(live).toHaveLength(1);
    act(() => {
      live[0].serverOpen();
      live[0].serverFrame({ type: 'session_ready' });
    });
    expect(result.current.status).toBe('ready');
  });
});
