// E2E 测试（task 12.8）：完整对话流程、断线重连、模式切换、错误恢复。
// 后端由 e2e/mock-backend.mjs 模拟（协议对齐 session-service）。

import { expect, test, type Page } from '@playwright/test';

const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';

/** 欢迎页输入 API Key 并进入主应用。 */
async function login(page: Page, apiKey = API_KEY) {
  await page.goto('/');
  await page.getByLabel('API Key', { exact: true }).fill(apiKey);
  await page.getByRole('button', { name: '保存' }).click();
}

/** 新建一个 full_auto 会话并等待 WS 就绪。 */
async function createSession(page: Page) {
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 10_000 });
}

async function sendMessage(page: Page, text: string) {
  await page.getByLabel('消息输入').fill(text);
  await page.getByLabel('发送').click();
}

test('完整对话流程：认证 → 创建会话 → 流式回复', async ({ page }) => {
  await login(page);
  await createSession(page);

  await sendMessage(page, '你好');
  // 用户消息与流式回显都渲染
  await expect(page.getByText('你好', { exact: true })).toBeVisible();
  await expect(page.getByText('Echo: 你好')).toBeVisible({ timeout: 10_000 });

  // 第二轮对话（轮次递增）
  await sendMessage(page, '继续');
  await expect(page.getByText('Echo: 继续')).toBeVisible({ timeout: 10_000 });
  // 限定底部状态栏，避免与侧栏会话卡片的“轮次 2”重复命中
  await expect(page.getByRole('contentinfo').getByText('轮次 2')).toBeVisible();
});

test('断线重连：连接掉线后自动恢复并可继续对话', async ({ page }) => {
  await login(page);
  await createSession(page);

  // 触发服务端掐线（1006）→ 先确认真的掉线，再等指数退避自动重连恢复
  await sendMessage(page, 'force-drop');
  await expect(page.locator('[data-ws-status="reconnecting"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-ws-status="ready"]')).toBeVisible({ timeout: 15_000 });

  await sendMessage(page, '回来了');
  await expect(page.getByText('Echo: 回来了')).toBeVisible({ timeout: 10_000 });
});

test('模式切换：Chat ↔ Terminal', async ({ page }) => {
  await login(page);
  await createSession(page);

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByTestId('xterm-container')).toBeVisible();

  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByLabel('消息输入')).toBeVisible();
});

test('错误恢复：无效 API Key 触发 401 后回到认证页', async ({ page }) => {
  await login(page, 'wrong-key');
  // 创建会话请求返回 401 → 清除 Key 并回到欢迎页提示重新认证
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByTestId('auth-expired-notice')).toBeVisible({ timeout: 10_000 });

  // 输入正确 Key 可恢复正常使用
  await page.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await page.getByRole('button', { name: '保存' }).click();
  await createSession(page);
  await sendMessage(page, '恢复');
  await expect(page.getByText('Echo: 恢复')).toBeVisible({ timeout: 10_000 });
});
