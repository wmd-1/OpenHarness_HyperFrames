// Drawio 图表画布（demo drawio-preview 移植）：
// 工具栏（步进缩放/适应屏幕/下载 SVG/全屏）+ 网格画布 + 状态栏。

import { useCallback, useRef, useState } from 'react';
import {
  SAMPLE_DIAGRAM_HEIGHT,
  SAMPLE_DIAGRAM_NAME,
  SAMPLE_DIAGRAM_WIDTH,
  SampleDiagram,
} from './sampleDiagram';
import { fitZoom, stepZoom } from './zoom';
import { downloadSvg } from './svgExport';

export function DiagramCanvas() {
  const [zoom, setZoom] = useState(100);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleFit = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    setZoom(
      fitZoom(content.clientWidth, content.clientHeight, SAMPLE_DIAGRAM_WIDTH, SAMPLE_DIAGRAM_HEIGHT),
    );
  }, []);

  const handleFullscreen = useCallback(() => {
    void wrapperRef.current?.requestFullscreen?.();
  }, []);

  return (
    <div className="drawio-preview" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="drawio-preview-header">
        <div className="drawio-preview-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <line x1="10" y1="6.5" x2="14" y2="6.5" />
            <line x1="6.5" y1="10" x2="6.5" y2="14" />
            <line x1="17.5" y1="10" x2="17.5" y2="14" />
            <line x1="10" y1="17.5" x2="14" y2="17.5" />
          </svg>
          图表预览
        </div>
        <div className="drawio-preview-toolbar">
          <div className="drawio-toolbar-group">
            <button
              type="button"
              className="btn-zoom"
              title="缩小"
              aria-label="缩小"
              onClick={() => setZoom((z) => stepZoom(z, -1))}
            >
              −
            </button>
            <span className="zoom-level">{zoom}%</span>
            <button
              type="button"
              className="btn-zoom"
              title="放大"
              aria-label="放大"
              onClick={() => setZoom((z) => stepZoom(z, 1))}
            >
              +
            </button>
            <button
              type="button"
              className="btn-zoom"
              title="适应屏幕"
              aria-label="适应屏幕"
              onClick={handleFit}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="btn-drawio-action"
            title="下载SVG文件"
            onClick={() => {
              if (svgRef.current) downloadSvg(svgRef.current);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="action-text">下载</span>
          </button>
          <button
            type="button"
            className="btn-drawio-action"
            title="全屏查看"
            onClick={handleFullscreen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
            <span className="action-text">全屏</span>
          </button>
        </div>
      </div>
      <div className="drawio-preview-body">
        <div className="drawio-canvas-wrapper" ref={wrapperRef}>
          <div className="drawio-canvas-grid" />
          <div className="drawio-canvas-content" ref={contentRef}>
            <SampleDiagram ref={svgRef} scale={zoom / 100} />
          </div>
          <div className="drawio-status-bar">
            <span>{SAMPLE_DIAGRAM_NAME}</span>
            <span>
              {SAMPLE_DIAGRAM_WIDTH} × {SAMPLE_DIAGRAM_HEIGHT}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
