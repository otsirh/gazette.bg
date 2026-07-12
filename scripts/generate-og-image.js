#!/usr/bin/env node
/*
 * Generates the 1200x630 social share image (og-image.png) used by Open Graph
 * and Twitter Cards. This is a one-off, manual step — run it only when the
 * branding changes: `npm run generate-og-image`. The PNG is committed as a
 * static asset, so deploys never depend on a browser being available.
 *
 * Mirrors the site: cream paper, Playfair nameplate, mono apparatus, a
 * vermilion rule. It is the front page of the paper, shrunk to a card.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'og-image.png');

const html = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"/>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Source+Serif+4:ital@0;1&family=JetBrains+Mono:wght@500;700&display=swap');
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: #fbf8f2; color: #14120d; padding: 56px 72px 48px;
    display: flex; flex-direction: column; justify-content: space-between;
    font-family: 'Source Serif 4', Georgia, serif;
  }
  .mono { font-family: 'JetBrains Mono', monospace; text-transform: uppercase; letter-spacing: 0.16em; }
  .kicker { font-size: 17px; font-weight: 500; color: #857f72; text-align: center; }
  .nameplate {
    font-family: 'Playfair Display', Georgia, serif; font-weight: 800;
    font-size: 96px; line-height: 1; letter-spacing: -0.02em; text-align: center;
    margin-top: 22px;
  }
  .edition {
    display: flex; justify-content: center; gap: 22px; margin-top: 26px;
    padding: 12px 0; border-top: 1px solid #14120d; border-bottom: 1px solid #14120d;
    font-size: 15px; font-weight: 500; color: #46413a;
  }
  .edition .accent { color: #ad2c20; font-weight: 700; }
  .edition .sep { color: #ddd6c7; }
  .lede {
    margin-top: 40px; font-size: 34px; font-style: italic; line-height: 1.4;
    color: #46413a; text-align: center; max-width: 900px; align-self: center;
  }
  .footer {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 18px; border-top: 1px solid #ddd6c7;
    font-size: 15px; color: #857f72;
  }
  .footer .url { color: #14120d; font-weight: 700; }
  .rule { width: 64px; height: 3px; background: #ad2c20; margin: 34px auto 0; }
</style></head>
<body>
  <div>
    <div class="mono kicker">Обобщения на официалното издание</div>
    <div class="nameplate">Държавен вестник</div>
    <div class="mono edition">
      <span class="accent">Неофициално издание</span>
      <span class="sep">·</span>
      <span>Обобщения с изкуствен интелект</span>
    </div>
  </div>
  <div>
    <div class="lede">Новите закони, правила и решения от всеки брой — обобщени ясно и кратко, за да видите какво ви засяга за минути.</div>
    <div class="rule"></div>
  </div>
  <div class="mono footer"><span class="url">gazette.bg</span><span>Източник · dv.parliament.bg</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(500); // let the webfonts settle
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();
console.log('[generate-og-image] wrote', OUT);
