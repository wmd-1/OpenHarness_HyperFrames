// 会话卡片：title 主行 + 状态/语义徽章 + 权限策略 + 轮次数 + 相对时间（F1.5/F1.6）。
// 三态交互：可恢复（正常点击建连）/ 只读（点击回看历史，「只读」徽标）/
// 不可恢复（置灰 + tooltip，点击仅回显历史不建连）。

import { Bot, MessagesSquare, ShieldCheck, Trash2 } from 'lucide-react';
import type { Session } from '../../types/session';
import { canConnectSession, isReadonlySession } from '../../types/session';
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
  const readonly = isReadonlySession(session);
  // 置灰态：既不可建连也非只读（快照丢失的 cold）；仍可点击回显历史（F1.5）
  const unrecoverable = !canConnectSession(session) && !readonly;
  const title = session.title?.trim() ? session.title : `${sid.slice(0, 8)}…`;

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
      title={unrecoverable ? '会话暂不可恢复（快照缺失），仅可查看历史' : undefined}
      className={`group w-full cursor-pointer rounded-lg border p-3 text-left transition-colors ${
        active
          ? 'border-accent bg-accent/5'
          : 'border-line bg-surface hover:border-muted'
      } ${unrecoverable ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg truncate text-xs font-medium" title={session.title ?? sid}>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {readonly && <StatusBadge variant="readonly" size="xs" />}
          {unrecoverable && <StatusBadge variant="unrecoverable" size="xs" />}
          <StatusBadge status={session.status} size="xs" />
        </span>
      </div>
      <div className="text-muted mt-2 flex items-center gap-3 text-xs">
        {session.permission_policy !== undefined && (
          <span
            className="flex items-center gap-1"
            title={interactive ? '交互审批模式' : '全自动模式'}
          >
            <PolicyIcon size={12} />
            {interactive ? '交互' : '自动'}
          </span>
        )}
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
