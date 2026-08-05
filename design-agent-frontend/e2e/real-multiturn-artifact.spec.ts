import { test, expect } from '@playwright/test';
import {
  preauth,
  createSessionViaApi,
  selectSession,
  sendMessage,
} from './_helpers';

/**
 * J5 多轮产物 → 轮次切换条（design.md D8）。
 *
 * 前端 `VideoPreviewPanel` 已提供 `role="tablist"` + `aria-label="产物轮次切换"` 的轮次切换条
 * （`VideoModulePage` 注入 `artifactTurns` / `activeTurn`）。本用例锁定：
 *   1) 单会话多轮产物时切换条出现且 tab 数 = 产物轮数；
 *   2) 默认选中最新轮（第 N 轮），标题与视频源（turns/{i}/artifact）一致；
 *   3) 点击旧轮次可切换标题与播放源。
 *
 * 后端用 stub：每个 `submit_line` 写真实 mp4，故两轮消息即两个带产物轮次。
 */
test('J5 多轮产物：轮次切换条出现且点击可切换播放轮次', async ({ page }) => {
  const s = await createSessionViaApi('j5-multiturn');
  await preauth(page);
  await selectSession(page, s.session_id);

  // stub 每轮写真实 mp4：发两条消息得到两个带产物轮次。
  await sendMessage(page, 'first artifact turn');
  await sendMessage(page, 'second artifact turn');

  const switcher = page.getByRole('tablist', { name: '产物轮次切换' });
  const previewToggle = page.getByRole('button', { name: '视频预览' });
  // 若预览面板未展开（aria-pressed!=='true'）才点击展开；否则（自动展开已生效）不重复点击，
  // 避免点击被已展开的面板头部拦截。随后轮询等待切换条渲染（WS→React 更新有滞后）。
  if ((await previewToggle.getAttribute('aria-pressed')) !== 'true') {
    await previewToggle.click();
  }
  await expect(switcher).toBeVisible();

  const tabs = switcher.getByRole('tab');
  await expect(tabs).toHaveCount(2);

  // 默认选中最新轮（第 2 轮）：标题与视频源一致。
  await expect(page.getByText(/第 2 轮产物/)).toBeVisible();
  await expect(switcher.getByRole('tab', { name: '第 2 轮' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('video').first()).toHaveAttribute('src', /turns\/1\/artifact/);

  // 点击第 1 轮：标题与视频源（turns/0/artifact）随之切换，且选中态更新。
  await switcher.getByRole('tab', { name: '第 1 轮' }).click();
  await expect(page.getByText(/第 1 轮产物/)).toBeVisible();
  await expect(switcher.getByRole('tab', { name: '第 1 轮' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('video').first()).toHaveAttribute('src', /turns\/0\/artifact/);
});
