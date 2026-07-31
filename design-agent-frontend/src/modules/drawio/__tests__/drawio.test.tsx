// Drawio 模块单测：缩放纯函数 + 示例图表渲染/序列化 + 下载合法性。

import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSvg } from '../svgExport';
import {
  SAMPLE_DIAGRAM_HEIGHT,
  SAMPLE_DIAGRAM_NAME,
  SAMPLE_DIAGRAM_WIDTH,
  SampleDiagram,
} from '../sampleDiagram';
import {
  DRAWIO_ZOOM_MAX,
  DRAWIO_ZOOM_MIN,
  DRAWIO_ZOOM_STEP,
  clampZoom,
  fitZoom,
  stepZoom,
} from '../zoom';

afterEach(() => cleanup());

describe('zoom 纯函数', () => {
  it('stepZoom 按步长 15 增减', () => {
    expect(stepZoom(100, 1)).toBe(100 + DRAWIO_ZOOM_STEP);
    expect(stepZoom(100, -1)).toBe(100 - DRAWIO_ZOOM_STEP);
  });

  it('stepZoom 限幅 30~300', () => {
    expect(stepZoom(DRAWIO_ZOOM_MIN, -1)).toBe(DRAWIO_ZOOM_MIN);
    expect(stepZoom(35, -1)).toBe(DRAWIO_ZOOM_MIN);
    expect(stepZoom(DRAWIO_ZOOM_MAX, 1)).toBe(DRAWIO_ZOOM_MAX);
    expect(stepZoom(295, 1)).toBe(DRAWIO_ZOOM_MAX);
  });

  it('clampZoom 边界', () => {
    expect(clampZoom(0)).toBe(DRAWIO_ZOOM_MIN);
    expect(clampZoom(1000)).toBe(DRAWIO_ZOOM_MAX);
    expect(clampZoom(150)).toBe(150);
  });

  it('fitZoom 采用 demo 公式：(容器-48)/viewBox 取小者', () => {
    // (748-48)/700 = 1.0, (468-48)/420 = 1.0 → 100%
    expect(fitZoom(748, 468, 700, 420)).toBe(100);
    // 宽受限：(398-48)/700 = 0.5 → 50%
    expect(fitZoom(398, 1000, 700, 420)).toBe(50);
    // 过小容器限幅到 30
    expect(fitZoom(100, 100, 700, 420)).toBe(DRAWIO_ZOOM_MIN);
    // 超大容器限幅到 300
    expect(fitZoom(10000, 10000, 700, 420)).toBe(DRAWIO_ZOOM_MAX);
  });
});

describe('SampleDiagram', () => {
  it('渲染 700×420 viewBox 且序列化为合法 SVG 文本', () => {
    const ref = createRef<SVGSVGElement>();
    render(<SampleDiagram ref={ref} scale={1} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current!.getAttribute('viewBox')).toBe(
      `0 0 ${SAMPLE_DIAGRAM_WIDTH} ${SAMPLE_DIAGRAM_HEIGHT}`,
    );
    const serialized = new XMLSerializer().serializeToString(ref.current!);
    expect(serialized).toContain('<svg');
    expect(serialized).toContain('信贷审批流程');
    expect(serialized).toContain('marker');
    expect(SAMPLE_DIAGRAM_NAME).toBe('信贷审批流程.drawio');
  });

  it('scale 属性驱动 transform', () => {
    const ref = createRef<SVGSVGElement>();
    render(<SampleDiagram ref={ref} scale={1.3} />);
    expect(ref.current!.style.transform).toBe('scale(1.3)');
  });
});

describe('downloadSvg', () => {
  it('序列化 → Blob(image/svg+xml) → a[download=diagram.svg]', () => {
    const ref = createRef<SVGSVGElement>();
    render(<SampleDiagram ref={ref} scale={1} />);

    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });

    try {
      downloadSvg(ref.current!);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(blob?.type).toContain('image/svg+xml');
      expect(clicked).toHaveLength(1);
      expect(clicked[0].download).toBe('diagram.svg');
      expect(clicked[0].href).toContain('blob:mock');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
