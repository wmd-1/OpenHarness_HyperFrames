// demo 会话时间展示工具（从 DemoHistoryPanel 拆出，SpacePace 复用；满足 react-refresh）。

import { formatRelativeTime } from '../../utils/format';

/** demo 种子时间为「今天 14:32」类文案，非 ISO 时原样展示。 */
export function displaySessionTime(value: string): string {
  return Number.isNaN(Date.parse(value)) ? value : formatRelativeTime(value);
}
