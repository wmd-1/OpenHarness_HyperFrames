// 会话列表侧栏：新建按钮 + 手动刷新 + 会话卡片列表 + 加载更多（F1.2/F1.3）。

import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { useCloseSession } from '../../hooks/useCloseSession';
import { loadMoreSessions, refreshSessionList } from '../../hooks/useSessionList';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { SessionCard } from '../Session/SessionCard';

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const currentId = useSessionStore((s) => s.currentId);
  const loading = useSessionStore((s) => s.loading);
  const loadingMore = useSessionStore((s) => s.loadingMore);
  const hasMore = useSessionStore((s) => s.hasMore);
  const selectSession = useSessionStore((s) => s.selectSession);
  const setCreateDialogOpen = useUiStore((s) => s.setCreateDialogOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  // 关闭会话：确认 → 关闭成功后保留只读（F1.8），失败回滚 + 错误横幅
  const { pendingSid, requestClose, confirmClose, cancelClose } = useCloseSession();

  const handleSelect = (sid: string) => {
    selectSession(sid);
    // 移动端选中后收起抽屉
    setSidebarOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="bg-accent text-accent-fg flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} />
          新建会话
        </button>
        <button
          type="button"
          onClick={() => void refreshSessionList()}
          disabled={loading}
          aria-label="刷新会话列表"
          title="刷新会话列表"
          className="border-line text-muted hover:text-fg rounded-lg border p-2 disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {loading && order.length === 0 && (
          <div className="text-muted flex items-center justify-center gap-2 py-4 text-xs">
            <Loader2 size={14} className="animate-spin" />
            加载会话列表…
          </div>
        )}
        {!loading && order.length === 0 && (
          <p className="text-muted py-8 text-center text-xs">暂无会话，点击上方按钮创建</p>
        )}
        {order.map((sid) => {
          const session = sessions[sid];
          if (!session) return null;
          return (
            <SessionCard
              key={sid}
              session={session}
              active={sid === currentId}
              onSelect={handleSelect}
              onClose={requestClose}
            />
          );
        })}
        {hasMore && (
          <button
            type="button"
            onClick={() => void loadMoreSessions()}
            disabled={loadingMore}
            className="border-line text-muted hover:text-fg flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-xs disabled:opacity-50"
          >
            {loadingMore && <Loader2 size={12} className="animate-spin" />}
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={pendingSid !== null}
        title="关闭会话"
        message={`确认关闭会话 ${pendingSid ? `${pendingSid.slice(0, 8)}…` : ''}？关闭后不可再对话，历史消息与文件仍可查看。`}
        confirmLabel="关闭会话"
        onConfirm={confirmClose}
        onCancel={cancelClose}
      />
    </div>
  );
}
