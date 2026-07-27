// 会话详情头（task 7.6）：ID + 状态 + 策略 + 轮次 + 创建/活跃时间。

import { Bot, Copy, ShieldCheck } from 'lucide-react';
import type { Session } from '../../types/session';
import { formatRelativeTime } from '../../utils/format';
import { StatusBadge } from './StatusBadge';

export function SessionDetail({ session }: { session: Session }) {
  const interactive = session.permission_policy === 'interactive';
  const PolicyIcon = interactive ? ShieldCheck : Bot;

  const copyId = () => {
    void navigator.clipboard?.writeText(session.session_id);
  };

  return (
    <div className="border-line bg-surface flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-sm">
      <span className="flex items-center gap-1.5">
        <code className="text-fg font-mono text-xs" title={session.session_id}>
          {session.session_id.slice(0, 12)}…
        </code>
        <button
          type="button"
          onClick={copyId}
          aria-label="复制会话 ID"
          className="text-muted hover:text-fg rounded p-0.5"
        >
          <Copy size={12} />
        </button>
      </span>
      <StatusBadge status={session.status} />
      <span className="text-muted flex items-center gap-1 text-xs">
        <PolicyIcon size={12} />
        {interactive ? '交互审批' : '全自动'}
      </span>
      <span className="text-muted text-xs">轮次 {session.turn_count}</span>
      <span className="text-muted ml-auto hidden text-xs sm:inline">
        创建于 {formatRelativeTime(session.created_at)} · 活跃于{' '}
        {formatRelativeTime(session.last_active_at)}
      </span>
    </div>
  );
}
