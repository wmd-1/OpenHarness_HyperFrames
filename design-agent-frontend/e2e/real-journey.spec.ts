import { test, expect } from '@playwright/test';
import {
  API_KEY,
  preauth,
  loginFlow,
  createSessionUi,
  selectSession,
  sendMessage,
  createSessionViaApi,
  waitForTurns,
  closeActiveSession,
  artifactUrl,
} from './_helpers';

/**
 * J 类：正常流程真实闭环（真实后端 + 真实浏览器）。
 * 覆盖：登录→建会话→WS 流式→turn_complete 含产物；产物 200/206；历史切换/只读；
 * 个人空间真实聚合；assistant_text 不重复。
 */
test('J1 真实登录→建会话→WS 流式→turn_complete 含产物', async ({ page }) => {
  await loginFlow(page, API_KEY);
  await page.goto('/video');
  await createSessionUi(page);

  await sendMessage(page, 'hello real backend');

  // assistant_text 不重复回归：单条消息 "Stub reply to:" 恰出现一次。
  await expect(page.getByText(/Stub reply to:/)).toHaveCount(1);

  // 经真实后端确认最新 turn 含产物（轮询克服落库延迟）。
  const sid = await page.evaluate(
    (k) => localStorage.getItem(k) as string,
    'da.currentSessionId',
  );
  expect(sid).toBeTruthy();
  const turns = await waitForTurns(sid);
  expect(turns.length).toBeGreaterThan(0);
  expect(turns[turns.length - 1].has_artifact).toBe(true);
});

test('J2 真实产物直链 200(video/mp4) 与 Range 206', async ({ page }) => {
  const s = await createSessionViaApi('j2-artifact');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'make a video');

  const turns = await waitForTurns(s.session_id);
  const last = turns[turns.length - 1];
  expect(last.has_artifact).toBe(true);

  const url = artifactUrl(s.session_id, last.turn_index);
  const r1 = await fetch(url);
  expect(r1.status).toBe(200);
  expect((r1.headers.get('content-type') || '')).toContain('video/mp4');

  const r2 = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  expect(r2.status).toBe(206);
});

test('J3 关闭会话进入只读', async ({ page }) => {
  const s = await createSessionViaApi('j3-history');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'hi');

  await closeActiveSession(page);
  // 只读标识出现（"已关闭"）。
  await expect(page.getByText('已关闭').first()).toBeVisible();
});

test('J4 个人空间视频 tab 真实聚合（含已关闭会话）', async ({ page }) => {
  const s = await createSessionViaApi('j4-aggregate');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'aggregate me');
  // 关闭后 finished_at 落库，空间聚合按 finished_at 倒序。
  await closeActiveSession(page);

  await page.goto('/space');
  // 视频 tab 默认激活，聚合真实产物卡片（卡片名来自产物而非会话标题）。
  const card = page.locator('.space-card').first();
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  // 下载链接指向真实后端产物端点，证明来自真实聚合。
  const dl = page.locator('.space-card-download').first();
  await expect(dl).toBeVisible();
  await expect(dl).toHaveAttribute('href', /v1\/sessions\//);
});
