// 会话卡片（task 7.5）：状态徽章 + 权限策略图标 + 轮次数 + 相对时间。

import { Bot, MessagesSquare, ShieldCheck, Trash2 } from 'lucide-react';
import type { Session } from '../../types/session';
import { formatRelativeTime } from '../../utils/format';
import { StatusBadge } from './StatusBadge';

export interface SessionCardProps {
  session: Session;
  active: boolean;
  onSelect: (sid: string) => void;
  onClose: (sid: string) => void;
}

export function SessionCard({ session, active, onSelect, onClose }: SessionCardProps) {
  const sid = session.session_id;
  const interactive = session.permission_policy === 'interactive';
  const PolicyIcon = interactive ? ShieldCheck : Bot;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(sid)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(sid);
        }
      }}
      aria-current={active}
      className={`group w-full cursor-pointer rounded-lg border p-3 text-left transition-colors ${
        active
          ? 'border-accent bg-accent/5'
          : 'border-line bg-surface hover:border-muted'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <code className="text-fg truncate font-mono text-xs" title={sid}>
          {sid.slice(0, 8)}…
        </code>
        <StatusBadge status={session.status} size="xs" />
      </div>
      <div className="text-muted mt-2 flex items-center gap-3 text-xs">
        <span
          className="flex items-center gap-1"
          title={interactive ? '交互审批模式' : '全自动模式'}
        >
          <PolicyIcon size={12} />
          {interactive ? '交互' : '自动'}
        </span>
        <span className="flex items-center gap-1" title="轮次数">
          <MessagesSquare size={12} />
          {session.turn_count}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {formatRelativeTime(session.last_active_at)}
          <button
            type="button"
            aria-label="关闭会话"
            onClick={(e) => {
              e.stopPropagation();
              onClose(sid);
            }}
            className="text-muted hover:text-err rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}
