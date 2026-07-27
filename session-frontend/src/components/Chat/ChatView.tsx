// Chat Mode 主视图（task 8.1）：TODO 面板 + 消息列表 + 输入栏。
// useConversation 在上层（SessionWorkspace）调用后传入，
// 与 Terminal Mode 共享同一条 WS 连接。

import { closeSession } from '../../api/sessions';
import { useConversationStore } from '../../store/conversationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';
import { isSessionTerminal } from '../../types/session';
import { SLASH_COMMANDS } from '../../utils/constants';
import type { UseConversationResult } from '../../hooks/useConversation';
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

  /** `/` 命令本地处理；非命令走 submit。返回是否已受理（清空输入框）。 */
  const handleSubmit = (text: string): boolean => {
    if (!text.startsWith('/')) return conversation.submit(text);
    const [command] = text.split(/\s+/);
    switch (command) {
      case '/interrupt':
        conversation.interrupt();
        return true;
      case '/clear':
        conversation.clearMessages();
        return true;
      case '/theme':
        useUiStore.getState().setSettingsOpen(true);
        return true;
      case '/terminal':
        useUiStore.getState().setMode('terminal');
        return true;
      case '/chat':
        useUiStore.getState().setMode('chat');
        return true;
      case '/close':
        useSessionStore.getState().patchSession(sid, { status: 'closed' });
        void closeSession(sid).catch(() => undefined);
        return true;
      case '/help':
        useConversationStore
          .getState()
          .addSystemMessage(
            sid,
            'info',
            `可用命令：${SLASH_COMMANDS.map((c) => `${c.command}（${c.description}）`).join('、')}`,
          );
        return true;
      default:
        // 未知命令按普通文本发送
        return conversation.submit(text);
    }
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
    </div>
  );
}
