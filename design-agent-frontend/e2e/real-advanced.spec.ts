import { test, expect, type Page } from '@playwright/test';
import {
  API_KEY,
  preauth,
  loginFlow,
  createSessionViaApi,
  selectSession,
  sendMessage,
  waitForVideoReady,
  waitForTurns,
  getSessionViaApi,
  closeActiveSession,
  CURRENT_SESSION_KEY,
} from './_helpers';

/**
 * 进阶能力真实后端 E2E（stub oh 可确定触发的部分）。
 *
 * 覆盖（对应 design.md M/I/T/W 类需求）：
 *   - T1 Terminal 模式切换：单条 WS 贯穿 Chat/Terminal，切换不重连，历史保留
 *   - M1 模型双通道①：建会话经 extra_oh_args 注入 --model（请求拦截断言）
 *   - M2 模型双通道②：空闲态经 WS 提交 /model，下拉乐观更新显示
 *   - M3 模型入口在轮次执行中禁用（busy 态防御）
 *   - I1 中断当前轮次：stub 固定睡 OH_STUB_TURN_SECONDS，interrupt 使其提前 line_complete
 *   - W4 关闭会话（DELETE→只读）后轮次历史仍可读
 *
 * 后端阻断项（stub 无注入点，非目标内不改动后端，见 design.md D3）：
 *   - A1 审批流：stub 不发射 approval 帧，ApprovalModal 不可被真实触发
 *   - M2 回执真实切模：stub 对 /model 回 unknown request type，仅验证乐观 UI
 *   - E3/E5/E9、W2/W3：需 403/503/WS close code 故障注入或杀容器，stub 不支持
 */

function modelBtn(page: Page) {
  return page.getByRole('button', { name: '模型切换' });
}

test('T1 Terminal 模式切换：WS 贯穿不重连 + 聊天历史保留', async ({ page }) => {
  const s = await createSessionViaApi('t1-terminal');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'hello terminal');
  await expect(page.getByText(/Stub reply to:/)).toBeVisible();

  // 切到 Terminal：xterm 容器挂载，且 WS 因单连接贯穿而不应断开。
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByTestId('xterm-container')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('section.video-layout')).toHaveAttribute(
    'data-ws-status',
    /^(ready|connected)$/,
    { timeout: 10_000 },
  );

  // 切回 Chat：消息历史仍在（非重新加载）。
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByText(/Stub reply to:/)).toBeVisible();
});

test('M1 模型双通道①：建会话经 extra_oh_args 注入 --model', async ({ page }) => {
  // 预置选中模型，使 uiStore.selectedModel='opus'（da.model 持久化）；
  // CreateDialog.handleSubmit 据此经 withModelArg 注入 --model（非默认模型才注入）。
  await page.addInitScript(() => {
    localStorage.setItem('da.model', 'opus');
  });
  await loginFlow(page, API_KEY);
  await page.goto('/video');

  let captured: any = null;
  await page.route('**/v1/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      try {
        captured = route.request().postDataJSON();
      } catch {
        captured = null;
      }
    }
    await route.continue();
  });

  await page.locator('.btn-new-session').first().click();
  const dialog = page.getByRole('dialog', { name: '创建会话' });
  await dialog.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await waitForVideoReady(page);

  expect(captured).not.toBeNull();
  expect(Array.isArray(captured.extra_oh_args)).toBe(true);
  expect(captured.extra_oh_args).toEqual(expect.arrayContaining(['--model', 'opus']));
});

test('M2 模型双通道②：空闲态切模乐观更新下拉显示', async ({ page }) => {
  const s = await createSessionViaApi('m2-runtime');
  await preauth(page);
  await selectSession(page, s.session_id);
  await waitForVideoReady(page);

  const btn = modelBtn(page);
  await expect(btn).toBeEnabled();
  await btn.click();
  await page.getByRole('option', { name: 'Sonnet' }).click();
  // 乐观更新：下拉按钮文案立即变为 Sonnet（stub 对 /model 回 unknown request type，
  // 真实后端才回执，本例仅验证前端乐观显示路径）。
  await expect(btn).toHaveText(/Sonnet/);
});

test('M3 模型切换入口在轮次执行中禁用', async ({ page }) => {
  const s = await createSessionViaApi('m3-busy');
  await preauth(page);
  await selectSession(page, s.session_id);
  await waitForVideoReady(page);

  const input = page.locator('textarea[aria-label="消息输入"]');
  await input.fill('busy turn');
  await page.locator('button[aria-label="发送"]').click();

  // busy 窗口（stub 睡 OH_STUB_TURN_SECONDS=3）：模型入口禁用。
  const btn = modelBtn(page);
  await expect(btn).toBeDisabled({ timeout: 5_000 });

  // 轮次结束后恢复可用。
  await expect(page.getByText(/Stub reply to:/).first()).toBeVisible({ timeout: 15_000 });
  await expect(btn).toBeEnabled();
});

test('I1 中断控制接线：busy 期间可见可点，轮次正常结束后消失', async ({ page }) => {
  const s = await createSessionViaApi('i1-interrupt');
  await preauth(page);
  await selectSession(page, s.session_id);
  await waitForVideoReady(page);

  const input = page.locator('textarea[aria-label="消息输入"]');
  await input.fill('interrupt me');
  await page.locator('button[aria-label="发送"]').click();

  // busy 态出现中断按钮（控制权接线正确）。
  const interruptBtn = page.locator('button[aria-label="中断当前轮次"]');
  await expect(interruptBtn).toBeVisible({ timeout: 5_000 });
  // 点击中断：前端发出 WS interrupt（不崩溃）。
  await interruptBtn.click();

  // 注：stub oh 现已支持在阻塞 sleep 期间即时响应 interrupt（real-category2 的 I1
  // 验证「提前结束」）。此处仅验证前端接线：轮次最终完成、中断按钮随轮次结束而消失。
  // 中断后 stub 回 "Interrupted:"；若未点中断则回 "Stub reply to:"，二者任一即代表完成。
  const btn = modelBtn(page);
  await expect(btn).toBeEnabled({ timeout: 12_000 });
  await expect(
    page.getByText(/Interrupted:|Stub reply to:/).first(),
  ).toBeVisible({ timeout: 5_000 });
  await expect(interruptBtn).toHaveCount(0);
});

test('W4 关闭会话后轮次历史仍可读（DELETE→只读）', async ({ page }) => {
  const s = await createSessionViaApi('w4-closed');
  await preauth(page);
  await selectSession(page, s.session_id);
  await sendMessage(page, 'before close');
  await closeActiveSession(page);

  // 关闭后 GET /turns 仍返回历史（read_only 不删数据）——这是 W4 的核心：软关闭不删历史。
  // 注：stub 栈下 has_artifact 标志对已关闭会话不可靠（产物登记依赖 session-service 异步
  // 扫描），故不在此断言产物直链；产物存活性已在 session-service 契约（rest.sh）覆盖。
  const turns = await waitForTurns(s.session_id);
  expect(turns.length).toBeGreaterThan(0);
  const ourTurn = turns.find((t) => JSON.stringify(t).includes('before close'));
  expect(ourTurn).toBeTruthy();

  // 软关闭后端侧：会话置为 read_only（status=closed），但历史与产物保留。
  const session = await getSessionViaApi(s.session_id);
  expect(session.status).toBe('closed');
  // 前端侧：仍停留在该会话但进入只读（输入框禁用），不崩溃、不误清空。
  const sid = await page.evaluate(
    (k) => localStorage.getItem(k),
    CURRENT_SESSION_KEY,
  );
  expect(sid).toBe(s.session_id);
  await expect(page.locator('textarea[aria-label="消息输入"]')).toBeDisabled();
});
