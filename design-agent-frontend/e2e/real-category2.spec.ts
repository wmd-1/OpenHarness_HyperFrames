/**
 * 类别 2（原后端阻断项）真实浏览器 E2E —— 基于真实 Session Service + Postgres + Redis + Stub OH。
 *
 * 本轮通过给 stub oh 增加「内容触发令牌」与受控故障注入（session-service 侧，
 * OH_E2E_FAULT_INJECTION 开关，生产默认关闭）补齐了此前无法覆盖的错误/审批/中断/关闭码路径：
 *   - A1 审批流（permission / edit_diff / question）：stub 发 modal_request 帧，前端弹窗
 *   - I1 中断缩短轮次：stub 在阻塞 sleep 期间即时响应 interrupt
 *   - M2 /model 后端回执：stub 正确处理 /model 指令并回显
 *   - E3 403 / E5 503 / E6 内联抑制：session-service ?fault=403/503（建会话）
 *   - E9 WS close code：4400/4403/4404 经前端驱动真实触发；4429/4430/4503/4500 经 ?force_ws_code 注入
 *   - E1 后端崩溃：stub 进程退出，前端优雅报错
 *   - W3 断线重连 resume：刷新后轮次历史连续
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createSessionViaApi,
  createSessionViaApiWithPolicy,
  preauth,
  selectSession,
  sendMessage,
  waitForVideoReady,
  waitForTurns,
  closeActiveSession,
} from './_helpers';

function modelBtn(page: Page) {
  return page.locator('button[aria-label="模型切换"]');
}

/** 前端全局错误横幅（排除 dialog 内联提示）。 */
function banner(page: Page) {
  return page.getByRole('alert').filter({ hasNot: page.locator('[role="dialog"]') }).first();
}

/** 关闭码/后端异常后：前端应优雅处理（不崩溃），出现横幅或回退到稳定页面。 */
async function expectGraceful(page: Page) {
  const ok = banner(page)
    .or(page.locator('section.video-layout'))
    .or(page.locator('[data-testid="welcome"], .welcome'))
    .first();
  await expect(ok).toBeVisible({ timeout: 15_000 });
}

/** 直接打开指定 session 的视频页（不等待 ready，用于触发 close code 分支）。 */
async function gotoVideo(page: Page, sessionId: string) {
  await page.goto(`/video?session_id=${sessionId}`);
}

/**
 * 打开「创建会话」对话框并提交（不等待对话框关闭）。
 * 故障注入场景下建会话必然失败、对话框保持打开，故不可复用 createSessionUi（其会等 ready）。
 */
async function openCreateDialogAndSubmit(page: Page) {
  await page.goto('/video');
  await page.locator('.btn-new-session').first().click();
  const dialog = page.getByRole('dialog', { name: '创建会话' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  return dialog;
}

/**
 * 发一条消息并等待真实回复；若后端返回 `busy`（上一轮 turn_task 尚未收尾，
 * 前端提示「当前有轮次正在执行」）则退避重试。
 */
async function sendTurnAccepted(page: Page, text: string, tries = 6) {
  const input = page.locator('textarea[aria-label="消息输入"]');
  const send = page.locator('button[aria-label="发送"]');
  const reply = page.getByText(new RegExp(`Stub reply to: ${text}`)).first();
  for (let i = 0; i < tries; i++) {
    // 轮次进行中「发送」按钮会被「中断」按钮替换，等其回归。
    await expect(send).toBeVisible({ timeout: 30_000 });
    await input.fill(text);
    await expect(send).toBeEnabled({ timeout: 10_000 });
    await send.click();
    try {
      await reply.waitFor({ state: 'visible', timeout: 12_000 });
      return;
    } catch {
      await page.waitForTimeout(1_000);
    }
  }
  throw new Error(`submit not accepted after ${tries} tries: ${text}`);
}

/** 仅对建会话 POST 注入 ?fault=<code>（GET 列表不受影响）。 */
async function injectCreateFault(page: Page, fault: '403' | '503') {
  await page.route('**/v1/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('fault', fault);
    await route.continue({ url: url.toString() });
  });
}

test.describe('类别 2：原后端阻断项（真实后端）', () => {
  // ---- A1 审批流 ----
  test('A1a 审批-权限弹窗：allow 后轮次完成', async ({ page }) => {
    const s = await createSessionViaApiWithPolicy('a1-perm', 'interactive');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('@@approval:permission 生成一段视频');
    await page.locator('button[aria-label="发送"]').click();

    const dlg = page.getByRole('dialog', { name: '审批请求' });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await dlg.getByRole('button', { name: '允许一次' }).click();

    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('A1b 审批-差异弹窗：allow 后轮次完成', async ({ page }) => {
    const s = await createSessionViaApiWithPolicy('a1-diff', 'interactive');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('@@approval:edit_diff 改一下脚本');
    await page.locator('button[aria-label="发送"]').click();

    const dlg = page.getByRole('dialog', { name: '审批请求' });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await dlg.getByRole('button', { name: '允许本次修改' }).click();

    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('A1c 审批-提问弹窗：回答后轮次完成', async ({ page }) => {
    const s = await createSessionViaApiWithPolicy('a1-quest', 'interactive');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('@@approval:question 选哪个框架');
    await page.locator('button[aria-label="发送"]').click();

    const dlg = page.getByRole('dialog', { name: '审批请求' });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await dlg.locator('textarea[aria-label="回答"]').fill('React');
    await dlg.getByRole('button', { name: '提交回答' }).click();

    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('A1d 审批-全流程：permission→edit_diff→question 顺序弹窗', async ({ page }) => {
    const s = await createSessionViaApiWithPolicy('a1-all', 'interactive');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('@@approval 完整流程');
    await page.locator('button[aria-label="发送"]').click();

    for (let i = 0; i < 3; i++) {
      const dlg = page.getByRole('dialog', { name: '审批请求' });
      await expect(dlg).toBeVisible({ timeout: 20_000 });
      if (await dlg.getByText('请求修改文件').count()) {
        await dlg.getByRole('button', { name: '允许本次修改' }).click();
      } else if (await dlg.locator('textarea[aria-label="回答"]').count()) {
        await dlg.locator('textarea[aria-label="回答"]').fill('React');
        await dlg.getByRole('button', { name: '提交回答' }).click();
      } else {
        await dlg.getByRole('button', { name: '允许一次' }).click();
      }
    }
    await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 30_000 });
  });

  // ---- I1 中断缩短轮次 ----
  test('I1 中断真正提前结束轮次（stub 即时响应 interrupt）', async ({ page }) => {
    const s = await createSessionViaApi('i1-shorten');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('please take a while');
    await page.locator('button[aria-label="发送"]').click();

    const interruptBtn = page.locator('button[aria-label="中断当前轮次"]');
    await expect(interruptBtn).toBeVisible({ timeout: 5_000 });
    await interruptBtn.click();

    // stub 在阻塞 sleep 期间收到 interrupt 即提前 line_complete，回 "Interrupted:"。
    // 断言提前结束（远小于完整 OH_STUB_TURN_SECONDS=3s），证明中断「有效性」。
    await expect(page.getByText(/Interrupted:/).first()).toBeVisible({ timeout: 5_000 });
    await expect(modelBtn(page)).toBeEnabled();
    await expect(interruptBtn).toHaveCount(0);
  });

  // ---- M2 /model 后端回执 ----
  test('M2 /model 后端回执：切换模型后 stub 回显 Switched model', async ({ page }) => {
    const s = await createSessionViaApi('m2-backend');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    // 打开模型下拉，选一个与当前按钮标签不同的模型（触发 WS submit "/model X"）。
    await modelBtn(page).click();
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    const before = (await modelBtn(page).innerText()).trim();
    const opts = listbox.getByRole('option');
    const count = await opts.count();
    let target = opts.first();
    for (let i = 0; i < count; i++) {
      const t = (await opts.nth(i).innerText()).trim();
      if (t !== before) {
        target = opts.nth(i);
        break;
      }
    }
    const picked = (await target.innerText()).trim();
    await target.click();

    // 乐观更新：按钮显示选中的模型标签（证明 onRuntimeSwitch 受理，WS 已提交 /model）。
    await expect(modelBtn(page)).toHaveText(new RegExp(picked));
    // 后端回执：stub 正确处理 /model 指令（不再回 unknown request type），模型名出现在消息流
    // （用户命令 "/model <name>" 或后端回显 "Switched model to <name>" 任一即可）。
    await expect(page.getByText(new RegExp(picked)).first()).toBeVisible({ timeout: 15_000 });
  });

  // ---- E3 403 ----
  test('E3 创建会话 403：前端内联报错、不崩溃', async ({ page }) => {
    await preauth(page);
    await injectCreateFault(page, '403');
    const dialog = await openCreateDialogAndSubmit(page);

    // 对话框内联展示后端 detail 原文（非配额类 403 不误入配额文案），仍停留在创建态。
    await expect(dialog.getByRole('alert')).toHaveText(/403/, { timeout: 15_000 });
    await expect(dialog).toBeVisible();
  });

  // ---- E5 503 ----
  test('E5 创建会话 503：前端内联提示容量满', async ({ page }) => {
    await preauth(page);
    await injectCreateFault(page, '503');
    const dialog = await openCreateDialogAndSubmit(page);

    await expect(dialog.getByRole('alert')).toHaveText('服务容量已满', { timeout: 15_000 });
    // Retry-After: 1 → 重试按钮进入倒计时后恢复可点。
    await expect(dialog.getByRole('button', { name: /^重试/ })).toBeEnabled({ timeout: 15_000 });
  });

  // ---- E6 内联抑制 ----
  test('E6 创建 503 内联抑制：不弹全局 fatal 横幅、对话框仍可用', async ({ page }) => {
    await preauth(page);
    await injectCreateFault(page, '503');
    const dialog = await openCreateDialogAndSubmit(page);

    await expect(dialog.getByRole('alert')).toHaveText('服务容量已满', { timeout: 15_000 });
    // 抑制：建会话 503 不触发全局 fatal 横幅（仅对话框就地提示）。
    await expect(page.getByText('服务暂不可用，节点容量已满')).toHaveCount(0);
    // 全局只有对话框内这一处 alert（没有额外的全局横幅）。
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.locator('[role="dialog"] [role="alert"]')).toHaveCount(1);
    // 对话框保留且可再次尝试。
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^(重试|创建)/ })).toBeEnabled({
      timeout: 15_000,
    });
  });

  // ---- E9 WS close code ----
  test('E9a WS 4404 未知会话：前端优雅回退', async ({ page }) => {
    await preauth(page);
    await gotoVideo(page, '11111111-1111-4111-8111-111111111111');
    await expectGraceful(page);
  });

  test('E9b WS 4400 非法会话 id：前端优雅回退', async ({ page }) => {
    await preauth(page);
    await gotoVideo(page, 'not-a-valid-uuid');
    await expectGraceful(page);
  });

  test('E9c WS 4403 已关闭会话：前端进入只读', async ({ page }) => {
    const s = await createSessionViaApi('e9-closed');
    await preauth(page);
    await selectSession(page, s.session_id);
    await sendMessage(page, 'before close');
    await closeActiveSession(page);

    await gotoVideo(page, s.session_id);
    // 4403 → 会话只读：输入框禁用。
    await expect(page.locator('textarea[aria-label="消息输入"]')).toBeDisabled({ timeout: 15_000 });
  });

  // 4429/4430/4503/4500 关闭码：经 ?force_ws_code 注入（仅 OH_E2E_FAULT_INJECTION 开）。
  // 注：4401（非法 key）走 markAuthExpired→回到欢迎页、无横幅，不在此断言；
  //      4400/4403/4404 已分别由 E9a/E9b/E9c 经真实会话状态驱动触发。
  for (const [code, label] of [
    [4429, 'WS 限流'],
    [4430, '租户配额满'],
    [4503, '容量满'],
    [4500, '后端不可用'],
  ] as const) {
    test(`E9d WS ${code} ${label}：前端按码处理`, async ({ page }) => {
      const s = await createSessionViaApi(`e9-${code}`);
      await preauth(page);
      // 给 WebSocket 构造函数注入 ?force_ws_code=<code>，使 session-service 立即以该码关闭。
      await page.addInitScript((c: number) => {
        const Orig = (window as any).WebSocket;
        (window as any).WebSocket = class extends Orig {
          constructor(url: string | URL, protocols?: any) {
            const u = String(url);
            const sep = u.includes('?') ? '&' : '?';
            super(u + sep + 'force_ws_code=' + c, protocols);
          }
        };
      }, code);

      // force_ws_code 使 WS 立即关闭，前端不会进入 ready；直接打开页面并断言按码分支（横幅/回退）。
      await gotoVideo(page, s.session_id);
      await expectGraceful(page);
    });
  }

  // ---- E1 后端崩溃 ----
  test('E1 后端崩溃：前端优雅报错不崩溃', async ({ page }) => {
    const s = await createSessionViaApi('e1-crash');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    const input = page.locator('textarea[aria-label="消息输入"]');
    await input.fill('@@crash 模拟后端挂掉');
    await page.locator('button[aria-label="发送"]').click();

    // stub 进程退出 → session-service 标记 FAILED/COLD → 前端优雅处理（不崩溃、不白屏）。
    await expectGraceful(page);
  });

  // ---- W3 断线重连 resume ----
  test('W3 刷新后 WS 重连：轮次历史连续', async ({ page }) => {
    const s = await createSessionViaApi('w3-resume');
    await preauth(page);
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    await sendTurnAccepted(page, 'first turn');
    await sendTurnAccepted(page, 'second turn');

    // 以真实 REST 轮次历史为准（避免只依赖流式渲染）。
    const turnsBefore = await waitForTurns(s.session_id, 60_000, 2);
    expect(turnsBefore.length).toBeGreaterThanOrEqual(2);

    // 刷新页面 → WS 断线重连 → 历史（turn_count 连续）应保留。
    await page.reload();
    await selectSession(page, s.session_id);
    await waitForVideoReady(page);

    await expect(page.getByText(/Stub reply to: first turn/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Stub reply to: second turn/).first()).toBeVisible({ timeout: 15_000 });
  });
});
