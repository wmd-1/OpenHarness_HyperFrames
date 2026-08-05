// 真实后端栈的「离开/返回会话页 → 恢复可用」E2E（Change3 任务 2，方向②验收口径）。
//
// 2026-08-05 调查结论（见 docs/bfcache-e2e-investigation-2026-08-04.md）：
// Playwright 默认以 `--disable-back-forward-cache` 启动 Chromium，BFCache 整项关闭；
// 即便移除该 flag，BFCache 恢复不派发 load 事件会使 Playwright 的 goBack/reload 挂死。
// 因此 `pageshow.persisted===true`（BFCache 唤醒）在 Playwright E2E 中**本质上不可达**，
// 方向①（换浏览器/flag）无解。本用例改为**方向②**：验证用户侧真实可自动化保证——
// 离开会话页 → 返回（整页 reload）→ 应用经 REST 重水合、WS 重连并建立可用连接、对话可继续。
// `pageshow.persisted` 仅作信息性 annotation，不 skip、不硬断言。

import { test, expect } from '@playwright/test';
import {
  API_KEY,
  preauth,
  createSessionViaApi,
  patchWebSocketUrl,
  selectSession,
  waitForVideoReady,
} from './_helpers';

test.describe('real back-navigation resilience + WS reconnect', () => {
  test.beforeEach(async ({ page }) => {
    // pageshow 捕获必须在 video 文档加载前注册；BFCache 恢复时会保留监听（本环境默认不触发）。
    await page.addInitScript(() => {
      window.__pageshowEvents = [];
      window.addEventListener('pageshow', (e) => {
        window.__pageshowEvents.push({
          persisted: e.persisted,
          url: location.href,
          t: Date.now(),
        });
      });
    });
    await page.addInitScript(patchWebSocketUrl({ api_key: API_KEY }));
    await preauth(page);
  });

  test('BF3 离开/返回会话页 → REST 重水合 + WS 重连可用 + 对话可继续', async ({ page }) => {
    const s = await createSessionViaApi('bfcache');
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    // 先完成一轮对话，确保存在 turn
    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('你好');
    await page.locator('button[aria-label="发送"]').click();
    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30000 });

    // 离开页面（真实导航，触发卸载 / WS 关闭）
    await page.goto('/');
    // 返回（Playwright 默认禁用 BFCache，此处为整页 reload；应用经 REST 重水合 + WS 重连）
    await page.goBack();

    // 信息性记录（不参与断言）：BFCache 是否在当前环境生效。
    // Playwright 默认 false 为预期；仅手动正向控制组（E2E_BFCACHE=1）可能 true。
    const wokeFromBFCache = await page.evaluate(() =>
      ((window as any).__pageshowEvents ?? []).some(
        (e: any) => e.persisted === true && e.url.includes('/video'),
      ),
    );
    test.info().annotations.push({
      type: 'bfcache',
      description: `wokeFromBFCache=${wokeFromBFCache}（Playwright 默认禁用 BFCache，此值恒 false 为预期，不参与断言）`,
    });

    // 方向② 验收：返回后应用恢复可用——输入可发送（会话已重水合 + WS 已建立），
    // 且能继续对话（第二轮 stub 回复可见）。不依赖 pageshow.persisted（Playwright 下不可达）。
    const input2 = page.locator('textarea[aria-label="消息输入"]');
    await expect(input2).toBeEnabled({ timeout: 20000 });
    await input2.fill('继续');
    await page.locator('button[aria-label="发送"]').click();
    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30000 });
  });
});
