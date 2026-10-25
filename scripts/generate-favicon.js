#!/usr/bin/env node
/*
 * Renders favicon.ico and apple-touch-icon.png from favicon.svg so the marks
 * can never drift apart. iOS ignores an SVG touch icon and wants a 180px PNG.
 * Legacy browsers, Google's favicon crawler and most link-preview bots resolve
 * /favicon.ico rather than the SVG, so a stale .ico means the old logo keeps
 * showing up in tabs and search results.
 *
 * Manual step, same as the OG image — run it when the mark changes:
 * `npm run generate-favicon`. Both files are committed as static assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib/issues.js';

const SVG_PATH = path.join(ROOT, 'favicon.svg');
const ICO_PATH = path.join(ROOT, 'favicon.ico');
const TOUCH_ICON_PATH = path.join(ROOT, 'apple-touch-icon.png');

const SIZES = [16, 32, 48];
const TOUCH_ICON_SIZE = 180;

// ICO container: 6-byte header, then one 16-byte directory entry per image,
// then the image payloads. Every modern consumer accepts PNG payloads.
function buildIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);

    const entries = [];
    let offset = 6 + images.length * 16;

    for (const { size, png } of images) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
        entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
        entry.writeUInt8(0, 2); // palette size (0 = no palette)
        entry.writeUInt8(0, 3); // reserved
        entry.writeUInt16LE(1, 4); // colour planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += png.length;
    }

    return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const svg = fs.readFileSync(SVG_PATH, 'utf8');
const browser = await chromium.launch();

async function renderPng(size) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
        `<!DOCTYPE html><html><head><style>
            html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; }
            svg { display: block; width: ${size}px; height: ${size}px; }
        </style></head><body>${svg}</body></html>`,
        { waitUntil: 'load' },
    );
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    return png;
}

const images = [];
for (const size of SIZES) images.push({ size, png: await renderPng(size) });
const touchIcon = await renderPng(TOUCH_ICON_SIZE);

await browser.close();
fs.writeFileSync(ICO_PATH, buildIco(images));
fs.writeFileSync(TOUCH_ICON_PATH, touchIcon);
console.log(
    `[generate-favicon] wrote ${ICO_PATH} (${SIZES.join(', ')}px) and ${TOUCH_ICON_PATH} (${TOUCH_ICON_SIZE}px)`,
);
