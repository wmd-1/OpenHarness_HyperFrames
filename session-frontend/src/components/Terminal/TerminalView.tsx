// Terminal Mode 主视图（task 9.5）：xterm 终端 + WS 帧桥接 + 本地命令。
// 与 Chat Mode 共享同一 useConversation（同一条 WS 连接与输入历史）。

import { useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { closeSession } from '../../api/sessions';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';
import type { UseConversationResult } from '../../hooks/useConversation';
import { TerminalBridge } from './TerminalBridge';
import { XtermContainer } from './XtermContainer';

export interface TerminalViewProps {
  session: Session;
  conversation: UseConversationResult;
}

export function TerminalView({ session, conversation }: TerminalViewProps) {
  const sid = session.session_id;
  const bridgeRef = useRef<TerminalBridge | null>(null);
  // 回调持有最新 conversation（bridge 生命周期长于渲染周期）
  const convRef = useRef(conversation);
  convRef.current = conversation;

  const handleLocalCommand = useCallback(
    (text: string): boolean => {
      const [command] = text.split(/\s+/);
      switch (command) {
        case '/interrupt':
          convRef.current.interrupt();
          return true;
        case '/clear':
          return false; // 由 bridge 外部处理不便，交给终端 clear：见下方 submit 包装
        case '/theme':
          useUiStore.getState().setSettingsOpen(true);
          return true;
        case '/chat':
          useUiStore.getState().setMode('chat');
          return true;
        case '/terminal':
          return true; // 已在 terminal
        case '/close':
          useSessionStore.getState().patchSession(sid, { status: 'closed' });
          void closeSession(sid).catch(() => undefined);
          return true;
        default:
          return false;
      }
    },
    [sid],
  );

  const handleReady = useCallback(
    (term: Terminal) => {
      const bridge = new TerminalBridge(
        term,
        {
          submit: (text) => convRef.current.submit(text),
          interrupt: () => convRef.current.interrupt(),
          onLocalCommand: (text) => {
            if (text.split(/\s+/)[0] === '/clear') {
              term.clear();
              return true;
            }
            return handleLocalCommand(text);
          },
        },
        convRef.current.inputHistory,
      );
      bridgeRef.current = bridge;
      // WS 帧桥接（addFrameListener 返回取消函数）
      const removeListener = convRef.current.ws.addFrameListener((frame) =>
        bridge.handleFrame(frame),
      );
      return () => {
        removeListener();
        bridge.dispose();
        bridgeRef.current = null;
      };
    },
    [handleLocalCommand],
  );

  const handleShiftEnter = useCallback((): boolean => {
    bridgeRef.current?.insertNewline();
    return true;
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black/90 p-2">
      <XtermContainer key={sid} onReady={handleReady} onShiftEnter={handleShiftEnter} />
    </div>
  );
}
