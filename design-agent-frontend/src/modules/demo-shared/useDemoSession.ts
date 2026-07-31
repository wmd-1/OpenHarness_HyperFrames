// demo 能力域会话编排 hook（spec design-agent-demo-modules：TurnStream 同构约束）。
// 模拟对话 MUST 经 DemoAdapter 的 TurnStream 接口，页面组件不直接 setTimeout 拼消息；
// 后端就绪时仅替换 registry 中 providers 指向即可转 GA。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionProvider, SessionSummary, TurnStream } from '../../platform/types';

export interface DemoChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  text: string;
}

export const DEMO_WELCOME_TEXT = '您已创建新会话，请描述您的设计需求。';

let msgSeq = 0;
function nextId(role: string): string {
  return `demo-${role}-${msgSeq++}`;
}

export interface DemoSessionState {
  sessions: SessionSummary[];
  currentId: string | null;
  currentSession: SessionSummary | null;
  messages: DemoChatMessage[];
  /** 轮次进行中（模拟回复未返回）。 */
  busy: boolean;
  /** 通道就绪可提交。 */
  ready: boolean;
  select: (sessionId: string) => void;
  create: () => void;
  submit: (text: string) => boolean;
}

export function useDemoSession(provider: SessionProvider): DemoSessionState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DemoChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const channelRef = useRef<TurnStream | null>(null);

  const closeChannel = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    setReady(false);
  }, []);

  /** 打开会话通道并订阅事件（delta final → 上屏；complete → 解除 busy）。 */
  const openChannel = useCallback(
    (sessionId: string) => {
      closeChannel();
      const channel = provider.openChannel(sessionId);
      channel.on((event) => {
        if (event.type === 'delta' && event.final) {
          const text = event.fullText ?? event.text;
          setMessages((prev) => [...prev, { id: nextId('assistant'), role: 'assistant', text }]);
        } else if (event.type === 'complete') {
          setBusy(false);
          // 会话轮次数在 provider 内部已推进，同步列表徽标
          setSessions((prev) =>
            prev.map((s) =>
              s.session_id === sessionId ? { ...s, turn_count: event.turnIndex + 1 } : s,
            ),
          );
        }
      });
      channel.onState((state) => setReady(state === 'ready'));
      setReady(channel.state === 'ready');
      channelRef.current = channel;
    },
    [provider, closeChannel],
  );

  const select = useCallback(
    (sessionId: string) => {
      setCurrentId(sessionId);
      setBusy(false);
      void provider.listTurns(sessionId).then(({ turns }) => {
        const restored: DemoChatMessage[] = [];
        for (const t of turns) {
          if (t.user_text) restored.push({ id: nextId('user'), role: 'user', text: t.user_text });
          if (t.assistant_text) {
            restored.push({ id: nextId('assistant'), role: 'assistant', text: t.assistant_text });
          }
        }
        if (restored.length === 0) {
          restored.push({ id: nextId('system'), role: 'system', text: DEMO_WELCOME_TEXT });
        }
        setMessages(restored);
      });
      openChannel(sessionId);
    },
    [provider, openChannel],
  );

  const create = useCallback(() => {
    void provider.create().then((created) => {
      setSessions((prev) => [created, ...prev]);
      setCurrentId(created.session_id);
      setBusy(false);
      setMessages([{ id: nextId('system'), role: 'system', text: DEMO_WELCOME_TEXT }]);
      openChannel(created.session_id);
    });
  }, [provider, openChannel]);

  const submit = useCallback((text: string): boolean => {
    const channel = channelRef.current;
    if (!channel) return false;
    const accepted = channel.submit(text);
    if (accepted) {
      setMessages((prev) => [...prev, { id: nextId('user'), role: 'user', text }]);
      setBusy(true);
    }
    return accepted;
  }, []);

  // 初始加载列表并自动选中第一条（demo 首条含预置对话）
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    let cancelled = false;
    void provider.list().then((page) => {
      if (cancelled) return;
      setSessions(page.sessions);
      if (page.sessions.length > 0) selectRef.current(page.sessions[0].session_id);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // 卸载时关闭通道
  useEffect(() => closeChannel, [closeChannel]);

  const currentSession = sessions.find((s) => s.session_id === currentId) ?? null;

  return { sessions, currentId, currentSession, messages, busy, ready, select, create, submit };
}
