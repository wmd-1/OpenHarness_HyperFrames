// 全局错误横幅（task 7.10）：info/warning/error/fatal 分级；fatal 不可关闭。

import { AlertTriangle, Info, OctagonAlert, X, XCircle } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import type { BannerLevel } from '../../store/uiStore';

const LEVEL_META: Record<
  BannerLevel,
  { className: string; Icon: typeof Info }
> = {
  info: { className: 'bg-accent/10 text-accent border-accent/30', Icon: Info },
  warning: { className: 'bg-warn/10 text-warn border-warn/30', Icon: AlertTriangle },
  error: { className: 'bg-err/10 text-err border-err/30', Icon: XCircle },
  fatal: { className: 'bg-err text-accent-fg border-err', Icon: OctagonAlert },
};

export function ErrorBanner() {
  const banner = useUiStore((s) => s.banner);
  const dismissBanner = useUiStore((s) => s.dismissBanner);
  if (!banner) return null;

  const { className, Icon } = LEVEL_META[banner.level];
  return (
    <div
      role="alert"
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${className}`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1">{banner.text}</span>
      {banner.closable && (
        <button
          type="button"
          onClick={dismissBanner}
          aria-label="关闭提示"
          className="rounded p-0.5 hover:opacity-70"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
