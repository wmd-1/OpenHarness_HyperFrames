// Drawio 画布缩放纯函数（demo drawioZoom/drawioFit 逻辑移植，供单测）。

export const DRAWIO_ZOOM_MIN = 30;
export const DRAWIO_ZOOM_MAX = 300;
export const DRAWIO_ZOOM_STEP = 15;

export function clampZoom(value: number): number {
  return Math.min(DRAWIO_ZOOM_MAX, Math.max(DRAWIO_ZOOM_MIN, value));
}

/** 步进缩放（demo drawioZoom：dir=±1，步长 15，限幅 30~300）。 */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(current + dir * DRAWIO_ZOOM_STEP);
}

/**
 * 适应屏幕（demo drawioFit）：
 * scale = min((容器宽-padding)/viewBox宽, (容器高-padding)/viewBox高)，
 * 百分比四舍五入后限幅。
 */
export function fitZoom(
  containerWidth: number,
  containerHeight: number,
  viewBoxWidth: number,
  viewBoxHeight: number,
  padding = 48,
): number {
  const scale = Math.min(
    (containerWidth - padding) / viewBoxWidth,
    (containerHeight - padding) / viewBoxHeight,
  );
  return clampZoom(Math.round(scale * 100));
}
