// 历史会话面板（spec design-agent-video：demo panel-history 风格 + 服务端权威分页）。
// 数据/动作复用 sessionStore + useSessionList 模块级函数，仅呈现层 demo 化。

import { Loader2, RefreshCw, X } from 'lucide-react';
import { loadMoreSessions, refreshSessionList } from '../../hooks/useSessionList';
import { useCloseSession } from '../../hooks/useCloseSession';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { isReadonlySession } from '../../types/session';
import { formatRelativeTime } from '../../utils/format';
import { ChatIcon, PlusIcon } from '../../shared/icons';
import { ConfirmDialog } from '../../components/Common/ConfirmDialog';

export function HistoryPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const currentId = useSessionStore((s) => s.currentId);
  const loading = useSessionStore((s) => s.loading);
  const loadingMore = useSessionStore((s) => s.loadingMore);
  const hasMore = useSessionStore((s) => s.hasMore);
  const total = useSessionStore((s) => s.total);
  const selectSession = useSessionStore((s) => s.selectSession);
  const setCreateDialogOpen = useUiStore((s) => s.setCreateDialogOpen);
  const { pendingSid, requestClose, confirmClose, cancelClose } = useCloseSession();

  return (
    <aside className="panel-history" aria-label="历史会话">
      <div className="panel-history-header">
        <button
          type="button"
          className="btn-new-session"
          onClick={() => setCreateDialogOpen(true)}
        >
          <PlusIcon />
          新建会话
        </button>
        <div className="panel-history-title">
          <ChatIcon />
          历史会话
          <button
            type="button"
            onClick={() => void refreshSessionList()}
            disabled={loading}
            aria-label="刷新会话列表"
            title="刷新会话列表"
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              display: 'flex',
              padding: 2,
            }}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>
      <div className="panel-history-list">
        {loading && order.length === 0 && (
          <div
            className="history-item-time"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 16px' }}
            role="status"
          >
            <Loader2 size={13} className="animate-spin" />
            加载会话列表…
          </div>
        )}
        {!loading && order.length === 0 && (
          <p
            className="history-item-time"
            style={{ padding: '24px 16px', textAlign: 'center' }}
          >
            暂无会话，点击上方按钮创建
          </p>
        )}
        {order.map((sid) => {
          const session = sessions[sid];
          if (!session) return null;
          const readonly = isReadonlySession(session);
          return (
            <div
              key={sid}
              className={`history-item${sid === currentId ? ' active' : ''}`}
              onClick={() => selectSession(sid)}
              onKeyDown={(e) => e.key === 'Enter' && selectSession(sid)}
              role="button"
              tabIndex={0}
              aria-current={sid === currentId}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div className="history-item-title" style={{ flex: 1, minWidth: 0 }}>
                  会话 {sid.slice(0, 8)}
                </div>
                {readonly && (
                  <span
                    className="history-item-time"
                    style={{ marginTop: 0, flexShrink: 0 }}
                    title="会话已只读，仅可查看历史"
                  >
                    只读
                  </span>
                )}
                {!readonly && (
                  <button
                    type="button"
                    aria-label={`关闭会话 ${sid.slice(0, 8)}`}
                    title="关闭会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(sid);
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      display: 'flex',
                      padding: 2,
                      flexShrink: 0,
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="history-item-time">
                {formatRelativeTime(session.last_active_at)} · {session.turn_count} 轮 ·{' '}
                {session.status}
              </div>
            </div>
          );
        })}
        {hasMore && (
          <button
            type="button"
            onClick={() => void loadMoreSessions()}
            disabled={loadingMore}
            className="history-item"
            style={{
              width: '100%',
              border: 'none',
              background: 'transparent',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-stack)',
            }}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </div>
      <div className="panel-history-footer">共 {total} 个会话</div>
      <ConfirmDialog
        open={pendingSid !== null}
        title="关闭会话"
        message={`确认关闭会话 ${pendingSid ? `${pendingSid.slice(0, 8)}…` : ''}？关闭后不可再对话，历史消息与文件仍可查看。`}
        confirmLabel="关闭会话"
        onConfirm={confirmClose}
        onCancel={cancelClose}
      />
    </aside>
  );
}
