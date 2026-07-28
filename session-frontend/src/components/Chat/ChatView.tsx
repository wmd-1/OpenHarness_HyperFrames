// Chat Mode 主视图（task 8.1）：TODO 面板 + 消息列表 + 输入栏。
// useConversation 在上层（SessionWorkspace）调用后传入，
// 与 Terminal Mode 共享同一条 WS 连接。

import { useConversationStore } from '../../store/conversationStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';
import { isSessionTerminal } from '../../types/session';
import { dispatchSlashCommand } from '../../utils/slashCommands';
import type { UseConversationResult } from '../../hooks/useConversation';
import { useCloseSession } from '../../hooks/useCloseSession';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { InputBar } from './InputBar';
import { MessageList } from './MessageList';
import { TodoPanel } from './TodoPanel';

export interface ChatViewProps {
  session: Session;
  conversation: UseConversationResult;
}

export function ChatView({ session, conversation }: ChatViewProps) {
  const sid = session.session_id;
  const disabled = isSessionTerminal(session.status) || conversation.turnActive;
  // /close 命令统一走确认 + 乐观关闭 + 失败回滚（A5）
  const { pendingSid, requestClose, confirmClose, cancelClose } = useCloseSession();

  /** `/` 命令走统一分发表（D3）；非命令/未知命令走 submit。返回是否已受理（清空输入框）。 */
  const handleSubmit = (text: string): boolean => {
    if (
      text.startsWith('/') &&
      dispatchSlashCommand(text, {
        interrupt: () => conversation.interrupt(),
        clearView: () => conversation.clearMessages(),
        openSettings: () => useUiStore.getState().setSettingsOpen(true),
        setMode: (mode) => useUiStore.getState().setMode(mode),
        requestClose: () => requestClose(sid),
        showHelp: (help) => useConversationStore.getState().addSystemMessage(sid, 'info', help),
      })
    ) {
      return true;
    }
    // 非命令 / 未知命令按普通文本发送
    return conversation.submit(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TodoPanel markdown={conversation.todoMarkdown} />
      <MessageList messages={conversation.messages} sid={sid} />
      <InputBar
        disabled={isSessionTerminal(session.status)}
        turnActive={conversation.turnActive}
        history={conversation.inputHistory}
        onSubmit={handleSubmit}
        onInterrupt={conversation.interrupt}
        placeholder={disabled && isSessionTerminal(session.status) ? '会话已结束' : undefined}
      />
      <ConfirmDialog
        open={pendingSid !== null}
        title="关闭会话"
        message="确认关闭当前会话？关闭后不可恢复。"
        confirmLabel="关闭会话"
        onConfirm={confirmClose}
        onCancel={cancelClose}
      />
    </div>
  );
}
