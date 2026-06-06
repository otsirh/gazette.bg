#!/usr/bin/env node
/*
 * Generates the 1200x630 social share image (og-image.png) used by Open Graph
 * and Twitter Cards. This is a one-off, manual step — run it only when the
 * branding changes: `npm run generate-og-image`. The PNG is committed as a
 * static asset, so deploys never depend on a browser being available.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'og-image.png');

// Mirrors the site's newspaper aesthetic (cream paper, serif title, rules).
const html = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"/>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600&family=Source+Serif+4:wght@600;700&display=swap');
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    font-family: 'Source Sans 3', system-ui, sans-serif;
    background: #f4ede0; color: #1a1a1a; padding: 70px 80px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .eyebrow {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 24px; text-transform: uppercase; letter-spacing: 0.16em; color: #6a6258;
    border-bottom: 3px solid #1a1a1a; padding-bottom: 18px;
  }
  .title {
    font-family: 'Source Serif 4', Georgia, serif; font-weight: 700;
    font-size: 82px; line-height: 1.05; letter-spacing: -0.01em; margin-top: 36px;
  }
  .title .accent { color: #a8421a; }
  .sub {
    font-family: 'Source Serif 4', Georgia, serif; font-size: 34px;
    color: #3a3530; margin-top: 26px; max-width: 1000px; line-height: 1.35;
  }
  .footer {
    display: flex; justify-content: space-between; align-items: center;
    border-top: 1px solid #d9cfbb; padding-top: 22px; font-size: 28px; color: #6a6258;
  }
  .footer .url { color: #a8421a; font-weight: 600; letter-spacing: 0.02em; }
</style></head>
<body>
  <div class="eyebrow"><span>Държавен вестник</span><span>обобщения с AI</span></div>
  <div>
    <div class="title">Законите на България,<br/><span class="accent">накратко и разбираемо</span></div>
    <!-- two lines keeps the card balanced at 1200x630 -->
    <div class="sub">Кратки обобщения на всеки брой на Държавен вестник — закони, постановления и решения за минути.</div>
  </div>
  <div class="footer"><span class="url">gazette.bg</span><span>Неофициален източник · dv.parliament.bg</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(400); // let the webfont settle
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();
console.log('[generate-og-image] wrote', OUT);
