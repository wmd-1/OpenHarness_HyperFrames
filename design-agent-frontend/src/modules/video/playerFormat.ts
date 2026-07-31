// 播放器纯函数/常量（从 CustomVideoPlayer 拆出，便于单测且满足 react-refresh）。

/** 控制条自动隐藏延迟（demo 同款 3s）。 */
export const CONTROLS_HIDE_DELAY_MS = 3000;

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** mm:ss 时间显示（秒向下取整；分钟可超 60 不进位小时，与 demo 一致）。 */
export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
