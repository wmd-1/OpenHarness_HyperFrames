// 原型页面设计源码视图（demo loadCodeContent 逻辑移植）：
// 静态示例代码 + 行号 + 简易语法高亮。输入为本文件内静态常量，
// 高亮结果经 dangerouslySetInnerHTML 渲染是安全的（先转义再包 span）。
// 注：下方 SAMPLE_CSS_CODE 中的 --bg-page/--bg-module/--accent/--text-primary/
// --shadow-card 是「示例源码文本内容」（展示给用户看的样例），不是运行时样式，
// 故不随主题令牌统一而改（change: design-frontend-theme-unify-and-layout-tokens 任务 4.5）。

export const SAMPLE_HTML_CODE = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '  <meta charset="UTF-8">',
  '  <title>银行内部管理系统</title>',
  '  <style>',
  '    /* 内部样式 */',
  '    body { background: #eef1f5; }',
  '    .header { background: #fff; padding: 16px 24px; }',
  '    .nav { width: 240px; background: #fff; }',
  '    .card { background: #fff; border-radius: 10px; }',
  '  </style>',
  '</head>',
  '<body>',
  '  <div class="header">',
  '    <h1>银行内部管理系统</h1>',
  '  </div>',
  '  <div class="layout">',
  '    <nav class="nav">',
  '      <a href="#" class="nav-link active">首页</a>',
  '      <a href="#" class="nav-link">数据报表</a>',
  '      <a href="#" class="nav-link">审批流程</a>',
  '    </nav>',
  '    <main class="content">',
  '      <div class="card">',
  '        <h2>欢迎登录</h2>',
  '        <p>系统概览与待办事项</p>',
  '      </div>',
  '    </main>',
  '  </div>',
  '</body>',
  '</html>',
].join('\n');

export const SAMPLE_CSS_CODE = [
  '/* ========== 全局变量 ========== */',
  ':root {',
  '  --bg-page: #eef1f5;',
  '  --bg-module: #ffffff;',
  '  --accent: #1a56db;',
  '  --text-primary: #1f2937;',
  '  --shadow-card: 0 2px 8px rgba(0,0,0,0.06);',
  '}',
  '',
  '/* ========== 头部导航 ========== */',
  '.header {',
  '  background: var(--bg-module);',
  '  box-shadow: 0 1px 4px rgba(0,0,0,0.04);',
  '  padding: 16px 24px;',
  '  height: 56px;',
  '}',
  '',
  '/* ========== 侧边栏 ========== */',
  '.nav {',
  '  width: 240px;',
  '  background: var(--bg-module);',
  '  border-right: 1px solid #e2e6ec;',
  '}',
  '.nav-link {',
  '  color: #6b7280;',
  '  padding: 12px 20px;',
  '  transition: all 0.2s;',
  '}',
  '.nav-link.active {',
  '  color: var(--accent);',
  '  background: rgba(26,86,219,0.06);',
  '}',
  '',
  '/* ========== 内容卡片 ========== */',
  '.card {',
  '  background: var(--bg-module);',
  '  border-radius: 14px;',
  '  box-shadow: var(--shadow-card);',
  '  padding: 24px;',
  '}',
  '.card:hover {',
  '  transform: translateY(-2px);',
  '  box-shadow: 0 4px 16px rgba(0,0,0,0.08);',
  '}',
].join('\n');

export type CodeLang = 'html' | 'css';

function escapeHtml(line: string): string {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 单行简易高亮（demo 同款规则，改单遍替换避免命中已插入的 span；输入为静态常量）。 */
export function highlightLine(rawLine: string, lang: CodeLang): string {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith('<!--') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
    return `<span class="code-comment">${escapeHtml(rawLine)}</span>`;
  }
  const line = escapeHtml(rawLine);
  if (lang === 'html') {
    return line.replace(
      /(&lt;\/?[\w-]+)|([\w-]+)(?==)|"([^"]*)"/g,
      (_m, tag: string | undefined, attr: string | undefined, val: string | undefined) => {
        if (tag !== undefined) return `<span class="code-tag">${tag}</span>`;
        if (attr !== undefined) return `<span class="code-attr">${attr}</span>`;
        return `<span class="code-val">"${val ?? ''}"</span>`;
      },
    );
  }
  return line.replace(
    /(--[\w-]+)|(#\w+)|(\d+px)/g,
    (_m, key: string | undefined, color: string | undefined, num: string | undefined) => {
      if (key !== undefined) return `<span class="code-key">${key}</span>`;
      if (color !== undefined) return `<span class="code-str">${color}</span>`;
      return `<span class="code-num">${num ?? ''}</span>`;
    },
  );
}

/** 整段代码 → 带行号的高亮 HTML（preview-code-body 内容）。 */
export function renderCodeHtml(lang: CodeLang): string {
  const code = lang === 'html' ? SAMPLE_HTML_CODE : SAMPLE_CSS_CODE;
  return code
    .split('\n')
    .map((line, i) => `<span class="code-line-num">${i + 1}</span>${highlightLine(line, lang)}`)
    .join('\n');
}
