#!/usr/bin/env node
// Fetches each outlet's icon once and keeps it in live/site/icons/ as a 64 px
// PNG, so pages show it without sending readers to anyone else's server.
//
// A site gives its apple-touch-icon or a PNG/SVG icon from its home page; a
// YouTube-only outlet shows its initials (YouTube's terms forbid reading its
// pages by program). Raster icons are scaled by drawing them
// into an SVG and rendering that with resvg (no image library needed). An
// outlet without a usable icon keeps the coloured dot.
//
//   node live/scripts/fetch-icons.js            # only outlets without one
//   node live/scripts/fetch-icons.js --all      # all again
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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

// The largest bitmap inside an .ico, as a PNG. Old icons keep BMP images,
// which resvg cannot draw: they are decoded here (1, 4, 8, 24 and 32 bits,
// with the 1-bit transparency mask) and written out as PNG.
function bmpFromIco(buf) {
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
    let best = null;
    for (let i = 0; i < buf.readUInt16LE(4); i++) {
        const e = 6 + i * 16;
        if (e + 16 > buf.length) break;
        const size = buf.readUInt32LE(e + 8);
        const off = buf.readUInt32LE(e + 12);
        if (off + 40 > buf.length || buf.readUInt32LE(off) !== 40) continue;
        const w = buf.readInt32LE(off + 4);
        const bpp = buf.readUInt16LE(off + 14);
        if (!best || w > best.w || (w === best.w && bpp > best.bpp))
            best = { w, bpp, data: buf.subarray(off, off + size) };
    }
    if (!best) return null;
    const d = best.data;
    const w = d.readInt32LE(4);
    const h = Math.abs(d.readInt32LE(8)) / 2;
    const bpp = d.readUInt16LE(14);
    if (d.readUInt32LE(16) !== 0 || ![1, 4, 8, 24, 32].includes(bpp) || w <= 0 || h <= 0 || w > 256) return null;
    const colors = bpp <= 8 ? d.readUInt32LE(32) || 1 << bpp : 0;
    const palette = 40;
    const pixels = palette + colors * 4;
    const stride = Math.ceil((w * bpp) / 32) * 4;
    const maskStart = pixels + stride * h;
    const maskStride = Math.ceil(w / 32) * 4;
    const rgba = Buffer.alloc(w * h * 4);
    let anyAlpha = false;
    for (let y = 0; y < h; y++) {
        const row = pixels + (h - 1 - y) * stride;
        for (let x = 0; x < w; x++) {
            let r;
            let g;
            let b;
            let a = 255;
            if (bpp === 32) {
                [b, g, r, a] = [d[row + x * 4], d[row + x * 4 + 1], d[row + x * 4 + 2], d[row + x * 4 + 3]];
                if (a) anyAlpha = true;
            } else if (bpp === 24) {
                [b, g, r] = [d[row + x * 3], d[row + x * 3 + 1], d[row + x * 3 + 2]];
            } else {
                const bit = x * bpp;
                const byte = d[row + (bit >> 3)];
                const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
                const p = palette + idx * 4;
                [b, g, r] = [d[p], d[p + 1], d[p + 2]];
            }
            const o = (y * w + x) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = a;
        }
    }
    // Without real alpha, the 1-bit mask says which pixels are transparent.
    if (!anyAlpha && maskStart + maskStride * h <= d.length) {
        for (let y = 0; y < h; y++) {
            const row = maskStart + (h - 1 - y) * maskStride;
            for (let x = 0; x < w; x++) {
                const masked = (d[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                rgba[(y * w + x) * 4 + 3] = masked ? 0 : 255;
            }
        }
    }
    return encodePng(w, h, rgba);
}

function encodePng(w, h, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
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

// A podcast's own cover, from its feed.
async function feedIcon(feedUrl) {
    const xml = (await get(feedUrl)).body;
    const url = xml.match(/<itunes:image[^>]+href="([^"]+)"/)?.[1] ?? xml.match(/<image>\s*<url>([^<]+)<\/url>/)?.[1];
    if (!url) return null;
    const img = await get(url, { binary: true });
    const mime = mimeOf(img.body, img.type);
    return mime ? toPng(img.body, mime) : null;
}

async function siteIcon(home) {
    let page;
    try {
        page = await get(home);
    } catch {
        page = { body: '', url: home };
    }
    const candidates = [
        ...iconCandidates(page.body, page.url),
        new URL('/apple-touch-icon.png', page.url).href,
        new URL('/favicon.ico', page.url).href,
    ];
    for (const url of candidates) {
        try {
            const img = await get(url, { binary: true });
            const body = pngFromIco(img.body) ?? bmpFromIco(img.body) ?? img.body;
            const mime = mimeOf(body, img.type);
            if (mime) return toPng(body, mime);
        } catch {}
    }
    return null;
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
            let png;
            // A YouTube-only outlet gets its initials: YouTube's terms forbid
            // reading its pages by program, and an avatar is often a person's
            // own photo.
            if (s.home.includes('youtube.com')) return `${o}: initials (YouTube only)`;
            else if (/anchor\.fm|\/rss/.test(s.home)) png = await feedIcon(s.feed);
            else png = await siteIcon(s.home);
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
