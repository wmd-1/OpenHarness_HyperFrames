// 流式助手回复渲染（task 8.4）：react-markdown（GFM 表格/删除线/任务列表）+ 流式打字光标。
// 批量 flush（50ms/384 字符）在 useWebSocket 的 StreamBuffer 完成，
// 这里只负责渲染已 flush 的文本。

import { memo, useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownLink } from './MarkdownLink';

// 链接统一走 MarkdownLink（新窗口 + noopener，B5）
const mdComponents = { a: MarkdownLink };

export const AssistantStream = memo(function AssistantStream({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  // 长文本流式期间 Markdown 重渲染降优先级，避免阻塞输入响应（C2）
  const deferredText = useDeferredValue(text);
  return (
    <div className={`markdown-body text-sm leading-relaxed ${streaming ? 'typing-cursor' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {deferredText}
      </ReactMarkdown>
    </div>
  );
});
