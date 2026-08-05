// 文本生成视频模块页（spec design-agent-video）：demo video-layout 三栏 +
// 真实 session-service 对接。编排逻辑对齐 SessionWorkspace（三步严格串行：
// hydrateHistory → setLastTurnIndex → WS 建连），呈现层 demo 化：
// 左栏 HistoryPanel | 中栏 chat-header + ChatView/TerminalView | 右栏视频预览（0↔50%）。

import { Loader2, Snowflake } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getSession } from '../../api/sessions';
import { ApprovalModal } from '../../components/Approval/ApprovalModal';
import { ChatView } from '../../components/Chat/ChatView';
import { ModeSwitcher } from '../../components/Layout/ModeSwitcher';
import { CreateDialog } from '../../components/Session/CreateDialog';
import { StatusBadge } from '../../components/Session/StatusBadge';
import { WorkspaceFilesPanel } from '../../components/Session/WorkspaceFilesPanel';
import { TerminalView } from '../../components/Terminal/TerminalView';
import { useConversation } from '../../hooks/useConversation';
import { useSessionList } from '../../hooks/useSessionList';
import { useTurnHistory } from '../../hooks/useTurnHistory';
import { useConversationStore } from '../../store/conversationStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { Session, SessionStatus } from '../../types/session';
import { canResumeSession, isReadonlySession } from '../../types/session';
import { MonitorIcon } from '../../shared/icons';
import { WAKEUP_SLOW_HINT_MS } from '../../utils/constants';
import { modelSwitchCommand } from '../../utils/model';
import { HistoryPanel } from './HistoryPanel';
import { ModelSelector } from './ModelSelector';
import { VideoPreviewPanel } from './VideoPreviewPanel';
import { extractArtifactTurns } from './videoArtifacts';
import { resolveActiveTurn } from './videoActiveTurn';

/** 终态提示文案（F2.6：closed 与 expired 区分语义，均只读可回看）。 */
const TERMINAL_NOTICE: Partial<Record<SessionStatus, string>> = {
  closed: '会话已关闭，不可再对话；历史消息与文件仍可回看',
  expired: '会话已过期（TTL 到期），历史消息只读',
  failed: '会话启动失败，无法继续交互',
};

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

/** 唤醒等待提示条（F3.4）：30s 未就绪追加排队提示。 */
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

/** 上传按钮（spec：保留 demo 交互但明示「暂不支持」，不做假上传）。 */
function UploadButton({ sid }: { sid: string }) {
  const notify = () =>
    useConversationStore
      .getState()
      .addSystemMessage(sid, 'info', '文件上传暂不支持，敬请期待后续版本');
  return (
    <button
      type="button"
      className="btn-toolbar btn-upload"
      onClick={notify}
      title="上传文档（暂不支持）"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      上传文档
    </button>
  );
}

function EmptyWorkspace() {
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
          <p className="text-sm">选择左侧会话，或创建一个新会话开始生成视频</p>
          <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn-new-session" style={{ width: 'auto', padding: '0 20px' }}>
            创建会话
          </button>
        </>
      )}
    </div>
  );
}

export function VideoModulePage() {
  // 列表刷新触发器（认证成功 + window focus 节流）
  useSessionList();

  const currentId = useSessionStore((s) => s.currentId);
  const session = useSessionStore((s) => (s.currentId ? s.sessions[s.currentId] : undefined));
  const mode = useUiStore((s) => s.mode);
  // 三步严格串行（F2.4）：hydrated 后才建 WS 连接
  const history = useTurnHistory(session ? currentId : null);
  const conversation = useConversation(session && history.hydrated ? currentId : null);

  const [filesOpen, setFilesOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  // 用户主动钉选某历史轮（在「当前 artifact 集合」下保持；新产物轮到达后由下方 effect 解除）
  const pinnedRef = useRef(false);
  // 上次已知 latestArtifact，用于检测「新产物轮到达」并解除钉选、自动跟随最新
  const lastLatestRef = useRef<number | null>(null);

  // 切会话：关闭文件抽屉与预览面板、清空预览轮次与钉选态
  useEffect(() => {
    setFilesOpen(false);
    setPreviewOpen(false);
    setActiveTurn(null);
    pinnedRef.current = false;
    lastLatestRef.current = null;
  }, [currentId]);

  // F1.4：列表 summary 不含 permission_policy，选中后懒加载 detail 补齐
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

  // 产物轮次（多轮切换条数据源）
  const artifactTurns = useMemo(
    () => extractArtifactTurns(conversation.messages),
    [conversation.messages],
  );
  const latestArtifact = artifactTurns.length > 0 ? artifactTurns[artifactTurns.length - 1] : null;

  // 多轮产物预览轮次（activeTurn 单一权威）：
  // 仅由 artifactTurns/latestArtifact 推导，**不依赖 turnActive 与 artifact 的到达时序**
  // （彻底消除原 effect 对两个异步来源到达顺序的耦合，见 design.md §2/§4）。
  // 派生优先级（高→低）：用户钉选 > 首屏最新 > 新 artifact 自动最新。
  useEffect(() => {
    const prevLatest = lastLatestRef.current;
    // 用户钉选后若又产出新产物轮，则解除钉选、自动跟随最新（优先级规则 3）
    if (prevLatest !== null && latestArtifact !== prevLatest) {
      pinnedRef.current = false;
    }
    const newArtifactArrived = prevLatest === null || latestArtifact !== prevLatest;
    lastLatestRef.current = latestArtifact;

    const next = resolveActiveTurn(activeTurn, artifactTurns, pinnedRef.current);
    if (next !== activeTurn) {
      setActiveTurn(next);
    }
    // 首屏/新产物轮出现时展开预览面板（保持原 turn_complete 自动展开语义）
    if (next !== null && newArtifactArrived && !previewOpen) {
      setPreviewOpen(true);
    }
  }, [artifactTurns, latestArtifact, activeTurn, previewOpen]);

  const readonly = session ? isReadonlySession(session) : false;
  const wsStatus = conversation.ws.status;
  const waking =
    session !== undefined &&
    canResumeSession(session) &&
    (session.status === 'cold' || session.status === 'failed') &&
    (wsStatus === 'connecting' || wsStatus === 'reconnecting');

  // 模型切换通道②：会话空闲态经 WS 提交 /model 命令（乐观更新，回执见消息流）
  const runtimeSwitch =
    session && !readonly && history.hydrated
      ? (model: string) => conversation.submit(modelSwitchCommand(model))
      : undefined;

  const inputTools = (
    <>
      <ModelSelector disabled={conversation.turnActive || readonly} onRuntimeSwitch={runtimeSwitch} />
      {sid && <UploadButton sid={sid} />}
    </>
  );

  return (
    <section
      className={`page-detail visible video-layout view-fade-in${previewOpen ? ' preview-open' : ''}`}
      // 不可见的 WS 状态测试钩子（e2e 依赖，demo 视觉零影响）：
      // 本平台使用 PlatformLayout 而非 session-frontend 的 AppShell/StatusBar，
      // 故直接在能力域根节点暴露连接态供 Playwright 断言。
      data-ws-status={wsStatus}
    >
      <HistoryPanel />

      <div className="panel-chat">
        {session && currentId ? (
          <>
            <div className="chat-header">
              <div className="chat-header-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <code className="font-mono" style={{ fontSize: 13 }} title={currentId}>
                  会话 {currentId.slice(0, 12)}…
                </code>
                <StatusBadge status={session.status} />
                <span className="text-muted" style={{ fontSize: 12 }}>
                  轮次 {session.turn_count}
                </span>
              </div>
              <div className="chat-header-right">
                <button
                  type="button"
                  className="btn-preview-toggle"
                  onClick={() => setFilesOpen(true)}
                >
                  文件
                </button>
                <ModeSwitcher />
                <button
                  type="button"
                  className={`btn-preview-toggle${previewOpen ? ' active' : ''}`}
                  aria-pressed={previewOpen}
                  onClick={() => setPreviewOpen((v) => !v)}
                >
                  <MonitorIcon />
                  视频预览
                </button>
              </div>
            </div>

            {waking ? (
              <WakeupNotice status={session.status} />
            ) : (
              <LifecycleNotice session={session} />
            )}

            {mode === 'terminal' && !readonly ? (
              <TerminalView session={session} conversation={conversation} />
            ) : (
              <ChatView
                session={session}
                conversation={conversation}
                hydrating={history.loading}
                hydrateError={history.error}
                onRetryHydrate={history.retry}
                inputTools={inputTools}
              />
            )}

            {conversation.pendingApproval && (
              <ApprovalModal
                sessionId={currentId}
                approval={conversation.pendingApproval}
                approve={conversation.approve}
              />
            )}
            {filesOpen && (
              <WorkspaceFilesPanel session={session} onClose={() => setFilesOpen(false)} />
            )}
          </>
        ) : (
          <EmptyWorkspace />
        )}
      </div>

      <VideoPreviewPanel
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        sid={sid}
        artifactTurns={artifactTurns}
        activeTurn={activeTurn}
        onSelectTurn={(turn) => {
          // 用户显式选择历史轮次 → 钉选（优先级规则 1，不被后续自动推进覆盖，
          // 直到新产物轮到达由上方 effect 解除钉选）
          pinnedRef.current = true;
          setActiveTurn(turn);
        }}
      />

      <CreateDialog />
    </section>
  );
}
