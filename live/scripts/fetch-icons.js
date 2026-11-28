#!/usr/bin/env node
// Fetches each outlet's icon once and keeps it in live/site/icons/ as a 64 px
// PNG, so pages show it without sending readers to anyone else's server.
//
// A site gives its apple-touch-icon or a PNG/SVG icon from its home page; a
// YouTube channel gives its avatar. Raster icons are scaled by drawing them
// into an SVG and rendering that with resvg (no image library needed). An
// outlet without a usable icon keeps the coloured dot.
//
//   node live/scripts/fetch-icons.js            # only outlets without one
//   node live/scripts/fetch-icons.js --all      # all again
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { mapLimit, USER_AGENT } from '../lib/feeds.js';
import { outletOf, SOURCES } from '../sources.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'site', 'icons');
const SIZE = 64;

async function get(url, { binary = false } = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'bg,en;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    return { type, body: binary ? Buffer.from(await res.arrayBuffer()) : await res.text(), url: res.url };
}

const attr = (tag, name) => tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1];

// The best icon a page declares: apple-touch first (big, square, PNG), then
// PNG or SVG icons, largest first.
function iconCandidates(html, base) {
    const links = html.match(/<link\b[^>]*>/gi) ?? [];
    const found = [];
    for (const tag of links) {
        const rel = (attr(tag, 'rel') ?? '').toLowerCase();
        const href = attr(tag, 'href');
        if (!href || !/icon/.test(rel)) continue;
        const size = Number((attr(tag, 'sizes') ?? '').split('x')[0]) || 0;
        const score = (rel.includes('apple-touch') ? 1000 : 0) + (/\.svg(\?|$)/i.test(href) ? 500 : 0) + size;
        try {
            found.push({ url: new URL(href, base).href, score });
        } catch {}
    }
    return found.sort((a, b) => b.score - a.score).map((f) => f.url);
}

// The largest PNG inside an .ico, if it carries one (most modern ones do).
function pngFromIco(buf) {
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
    let best = null;
    for (let i = 0; i < buf.readUInt16LE(4); i++) {
        const e = 6 + i * 16;
        if (e + 16 > buf.length) break;
        const w = buf[e] || 256;
        const data = buf.subarray(buf.readUInt32LE(e + 12), buf.readUInt32LE(e + 12) + buf.readUInt32LE(e + 8));
        const isPng = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
        if (isPng && (!best || w > best.w)) best = { w, data };
    }
    return best?.data ?? null;
}

function mimeOf(buf, type) {
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (/svg/.test(type) || /^\s*<(\?xml|svg)/.test(buf.subarray(0, 100).toString())) return 'image/svg+xml';
    return null; // ICO, WebP, GIF: not drawable here
}

function toPng(buf, mime) {
    let svg;
    if (mime === 'image/svg+xml') {
        svg = buf.toString('utf8');
        return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } }).render().asPng());
    }
    svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}"><image width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice" xlink:href="data:${mime};base64,${buf.toString('base64')}"/></svg>`;
    return Buffer.from(new Resvg(svg).render().asPng());
}

async function siteIcon(home) {
    const page = await get(home);
    const candidates = [
        ...iconCandidates(page.body, page.url),
        new URL('/apple-touch-icon.png', page.url).href,
        new URL('/favicon.ico', page.url).href,
    ];
    for (const url of candidates) {
        try {
            const img = await get(url, { binary: true });
            const body = pngFromIco(img.body) ?? img.body;
            const mime = mimeOf(body, img.type);
            if (mime) return toPng(body, mime);
        } catch {}
    }
    return null;
}

async function youtubeIcon(channelUrl) {
    const page = await get(channelUrl);
    const avatar = page.body.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    if (!avatar) return null;
    const small = avatar.replace(/=s\d+[^"]*$/, `=s${SIZE * 2}-c-k-c0x00ffffff-no-rj`);
    const img = await get(small, { binary: true });
    const mime = mimeOf(img.body, img.type);
    return mime ? toPng(img.body, mime) : null;
}

async function main() {
    await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    fs.mkdirSync(DIR, { recursive: true });
    const all = process.argv.includes('--all');
    // One icon per outlet: its site when it has one, else its channel.
    const outlets = new Map();
    for (const s of SOURCES) {
        const o = outletOf(s.id);
        const prev = outlets.get(o);
        if (!prev || (prev.kind === 'video' && s.kind === 'article')) outlets.set(o, s);
    }
    const todo = [...outlets].filter(([o]) => all || !fs.existsSync(path.join(DIR, `${o}.png`)));
    const results = await mapLimit(todo, 6, async ([o, s]) => {
        try {
            const png = s.home.includes('youtube.com') ? await youtubeIcon(s.home) : await siteIcon(s.home);
            if (!png) return `${o}: none`;
            fs.writeFileSync(path.join(DIR, `${o}.png`), png);
            return `${o}: ok (${png.length} B)`;
        } catch (err) {
            return `${o}: ${err.message}`;
        }
    });
    for (const r of results) console.log(r);
}

main();
