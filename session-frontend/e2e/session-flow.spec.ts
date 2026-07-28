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

test('产物链路：has_artifact 轮次渲染视频卡片与下载入口', async ({ page }) => {
  await login(page);
  await createSession(page);

  await sendMessage(page, 'make-video');
  await expect(page.getByText('Echo: make-video')).toBeVisible({ timeout: 10_000 });

  // turn_complete 带 has_artifact: true → 消息气泡渲染视频预览与下载按钮
  const video = page.locator('video');
  await expect(video).toBeVisible({ timeout: 10_000 });
  // 直链 src 携带 ?api_key= 查询参数认证（A2）
  await expect(video).toHaveAttribute('src', /api_key=/);
  await expect(page.getByRole('button', { name: '下载产物' })).toBeVisible();

  // 普通轮次（无产物）不新增视频卡片
  await sendMessage(page, '续聊');
  await expect(page.getByText('Echo: 续聊')).toBeVisible({ timeout: 10_000 });
  await expect(video).toHaveCount(1);
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

test('关闭会话需二次确认：取消后会话仍存活', async ({ page }) => {
  await login(page);
  await createSession(page);

  // /close 命令弹出确认对话框，不直接关闭（A5）
  await sendMessage(page, '/close');
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).not.toBeVisible();

  // 取消后会话保持存活，可继续对话
  await sendMessage(page, '仍然在线');
  await expect(page.getByText('Echo: 仍然在线')).toBeVisible({ timeout: 10_000 });

  // 侧栏垃圾桶入口同样先确认
  const card = page.locator('[aria-current="true"]').first();
  await card.hover();
  await card.getByLabel('关闭会话').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('confirm-dialog')).not.toBeVisible();
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
