// 原型页面设计源码视图单测：行数/行号/转义/高亮。

import { describe, expect, it } from 'vitest';
import {
  SAMPLE_CSS_CODE,
  SAMPLE_HTML_CODE,
  highlightLine,
  renderCodeHtml,
} from '../previewCode';

describe('highlightLine', () => {
  it('注释行整行包裹 code-comment（html 注释 / css 块注释 / 行注释）', () => {
    expect(highlightLine('<!-- 头部 -->', 'html')).toBe(
      '<span class="code-comment">&lt;!-- 头部 --&gt;</span>',
    );
    expect(highlightLine('  /* 内部样式 */', 'css')).toContain('code-comment');
    expect(highlightLine('// note', 'css')).toContain('code-comment');
  });

  it('html 行先转义再高亮：标签/属性/值', () => {
    const out = highlightLine('<div class="header">', 'html');
    expect(out).not.toContain('<div'); // 已转义
    expect(out).toContain('<span class="code-tag">&lt;div</span>');
    expect(out).toContain('<span class="code-attr">class</span>');
    expect(out).toContain('<span class="code-val">"header"</span>');
  });

  it('css 行高亮：变量/色值/px 数值', () => {
    expect(highlightLine('  --accent: #1a56db;', 'css')).toContain(
      '<span class="code-key">--accent</span>',
    );
    expect(highlightLine('  color: #fff;', 'css')).toContain('<span class="code-str">#fff</span>');
    expect(highlightLine('  width: 240px;', 'css')).toContain(
      '<span class="code-num">240px</span>',
    );
  });

  it('普通行转义特殊字符', () => {
    expect(highlightLine('a & b', 'css')).toBe('a &amp; b');
  });
});

describe('renderCodeHtml', () => {
  it('输出行数与源码一致且行号递增', () => {
    const htmlLines = SAMPLE_HTML_CODE.split('\n');
    const out = renderCodeHtml('html');
    expect(out.split('\n')).toHaveLength(htmlLines.length);
    expect(out).toContain('<span class="code-line-num">1</span>');
    expect(out).toContain(`<span class="code-line-num">${htmlLines.length}</span>`);
  });

  it('css 源码同样带行号', () => {
    const out = renderCodeHtml('css');
    expect(out.split('\n')).toHaveLength(SAMPLE_CSS_CODE.split('\n').length);
    expect(out).toContain('code-line-num');
    expect(out).toContain('code-key');
  });
});
