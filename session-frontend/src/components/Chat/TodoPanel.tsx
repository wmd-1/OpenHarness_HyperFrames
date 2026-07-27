// TODO 面板（task 8.6）：可折叠 + markdown 复选框解析 + 进度显示。

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

/** 从 markdown 中统计 - [ ] / - [x] 复选框进度。 */
function parseProgress(markdown: string): { done: number; total: number } {
  const done = (markdown.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
  const open = (markdown.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

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
          <ReactMarkdown>{markdown}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
