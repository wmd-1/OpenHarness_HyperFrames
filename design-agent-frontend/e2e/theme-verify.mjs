// 主题验收截图脚本（change: design-frontend-theme-unify-and-layout-tokens 5.3/8.2）
// 用法：在 e2e 镜像内，先 build dist 到 ./dist，再 `node e2e/theme-verify.mjs`
// 验证切主题后顶栏/卡片/对话区不再保持亮色（用户问题②的视觉证明）。

import { chromium } from 'playwright';
import { createServer } from 'http';
import { statSync } from 'fs';
import { extname, join, normalize } from 'path';

const DIST = join(process.cwd(), 'dist');
const OUT = join(process.cwd(), 'docs/ui-theme-before-after');
const PORT = 4173;
const THEMES = ['default', 'dark', 'minimal', 'cyberpunk', 'solarized'];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serve() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = normalize(join(DIST, p));
      if (!fp.startsWith(DIST)) { res.statusCode = 403; return res.end('forbidden'); }
      try {
        const data = readFileSync(fp);
        res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream');
        res.end(data);
      } catch {
        // SPA fallback
        try { res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(join(DIST, 'index.html'))); }
        catch { res.statusCode = 404; res.end('not found'); }
      }
    });
    srv.listen(PORT, () => resolve(srv));
  });
}
import { readFileSync } from 'fs';

async function main() {
  try { statSync(DIST); } catch { console.error('dist 不存在，请先 npm run build'); process.exit(1); }
  const srv = await serve();
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH });
  const baseURL = `http://localhost:${PORT}`;
  console.log('baseURL:', baseURL);
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => {
      localStorage.setItem('da.apiKey', 'theme-verify-key');
      localStorage.setItem('da.theme', t);
    }, theme);
    const page = await ctx.newPage();
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.module-card', { timeout: 8000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${theme}-home.png`), fullPage: false });
    // 校验顶栏背景跟随主题：取 .app-header 背景色
    const headerBg = await page.evaluate(() => getComputedStyle(document.querySelector('.app-header')).backgroundColor);
    const cardBg = await page.evaluate(() => getComputedStyle(document.querySelector('.module-card')).backgroundColor);
    console.log(`[${theme}] app-header bg=${headerBg}  module-card bg=${cardBg}`);
    // 打开设置面板截图 ThemeSelector
    await page.click('button[aria-label="设置"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 4000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${theme}-settings.png`), fullPage: false });
    await ctx.close();
  }
  await browser.close();
  srv.close();
  console.log('done → docs/ui-theme-before-after/');
}
main().catch((e) => { console.error(e); process.exit(1); });
