// 原型页面设计预览面板（demo panel-preview 同款）：
// 网页/手机/平板三种设备帧 + 源码视图（HTML/CSS tab + 行号高亮）。

import { useState } from 'react';
import { renderCodeHtml, type CodeLang } from './previewCode';

export type PreviewDevice = 'web' | 'phone' | 'tablet' | 'code';

const DEVICES: { id: PreviewDevice; label: string; icon: JSX.Element }[] = [
  {
    id: 'web',
    label: '网页',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'phone',
    label: '手机',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    ),
  },
  {
    id: 'tablet',
    label: '平板',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    ),
  },
  {
    id: 'code',
    label: '源码',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
];

export function UiPreviewPanel({ expanded }: { expanded: boolean }) {
  const [device, setDevice] = useState<PreviewDevice>('web');
  const [codeTab, setCodeTab] = useState<CodeLang>('html');

  return (
    <div className={`panel-preview${expanded ? ' expanded' : ''}`} aria-label="界面预览面板">
      <div className="preview-header">
        <div className="preview-title">界面预览</div>
        <div className="preview-devices">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`btn-device${device === d.id ? ' active' : ''}`}
              onClick={() => setDevice(d.id)}
            >
              {d.icon}
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="preview-body">
        {device === 'code' ? (
          <div className="preview-code visible">
            <div className="preview-code-bar">
              <button
                type="button"
                className={`preview-code-tab${codeTab === 'html' ? ' active' : ''}`}
                onClick={() => setCodeTab('html')}
              >
                HTML
              </button>
              <button
                type="button"
                className={`preview-code-tab${codeTab === 'css' ? ' active' : ''}`}
                onClick={() => setCodeTab('css')}
              >
                CSS
              </button>
            </div>
            <div
              className="preview-code-body"
              style={{ whiteSpace: 'pre' }}
              // 内容来自本模块静态常量（previewCode.ts），先转义再高亮，安全
              dangerouslySetInnerHTML={{ __html: renderCodeHtml(codeTab) }}
            />
          </div>
        ) : (
          <div className={`preview-frame device-${device}`}>
            {device === 'phone' ? (
              <div className="preview-frame-phone-bar">
                <div className="preview-frame-phone-notch" />
              </div>
            ) : (
              <div className="preview-frame-bar">
                <div className="preview-frame-dot" />
                <div className="preview-frame-dot" />
                <div className="preview-frame-dot" />
                <div className="preview-frame-url">https://design-agent.local/bank-home</div>
              </div>
            )}
            <div className="preview-frame-content">
              <div className="preview-placeholder-title">银行内部管理系统</div>
              <div className="preview-placeholder-text">
                此处将展示AI生成的网页界面预览效果。当设计智能体完成界面代码生成后，
                预览面板将实时渲染对应的HTML页面，支持网页、手机、平板三种设备视图切换。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
