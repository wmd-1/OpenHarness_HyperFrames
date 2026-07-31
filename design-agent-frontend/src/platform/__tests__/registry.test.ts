// 平台抽象层单测（tasks 2.4）：注册表派生一致性 / TurnStream 事件同构 / canResume 谓词。

import { describe, expect, it } from 'vitest';
import type { Session } from '../../types/session';
import { canResumeSession } from '../../types/session';
import { getAgent, getAgentByRoute, isDemoAgent, listAgents } from '../registry';

describe('AgentRegistry', () => {
  it('注册 video-generation(ga) / ui-prototype(demo) / drawio-diagram(demo) 三个能力域', () => {
    const ids = listAgents().map((a) => a.id);
    expect(ids).toContain('video-generation');
    expect(ids).toContain('ui-prototype');
    expect(ids).toContain('drawio-diagram');
    expect(getAgent('video-generation')?.maturity).toBe('ga');
    expect(getAgent('ui-prototype')?.maturity).toBe('demo');
    expect(getAgent('drawio-diagram')?.maturity).toBe('demo');
  });

  it('路由映射与注册表一致（主页/路由/space tab 同源派生）', () => {
    for (const agent of listAgents()) {
      expect(getAgentByRoute(agent.route)).toBe(agent);
      // 每个能力域均具备派生所需的完整描述符字段
      expect(agent.title).toBeTruthy();
      expect(agent.route.startsWith('/')).toBe(true);
      expect(agent.artifactMediaTypes.length).toBeGreaterThan(0);
      expect(agent.providers.session).toBeDefined();
      expect(agent.providers.artifacts).toBeDefined();
      expect(agent.page).toBeDefined();
    }
  });

  it('maturity!==ga 判定为演示能力域（演示角标依据）', () => {
    expect(isDemoAgent(getAgent('ui-prototype')!)).toBe(true);
    expect(isDemoAgent(getAgent('drawio-diagram')!)).toBe(true);
    expect(isDemoAgent(getAgent('video-generation')!)).toBe(false);
  });

  it('demo 能力域聚合产物全部携带演示标识', async () => {
    for (const agent of listAgents().filter(isDemoAgent)) {
      const refs = await agent.providers.artifacts.aggregate();
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every((r) => r.demo === true)).toBe(true);
    }
  });
});

describe('canResumeSession 谓词（spec：resumable && !read_only）', () => {
  const base: Session = {
    session_id: 's1',
    status: 'cold',
    turn_count: 1,
    created_at: '2026-07-31T00:00:00Z',
    last_active_at: '2026-07-31T00:00:00Z',
  };

  it('resumable=true 且 read_only=false → 可交互', () => {
    expect(canResumeSession({ ...base, resumable: true, read_only: false })).toBe(true);
  });

  it('read_only=true → 仅可查阅', () => {
    expect(canResumeSession({ ...base, resumable: false, read_only: true })).toBe(false);
  });

  it('resumable=false → 不可唤醒', () => {
    expect(canResumeSession({ ...base, resumable: false, read_only: false })).toBe(false);
  });
});
