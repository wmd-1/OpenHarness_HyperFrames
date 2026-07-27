// 消息列表（task 8.2）：@tanstack/react-virtual 虚拟滚动 +
// 新消息自动吸底（用户上翻时暂停吸底）。

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '../../types/conversation';
import { MessageBubble } from './MessageBubble';

export function MessageList({ messages, sid }: { messages: Message[]; sid: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在底部（决定新消息是否自动吸底）。 */
  const pinnedRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => messages[index].id,
  });

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // 新消息 / 流式追加时吸底
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    if (!pinnedRef.current || messages.length === 0) return;
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, lastMessage, virtualizer]);

  if (messages.length === 0) {
    return (
      <div className="text-muted flex flex-1 items-center justify-center text-sm">
        发送第一条消息开始对话
      </div>
    );
  }

  return (
    <div ref={parentRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <MessageBubble message={messages[item.index]} sid={sid} />
          </div>
        ))}
      </div>
    </div>
  );
}
