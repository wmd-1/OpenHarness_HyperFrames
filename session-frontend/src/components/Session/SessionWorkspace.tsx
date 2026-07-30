// 会话工作区（task 11.4）：会话生命周期状态机 UI + Chat/Terminal 模式渲染。
// 在此层调用一次 useConversation（单 WS 连接），向下传给 ChatView/TerminalView。

import { Loader2, MessageSquarePlus, Snowflake } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getSession } from '../../api/sessions';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session, SessionStatus } from '../../types/session';
import { canResumeSession, isReadonlySession } from '../../types/session';
import { useConversation } from '../../hooks/useConversation';
import { useTurnHistory } from '../../hooks/useTurnHistory';
import { WAKEUP_SLOW_HINT_MS } from '../../utils/constants';
import { ApprovalModal } from '../Approval/ApprovalModal';
import { ChatView } from '../Chat/ChatView';
import { SessionDetail } from '../Session/SessionDetail';
import { TerminalView } from '../Terminal/TerminalView';
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel';

/** 终态提示文案（F2.6：closed 与 expired 区分语义，均只读可回看）。 */
const TERMINAL_NOTICE: Partial<Record<SessionStatus, string>> = {
  closed: '会话已关闭，不可再对话；历史消息与文件仍可回看',
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

/** 唤醒等待提示条（F3.4）：status 仅选文案；30s 未就绪追加排队提示（纯前端计时）。 */
function WakeupNotice({ status }: { status: SessionStatus }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), WAKEUP_SLOW_HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const text =
    status === 'failed'
      ? '正在尝试恢复会话（从快照重建容器，可能需要数十秒）…'
      : '正在唤醒会话（拉起容器并恢复数据，可能需要数十秒）…';

  return (
    <div className="text-warn flex items-center gap-2 px-4 py-2 text-xs" role="status">
      <Loader2 size={13} className="animate-spin" />
      {text}
      {slow && <span className="text-muted">仍在排队/冷启动中，请耐心等待</span>}
    </div>
  );
}

export function SessionWorkspace() {
  const currentId = useSessionStore((s) => s.currentId);
  const session = useSessionStore((s) => (s.currentId ? s.sessions[s.currentId] : undefined));
  const mode = useUiStore((s) => s.mode);
  // 三步严格串行（F2.4）：①hydrateHistory ②setLastTurnIndex 在 useTurnHistory 内完成，
  // hydrated 后才把 sessionId 传给 useConversation → useWebSocket 建连（③，禁止并行）
  const history = useTurnHistory(session ? currentId : null);
  const conversation = useConversation(session && history.hydrated ? currentId : null);
  // F5.1 工作区文件面板：会话内本地开关，切会话自动关闭
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    setFilesOpen(false);
  }, [currentId]);

  // F1.4：列表 summary 不含 permission_policy，选中后懒加载 detail 补齐；
  // 失败不阻塞（审批过滤按保守策略处理）
  const sid = session?.session_id ?? null;
  const needDetail = session !== undefined && session.permission_policy === undefined;
  useEffect(() => {
    if (!sid || !needDetail) return;
    let cancelled = false;
    void getSession(sid)
      .then((detail) => {
        if (!cancelled) useSessionStore.getState().updateSession(detail);
      })
      .catch(() => {
        // 详情拉取失败不阻塞会话交互
      });
    return () => {
      cancelled = true;
    };
  }, [sid, needDetail]);

  if (!session) return <EmptyPlaceholder />;

  const readonly = isReadonlySession(session);
  // F3.4 唤醒等待态：以 canResumeSession 为门槛（resumable 优先），status 仅选文案；
  // session_ready 会 patch status→live（useWebSocket）自然退出该状态
  const wsStatus = conversation.ws.status;
  const waking =
    canResumeSession(session) &&
    (session.status === 'cold' || session.status === 'failed') &&
    (wsStatus === 'connecting' || wsStatus === 'reconnecting');

  return (
    <>
      <SessionDetail session={session} onOpenFiles={() => setFilesOpen(true)} />
      {waking ? <WakeupNotice status={session.status} /> : <LifecycleNotice session={session} />}
      {mode === 'terminal' && !readonly ? (
        <TerminalView session={session} conversation={conversation} />
      ) : (
        <ChatView
          session={session}
          conversation={conversation}
          hydrating={history.loading}
          hydrateError={history.error}
          onRetryHydrate={history.retry}
        />
      )}
      {/* 审批弹窗（interactive 策略下由 approval_request 帧触发） */}
      {conversation.pendingApproval && currentId && (
        <ApprovalModal
          sessionId={currentId}
          approval={conversation.pendingApproval}
          approve={conversation.approve}
        />
      )}
      {/* 工作区文件抽屉（F5）：closed/expired 只读会话仍可回看归档文件 */}
      {filesOpen && <WorkspaceFilesPanel session={session} onClose={() => setFilesOpen(false)} />}
    </>
  );
}
