import { test, expect } from '@playwright/test';
import {
  preauth,
  createSessionViaApi,
  selectSession,
  sendMessage,
} from './_helpers';

/**
 * P3 个人空间「视频」tab 分页（design.md D5 性能：大数据量空间分页滚动）。
 *
 * 前端 `AgentAssetsTab` + `SpacePagination` 以 `SPACE_PAGE_SIZE=6` 分页聚合真实产物
 * （`useAgentAssets` → `agent.providers.artifacts.aggregate`）。本用例制造 ≥7 个产物
 * （每个独立会话一轮产物），确保总产物数超过单页 6 触发分页控件：
 *   1) `.space-pagination` 出现；
 *   2) 首页固定 6 张 `.space-card`；
 *   3) 点击「下一页」页码更新（第 2/… 页），「上一页」可还原首页数量。
 *
 * 说明：完整「100 turns」浸没为独立 perf soak（stub 单轮 ~3s、共享栈压测风险），本例以
 * 跨页边界（≥7 产物）验证分页控件与翻页逻辑，不跑满 100 轮。
 */
test('P3 个人空间视频 tab 分页：超单页触发分页且可翻页', async ({ page }) => {
  test.setTimeout(180_000);

  // 制造 ≥7 个产物（每个独立会话一轮产物），超过 SPACE_PAGE_SIZE=6 触发分页。
  const COUNT = 8;
  for (let i = 0; i < COUNT; i++) {
    const s = await createSessionViaApi(`e2e-p3-page-${i}-${Date.now()}`);
    await preauth(page);
    await selectSession(page, s.session_id);
    await sendMessage(page, `artifact seed ${i}`);
  }

  await page.goto('/space');
  const cards = page.locator('.space-card');
  await cards.first().waitFor({ state: 'visible' });

  // 分页控件出现（总产物 > 单页 6）。
  await expect(page.locator('.space-pagination')).toBeVisible();

  // 首页固定 6 张。
  await expect(cards).toHaveCount(6);

  // 翻到下一页：页码更新为第 2 页。
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText(/第 2\//)).toBeVisible();

  // 回到上一页还原首页数量。
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(cards).toHaveCount(6);
});
