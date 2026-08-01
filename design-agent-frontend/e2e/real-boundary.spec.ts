import { test, expect } from '@playwright/test';
import {
  API_KEY,
  preauth,
  selectSession,
  sendMessage,
  waitForVideoReady,
  createSessionViaApi,
  tryCreateSessionViaApi,
} from './_helpers';

/**
 * B 类：边界情况真实验证（真实后端）。
 */
test('B1 空输入时发送禁用', async ({ page }) => {
  const s = await createSessionViaApi('b1');
  await preauth(page);
  await selectSession(page, s.session_id);
  await expect(page.locator('button[aria-label="发送"]')).toBeDisabled();
});

test('B2 超大文本真实提交', async ({ page }) => {
  const s = await createSessionViaApi('b2');
  await preauth(page);
  await selectSession(page, s.session_id);
  await page.locator('textarea[aria-label="消息输入"]').fill('x'.repeat(20_000));
  await page.locator('button[aria-label="发送"]').click();
  await page.getByText(/Stub reply to:/).first().waitFor({ state: 'visible', timeout: 40_000 });
});

test('B3 特殊字符往返无注入', async ({ page }) => {
  const s = await createSessionViaApi('b3');
  await preauth(page);
  await selectSession(page, s.session_id);
  const special = '<script>alert(1)</script> 🚀 中文';
  await sendMessage(page, special);
  // 回复文案含原 prompt（作为纯文本，未被当作 HTML 执行）。
  await expect(
    page.getByText(/Stub reply to:.*<script>alert\(1\)<\/script>/),
  ).toBeVisible();
});

test('B4 并发建多个会话触发真实并发配额 429', async () => {
  // OH_TENANT_MAX_CONCURRENT 默认 12；并发发起 15 个建会话，超出部分被真实拒绝为 429。
  const N = 15;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => tryCreateSessionViaApi(`b4-${i}`)),
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 429);
  // 至少创建一个成功、至少一次被真实配额拒绝（证明后端并发配额生效）。
  expect(created.length).toBeGreaterThan(0);
  expect(rejected.length).toBeGreaterThan(0);
  // 成功者 session_id 互不相同。
  expect(new Set(created.map((r) => r.session_id)).size).toBe(created.length);
});

test('B5 刷新重放恢复会话', async ({ page }) => {
  const s = await createSessionViaApi('b5');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'keep');
  await page.reload();
  await waitForVideoReady(page);
  await expect(page.locator('textarea[aria-label="消息输入"]')).toBeEnabled();
});
