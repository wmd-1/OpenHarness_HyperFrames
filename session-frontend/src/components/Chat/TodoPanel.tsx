// TODO 面板（task 8.6）：可折叠 + GFM 任务列表渲染 + 进度显示。
// 已完成项（- [x]）通过自定义 li 渲染器加删除线（A8）。

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownLink } from './MarkdownLink';

/** 从 markdown 中统计 - [ ] / - [x] 复选框进度。 */
function parseProgress(markdown: string): { done: number; total: number } {
  const done = (markdown.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
  const open = (markdown.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

/** GFM 任务列表：已勾选项加删除线 + 降低不透明度；链接走 MarkdownLink（B5）。 */
const todoComponents: Components = {
  a: MarkdownLink,
  li({ node, className, children, ...rest }) {
    const checked = node?.children.some(
      (child) =>
        child.type === 'element' &&
        child.tagName === 'input' &&
        Boolean(child.properties?.checked),
    );
    return (
      <li {...rest} className={`${className ?? ''}${checked ? ' line-through opacity-60' : ''}`}>
        {children}
      </li>
    );
  },
};

export function TodoPanel({ markdown }: { markdown: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const progress = useMemo(() => parseProgress(markdown), [markdown]);

  if (!markdown.trim()) return null;

  return (
    <div className="border-line bg-surface border-b">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
      >
        <ListTodo size={14} className="text-accent" />
        <span className="text-fg font-medium">任务清单</span>
        {progress.total > 0 && (
          <>
            <span className="text-muted text-xs">
              {progress.done}/{progress.total}
            </span>
            <span className="bg-raised h-1.5 w-24 overflow-hidden rounded-full">
              <span
                className="bg-ok block h-full rounded-full transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </span>
          </>
        )}
        <span className="text-muted ml-auto">
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>
      {!collapsed && (
        <div className="markdown-body max-h-48 overflow-y-auto px-4 pb-3 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={todoComponents}>
            {markdown}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
