// useWorkspaceFiles 单测（F5.2/F5.5/F5.6）：首拉/续拉分页、prefix 过滤防抖、
// 400（page_token 非法）重置自愈、404 横幅提示、turn_count 变化自动刷新。

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceFiles } from '../useWorkspaceFiles';
import { listWorkspaceFiles } from '../../api/sessions';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { WorkspaceFileListResponse } from '../../types/api';
import type { Session } from '../../types/session';

vi.mock('../../api/sessions', () => ({
  listWorkspaceFiles: vi.fn(),
}));

const SID = 's1';

const makeSession = (patch: Partial<Session> = {}): Session => ({
  session_id: SID,
  status: 'live',
  permission_policy: 'interactive',
  turn_count: 1,
  oh_session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ws_url: null,
  ...patch,
});

const makeResp = (patch: Partial<WorkspaceFileListResponse> = {}): WorkspaceFileListResponse => ({
  source: 'live',
  stale: false,
  sync_seq: 1,
  last_synced_at: '2026-01-01T00:00:00Z',
  total: 1,
  files: [{ path: 'output/final.mp4', size: 1024, mtime: '2026-01-01T00:00:00Z' }],
  next_page_token: null,
  ...patch,
});

/** ky HTTPError 形状（errorStatus/extractErrorDetail 读 response）。 */
const httpError = (status: number, body: unknown = { detail: 'err' }) => ({
  response: new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }),
});

beforeEach(() => {
  useSessionStore.setState({ sessions: { [SID]: makeSession() }, order: [SID], currentId: SID });
  useUiStore.setState({ banner: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useWorkspaceFiles 拉取与分页（F5.2）', () => {
  it('sessionId 为 null：不拉取，状态为空', () => {
    const { result } = renderHook(() => useWorkspaceFiles(null));
    expect(listWorkspaceFiles).not.toHaveBeenCalled();
    expect(result.current.files).toEqual([]);
    expect(result.current.source).toBeNull();
  });

  it('挂载即拉首页（limit=200 不带 page_token），响应落地 source/stale/total', async () => {
    vi.mocked(listWorkspaceFiles).mockResolvedValue(
      makeResp({ source: 'archive', stale: true, total: 3 }),
    );
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.source).toBe('archive'));

    expect(listWorkspaceFiles).toHaveBeenCalledWith(SID, {
      limit: 200,
      page_token: undefined,
      prefix: undefined,
    });
    expect(result.current.stale).toBe(true);
    expect(result.current.total).toBe(3);
    expect(result.current.files).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore：带 next_page_token 续拉并追加文件', async () => {
    vi.mocked(listWorkspaceFiles)
      .mockResolvedValueOnce(makeResp({ total: 2, next_page_token: 'tok1' }))
      .mockResolvedValueOnce(
        makeResp({
          total: 2,
          files: [{ path: 'output/b.mp4', size: 2048, mtime: '2026-01-01T00:00:01Z' }],
        }),
      );
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.files).toHaveLength(2));

    expect(listWorkspaceFiles).toHaveBeenLastCalledWith(SID, {
      limit: 200,
      page_token: 'tok1',
      prefix: undefined,
    });
    expect(result.current.files.map((f) => f.path)).toEqual(['output/final.mp4', 'output/b.mp4']);
    expect(result.current.hasMore).toBe(false);
  });

  it('prefix 过滤：防抖后带 prefix 重拉第一页', async () => {
    vi.mocked(listWorkspaceFiles).mockResolvedValue(makeResp());
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.source).toBe('live'));

    act(() => result.current.setPrefix('output/'));
    await waitFor(() =>
      expect(listWorkspaceFiles).toHaveBeenLastCalledWith(SID, {
        limit: 200,
        page_token: undefined,
        prefix: 'output/',
      }),
    );
  });
});

describe('useWorkspaceFiles 错误恢复与自动刷新（F5.5/F5.6）', () => {
  it('续拉 400（page_token 非法）：自动重置分页重拉第一页', async () => {
    vi.mocked(listWorkspaceFiles)
      .mockResolvedValueOnce(makeResp({ total: 2, next_page_token: 'expired' }))
      .mockRejectedValueOnce(httpError(400, { detail: 'invalid page_token' }))
      .mockResolvedValueOnce(makeResp({ total: 1 }));
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(3));

    // 第三次为重置后的第一页请求（不带 page_token），列表被整体替换
    expect(vi.mocked(listWorkspaceFiles).mock.calls[2][1]).toEqual({
      limit: 200,
      page_token: undefined,
      prefix: undefined,
    });
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it('首页 404：warning 横幅提示且 error 落地（不无限重拉）', async () => {
    vi.mocked(listWorkspaceFiles).mockRejectedValue(httpError(404, { detail: 'not found' }));
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(useUiStore.getState().banner).toMatchObject({
      level: 'warning',
      text: '文件已不存在，列表已刷新',
    });
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
  });

  it('turn_count 变化（turn_complete patch）：自动重拉第一页', async () => {
    vi.mocked(listWorkspaceFiles).mockResolvedValue(makeResp());
    const { result } = renderHook(() => useWorkspaceFiles(SID));
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionStore.setState((s) => ({
        sessions: { ...s.sessions, [SID]: { ...s.sessions[SID], turn_count: 2 } },
      }));
    });
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(2));
  });
});
