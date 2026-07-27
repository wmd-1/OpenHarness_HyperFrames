// 流式助手回复渲染（task 8.4）：react-markdown + 流式打字光标。
// 批量 flush（50ms/384 字符）在 useWebSocket 的 StreamBuffer 完成，
// 这里只负责渲染已 flush 的文本。

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';

export const AssistantStream = memo(function AssistantStream({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div className={`markdown-body text-sm leading-relaxed ${streaming ? 'typing-cursor' : ''}`}>
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
});
