// 个人空间标签工具（从 SpacePage 拆出，便于单测且满足 react-refresh）。

/** mediaType → 角标文案（demo thumb-type：HTML/SVG/MP4）。 */
export function thumbTypeLabel(mediaType: string): string {
  if (mediaType.includes('html')) return 'HTML';
  if (mediaType.includes('svg')) return 'SVG';
  if (mediaType.includes('mp4') || mediaType.startsWith('video/')) return 'MP4';
  return mediaType.split('/').pop()?.toUpperCase() ?? 'FILE';
}
