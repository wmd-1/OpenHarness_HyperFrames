import { test, expect } from '@playwright/test';
import { API_KEY, preauth } from './_helpers';

/**
 * R/D 类：平台一致性与演示标识（对齐 design-agent-platform / space）。
 * 主页模块卡片、个人空间 tab MUST 派生自 AgentRegistry；demo 域数据带「演示数据」标识。
 */
test('R1 首页模块卡片派生自注册表（3 个能力域）', async ({ page }) => {
  await preauth(page, API_KEY);
  await page.goto('/');
  await expect(page.getByText('原型页面设计')).toBeVisible();
  await expect(page.getByText('Drawio设计')).toBeVisible();
  await expect(page.getByText('文本生成视频')).toBeVisible();
});

test('R2 个人空间 tab 派生自注册表', async ({ page }) => {
  await preauth(page, API_KEY);
  await page.goto('/space');
  await expect(page.getByRole('tab', { name: '原型页面设计' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Drawio设计' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '文本生成视频' })).toBeVisible();
});

test('D1 demo 能力域带「演示数据」标识', async ({ page }) => {
  await preauth(page, API_KEY);
  await page.goto('/ui');
  await expect(page.getByText(/演示数据/)).toBeVisible();
});
