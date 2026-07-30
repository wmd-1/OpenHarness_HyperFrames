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

// 隔离创建成功后的列表刷新副作用（避免真实 listSessions 请求）
vi.mock('../../../hooks/useSessionList', () => ({
  requestSessionListRefresh: vi.fn(),
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

  it('焦点圈定：初始焦点入框，Tab 在首尾循环（D5）', () => {
    render(<CreateDialog />);
    const closeBtn = screen.getByRole('button', { name: '关闭' });
    const createBtn = screen.getByRole('button', { name: '创建' });
    // 初始焦点落在第一个可聚焦元素
    expect(document.activeElement).toBe(closeBtn);
    // 末尾元素 Tab → 回到第一个
    createBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
    // 第一个元素 Shift+Tab → 到末尾
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(createBtn);
  });

  it('Escape 关闭对话框（D5）', () => {
    render(<CreateDialog />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUiStore.getState().createDialogOpen).toBe(false);
  });
});

// ---- 容器池四类错误映射（F4）----

/** 构造 ky HTTPError 形状的拒绝对象（errorStatus/extract* 只依赖 .response）。 */
function httpError(
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): { response: Response } {
  return {
    response: new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers,
    }),
  };
}

describe('CreateDialog 容器池错误映射（F4）', () => {
  it('429 频率限流（detail=Rate limit）→「请求过于频繁」', async () => {
    mockedCreateSession.mockRejectedValue(httpError(429, { detail: 'Rate limit exceeded' }));
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('请求过于频繁，请稍后再试');
    });
  });

  it('429 并发配额（detail=Concurrent session quota）→「并发会话已达上限」', async () => {
    mockedCreateSession.mockRejectedValue(
      httpError(429, { detail: 'Concurrent session quota exceeded' }),
    );
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/并发会话已达上限/);
    });
  });

  it('403 daily_quota_exceeded（结构化 code）→「今日会话创建次数已用完」', async () => {
    mockedCreateSession.mockRejectedValue(
      httpError(403, { detail: { code: 'daily_quota_exceeded', message: 'quota used up' } }),
    );
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        '今日会话创建次数已用完（UTC 日重置）',
      );
    });
  });

  it('403 其他 code 不误入配额文案，展示 detail 原文', async () => {
    mockedCreateSession.mockRejectedValue(
      httpError(403, { detail: { code: 'forbidden', message: 'no permission' } }),
    );
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('no permission');
    });
  });

  it('503 + Retry-After：展示容量满 + 倒计时重试按钮，归零后自动可点', async () => {
    mockedCreateSession.mockRejectedValue(
      httpError(503, { detail: 'capacity full' }, { 'Retry-After': '2' }),
    );
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    // 倒计时期间：按钮变「重试（Ns）」且禁用
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('服务容量已满');
    });
    expect(screen.getByRole('button', { name: '重试（2s）' })).toBeDisabled();

    // 真实计时递减到归零：按钮变「重试」且可点
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
      },
      { timeout: 3500 },
    );
  });

  it('503 无 Retry-After：不倒计时，按钮保持可点可直接重试', async () => {
    mockedCreateSession.mockRejectedValue(httpError(503));
    render(<CreateDialog />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('服务容量已满');
    });
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });
});
