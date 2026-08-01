import { test, expect } from '@playwright/test';
import { API_KEY, preauth, selectSession, waitForVideoReady, createSessionViaApi } from './_helpers';

/**
 * C 类：浏览器兼容性（真实后端）。
 */
test('C1 新标签打开会话直链', async ({ page, context }) => {
  const s = await createSessionViaApi('c1');
  await preauth(page);
  await selectSession(page, s.session_id);
  const url = page.url();

  const page2 = await context.newPage();
  await preauth(page2);
  await page2.goto(url);
  await waitForVideoReady(page2);
});

test('C2 前进/后退不破坏会话', async ({ page }) => {
  const s = await createSessionViaApi('c2');
  await preauth(page);
  await selectSession(page, s.session_id);
  await page.goto('/');
  await page.goBack();
  await waitForVideoReady(page);
});

test('C3 清 localStorage 重访回欢迎', async ({ page }) => {
  // 手动设置一次 key（不用 addInitScript，避免每次导航被重置）。
  await page.goto('/');
  await page.evaluate((k) => localStorage.setItem('da.apiKey', k), API_KEY);
  await page.reload();
  await expect(page.getByText('文本生成视频')).toBeVisible(); // 已登录
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await expect(page.locator('input[aria-label="API Key"]')).toBeVisible();
});
