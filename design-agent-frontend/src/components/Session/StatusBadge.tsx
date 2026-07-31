// 会话状态徽章（task 7.8）：颜色编码 + 中文标签。
// F1.6：增「只读」「不可恢复」语义变体（variant 优先于 status 渲染）。

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

/** 语义变体（F1.5/F1.6）：read_only=true →「只读」；resumable=false 且非只读 →「不可恢复」。 */
const VARIANT_META = {
  readonly: { label: '只读', className: 'bg-muted/15 text-muted' },
  unrecoverable: { label: '不可恢复', className: 'bg-err/15 text-err' },
} as const;

export type StatusBadgeVariant = keyof typeof VARIANT_META;

export function StatusBadge({
  status,
  variant,
  size = 'sm',
}: {
  status?: SessionStatus;
  variant?: StatusBadgeVariant;
  size?: 'sm' | 'xs';
}) {
  const meta = variant
    ? VARIANT_META[variant]
    : ((status && STATUS_META[status]) ?? {
        label: status ?? '未知',
        className: 'bg-muted/15 text-muted',
      });
  const sizeCls = size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${sizeCls} ${meta.className}`}
      data-status={status}
      data-variant={variant}
    >
      {meta.label}
    </span>
  );
}
