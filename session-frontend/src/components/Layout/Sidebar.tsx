// 会话列表侧栏（task 7.2）：新建按钮 + 会话卡片列表。

import { Loader2, Plus } from 'lucide-react';
import { useCloseSession } from '../../hooks/useCloseSession';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { SessionCard } from '../Session/SessionCard';

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const currentId = useSessionStore((s) => s.currentId);
  const loading = useSessionStore((s) => s.loading);
  const selectSession = useSessionStore((s) => s.selectSession);
  const setCreateDialogOpen = useUiStore((s) => s.setCreateDialogOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  // 关闭会话：确认 → 乐观置 closed → 失败回滚 + 错误横幅（A5）
  const { pendingSid, requestClose, confirmClose, cancelClose } = useCloseSession();

  const handleSelect = (sid: string) => {
    selectSession(sid);
    // 移动端选中后收起抽屉
    setSidebarOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="bg-accent text-accent-fg flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} />
          新建会话
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {loading && (
          <div className="text-muted flex items-center justify-center gap-2 py-4 text-xs">
            <Loader2 size={14} className="animate-spin" />
            恢复会话中…
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
      </div>
      <ConfirmDialog
        open={pendingSid !== null}
        title="关闭会话"
        message={`确认关闭会话 ${pendingSid ? `${pendingSid.slice(0, 8)}…` : ''}？关闭后不可恢复。`}
        confirmLabel="关闭会话"
        onConfirm={confirmClose}
        onCancel={cancelClose}
      />
    </div>
  );
}
