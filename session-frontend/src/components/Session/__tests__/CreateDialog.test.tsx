// CreateDialog 集成测试（task 12.6）：表单校验、提交流程、错误处理。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateDialog } from '../CreateDialog';
import { createSession } from '../../../api/sessions';
import { useSessionStore } from '../../../store/sessionStore';
import { useUiStore } from '../../../store/uiStore';
import type { Session } from '../../../types/session';

vi.mock('../../../api/sessions', () => ({
  createSession: vi.fn(),
}));

const mockedCreateSession = vi.mocked(createSession);

const makeSession = (sid: string): Session => ({
  session_id: sid,
  status: 'creating',
  permission_policy: 'full_auto',
  turn_count: 0,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
});

beforeEach(() => {
  localStorage.clear();
  mockedCreateSession.mockReset();
  useSessionStore.setState({ sessions: {}, order: [], currentId: null, loading: false });
  useUiStore.setState({ banner: null, createDialogOpen: true, settingsOpen: false });
});

describe('CreateDialog', () => {
  it('createDialogOpen=false 时不渲染', () => {
    useUiStore.setState({ createDialogOpen: false });
    render(<CreateDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('非法高级参数即时报错并禁用创建按钮', () => {
    render(<CreateDialog />);
    fireEvent.click(screen.getByText('高级参数（可选）'));
    fireEvent.change(screen.getByLabelText('额外参数'), { target: { value: '--rm' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    // 修正后错误消失
    fireEvent.change(screen.getByLabelText('额外参数'), {
      target: { value: '--temperature 0.7' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });

  it('提交调用 createSession 并选中新会话、关闭对话框', async () => {
    mockedCreateSession.mockResolvedValue(makeSession('new-1'));
    render(<CreateDialog />);
    // 选择交互审批策略 + 合法高级参数
    fireEvent.click(screen.getByRole('radio', { name: /交互审批/ }));
    fireEvent.click(screen.getByText('高级参数（可选）'));
    fireEvent.change(screen.getByLabelText('额外参数'), {
      target: { value: '--max-turns 20' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mockedCreateSession).toHaveBeenCalledWith({
        permission_policy: 'interactive',
        extra_oh_args: ['--max-turns', '20'],
      });
    });
    await waitFor(() => {
      expect(useSessionStore.getState().currentId).toBe('new-1');
    });
    expect(useSessionStore.getState().order).toEqual(['new-1']);
    expect(useUiStore.getState().createDialogOpen).toBe(false);
  });

  it('提交失败展示后端错误且保持对话框打开', async () => {
    mockedCreateSession.mockRejectedValue(new Error('容量已满'));
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('容量已满');
    });
    expect(useUiStore.getState().createDialogOpen).toBe(true);
    expect(useSessionStore.getState().order).toEqual([]);
  });
});
