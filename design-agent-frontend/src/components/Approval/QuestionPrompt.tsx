// question 回答弹窗（task 10.4）：问题文本 + 输入框；Enter 提交、Shift+Enter 换行。

import { useState } from 'react';
import { MessageCircleQuestion, Send, X } from 'lucide-react';
import type { ApprovalModal } from '../../types/ws';
import type { ApprovalDecision } from './approvalTypes';

export interface QuestionPromptProps {
  modal: ApprovalModal;
  onDecide: ApprovalDecision;
}

export function QuestionPrompt({ modal, onDecide }: QuestionPromptProps) {
  const [answer, setAnswer] = useState('');

  const submit = () => {
    const text = answer.trim();
    if (!text) return;
    onDecide(true, undefined, text);
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        <MessageCircleQuestion size={20} className="text-accent mt-0.5 shrink-0" />
        <p className="text-fg min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed font-medium">
          {modal.question ?? '（问题内容缺失）'}
        </p>
      </div>

      <textarea
        autoFocus
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={4}
        placeholder="输入回答…（Enter 提交，Shift+Enter 换行）"
        aria-label="回答"
        className="bg-base border-line focus:border-accent mt-4 w-full resize-y rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none"
      />

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => onDecide(false, 'reject')}
          className="border-line text-err hover:bg-err/10 flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm"
        >
          <X size={14} />
          拒绝回答
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!answer.trim()}
          className="bg-accent text-accent-fg flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
        >
          <Send size={14} />
          提交回答
        </button>
      </div>
    </div>
  );
}
