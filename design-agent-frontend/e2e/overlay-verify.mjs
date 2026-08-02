// 浮层公共原语视觉验收（change: design-frontend-overlay-primitives P0+P1 门禁 2.3/4.2）
// 验证：① z-index 修复（overlay var(--z-modal)=200 > header var(--z-header)=100）；
//       ② CreateDialog overlay-click 关闭保现；③ SettingsPanel 抽屉渲染。
// 用法：e2e 镜像内 `npm run build && node e2e/overlay-verify.mjs`

import { chromium } from 'playwright';
import { createServer } from 'http';
import { statSync, readFileSync } from 'fs';
import { extname, join, normalize } from 'path';

const DIST = join(process.cwd(), 'dist');
const OUT = join(process.cwd(), 'docs/overlay-primitives-before-after');
const PORT = 4174;
const THEMES = ['default', 'dark'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serve() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = normalize(join(DIST, p));
      if (!fp.startsWith(DIST)) { res.statusCode = 403; return res.end('forbidden'); }
      try {
        res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream');
        res.end(readFileSync(fp));
      } catch {
        try { res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(join(DIST, 'index.html'))); }
        catch { res.statusCode = 404; res.end('not found'); }
      }
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

async function main() {
  try { statSync(DIST); } catch { console.error('dist 不存在，请先 npm run build'); process.exit(1); }
  const srv = await serve();
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH });
  const baseURL = `http://localhost:${PORT}`;
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => {
      localStorage.setItem('da.apiKey', 'overlay-verify-key');
      localStorage.setItem('da.theme', t);
    }, theme);
    const page = await ctx.newPage();
    // === SettingsPanel（从首页点设置按钮）===
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.module-card', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.click('button[aria-label="设置"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 4000 });
    await page.waitForTimeout(300);
    const settingsZ = await page.evaluate(() => {
      const overlay = document.querySelector('[role="presentation"]');
      const header = document.querySelector('.app-header');
      return {
        overlayZ: overlay ? getComputedStyle(overlay).zIndex : 'none',
        headerZ: header ? getComputedStyle(header).zIndex : 'none',
      };
    });
    await page.screenshot({ path: join(OUT, `${theme}-settings.png`) });
    console.log(`[${theme}] SettingsPanel: overlay z=${settingsZ.overlayZ}  header z=${settingsZ.headerZ}  → overlay>header: ${Number(settingsZ.overlayZ) > Number(settingsZ.headerZ)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // === CreateDialog（导航到 /video 点新建会话）===
    await page.goto(`${baseURL}/video`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.btn-new-session', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.click('.btn-new-session');
    await page.waitForSelector('[role="dialog"]', { timeout: 4000 });
    await page.waitForTimeout(300);
    const dialogZ = await page.evaluate(() => {
      const overlay = document.querySelector('[role="presentation"]');
      const header = document.querySelector('.app-header');
      return {
        overlayZ: overlay ? getComputedStyle(overlay).zIndex : 'none',
        headerZ: header ? getComputedStyle(header).zIndex : 'none',
      };
    });
    await page.screenshot({ path: join(OUT, `${theme}-create-dialog.png`) });
    console.log(`[${theme}] CreateDialog:   overlay z=${dialogZ.overlayZ}  header z=${dialogZ.headerZ}  → overlay>header: ${Number(dialogZ.overlayZ) > Number(dialogZ.headerZ)}`);

    // === CreateDialog overlay-click 关闭保现（点遮罩应关闭）===
    await page.click('[role="presentation"]', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(400);
    const dialogGone = await page.locator('[role="dialog"]').count();
    console.log(`[${theme}] CreateDialog overlay-click 关闭保现: dialog count=${dialogGone} (期望 0)`);
    await ctx.close();
  }
  await browser.close();
  srv.close();
  console.log('done → docs/overlay-primitives-before-after/');
}
main().catch((e) => { console.error(e); process.exit(1); });
