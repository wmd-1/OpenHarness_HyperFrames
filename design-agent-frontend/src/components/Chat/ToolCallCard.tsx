// 工具调用折叠卡片（task 8.5）：名称 + 输入摘要 + 状态图标 + 展开详情。

import { memo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react';
import type { ToolCall } from '../../types/conversation';
import { truncate } from '../../utils/format';

function inputSummary(input: Record<string, unknown> | null): string {
  if (!input) return '';
  try {
    return truncate(JSON.stringify(input), 80);
  } catch {
    return '';
  }
}

export const ToolCallCard = memo(function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const StatusIcon =
    toolCall.status === 'running' ? (
      <Loader2 size={13} className="text-warn animate-spin" />
    ) : toolCall.status === 'success' ? (
      <CheckCircle2 size={13} className="text-ok" />
    ) : (
      <XCircle size={13} className="text-err" />
    );

  return (
    <div className="border-line bg-raised/60 my-1 rounded-lg border text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className="text-muted shrink-0" />
        <code className="text-fg font-mono font-medium">{toolCall.toolName}</code>
        <span className="text-muted min-w-0 flex-1 truncate font-mono">
          {inputSummary(toolCall.input)}
        </span>
        {StatusIcon}
      </button>
      {expanded && (
        <div className="border-line space-y-2 border-t px-2.5 py-2">
          {toolCall.input && (
            <div>
              <p className="text-muted mb-1">输入</p>
              <pre className="bg-surface border-line overflow-x-auto rounded border p-2 font-mono">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.output != null && (
            <div>
              <p className="text-muted mb-1">输出</p>
              <pre
                className={`bg-surface border-line max-h-48 overflow-auto rounded border p-2 font-mono whitespace-pre-wrap ${
                  toolCall.status === 'error' ? 'text-err' : ''
                }`}
              >
                {toolCall.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
