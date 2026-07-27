// 会话工作区（task 11.4）：会话生命周期状态机 UI + Chat/Terminal 模式渲染。
// 在此层调用一次 useConversation（单 WS 连接），向下传给 ChatView/TerminalView。

import { Loader2, MessageSquarePlus, Snowflake } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session, SessionStatus } from '../../types/session';
import { isSessionTerminal } from '../../types/session';
import { useConversation } from '../../hooks/useConversation';
import { ApprovalModal } from '../Approval/ApprovalModal';
import { ChatView } from '../Chat/ChatView';
import { SessionDetail } from '../Session/SessionDetail';
import { TerminalView } from '../Terminal/TerminalView';

/** 终态提示文案（closed/expired/failed → 只读）。 */
const TERMINAL_NOTICE: Partial<Record<SessionStatus, string>> = {
  closed: '会话已关闭，历史消息只读',
  expired: '会话已过期（TTL 到期），历史消息只读',
  failed: '会话启动失败，无法继续交互',
};

function EmptyPlaceholder() {
  const setCreateDialogOpen = useUiStore((s) => s.setCreateDialogOpen);
  const loading = useSessionStore((s) => s.loading);

  return (
    <div className="text-muted flex flex-1 flex-col items-center justify-center gap-3 p-8">
      {loading ? (
        <>
          <Loader2 size={28} className="animate-spin" />
          <p className="text-sm">正在恢复历史会话…</p>
        </>
      ) : (
        <>
          <MessageSquarePlus size={32} />
          <p className="text-sm">选择左侧会话，或创建一个新会话开始对话</p>
          <button
            type="button"
            onClick={() => setCreateDialogOpen(true)}
            className="bg-accent text-accent-fg rounded-lg px-4 py-2 text-sm"
          >
            创建会话
          </button>
        </>
      )}
    </div>
  );
}

/** 生命周期附加提示条（creating 加载 / cold 冷启动 / 终态只读）。 */
function LifecycleNotice({ session }: { session: Session }) {
  if (session.status === 'creating') {
    return (
      <div className="text-muted flex items-center gap-2 px-4 py-2 text-xs" role="status">
        <Loader2 size={13} className="animate-spin" />
        会话创建中，容器启动完成后即可对话…
      </div>
    );
  }
  if (session.status === 'cold') {
    return (
      <div className="text-warn flex items-center gap-2 px-4 py-2 text-xs" role="status">
        <Snowflake size={13} />
        会话已冷却，提交新消息将自动唤醒（首轮响应较慢）
      </div>
    );
  }
  const notice = TERMINAL_NOTICE[session.status];
  if (notice) {
    return (
      <div className="text-muted bg-raised px-4 py-2 text-xs" role="status">
        {notice}
      </div>
    );
  }
  return null;
}

export function SessionWorkspace() {
  const currentId = useSessionStore((s) => s.currentId);
  const session = useSessionStore((s) => (s.currentId ? s.sessions[s.currentId] : undefined));
  const mode = useUiStore((s) => s.mode);
  // Hook 必须无条件调用；无会话时传 null（不建连、返回空态）
  const conversation = useConversation(session ? currentId : null);

  if (!session) return <EmptyPlaceholder />;

  const readonly = isSessionTerminal(session.status);

  return (
    <>
      <SessionDetail session={session} />
      <LifecycleNotice session={session} />
      {mode === 'terminal' && !readonly ? (
        <TerminalView session={session} conversation={conversation} />
      ) : (
        <ChatView session={session} conversation={conversation} />
      )}
      {/* 审批弹窗（interactive 策略下由 approval_request 帧触发） */}
      {conversation.pendingApproval && currentId && (
        <ApprovalModal
          sessionId={currentId}
          approval={conversation.pendingApproval}
          approve={conversation.approve}
        />
      )}
    </>
  );
}
