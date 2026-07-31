// 单条消息气泡（task 8.3）：用户 / 助手 / 系统 / 工具四种角色。

import { memo } from 'react';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import type { Message } from '../../types/conversation';
import { formatClock } from '../../utils/format';
import { VideoPlayer } from '../Artifact/VideoPlayer';
import { AssistantStream } from './AssistantStream';
import { ToolCallCard } from './ToolCallCard';

const SYSTEM_META = {
  info: { Icon: Info, className: 'text-accent' },
  warning: { Icon: AlertTriangle, className: 'text-warn' },
  error: { Icon: XCircle, className: 'text-err' },
} as const;

export const MessageBubble = memo(function MessageBubble({
  message,
  sid,
}: {
  message: Message;
  sid: string;
}) {
  if (message.kind === 'tool') {
    return (
      <div className="px-4">
        <ToolCallCard toolCall={message.toolCall} />
      </div>
    );
  }

  if (message.kind === 'system') {
    const { Icon, className } = SYSTEM_META[message.level];
    return (
      <div className={`flex items-center justify-center gap-1.5 px-4 py-1 text-xs ${className}`}>
        <Icon size={12} />
        {message.text}
      </div>
    );
  }

  if (message.kind === 'user') {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="bg-user-bubble text-user-bubble-fg max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 md:max-w-[70%]">
          <p className="text-sm whitespace-pre-wrap">{message.text}</p>
          <p className="mt-0.5 text-right text-[10px] opacity-60">
            {formatClock(message.createdAt)}
          </p>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="bg-assistant-bubble border-line max-w-[85%] rounded-2xl rounded-bl-sm border px-3.5 py-2 md:max-w-[70%]">
        <AssistantStream text={message.text} streaming={message.streaming} />
        {message.hasArtifact && <VideoPlayer sid={sid} turnIndex={message.turnIndex} />}
        {!message.streaming && (
          <p className="text-muted mt-0.5 text-[10px]">{formatClock(message.createdAt)}</p>
        )}
      </div>
    </div>
  );
});
