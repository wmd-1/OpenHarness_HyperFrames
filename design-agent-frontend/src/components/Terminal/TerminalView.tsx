// Terminal Mode 主视图（task 9.5）：xterm 终端 + WS 帧桥接 + 本地命令。
// 与 Chat Mode 共享同一 useConversation（同一条 WS 连接与输入历史）。

import { useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useConversationStore } from '../../store/conversationStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';
import { dispatchSlashCommand } from '../../utils/slashCommands';
import type { UseConversationResult } from '../../hooks/useConversation';
import { useCloseSession } from '../../hooks/useCloseSession';
import { ConfirmDialog } from '../Common/ConfirmDialog';
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
  // /close 命令统一走确认 + 乐观关闭 + 失败回滚（A5）
  const { pendingSid, requestClose, confirmClose, cancelClose } = useCloseSession();

  const handleReady = useCallback(
    (term: Terminal) => {
      const bridge = new TerminalBridge(term, {
        submit: (text) => convRef.current.submit(text),
        interrupt: () => convRef.current.interrupt(),
        // 共享输入历史直接读/写 store，不再副本化（D4）
        getHistory: () => convRef.current.inputHistory,
        pushHistory: (text) => useConversationStore.getState().pushInputHistory(sid, text),
        // `/` 命令走统一分发表（D3）；差异项：清屏用 term.clear，帮助直接打印到终端
        onLocalCommand: (text) =>
          dispatchSlashCommand(text, {
            interrupt: () => convRef.current.interrupt(),
            clearView: () => term.clear(),
            openSettings: () => useUiStore.getState().setSettingsOpen(true),
            setMode: (mode) => useUiStore.getState().setMode(mode),
            requestClose: () => requestClose(sid),
            showHelp: (help) => term.writeln(help),
          }),
      });
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
    [sid, requestClose],
  );

  const handleShiftEnter = useCallback((): boolean => {
    bridgeRef.current?.insertNewline();
    return true;
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black/90 p-2">
      <XtermContainer key={sid} onReady={handleReady} onShiftEnter={handleShiftEnter} />
      <ConfirmDialog
        open={pendingSid !== null}
        title="关闭会话"
        message="确认关闭当前会话？关闭后不可再对话，历史消息与文件仍可查看。"
        confirmLabel="关闭会话"
        onConfirm={confirmClose}
        onCancel={cancelClose}
      />
    </div>
  );
}
