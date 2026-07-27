// 会话列表侧栏（task 7.2）：新建按钮 + 会话卡片列表。

import { Loader2, Plus } from 'lucide-react';
import { closeSession } from '../../api/sessions';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { SessionCard } from '../Session/SessionCard';

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const currentId = useSessionStore((s) => s.currentId);
  const loading = useSessionStore((s) => s.loading);
  const selectSession = useSessionStore((s) => s.selectSession);
  const patchSession = useSessionStore((s) => s.patchSession);
  const setCreateDialogOpen = useUiStore((s) => s.setCreateDialogOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

  const handleSelect = (sid: string) => {
    selectSession(sid);
    // 移动端选中后收起抽屉
    setSidebarOpen(false);
  };

  const handleClose = (sid: string) => {
    // 乐观更新为 closed；失败时保持原状态由后端下次 GET 纠正
    patchSession(sid, { status: 'closed' });
    void closeSession(sid).catch(() => undefined);
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
              onClose={handleClose}
            />
          );
        })}
      </div>
    </div>
  );
}
