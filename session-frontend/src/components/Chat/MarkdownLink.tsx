// Markdown 链接渲染器（B5）：新窗口打开 + rel 防护 + 外链图标，
// 避免 agent 输出的链接在当前窗口覆盖会话页面 / window.opener 泄露。

import type { AnchorHTMLAttributes } from 'react';
import { ExternalLink } from 'lucide-react';

export function MarkdownLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={12} className="ml-0.5 inline-block align-baseline" aria-hidden="true" />
    </a>
  );
}
