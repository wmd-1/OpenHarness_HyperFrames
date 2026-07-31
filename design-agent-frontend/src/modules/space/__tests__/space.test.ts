// 个人空间单测（spec design-agent-space）：
// 分页纯函数 / RealArtifactProvider.aggregate（并发聚合+缓存+容错+排序）/
// DemoArtifactProvider 演示标识 / provider 可替换性契约。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SessionListResponse, TurnListResponse } from '../../../types/api';
import { createDemoAdapter } from '../../../platform/demoAdapter';
import { createSessionServiceAdapter } from '../../../platform/sessionServiceAdapter';
import type { ArtifactProvider } from '../../../platform/types';
import { UI_DEMO_ARTIFACTS, UI_DEMO_SESSIONS, uiDemoReply } from '../../../platform/demoData';
import { SPACE_PAGE_SIZE, pageCount, pageSlice } from '../paging';
import { thumbTypeLabel } from '../spaceLabels';

vi.mock('../../../api/sessions', () => ({
  artifactStreamUrl: vi.fn((sid: string, t: number) => `/stream/${sid}/${t}`),
  artifactUrl: vi.fn((sid: string, t: number) => `/dl/${sid}/${t}`),
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  listTurns: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  workspaceFileUrl: vi.fn(),
}));

const api = await import('../../../api/sessions');
const mockListSessions = api.listSessions as unknown as Mock;
const mockListTurns = api.listTurns as unknown as Mock;

function sessionSummary(sid: string, turnCount: number): SessionListResponse['items'][number] {
  return {
    session_id: sid,
    status: 'live',
    title: sid,
    turn_count: turnCount,
    resumable: true,
    read_only: false,
    created_at: '2026-07-30T00:00:00Z',
    last_active_at: '2026-07-30T00:00:00Z',
  };
}

function turn(
  index: number,
  hasArtifact: boolean,
  finishedAt: string | null,
): TurnListResponse['items'][number] {
  return {
    turn_id: `t${index}`,
    turn_index: index,
    status: 'completed',
    prompt: `p${index}`,
    assistant_text: 'ok',
    error_message: null,
    has_artifact: hasArtifact,
    started_at: '2026-07-30T00:00:00Z',
    finished_at: finishedAt,
  };
}

describe('paging 纯函数', () => {
  it('每页 6 条', () => {
    expect(SPACE_PAGE_SIZE).toBe(6);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(6)).toBe(1);
    expect(pageCount(7)).toBe(2);
    expect(pageCount(13)).toBe(3);
  });

  it('pageSlice 切片与越界', () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    expect(pageSlice(items, 1)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pageSlice(items, 2)).toEqual([6, 7]);
    expect(pageSlice(items, 3)).toEqual([]);
  });
});

describe('thumbTypeLabel', () => {
  it('mediaType → 角标文案', () => {
    expect(thumbTypeLabel('text/html')).toBe('HTML');
    expect(thumbTypeLabel('image/svg+xml')).toBe('SVG');
    expect(thumbTypeLabel('video/mp4')).toBe('MP4');
  });
});

describe('RealArtifactProvider.aggregate', () => {
  beforeEach(() => {
    mockListSessions.mockReset();
    mockListTurns.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('跨会话聚合：只收 has_artifact 轮次，finished_at 倒序', async () => {
    const { artifacts } = createSessionServiceAdapter();
    mockListSessions.mockResolvedValue({
      items: [sessionSummary('aaaa1111', 2), sessionSummary('bbbb2222', 1)],
      total: 2,
      limit: 100,
      offset: 0,
    });
    mockListTurns.mockImplementation((sid: string) =>
      Promise.resolve(
        sid === 'aaaa1111'
          ? {
              items: [turn(0, true, '2026-07-01T00:00:00Z'), turn(1, false, null)],
              total: 2,
            }
          : { items: [turn(0, true, '2026-07-20T00:00:00Z')], total: 1 },
      ),
    );

    const refs = await artifacts.aggregate();
    expect(refs).toHaveLength(2);
    // 倒序：bbbb2222（7-20）在前
    expect(refs[0].sessionId).toBe('bbbb2222');
    expect(refs[1].sessionId).toBe('aaaa1111');
    expect(refs[1].name).toBe('aaaa1111_turn0.mp4');
    expect(mockListSessions).toHaveBeenCalledWith({ limit: 100 });
  });

  it('缓存：turn_count 未变不重拉 turns；变化后重拉', async () => {
    const { artifacts } = createSessionServiceAdapter();
    const listResp = {
      items: [sessionSummary('cccc3333', 1)],
      total: 1,
      limit: 100,
      offset: 0,
    };
    mockListSessions.mockResolvedValue(listResp);
    mockListTurns.mockResolvedValue({
      items: [turn(0, true, '2026-07-10T00:00:00Z')],
      total: 1,
    });

    await artifacts.aggregate();
    expect(mockListTurns).toHaveBeenCalledTimes(1);

    // 二次聚合（turn_count 不变）→ 命中缓存
    const second = await artifacts.aggregate();
    expect(mockListTurns).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(1);

    // turn_count 推进 → 重拉
    mockListSessions.mockResolvedValue({
      ...listResp,
      items: [sessionSummary('cccc3333', 2)],
    });
    await artifacts.aggregate();
    expect(mockListTurns).toHaveBeenCalledTimes(2);
  });

  it('单会话失败不阻塞聚合', async () => {
    const { artifacts } = createSessionServiceAdapter();
    mockListSessions.mockResolvedValue({
      items: [sessionSummary('bad00000', 1), sessionSummary('good1111', 1)],
      total: 2,
      limit: 100,
      offset: 0,
    });
    mockListTurns.mockImplementation((sid: string) =>
      sid === 'bad00000'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ items: [turn(0, true, '2026-07-15T00:00:00Z')], total: 1 }),
    );

    const refs = await artifacts.aggregate();
    expect(refs).toHaveLength(1);
    expect(refs[0].sessionId).toBe('good1111');
  });

  it('真实域 streamUrl/downloadUrl 为直链', async () => {
    const { artifacts } = createSessionServiceAdapter();
    const ref = { sessionId: 's1', turnIndex: 3, name: 'x.mp4', mediaType: 'video/mp4' };
    expect(artifacts.streamUrl(ref)).toBe('/stream/s1/3');
    expect(artifacts.downloadUrl(ref)).toBe('/dl/s1/3');
  });
});

describe('DemoArtifactProvider（演示数据标识）', () => {
  const adapter = createDemoAdapter({
    agentId: 'ui-prototype',
    sessions: UI_DEMO_SESSIONS,
    artifacts: UI_DEMO_ARTIFACTS,
    artifactMediaType: 'text/html',
    reply: uiDemoReply,
  });

  it('aggregate 产物 MUST 全部 demo:true', async () => {
    const refs = await adapter.artifacts.aggregate();
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.demo === true)).toBe(true);
  });

  it('demo 域 streamUrl/downloadUrl 返回 null → UI 呈现占位下载', async () => {
    const [ref] = await adapter.artifacts.aggregate();
    expect(adapter.artifacts.streamUrl(ref)).toBeNull();
    expect(adapter.artifacts.downloadUrl(ref)).toBeNull();
  });
});

describe('provider 可替换性契约（demo→GA 仅换 providers 指向）', () => {
  it('真实/演示 ArtifactProvider 暴露同一契约面', () => {
    const real: ArtifactProvider = createSessionServiceAdapter().artifacts;
    const demo: ArtifactProvider = createDemoAdapter({
      agentId: 'ui-prototype',
      sessions: UI_DEMO_SESSIONS,
      artifacts: UI_DEMO_ARTIFACTS,
      artifactMediaType: 'text/html',
      reply: uiDemoReply,
    }).artifacts;
    for (const provider of [real, demo]) {
      expect(typeof provider.listBySession).toBe('function');
      expect(typeof provider.aggregate).toBe('function');
      expect(typeof provider.streamUrl).toBe('function');
      expect(typeof provider.downloadUrl).toBe('function');
    }
  });
});
