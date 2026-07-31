// 语义谓词单测（F1.5 rev1/rev2）：canConnect/isReadonly/canResume 真值表，
// 并断言 isSessionTerminal 行为保持不变（职责不扩大）。

import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from '../session';
import {
  canConnectSession,
  canResumeSession,
  isReadonlySession,
  isSessionTerminal,
} from '../session';

const makeSession = (patch: Partial<Session> = {}): Session => ({
  session_id: 's1',
  status: 'live',
  turn_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ...patch,
});

describe('isSessionTerminal（行为不变回归）', () => {
  it.each<[SessionStatus, boolean]>([
    ['creating', false],
    ['live', false],
    ['idle', false],
    ['cold', false],
    ['closed', true],
    ['expired', true],
    ['failed', true],
  ])('%s -> %s', (status, expected) => {
    expect(isSessionTerminal(status)).toBe(expected);
  });
});

describe('canConnectSession（WS 建连唯一门控）', () => {
  it('resumable=true 时无论 status 均可建连（快照存在的 closed 不会出现，防御性）', () => {
    expect(canConnectSession(makeSession({ resumable: true, status: 'cold' }))).toBe(true);
    expect(canConnectSession(makeSession({ resumable: true, status: 'failed' }))).toBe(true);
  });

  it('resumable=false 时即使 live 也不建连（契约优先于 status）', () => {
    expect(canConnectSession(makeSession({ resumable: false, status: 'live' }))).toBe(false);
    expect(canConnectSession(makeSession({ resumable: false, status: 'cold' }))).toBe(false);
  });

  it('字段缺失（旧后端仅 detail 数据）回退 !isSessionTerminal', () => {
    expect(canConnectSession(makeSession({ status: 'live' }))).toBe(true);
    expect(canConnectSession(makeSession({ status: 'cold' }))).toBe(true);
    expect(canConnectSession(makeSession({ status: 'closed' }))).toBe(false);
    expect(canConnectSession(makeSession({ status: 'failed' }))).toBe(false);
  });
});

describe('isReadonlySession（只读回看）', () => {
  it('read_only 字段优先于 status', () => {
    expect(isReadonlySession(makeSession({ read_only: true, status: 'live' }))).toBe(true);
    expect(isReadonlySession(makeSession({ read_only: false, status: 'closed' }))).toBe(false);
  });

  it('字段缺失回退终态 status 判定', () => {
    expect(isReadonlySession(makeSession({ status: 'closed' }))).toBe(true);
    expect(isReadonlySession(makeSession({ status: 'expired' }))).toBe(true);
    expect(isReadonlySession(makeSession({ status: 'live' }))).toBe(false);
  });
});

describe('canResumeSession（唤醒门槛）真值表', () => {
  it.each<[boolean | undefined, boolean | undefined, SessionStatus, boolean]>([
    // [resumable, read_only, status, expected]
    [true, false, 'cold', true], // 正常可唤醒
    [false, false, 'cold', false], // 快照丢失 → 置灰
    [false, true, 'closed', false], // 只读会话不可唤醒
    [true, true, 'closed', false], // rev2 语义边界：并存态按防御性冗余判 false
    [undefined, undefined, 'live', true], // 全缺失 → status 回退
    [undefined, undefined, 'closed', false],
  ])(
    'resumable=%s read_only=%s status=%s -> %s',
    (resumable, read_only, status, expected) => {
      expect(canResumeSession(makeSession({ resumable, read_only, status }))).toBe(expected);
    },
  );
});
