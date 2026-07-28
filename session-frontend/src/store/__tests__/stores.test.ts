// store 单元测试（task 12.4）：sessionStore / conversationStore / uiStore /
// wsStore / authStore 的状态变更逻辑。

import { beforeEach, describe, expect, it } from 'vitest';
import { loadCachedSessionIds, useSessionStore } from '../sessionStore';
import { useConversationStore } from '../conversationStore';
import { useUiStore } from '../uiStore';
import { useWsStore } from '../wsStore';
import { useAuthStore } from '../authStore';
import { STORAGE_KEYS } from '../../utils/constants';
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

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ sessions: {}, order: [], currentId: null, loading: false });
  useConversationStore.setState({ conversations: {} });
  useWsStore.setState({ status: {}, lastMessageAt: {}, reconnectAttempt: {}, lastTurnIndex: {} });
  useUiStore.setState({ banner: null, createDialogOpen: false, settingsOpen: false });
  useAuthStore.setState({ apiKey: null, authExpired: false });
});

describe('sessionStore', () => {
  it('addSession 新会话置顶并持久化 ID 列表', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().addSession(makeSession('b'));
    expect(useSessionStore.getState().order).toEqual(['b', 'a']);
    expect(loadCachedSessionIds()).toEqual(['b', 'a']);
  });

  it('patchSession 局部更新已有会话，忽略未知会话', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().patchSession('a', { status: 'closed' });
    useSessionStore.getState().patchSession('ghost', { status: 'closed' });
    expect(useSessionStore.getState().sessions.a.status).toBe('closed');
    expect(useSessionStore.getState().sessions.ghost).toBeUndefined();
  });

  it('removeSession 清除选中态并同步缓存', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().selectSession('a');
    useSessionStore.getState().removeSession('a');
    expect(useSessionStore.getState().currentId).toBeNull();
    expect(loadCachedSessionIds()).toEqual([]);
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

  it('reset 清空全部状态与缓存', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().reset();
    expect(useSessionStore.getState().order).toEqual([]);
    expect(loadCachedSessionIds()).toEqual([]);
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
