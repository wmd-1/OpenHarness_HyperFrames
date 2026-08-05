import { test } from '@playwright/test';
import {
  API_KEY,
  preauth,
  createSessionViaApi,
  selectSession,
  listTurnsViaApi,
} from './_helpers';

/**
 * J5 live-path 证据闭环诊断（只读取证，绝不修改任何业务代码/原 J5 断言）。
 *
 * 关键修正 ①：每个会话使用「全新 browser context」（与 Playwright 单测隔离一致），
 * 避免同一 page 反复 page.goto 导致的会话 store 跨会话泄漏污染证据。
 * 关键修正 ②：自己实现 sendTurn，显式等待「第 N 个 turn_complete WS 帧」到达，
 * 避免共享 sendMessage 用 .first() 匹配到上一条已存在的 "Stub reply to:" 而提前返回，
 * 导致第二轮消息未被驱动完成（这是上一轮只观察到 1 轮的根因，属测试辅助缺陷）。
 *
 * 三方交叉：
 *   (1) WS 帧：Playwright page.on('websocket') 捕获真实 turn_complete 帧
 *       → { turn_index, has_artifact, ts }（后端经 supervisor 注入）。
 *   (2) 前端 DOM：产物轮次切换条 tab 数 = artifactTurns.length 的代理；
 *       早期(15s) vs 晚期(+5s) 对比，用于区分「等待不足(D)」与「前端状态缺口(B/C)」。
 *   (3) REST /turns：后端落库 has_artifact 真值（DB 事实）。
 */
test.setTimeout(30 * 60 * 1000);

interface WsTurn {
  conn: number;
  ts: number;
  turn_index: number | null;
  has_artifact: boolean | null;
}
interface Iter {
  i: number;
  sid: string;
  earlyVisible: boolean;
  tabEarly: number;
  tabLate: number;
  wsTurns: WsTurn[];
  sentFrames: any[];
  serverFrames: any[];
  secondTurnArrived: boolean;
  restHasArtifactTrue: number;
  restTurnCount: number;
  consoleErrors: string[];
}

async function sendTurn(
  page: any,
  text: string,
  wsTurns: WsTurn[],
  expectCount: number,
  timeoutMs = 60_000,
): Promise<void> {
  const input = page.locator('textarea[aria-label="消息输入"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(text);
  const sendBtn = page.locator('button[aria-label="发送"]');
  // 关键：等待「发送」按钮可用再点击——上一条 turn 的 busy 窗口内按钮会被禁用，
  // 直接 click 会被静默忽略（这正是上一轮 2nd turn 丢失的根因候选）。
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await sendBtn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await sendBtn.click();
  // 等待第 expectCount 个 turn_complete 帧
  while (Date.now() - start < timeoutMs) {
    if (wsTurns.length >= expectCount) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout: expected ${expectCount} turn_complete, got ${wsTurns.length}`);
}

test('J5 live-path evidence capture (diagnostic)', async ({ browser }) => {
  const N = 2;
  const iters: Iter[] = [];
  for (let i = 0; i < N; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const wsTurns: WsTurn[] = [];
    const serverFrames: any[] = [];
    const sentFrames: any[] = [];
    let connIdx = 0;
    page.on('websocket', (ws) => {
      const c = ++connIdx;
      ws.on('framereceived', (frame) => {
        try {
          const o = JSON.parse(String((frame as any).payload));
          serverFrames.push({ conn: c, ts: Date.now(), type: o?.type ?? null, turn_index: o?.turn_index ?? null, has_artifact: o?.has_artifact ?? null, interrupted: o?.interrupted ?? null, message: typeof o?.message === 'string' ? o.message.slice(0, 120) : undefined });
          if (o && o.type === 'turn_complete') {
            wsTurns.push({
              conn: c,
              ts: Date.now(),
              turn_index: o.turn_index ?? null,
              has_artifact: o.has_artifact ?? null,
            });
          }
        } catch {
          /* ignore */
        }
      });
      ws.on('framesent', (frame) => {
        try {
          const o = JSON.parse(String((frame as any).payload));
          sentFrames.push({ conn: c, ts: Date.now(), type: o?.type ?? null, text: typeof o?.text === 'string' ? o.text.slice(0, 60) : undefined });
        } catch {
          /* ignore non-JSON */
        }
      });
    });
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

    // 捕获 POST /turns 的请求与响应，确认第 2 条消息到底有没有真正 submitted
    const turnPosts: any[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/turns')) {
        turnPosts.push({ kind: 'req', url: req.url(), ts: Date.now() });
      }
    });
    page.on('response', async (resp) => {
      const req = resp.request();
      if (req.method() === 'POST' && req.url().includes('/turns')) {
        let body = '';
        try {
          body = (await resp.text()).slice(0, 400);
        } catch {
          /* ignore */
        }
        turnPosts.push({ kind: 'res', status: resp.status(), url: req.url(), body, ts: Date.now() });
      }
    });

    await preauth(page);
    const created = await createSessionViaApi(`j5-diag-${i}`);
    const sid = created.session_id as string;
    await selectSession(page, sid);

    // 显式等待第 1、第 2 个 turn_complete 帧（不让 .first() 提前返回）
    wsTurns.length = 0;
    await sendTurn(page, 'first artifact turn', wsTurns, 1);
    let secondTurnArrived = true;
    try {
      await sendTurn(page, 'second artifact turn', wsTurns, 2);
    } catch (e) {
      secondTurnArrived = false;
      consoleErrors.push('secondTurn: ' + String(e));
    }

    const switcher = page.getByRole('tablist', { name: '产物轮次切换' });
    let earlyVisible = false;
    let tabEarly = 0;
    try {
      await switcher.waitFor({ state: 'visible', timeout: 15_000 });
      earlyVisible = true;
      tabEarly = await switcher.getByRole('tab').count();
    } catch {
      tabEarly = await switcher.getByRole('tab').count().catch(() => 0);
    }
    // D 检验：多等 5s 再读一次
    await page.waitForTimeout(5_000);
    let tabLate = 0;
    if (await switcher.isVisible().catch(() => false)) {
      tabLate = await switcher.getByRole('tab').count();
    }

    let restTurnCount = 0;
    let restHasArtifactTrue = 0;
    try {
      const turns = await listTurnsViaApi(sid);
      restTurnCount = turns.length;
      restHasArtifactTrue = turns.filter((t) => t.has_artifact === true).length;
    } catch (e) {
      consoleErrors.push('listTurns failed: ' + String(e));
    }

    iters.push({
      i,
      sid,
      earlyVisible,
      tabEarly,
      tabLate,
      wsTurns,
      serverFrames,
      sentFrames,
      secondTurnArrived,
      restHasArtifactTrue,
      restTurnCount,
      turnPosts,
      consoleErrors,
    });
    await context.close();
  }

  console.log('J5_DIAG_SUMMARY ' + JSON.stringify({ apiKey: API_KEY, iters }, null, 2));
});
