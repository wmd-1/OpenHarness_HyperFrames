// ApprovalModal 集成测试（task 12.7）：三类审批弹窗的决策提交、
// 键盘交互（Escape 拒绝）、request_id 缺失兜底。

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalModal } from '../ApprovalModal';
import { useConversationStore } from '../../../store/conversationStore';
import type { ApprovalModal as ApprovalModalPayload, ApprovalRequestFrame } from '../../../types/ws';

const SID = 's1';

const makeApproval = (modal: ApprovalModalPayload | null, requestId: string | null = 'r1') =>
  ({
    type: 'approval_request',
    request_id: requestId,
    modal,
    turn_index: 0,
  }) satisfies ApprovalRequestFrame;

beforeEach(() => {
  localStorage.clear();
  useConversationStore.setState({ conversations: {} });
});

describe('ApprovalModal / permission', () => {
  it('允许一次 → approve(id, true, once)', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({ kind: 'permission', tool_name: 'bash', reason: '执行命令' })}
        approve={approve}
      />,
    );
    expect(screen.getByText('bash')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    expect(approve).toHaveBeenCalledWith('r1', true, 'once', undefined);
  });

  it('始终允许 → reply=always', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal sessionId={SID} approval={makeApproval({ kind: 'permission' })} approve={approve} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /始终允许/ }));
    expect(approve).toHaveBeenCalledWith('r1', true, 'always', undefined);
  });

  it('Escape 键 → 拒绝', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal sessionId={SID} approval={makeApproval({ kind: 'permission' })} approve={approve} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(approve).toHaveBeenCalledWith('r1', false, 'reject', undefined);
  });

  it('modal 缺失时回退 permission 弹窗', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(<ApprovalModal sessionId={SID} approval={makeApproval(null)} approve={approve} />);
    expect(screen.getByRole('button', { name: /允许一次/ })).toBeInTheDocument();
  });
});

describe('ApprovalModal / edit_diff', () => {
  it('渲染路径与 diff 内容，允许本次修改 → reply=once', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({
          kind: 'edit_diff',
          path: '/tmp/a.py',
          diff: '@@ -1 +1 @@\n-old\n+new',
          added: 1,
          removed: 1,
        })}
        approve={approve}
      />,
    );
    expect(screen.getByText('/tmp/a.py')).toBeInTheDocument();
    expect(screen.getByTestId('diff-content')).toHaveTextContent('+new');
    fireEvent.click(screen.getByRole('button', { name: /允许本次修改/ }));
    expect(approve).toHaveBeenCalledWith('r1', true, 'once', undefined);
  });
});

describe('ApprovalModal / question', () => {
  it('输入回答后提交 → approve(id, true, undefined, answer)', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({ kind: 'question', question: '选哪个方案？' })}
        approve={approve}
      />,
    );
    expect(screen.getByText('选哪个方案？')).toBeInTheDocument();
    const submitBtn = screen.getByRole('button', { name: /提交回答/ });
    expect(submitBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '方案 A' } });
    fireEvent.click(submitBtn);
    expect(approve).toHaveBeenCalledWith('r1', true, undefined, '方案 A');
  });

  it('Enter 直接提交回答', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({ kind: 'question', question: 'Q' })}
        approve={approve}
      />,
    );
    const textarea = screen.getByLabelText('回答');
    fireEvent.change(textarea, { target: { value: '答案' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(approve).toHaveBeenCalledWith('r1', true, undefined, '答案');
  });
});

describe('ApprovalModal / 异常兜底', () => {
  it('request_id 缺失：本地关闭 + 错误系统消息，不调用 approve', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({ kind: 'permission' }, null)}
        approve={approve}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    expect(approve).not.toHaveBeenCalled();
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.pendingApproval).toBeNull();
    expect(conv.messages.at(-1)).toMatchObject({ kind: 'system', level: 'error' });
  });

  it('modal.request_id 兜底顶层缺失的 request_id', () => {
    const approve = vi.fn().mockReturnValue(true);
    render(
      <ApprovalModal
        sessionId={SID}
        approval={makeApproval({ kind: 'permission', request_id: 'r-modal' }, null)}
        approve={approve}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    expect(approve).toHaveBeenCalledWith('r-modal', true, 'once', undefined);
  });

  it('approve 返回 false（连接未就绪）时写入错误提示', () => {
    const approve = vi.fn().mockReturnValue(false);
    render(
      <ApprovalModal sessionId={SID} approval={makeApproval({ kind: 'permission' })} approve={approve} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    const conv = useConversationStore.getState().conversations[SID];
    expect(conv.messages.at(-1)).toMatchObject({ kind: 'system', level: 'error' });
  });
});
