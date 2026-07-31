// demo 能力域历史面板（demo panel-history 同款结构；本地内存数据，刷新即重置）。

import type { SessionSummary } from '../../platform/types';
import { PlusIcon } from '../../shared/icons';
import { displaySessionTime } from './demoTime';

export interface DemoHistoryPanelProps {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
}

export function DemoHistoryPanel({
  sessions,
  currentId,
  onSelect,
  onCreate,
}: DemoHistoryPanelProps) {
  return (
    <aside className="panel-history" aria-label="历史会话">
      <div className="panel-history-header">
        <button type="button" className="btn-new-session" onClick={onCreate}>
          <PlusIcon />
          新建会话
        </button>
        <div className="panel-history-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          历史会话
        </div>
      </div>
      <div className="panel-history-list">
        {sessions.map((session) => (
          <div
            key={session.session_id}
            className={`history-item${session.session_id === currentId ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(session.session_id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(session.session_id);
              }
            }}
          >
            <div className="history-item-title">{session.title ?? session.session_id}</div>
            <div className="history-item-time">{displaySessionTime(session.created_at)}</div>
          </div>
        ))}
      </div>
      <div className="panel-history-footer">共 {sessions.length} 个会话 · 演示数据</div>
    </aside>
  );
}
