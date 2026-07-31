// demo 能力域对话区（demo msg-system/msg-user/msg-ai 三色气泡 + chat-input-box）。
// 消息与输入均为受控呈现，提交经 useDemoSession → TurnStream。

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DemoChatMessage } from './useDemoSession';

export interface DemoChatProps {
  messages: DemoChatMessage[];
  busy: boolean;
  /** 通道未就绪时禁用发送。 */
  ready: boolean;
  onSubmit: (text: string) => boolean;
  /** msg-ai 徽标文案（demo：设计智能体）。 */
  agentLabel: string;
  placeholder: string;
}

export function DemoChat({
  messages,
  busy,
  ready,
  onSubmit,
  agentLabel,
  placeholder,
}: DemoChatProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚到底（demo scrollTop = scrollHeight）
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy || !ready) return;
    if (onSubmit(text)) setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      <div className="chat-messages" ref={listRef}>
        {messages.map((m) => {
          if (m.role === 'system') {
            return (
              <div key={m.id} className="msg-system view-fade-in">
                <div className="msg-system-label">系统提示</div>
                {m.text}
              </div>
            );
          }
          if (m.role === 'user') {
            return (
              <div key={m.id} className="msg-user view-fade-in">
                <div className="msg-user-label">我</div>
                {m.text}
              </div>
            );
          }
          return (
            <div key={m.id} className="msg-ai view-fade-in" style={{ whiteSpace: 'pre-wrap' }}>
              <div className="msg-ai-label">
                <div className="msg-ai-label-dot" />
                {agentLabel}
              </div>
              {m.text}
            </div>
          );
        })}
        {busy && (
          <div className="msg-ai view-fade-in" role="status">
            <div className="msg-ai-label">
              <div className="msg-ai-label-dot" />
              {agentLabel}
            </div>
            正在生成回复…
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-box">
          <textarea
            className="chat-input-text"
            aria-label="消息输入"
            placeholder={placeholder}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="chat-input-bottom">
            <div className="chat-input-tools" />
            <button
              type="button"
              className="btn-send"
              aria-label="发送"
              disabled={busy || !ready}
              style={busy || !ready ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              onClick={send}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
