// 输入栏（task 8.7）：多行输入 + Enter 发送 + Shift+Enter 换行 +
// `/` 命令补全 + 上下箭头历史导航 + 执行中显示中断按钮。

import { useEffect, useRef, useState } from 'react';
import { CircleStop, SendHorizontal } from 'lucide-react';
import { MAX_INPUT_LENGTH, SLASH_COMMANDS } from '../../utils/constants';

export interface InputBarProps {
  disabled: boolean;
  turnActive: boolean;
  history: string[];
  onSubmit: (text: string) => boolean;
  onInterrupt: () => void;
  placeholder?: string;
}

export function InputBar({
  disabled,
  turnActive,
  history,
  onSubmit,
  onInterrupt,
  placeholder,
}: InputBarProps) {
  const [text, setText] = useState('');
  // -1 = 未处于历史导航；否则为 history 下标
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // `/` 命令补全候选
  const slashMatches =
    text.startsWith('/') && !text.includes(' ')
      ? SLASH_COMMANDS.filter((c) => c.command.startsWith(text))
      : [];
  const [slashIndex, setSlashIndex] = useState(0);

  useEffect(() => {
    setSlashIndex(0);
  }, [text]);

  // 自适应高度（最多 8 行）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 8 * 24)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (onSubmit(trimmed)) {
      setText('');
      setHistoryIndex(-1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 命令补全导航
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        setText(slashMatches[slashIndex].command);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (slashMatches.length > 0 && text !== slashMatches[slashIndex].command) {
        setText(slashMatches[slashIndex].command);
        return;
      }
      submit();
      return;
    }

    // 历史导航：仅在光标位于首行/末行且无补全时生效
    if (e.key === 'ArrowUp' && history.length > 0) {
      const el = e.currentTarget;
      if (el.value.slice(0, el.selectionStart).includes('\n')) return;
      e.preventDefault();
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex === -1) setDraftBeforeHistory(text);
      setHistoryIndex(next);
      setText(history[next]);
    } else if (e.key === 'ArrowDown' && historyIndex !== -1) {
      const el = e.currentTarget;
      if (el.value.slice(el.selectionEnd).includes('\n')) return;
      e.preventDefault();
      if (historyIndex >= history.length - 1) {
        setHistoryIndex(-1);
        setText(draftBeforeHistory);
      } else {
        setHistoryIndex(historyIndex + 1);
        setText(history[historyIndex + 1]);
      }
    }
  };

  return (
    <div className="border-line bg-surface relative border-t p-3">
      {/* `/` 命令补全菜单 */}
      {slashMatches.length > 0 && (
        <ul
          role="listbox"
          aria-label="命令补全"
          className="border-line bg-surface absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border shadow-lg"
        >
          {slashMatches.map((c, i) => (
            <li key={c.command} role="option" aria-selected={i === slashIndex}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(c.command);
                  textareaRef.current?.focus();
                }}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${
                  i === slashIndex ? 'bg-accent/10 text-accent' : 'text-fg'
                }`}
              >
                <code className="font-mono">{c.command}</code>
                <span className="text-muted text-xs">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_INPUT_LENGTH))}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={placeholder ?? (turnActive ? '轮次执行中…' : '输入消息，/ 查看命令')}
          aria-label="消息输入"
          className="border-line bg-base focus:border-accent max-h-48 flex-1 resize-none rounded-xl border px-3.5 py-2.5 text-sm outline-none disabled:opacity-60"
        />
        {turnActive ? (
          <button
            type="button"
            onClick={onInterrupt}
            aria-label="中断当前轮次"
            className="bg-err/10 text-err hover:bg-err/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          >
            <CircleStop size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            aria-label="发送"
            className="bg-accent text-accent-fg flex h-10 w-10 shrink-0 items-center justify-center rounded-xl disabled:opacity-40"
          >
            <SendHorizontal size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
