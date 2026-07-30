// WorkspaceFilesPanel 渲染单测（F5.1/F5.3）：双源角标（live/archive+stale）、
// none 空态、加载更多按钮与 loadMore 透传。

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel';
import { useWorkspaceFiles } from '../../../hooks/useWorkspaceFiles';
import type { UseWorkspaceFilesResult } from '../../../hooks/useWorkspaceFiles';
import type { Session } from '../../../types/session';

vi.mock('../../../hooks/useWorkspaceFiles', () => ({
  useWorkspaceFiles: vi.fn(),
}));

const session: Session = {
  session_id: 's1',
  status: 'live',
  permission_policy: 'interactive',
  turn_count: 1,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
};

const makeResult = (patch: Partial<UseWorkspaceFilesResult> = {}): UseWorkspaceFilesResult => ({
  files: [],
  source: 'live',
  stale: false,
  lastSyncedAt: null,
  total: 0,
  hasMore: false,
  loading: false,
  error: null,
  prefix: '',
  setPrefix: vi.fn(),
  refresh: vi.fn(),
  loadMore: vi.fn(),
  ...patch,
});

function renderPanel(patch: Partial<UseWorkspaceFilesResult> = {}) {
  const result = makeResult(patch);
  vi.mocked(useWorkspaceFiles).mockReturnValue(result);
  render(<WorkspaceFilesPanel session={session} onClose={vi.fn()} />);
  return result;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WorkspaceFilesPanel 双源角标与空态', () => {
  it('live 源：显示「实时」角标，无 stale 提示', () => {
    renderPanel({
      source: 'live',
      total: 1,
      files: [{ path: 'output/final.mp4', size: 1024, mtime: '2026-01-01T00:00:00Z' }],
    });
    expect(screen.getByText('实时')).toBeInTheDocument();
    expect(screen.queryByText(/^归档快照/)).not.toBeInTheDocument();
    expect(screen.queryByText(/可能落后最新一轮/)).not.toBeInTheDocument();
    expect(screen.getByText('output/final.mp4')).toBeInTheDocument();
  });

  it('archive + stale：显示「归档快照」角标与落后提示', () => {
    renderPanel({
      source: 'archive',
      stale: true,
      lastSyncedAt: new Date().toISOString(),
      total: 1,
      files: [{ path: 'output/final.mp4', size: 1024, mtime: '2026-01-01T00:00:00Z' }],
    });
    // ^ 锚定角标（「文件为最近归档快照…」提示单独断言，避免多匹配）
    expect(screen.getByText(/^归档快照/)).toBeInTheDocument();
    expect(screen.getByText('文件为最近归档快照，可能落后最新一轮')).toBeInTheDocument();
  });

  it('none 源：显示「暂无文件归档」空态', () => {
    renderPanel({ source: 'none' });
    expect(screen.getByText('暂无文件归档')).toBeInTheDocument();
  });

  it('live 源但过滤后 0 文件：显示「无匹配文件」', () => {
    renderPanel({ source: 'live', total: 0, files: [], prefix: 'nope/' });
    expect(screen.getByText('无匹配文件')).toBeInTheDocument();
  });

  it('hasMore：显示「加载更多」并点击透传 loadMore', () => {
    const result = renderPanel({
      source: 'live',
      total: 5,
      hasMore: true,
      files: [{ path: 'output/final.mp4', size: 1024, mtime: '2026-01-01T00:00:00Z' }],
    });
    const button = screen.getByRole('button', { name: /加载更多/ });
    expect(button).toHaveTextContent('已载入 1/5');
    fireEvent.click(button);
    expect(result.loadMore).toHaveBeenCalledTimes(1);
  });

  it('error：显示错误与重试按钮，点击透传 refresh', () => {
    const result = renderPanel({ error: '文件列表加载失败' });
    expect(screen.getByRole('alert')).toHaveTextContent('文件列表加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(result.refresh).toHaveBeenCalledTimes(1);
  });
});
