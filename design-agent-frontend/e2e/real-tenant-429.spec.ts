import { test, expect } from '@playwright/test';
import { tryCreateSessionViaApi } from './_helpers';

/**
 * 租户并发配额 429 专用验证（test-infra change 2026-08-04-e2e-stub-429-concurrency-adjust）。
 *
 * 默认 stub profile（docker-compose.stub.yml）OH_TENANT_MAX_CONCURRENT=12 保持不变；
 * 本用例仅在专用低并发 profile 下运行：
 *   - 运行脚本追加 docker-compose.stub.429.yml（OH_TENANT_MAX_CONCURRENT=2）
 *   - 由 OH_E2E_429_PROFILE=1 门控，避免默认 suite 出现脆弱断言
 * 不影响其他 E2E。
 */
test('C1 低并发 profile 下并发建会话真实返回 429', async () => {
  test.skip(
    process.env.OH_E2E_429_PROFILE !== '1',
    '429 仅在专用低并发 profile 验证（docker-compose.stub.429.yml，limit=2）；默认 stub profile 不改',
  );
  // limit=2，发起 5 个并发建会话，超出部分应被真实配额拒绝为 429。
  const N = 5;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => tryCreateSessionViaApi(`c1-${i}`)),
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 429);
  // 至少创建一个成功、至少一次被真实配额拒绝（证明后端并发配额生效）。
  expect(created.length).toBeGreaterThan(0);
  expect(rejected.length).toBeGreaterThan(0);
  // 成功者 session_id 互不相同。
  expect(new Set(created.map((r) => r.session_id)).size).toBe(created.length);
  // 429 是真服务器拒绝（有响应体），非网络错误。
  for (const r of rejected) {
    expect(r.data).toBeTruthy();
  }
});
