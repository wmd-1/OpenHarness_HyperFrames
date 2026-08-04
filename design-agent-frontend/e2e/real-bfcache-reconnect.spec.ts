// 真实后端栈的 BFCache 唤醒 E2E（Change3 任务 2）。
// 流程：进入会话 → 完成一轮对话 → 离开页面（触发 BFCache 冻结）→ 返回（pageshow persisted）
//       → WS probe/reconnect → 连接恢复 → 对话可继续。
// 同时校验 Change3 的 toast 接线：reconnecting → recovered。

import { test, expect } from '@playwright/test';
import {
  API_KEY,
  preauth,
  createSessionViaApi,
  patchWebSocketUrl,
  selectSession,
  waitForVideoReady,
} from './_helpers';

test.describe('real BFCache wakeup reconnect', () => {
  test.beforeEach(async ({ page }) => {
    // pageshow 捕获必须在 video 文档加载前注册，才能随 BFCache 冻结/恢复保留监听。
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

  test('BF3 进入/离开 BFCache → pageshow persisted → WS 重连 → 对话可继续', async ({ page }) => {
    const s = await createSessionViaApi('bfcache');
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    // 测试侧钩子：在页面 JS 上下文安装 pageshow 记录器。BFCache 冻结时该上下文被保留，
    // 故 goBack 从 BFCache 恢复后 pageshow(persisted=true) 会被记录；headless-shell 不支持
    // BFCache 时 goBack 为整页重载、上下文重建、记录为空 → 判定为不支持并 skip（保留默认行为）。
    await page.evaluate(() => {
      (window as any).__pageshowEvents = [];
      window.addEventListener('pageshow', (e: any) => {
        (window as any).__pageshowEvents.push({ persisted: e.persisted, url: location.href });
      });
    });

    // 先完成一轮对话，确保存在 turn
    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('你好');
    await page.locator('button[aria-label="发送"]').click();
    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30000 });

    // 离开页面（真实导航，触发 BFCache 冻结）
    await page.goto('/');
    // 返回（从 BFCache 恢复）
    await page.goBack();

    // 页面经 BFCache 恢复：pageshow.persisted === true（针对 video 文档）。
    // 注意：默认 e2e 镜像仅含 chrome-headless-shell（old headless），不冻结页面，
    // pageshow.persisted 恒为 false → bfcacheSupported=false → 本用例 skip（无回归）。
    // 需在 e2e 镜像启用 new headless（完整 chromium）后才能真正验证 BFCache 唤醒路径。
    const bfcacheSupported = await page.evaluate(() =>
      ((window as any).__pageshowEvents ?? []).some(
        (e: any) => e.persisted === true && e.url.includes('/video'),
      ),
    );
    test.skip(
      !bfcacheSupported,
      'BFCache 未生效（pageshow.persisted=false，goBack 走了整页重载而非 BFCache 恢复）：' +
        '当前 e2e 对着 vite dev server（含 HMR WebSocket），页面可能不具备 BFCache 资格；' +
        '需在 e2e 镜像启用 new headless（完整 chromium）并以生产构建（无 HMR）托管后才能验证。',
    );

    // WS 探测重连（Change3 toast 接线：reconnecting → recovered）
    await page.waitForFunction(
      () =>
        (window.__toastLog ?? []).some((t) => t.id === 'ws-reconnect') &&
        (window.__toastLog ?? []).some((t) => t.id === 'ws-recovered'),
      null,
      { timeout: 15000 },
    );

    // 重连后连接恢复
    await expect(
      page.locator('section.video-layout').first().filter({ hasAttribute: 'data-ws-status' }),
    ).toHaveAttribute('data-ws-status', 'ready', { timeout: 15000 });

    // 对话可继续：再发一轮
    const input2 = page.locator('textarea[aria-label="消息输入"]');
    await expect(input2).toBeEnabled({ timeout: 15000 });
    await input2.fill('继续');
    await page.locator('button[aria-label="发送"]').click();
    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30000 });
  });
});
