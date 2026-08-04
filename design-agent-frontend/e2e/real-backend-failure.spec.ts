// 真实后端栈的「后端故障」E2E（Change3 任务 3）。
// 触发方式：WS 连接时携带 `force_backend_failure=start|recovery`（受 OH_E2E_FAULT_INJECTION 门控），
// 直接走 C3/C4 分类路径 → 服务端发送 error 帧(code=BACKEND_START_FAILED/RECOVERY_FAILED) + close(1011)。
// 断言：1011 关闭、error.code 在 UI 展示、且无空错误。

import { test, expect, type Page } from '@playwright/test';
import {
  API_KEY,
  preauth,
  createSessionViaApi,
  patchWebSocketUrl,
  captureWsCloseCodes,
} from './_helpers';

async function openWithBackendFailure(
  page: Page,
  sessionId: string,
  mode: 'start' | 'recovery',
): Promise<void> {
  await page.addInitScript(patchWebSocketUrl({ force_backend_failure: mode, api_key: API_KEY }));
  await page.addInitScript(captureWsCloseCodes());
  await page.goto(`/video?session_id=${sessionId}`);
}

test.describe('real backend failure (WS 1011 + error.code)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(patchWebSocketUrl({ api_key: API_KEY }));
    await preauth(page);
  });

  test('BF1 后端启动失败 → 1011 关闭 + 展示 error.code（无空错误）', async ({ page }) => {
    const s = await createSessionViaApi('bf1');
    await openWithBackendFailure(page, s.session_id, 'start');

    // error.code 在 UI 展示（toast 文案含 BACKEND_START_FAILED 且非空）
    await page.waitForFunction(
      () =>
        (window.__toastLog ?? []).some(
          (t) =>
            t.level === 'error' &&
            typeof t.message === 'string' &&
            t.message.includes('BACKEND_START_FAILED') &&
            t.message.trim().length > 0,
        ),
      null,
      { timeout: 15000 },
    );

    // 系统消息也展示 code
    await expect(page.getByText(/BACKEND_START_FAILED/)).toBeVisible({ timeout: 15000 });

    // 1011 关闭
    await page.waitForFunction(() => (window.__wsCloseCodes ?? []).includes(1011), null, {
      timeout: 15000,
    });

    // 无空错误：toast 文案长度应显著大于仅含 code 的最小串
    const ok = await page.evaluate(() => {
      const t = (window.__toastLog ?? []).find(
        (x) => x.level === 'error' && x.message.includes('BACKEND_START_FAILED'),
      );
      return !!t && t.message.trim().length > '后端错误：BACKEND_START_FAILED'.length;
    });
    expect(ok).toBe(true);
  });

  test('BF2 恢复失败（RECOVERY_FAILED）→ 同样 1011 + error.code', async ({ page }) => {
    const s = await createSessionViaApi('bf2');
    await openWithBackendFailure(page, s.session_id, 'recovery');

    await page.waitForFunction(
      () => (window.__toastLog ?? []).some((t) => t.level === 'error' && t.message.includes('RECOVERY_FAILED')),
      null,
      { timeout: 15000 },
    );
    await expect(page.getByText(/RECOVERY_FAILED/)).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => (window.__wsCloseCodes ?? []).includes(1011), null, {
      timeout: 15000,
    });
  });
});
