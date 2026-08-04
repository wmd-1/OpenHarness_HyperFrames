/**
 * 决定性控制组：真实同源 HTTP 静态页 A -> B -> Back 的 BFCache 验证。
 *
 * 目的（test-infra change 2026-08-04-e2e-chromium-new-headless-bfcache 诊断，
 * 不修改 BF3、不归档 change）：
 *   在**同一浏览器、同一套启动参数**下，使用一个**真实 HTTP 服务**（Node http，
 *   从磁盘读取真正的 .html 文件，经 TCP 返回真实 HTTP 响应）提供两张纯静态页面，
 *   不经过 Vite、不经过 Playwright route.fulfill、不经过 data:、不经过任何业务/dev server。
 *
 *   若 A->B->Back 后 pageshow.persisted === true  -> BFCache 能力存在，
 *     说明 BF3 的 false 来自 E2E harness（vite/HMR/WS/缓存头等），而非 Chromium 本身。
 *   若 pageshow.persisted 始终为 false              -> 这是该浏览器/headless 启动参数
 *     下的能力限制，与实验方法无关。
 *
 * 本用例为诊断探针：明确输出结论（console + annotations + 附件 JSON），不充当 CI 门控。
 * 通过 run 脚本两次运行（带 / 不带 PW_USE_NEW_HEADLESS=1）可分别验证两套启动参数。
 */

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static-ab');

interface PageshowEvent {
  persisted: boolean;
  url: string;
  t: number;
}

function startStaticServer(): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // 仅提供 static-ab 目录内的 .html；防目录穿越。
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
      let rel = safe === '/' || safe === '' ? 'a.html' : safe.replace(/^\/+/, '');
      const file = join(STATIC_DIR, rel);
      if (!file.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      try {
        const body = readFileSync(file);
        // 注意：不发送 no-store / 不发送任何阻止 BFCache 的响应头。
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'max-age=300',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

// 若设置了 BFCACHE_STATIC_PORT，则复用由外部进程（如独立 python3 -m http.server）
// 提供的真实静态 HTTP 服务，而非在测试进程内自建服务器——彻底排除测试进程内建服务
// 与 Playwright 之间可能存在的耦合疑虑。
const EXTERNAL_PORT = process.env.BFCACHE_STATIC_PORT;
const useExternal = !!EXTERNAL_PORT;

test.describe('真实 HTTP 静态页 BFCache 控制组', () => {
  test('A -> B -> Back：真实同源静态页能否命中 BFCache', async ({ page, context }) => {
    const srv = useExternal
      ? { baseUrl: `http://127.0.0.1:${EXTERNAL_PORT}`, close: () => {} }
      : await startStaticServer();
    const verdict: Record<string, unknown> = {
      baseUrl: srv.baseUrl,
      serverMode: useExternal ? 'external-python-http-server' : 'in-process-node-http',
    };

    try {
      // pageshow 捕获：必须在 a.html 文档创建前注册，随 BFCache 冻结/恢复保留监听。
      await page.addInitScript(() => {
        (window as any).__ps = [];
        window.addEventListener('pageshow', (e: PageTransitionEvent) => {
          (window as any).__ps.push({
            persisted: e.persisted,
            url: location.pathname,
            t: Date.now(),
          } as PageshowEvent);
        });
      });

      // A 加载（首次，persisted 应为 false；确认监听已安装）。
      await page.goto(`${srv.baseUrl}/a.html`);
      await expect(page.locator('h1')).toHaveText('Page A');

      // B 加载。
      await page.goto(`${srv.baseUrl}/b.html`);
      await expect(page.locator('h1')).toHaveText('Page B');

      // 返回 A：若命中 BFCache，a.html 的 pageshow(persisted=true) 会被保留的上下文触发。
      await page.goBack();
      await expect(page.locator('h1')).toHaveText('Page A');

      const events: PageshowEvent[] = await page.evaluate(
        () => (window as any).__ps ?? [],
      );
      verdict.pageshowEvents = events;

      // 附加证据：恢复导航的 PerformanceNavigationTiming.entryType/type。
      const navType = await page.evaluate(() => {
        const navs = performance.getEntriesByType(
          'navigation',
        ) as PerformanceNavigationTiming[];
        return navs.map((n) => ({ type: n.type, name: n.name }));
      });
      verdict.navigationEntries = navType;

      // 运行模式实证：headed 模式窗口有标题栏/边框，outerHeight - innerHeight > 0；
      // headless 无窗口装饰，差值≈0。用于确证本次是否真正以“有头”运行，
      // 排除“headless:false 被静默忽略”的疑虑。
      const modeProbe = await page.evaluate(() => {
        return {
          outerH: window.outerHeight,
          innerH: window.innerHeight,
          outerW: window.outerWidth,
          innerW: window.innerWidth,
          chromeDelta: window.outerHeight - window.innerHeight,
          screenW: window.screen.width,
          screenH: window.screen.height,
          ua: navigator.userAgent,
        };
      });
      verdict.modeProbe = modeProbe;
      verdict.pwHeadedEnv = process.env.PW_HEADED === '1';
      verdict.pwNewHeadlessEnv = process.env.PW_USE_NEW_HEADLESS === '1';

      const backPersisted = events.some((e) => e.persisted === true);
      verdict.backPersisted = backPersisted;

      // 结论输出。
      const conclusion = backPersisted
        ? 'REAL-HTTP-HIT: 真实静态 HTTP 页命中 BFCache(persisted=true) => BF3 的 false 来自 E2E harness（vite/HMR/WS/缓存头等），非 Chromium 能力问题。'
        : 'REAL-HTTP-MISS: 真实静态 HTTP 页仍未命中 BFCache(persisted=false) => 该浏览器/headless 启动参数下 BFCache 不可用，与实验方法无关。';
      verdict.conclusion = conclusion;
      verdict.launchArgs =
        (context as any)._options?.launchOptions?.args ?? 'n/a';

      console.log('=== BFCACHE-STATIC-CONTROL VERDICT ===');
      console.log(JSON.stringify(verdict, null, 2));
      console.log('=== /BFCACHE-STATIC-CONTROL VERDICT ===');

      test.info().annotations.push({
        type: 'BFCache-static-control',
        description: conclusion,
      });
      await test.info().attach('bfcache-static-verdict.json', {
        body: JSON.stringify(verdict, null, 2),
        contentType: 'application/json',
      });

      // 诊断探针：不强制 pass/fail，但必须确认 pageshow 监听确实工作（至少一次首次加载 false）。
      expect(events.length, 'pageshow 监听应至少捕获到首次加载事件').toBeGreaterThan(0);
    } finally {
      srv.close();
    }
  });
});
