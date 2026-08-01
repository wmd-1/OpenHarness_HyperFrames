import { test, expect } from '@playwright/test';
import { API_KEY, preauth } from './_helpers';

/**
 * E 类：错误处理真实后端。
 * 注：stub 后端不强制租户隔离、且 429/503 需真实配额/容量条件（依赖项，见 tasks.md 6.4），
 * 本文件覆盖可确定性触发的真实错误：401 错 Key、404 未知会话。
 */
test('E1 错误 API Key → 401 → 回欢迎页重新认证', async ({ page }) => {
  await preauth(page, 'totally-wrong-key-xyz');
  // 必须进入会触发会话列表请求的路由（/video），首页为静态不发起请求。
  await page.goto('/video');
  // 应用加载会话列表收到 401 → markAuthExpired 清 key → 欢迎页重弹。
  await expect(page.locator('input[aria-label="API Key"]')).toBeVisible({
    timeout: 20_000,
  });
});

test('E2 未知 session_id → 404 → 前端优雅回退空工作区', async ({ page }) => {
  await preauth(page, API_KEY);
  await page.goto('/video?session_id=00000000-0000-0000-0000-000000000000');
  // 真实后端返回 404；ChatView 仅在 session 存在时挂载，未知会话优雅回退到空工作区（不崩溃）。
  await expect(page.locator('.btn-new-session').first()).toBeVisible({
    timeout: 20_000,
  });
});
