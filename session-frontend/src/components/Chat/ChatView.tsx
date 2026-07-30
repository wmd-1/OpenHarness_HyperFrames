// Chat Mode 主视图（task 8.1）：TODO 面板 + 消息列表 + 输入栏。
// useConversation 在上层（SessionWorkspace）调用后传入，
// 与 Terminal Mode 共享同一条 WS 连接。

import { Loader2 } from 'lucide-react';
import { useConversationStore } from '../../store/conversationStore';
import { useUiStore } from '../../store/uiStore';
import type { Session } from '../../types/session';
import { isReadonlySession } from '../../types/session';
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
  /** 历史回显拉取中（F2.5 骨架提示条）。 */
  hydrating?: boolean;
  /** 历史回显失败信息（F2.5 重试条）。 */
  hydrateError?: string | null;
  onRetryHydrate?: () => void;
}

export function ChatView({
  session,
  conversation,
  hydrating = false,
  hydrateError = null,
  onRetryHydrate,
}: ChatViewProps) {
  const sid = session.session_id;
  // 只读语义谓词（F1.5）：read_only 优先，缺失时回退终态判定
  const readonly = isReadonlySession(session);
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
      {hydrating && (
        <div className="text-muted flex items-center gap-2 px-4 py-2 text-xs" role="status">
          <Loader2 size={13} className="animate-spin" />
          正在加载历史消息…
        </div>
      )}
      {hydrateError && !hydrating && (
        <div
          className="bg-err/10 text-err flex items-center justify-between gap-2 px-4 py-2 text-xs"
          role="alert"
        >
          <span>{hydrateError}</span>
          {onRetryHydrate && (
            <button
              type="button"
              onClick={onRetryHydrate}
              className="border-err/40 rounded border px-2 py-0.5"
            >
              重试
            </button>
          )}
        </div>
      )}
      <MessageList messages={conversation.messages} sid={sid} />
      <InputBar
        disabled={readonly}
        turnActive={conversation.turnActive}
        history={conversation.inputHistory}
        onSubmit={handleSubmit}
        onInterrupt={conversation.interrupt}
        placeholder={readonly ? '会话已只读，仅可查看历史消息' : undefined}
      />
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
