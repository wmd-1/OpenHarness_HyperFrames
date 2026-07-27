// 服务健康状态徽章（task 7.9）：绿=正常 / 红=异常 / 灰=未知。

import { Activity } from 'lucide-react';
import type { HealthState } from '../../hooks/useHealth';

const HEALTH_META: Record<HealthState, { label: string; dot: string; text: string }> = {
  healthy: { label: '服务正常', dot: 'bg-ok', text: 'text-ok' },
  unhealthy: { label: '服务异常', dot: 'bg-err', text: 'text-err' },
  unknown: { label: '检测中', dot: 'bg-muted', text: 'text-muted' },
};

export function HealthBadge({ health }: { health: HealthState }) {
  const meta = HEALTH_META[health];
  return (
    <span
      className={`border-line bg-surface inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${meta.text}`}
      title={meta.label}
      data-health={health}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      <Activity size={12} />
      <span className="hidden sm:inline">{meta.label}</span>
    </span>
  );
}
