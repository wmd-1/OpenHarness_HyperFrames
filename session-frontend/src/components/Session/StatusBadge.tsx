// 会话状态徽章（task 7.8）：颜色编码 + 中文标签。

import type { SessionStatus } from '../../types/session';

const STATUS_META: Record<SessionStatus, { label: string; className: string }> = {
  creating: { label: '创建中', className: 'bg-warn/15 text-warn' },
  live: { label: '活跃', className: 'bg-ok/15 text-ok' },
  idle: { label: '空闲', className: 'bg-accent/15 text-accent' },
  cold: { label: '休眠', className: 'bg-muted/15 text-muted' },
  closed: { label: '已关闭', className: 'bg-muted/15 text-muted' },
  expired: { label: '已过期', className: 'bg-err/15 text-err' },
  failed: { label: '失败', className: 'bg-err/15 text-err' },
};

export function StatusBadge({ status, size = 'sm' }: { status: SessionStatus; size?: 'sm' | 'xs' }) {
  const meta = STATUS_META[status] ?? { label: status, className: 'bg-muted/15 text-muted' };
  const sizeCls = size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${sizeCls} ${meta.className}`}
      data-status={status}
    >
      {meta.label}
    </span>
  );
}
