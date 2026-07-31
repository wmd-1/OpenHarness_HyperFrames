// SVG 导出工具（从 DiagramCanvas 拆出，便于单测且满足 react-refresh）。

/** 序列化当前 SVG 并触发下载（demo drawioDownload：XMLSerializer → Blob → a[download]）。 */
export function downloadSvg(svg: SVGSVGElement, filename = 'diagram.svg'): void {
  const source = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
