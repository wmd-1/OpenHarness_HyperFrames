import { test, expect } from '@playwright/test';
import {
  preauth,
  selectSession,
  waitForVideoReady,
  tryCreateSessionViaApi,
} from './_helpers';

/**
 * P1 ≤8 并发建会话基线（design.md D5 性能）。
 *
 * 后端网关默认 `OH_TENANT_MAX_CONCURRENT=12`，故 ≤8 并发建会话不应触发 429/503。
 * 本用例并发提交 8 个 `POST /v1/sessions`：
 *   1) 全部返回 201，且 session_id 唯一（无静默合并/失败）；
 *   2) 抽查其中一个会话可经 WS 连真实后端并进入 ready（基线连通性）。
 *
 * 注意：429 并发配额独立覆盖（见 `real-stub-429.spec.ts` 一类），本例仅验证正常并发基线。
 */
test('P1 ≤8 并发建会话基线：全部 201 且无 429/503，抽查可连 WS', async ({ page }) => {
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      tryCreateSessionViaApi(`e2e-p1-baseline-${i}-${Date.now()}`),
    ),
  );

  const statuses = results.map((r) => r.status);
  expect(statuses.every((s) => s === 201)).toBe(true);

  const ids = results.map((r) => r.session_id).filter(Boolean) as string[];
  expect(ids.length).toBe(N);
  expect(new Set(ids).size).toBe(ids.length); // 全部唯一，无静默失败/合并

  // 抽查一个会话可经 WS 连真实后端并产出产物区（基线连通性）。
  await preauth(page);
  await selectSession(page, ids[0]);
  await waitForVideoReady(page);
});
