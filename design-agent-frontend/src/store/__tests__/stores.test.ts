// store 单元测试（task 12.4）：sessionStore / conversationStore / uiStore /
// wsStore / authStore 的状态变更逻辑。

import { beforeEach, describe, expect, it } from 'vitest';
import { loadPersistedCurrentId, useSessionStore } from '../sessionStore';
import { useConversationStore } from '../conversationStore';
import { useUiStore } from '../uiStore';
import { useWsStore } from '../wsStore';
import { useAuthStore } from '../authStore';
import { STORAGE_KEYS } from '../../utils/constants';
import type { SessionSummary, TurnResponse } from '../../types/api';
import type { Session } from '../../types/session';

const makeSession = (sid: string, patch: Partial<Session> = {}): Session => ({
  session_id: sid,
  status: 'live',
  permission_policy: 'full_auto',
  turn_count: 0,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
  ...patch,
});

const makeSummary = (sid: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  session_id: sid,
  status: 'live',
  title: null,
  turn_count: 0,
  resumable: true,
  read_only: false,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({
    sessions: {},
    order: [],
    currentId: null,
    loading: false,
    loadingMore: false,
    total: 0,
    offset: 0,
    hasMore: false,
  });
  useConversationStore.setState({ conversations: {} });
  useWsStore.setState({ status: {}, lastMessageAt: {}, reconnectAttempt: {}, lastTurnIndex: {} });
  useUiStore.setState({ banner: null, createDialogOpen: false, settingsOpen: false });
  useAuthStore.setState({ apiKey: null, authExpired: false });
});

describe('sessionStore', () => {
  it('addSession 新会话置顶', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().addSession(makeSession('b'));
    expect(useSessionStore.getState().order).toEqual(['b', 'a']);
  });

  it('patchSession 局部更新已有会话，忽略未知会话', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().patchSession('a', { status: 'closed' });
    useSessionStore.getState().patchSession('ghost', { status: 'closed' });
    expect(useSessionStore.getState().sessions.a.status).toBe('closed');
    expect(useSessionStore.getState().sessions.ghost).toBeUndefined();
  });

  it('merge 为 patch 语义：summary 刷新不冲掉 detail 独有字段（F1.1）', () => {
    useSessionStore.getState().addSession(makeSession('a', { permission_policy: 'interactive' }));
    // 列表 summary 不含 permission_policy/ws_url → undefined 字段不覆盖
    useSessionStore.getState().applyListPage(
      [
        {
          session_id: 'a',
          status: 'idle',
          title: '做个视频',
          turn_count: 3,
          resumable: true,
          read_only: false,
          created_at: '2026-01-01T00:00:00Z',
          last_active_at: '2026-01-02T00:00:00Z',
        },
      ],
      { total: 1, offset: 0 },
      'replace',
    );
    const merged = useSessionStore.getState().sessions.a;
    expect(merged.permission_policy).toBe('interactive');
    expect(merged).toMatchObject({ status: 'idle', title: '做个视频', turn_count: 3, resumable: true });
  });

  it('applyListPage replace 以第一页为准，已加载其余会话保序拼后（F1.2）', () => {
    useSessionStore.getState().addSession(makeSession('local'));
    useSessionStore.getState().applyListPage(
      [makeSummary('b'), makeSummary('c')],
      { total: 5, offset: 0 },
      'replace',
    );
    const state = useSessionStore.getState();
    expect(state.order).toEqual(['b', 'c', 'local']);
    expect(state).toMatchObject({ total: 5, offset: 2, hasMore: true });
  });

  it('applyListPage append 追加去重并递增 offset，拉尽后 hasMore=false', () => {
    useSessionStore.getState().applyListPage(
      [makeSummary('a'), makeSummary('b')],
      { total: 3, offset: 0 },
      'replace',
    );
    useSessionStore.getState().applyListPage(
      [makeSummary('b'), makeSummary('c')],
      { total: 3, offset: 2 },
      'append',
    );
    const state = useSessionStore.getState();
    expect(state.order).toEqual(['a', 'b', 'c']);
    expect(state).toMatchObject({ offset: 4, hasMore: false });
  });

  it('selectSession 持久化选中项到 localStorage（F1.7）', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().selectSession('a');
    expect(loadPersistedCurrentId()).toBe('a');
    useSessionStore.getState().selectSession(null);
    expect(loadPersistedCurrentId()).toBeNull();
  });

  it('removeSession 清除选中态与持久化（4404 专用）', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().selectSession('a');
    useSessionStore.getState().removeSession('a');
    expect(useSessionStore.getState().currentId).toBeNull();
    expect(loadPersistedCurrentId()).toBeNull();
  });

  it('removeSession 级联清理对话与 WS 状态（A9）', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useConversationStore.getState().addUserMessage('a', 'hi');
    useWsStore.getState().setStatus('a', 'ready');
    useWsStore.getState().setLastTurnIndex('a', 2);
    useSessionStore.getState().removeSession('a');
    expect(useConversationStore.getState().conversations.a).toBeUndefined();
    expect(useWsStore.getState().status.a).toBeUndefined();
    expect(useWsStore.getState().lastTurnIndex.a).toBeUndefined();
  });

  it('关闭会话 patch 只读态后仍保留在列表（F1.8 四不变量之一）', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useConversationStore.getState().addUserMessage('a', 'hi');
    useSessionStore
      .getState()
      .patchSession('a', { status: 'closed', read_only: true, resumable: false });
    const state = useSessionStore.getState();
    expect(state.order).toContain('a');
    expect(state.sessions.a).toMatchObject({ status: 'closed', read_only: true, resumable: false });
    // 对话历史不被清除
    expect(useConversationStore.getState().conversations.a.messages).toHaveLength(1);
  });

  it('reset 清空全部状态与持久化选中项', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().selectSession('a');
    useSessionStore.getState().reset();
    expect(useSessionStore.getState().order).toEqual([]);
    expect(loadPersistedCurrentId()).toBeNull();
  });
});

describe('conversationStore', () => {
  const sid = 's1';

  it('addUserMessage 追加消息并激活轮次', () => {
    useConversationStore.getState().addUserMessage(sid, 'hello');
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(conv.turnActive).toBe(true);
  });

  it('appendAssistantText 首次创建流式消息，后续追加', () => {
    const store = useConversationStore.getState();
    store.appendAssistantText(sid, 0, 'Hel');
    store.appendAssistantText(sid, 0, 'lo');
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
  });

  it('replaceAssistantText 整体覆盖流式消息文本（P0-1 最终覆盖语义）', () => {
    const store = useConversationStore.getState();
    store.appendAssistantText(sid, 0, 'Hel');
    store.replaceAssistantText(sid, 0, 'Hello world');
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]).toMatchObject({ kind: 'assistant', text: 'Hello world', streaming: true });
  });

  it('replaceAssistantText 无在流消息时直接创建（全部 delta 丢失兜底）', () => {
    useConversationStore.getState().replaceAssistantText(sid, 3, 'full only');
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages[0]).toMatchObject({ kind: 'assistant', text: 'full only', turnIndex: 3 });
  });

  it('completeTurn 结束流式并清除待审批', () => {
    const store = useConversationStore.getState();
    store.appendAssistantText(sid, 0, 'done');
    store.setPendingApproval(sid, { type: 'approval_request', request_id: 'r', modal: null, turn_index: 0 });
    store.completeTurn(sid, 0);
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages[0]).toMatchObject({ streaming: false });
    expect(conv.turnActive).toBe(false);
    expect(conv.pendingApproval).toBeNull();
  });

  it('completeTurn 补发轮次（replayedText）本地无消息时补建', () => {
    useConversationStore.getState().completeTurn(sid, 2, { replayedText: '补发内容' });
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages[0]).toMatchObject({ kind: 'assistant', text: '补发内容', turnIndex: 2 });
  });

  it('completeTurn interrupted 追加系统警告', () => {
    useConversationStore.getState().completeTurn(sid, 0, { interrupted: true });
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages.at(-1)).toMatchObject({ kind: 'system', level: 'warning' });
  });

  it('addToolStart/addToolEnd 匹配同轮次同名 running 卡片', () => {
    const store = useConversationStore.getState();
    store.addToolStart(sid, 0, 'bash', { cmd: 'ls' });
    store.addToolEnd(sid, 0, 'bash', 'ok', false);
    const conv = useConversationStore.getState().conversations[sid];
    const msg = conv.messages[0];
    if (msg.kind !== 'tool') throw new Error('expected tool message');
    expect(msg.toolCall).toMatchObject({ status: 'success', output: 'ok' });
  });

  it('addToolEnd is_error 标记 error 状态', () => {
    const store = useConversationStore.getState();
    store.addToolStart(sid, 0, 'bash', null);
    store.addToolEnd(sid, 0, 'bash', 'boom', true);
    const conv = useConversationStore.getState().conversations[sid];
    const msg = conv.messages[0];
    if (msg.kind !== 'tool') throw new Error('expected tool message');
    expect(msg.toolCall.status).toBe('error');
  });

  it('pushInputHistory 相邻去重且上限 100', () => {
    const store = useConversationStore.getState();
    store.pushInputHistory(sid, 'a');
    store.pushInputHistory(sid, 'a');
    store.pushInputHistory(sid, 'b');
    expect(useConversationStore.getState().conversations[sid].inputHistory).toEqual(['a', 'b']);
  });

  it('clearMessages 只清消息与 TODO，保留输入历史', () => {
    const store = useConversationStore.getState();
    store.addUserMessage(sid, 'x');
    store.pushInputHistory(sid, 'x');
    store.setTodo(sid, '- [ ] t');
    store.clearMessages(sid);
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toEqual([]);
    expect(conv.todoMarkdown).toBe('');
    expect(conv.inputHistory).toEqual(['x']);
  });

  const makeTurn = (turnIndex: number, patch: Partial<TurnResponse> = {}): TurnResponse => ({
    turn_id: `t${turnIndex}`,
    turn_index: turnIndex,
    status: 'completed',
    prompt: `q${turnIndex}`,
    assistant_text: `a${turnIndex}`,
    error_message: null,
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:00:10Z',
    ...patch,
  });

  it('hydrateHistory 映射（F2.3）：user/assistant/interrupted/error 四类消息 + hydratedAt 打标', () => {
    const turns: TurnResponse[] = [
      makeTurn(0, { has_artifact: true }),
      makeTurn(1, { status: 'interrupted', assistant_text: '部分输出' }),
      makeTurn(2, { status: 'failed', assistant_text: null, error_message: '执行失败' }),
    ];
    useConversationStore.getState().hydrateHistory(sid, turns);
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.hydratedAt).not.toBeNull();
    expect(conv.messages.map((m) => m.kind)).toEqual([
      'user', 'assistant',            // turn 0
      'user', 'assistant', 'system',  // turn 1（interrupted 警告）
      'user', 'system',               // turn 2（failed 无 assistant_text）
    ]);
    expect(conv.messages[1]).toMatchObject({ text: 'a0', streaming: false, hasArtifact: true });
    expect(conv.messages[4]).toMatchObject({ kind: 'system', level: 'warning', text: '轮次已中断' });
    expect(conv.messages[6]).toMatchObject({ kind: 'system', level: 'error', text: '执行失败' });
    // createdAt 取轮次时间戳（started_at/finished_at）而非当前时刻
    expect(conv.messages[0].createdAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(conv.messages[1].createdAt).toBe(Date.parse('2026-01-01T00:00:10Z'));
  });

  it('hydrateHistory 后同 turn_index 补发 turn_complete 不重复追加（F2.4 幂等兜底）', () => {
    const store = useConversationStore.getState();
    store.hydrateHistory(sid, [makeTurn(0)]);
    // WS 重连后同 index 补发（replayed 带 assistant_text）：命中已有 assistant 消息，不新建
    store.completeTurn(sid, 0, { replayedText: 'a0', hasArtifact: false });
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages.filter((m) => m.kind === 'assistant')).toHaveLength(1);
  });

  it('关闭会话不清历史（F1.8 四不变量：patch 只读态不触碰 conversation）', () => {
    useSessionStore.getState().addSession(makeSession(sid));
    useConversationStore.getState().hydrateHistory(sid, [makeTurn(0)]);
    useSessionStore.getState().patchSession(sid, { status: 'closed', read_only: true, resumable: false });
    const conv = useConversationStore.getState().conversations[sid];
    expect(conv.messages).toHaveLength(2);
    expect(conv.hydratedAt).not.toBeNull();
    expect(useSessionStore.getState().order).toContain(sid);
  });
});

describe('uiStore', () => {
  it('setMode 持久化到 localStorage', () => {
    useUiStore.getState().setMode('terminal');
    expect(useUiStore.getState().mode).toBe('terminal');
    expect(localStorage.getItem(STORAGE_KEYS.mode)).toBe('terminal');
  });

  it('showBanner / dismissBanner', () => {
    useUiStore.getState().showBanner('error', 'boom');
    expect(useUiStore.getState().banner).toMatchObject({ level: 'error', text: 'boom' });
    useUiStore.getState().dismissBanner();
    expect(useUiStore.getState().banner).toBeNull();
  });
});

describe('wsStore', () => {
  it('setLastTurnIndex 单调递增', () => {
    const store = useWsStore.getState();
    store.setLastTurnIndex('s', 3);
    store.setLastTurnIndex('s', 1);
    expect(useWsStore.getState().lastTurnIndex.s).toBe(3);
  });

  it('clear 移除会话所有 WS 状态', () => {
    const store = useWsStore.getState();
    store.setStatus('s', 'ready');
    store.setReconnectAttempt('s', 2);
    store.clear('s');
    expect(useWsStore.getState().status.s).toBeUndefined();
    expect(useWsStore.getState().reconnectAttempt.s).toBeUndefined();
  });
});

describe('authStore', () => {
  it('setApiKey 持久化并清除过期标记', () => {
    useAuthStore.setState({ authExpired: true });
    useAuthStore.getState().setApiKey('k1');
    expect(useAuthStore.getState()).toMatchObject({ apiKey: 'k1', authExpired: false });
    expect(localStorage.getItem(STORAGE_KEYS.apiKey)).toBe('k1');
  });

  it('markAuthExpired 清 Key 并标记（401 重新认证流）', () => {
    useAuthStore.getState().setApiKey('k1');
    useAuthStore.getState().markAuthExpired();
    expect(useAuthStore.getState()).toMatchObject({ apiKey: null, authExpired: true });
    expect(localStorage.getItem(STORAGE_KEYS.apiKey)).toBeNull();
  });
});
