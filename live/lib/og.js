// Pictures for shared links and app icons, made at build time with Satori and
// resvg. A shared story shows its headline, how hot it is and how many outlets
// carry it; the front page shows what is hottest right now. A failure here
// never fails an update: the page keeps the site's default picture.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';

const require = createRequire(import.meta.url);
const W = 1200;
const H = 630;
const C = {
    bg: '#0b0d12',
    text: '#f3f4f7',
    muted: '#9aa3b2',
    hot: '#ff4d3d',
    warm: '#ffa53a',
    cool: '#7b8494',
    line: '#262b36',
};

let ready = null;

function font(file, name, weight) {
    return {
        name,
        weight,
        style: 'normal',
        data: fs.readFileSync(require.resolve(`@fontsource/unbounded/files/${file}`)),
    };
}

async function init() {
    ready ??= (async () => {
        await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
        // Each subset under its own name: the latin one carries digits and
        // punctuation, reached by fallback.
        return [
            font('unbounded-cyrillic-700-normal.woff', 'U', 700),
            font('unbounded-latin-700-normal.woff', 'UL', 700),
            font('unbounded-cyrillic-400-normal.woff', 'U', 400),
            font('unbounded-latin-400-normal.woff', 'UL', 400),
        ];
    })();
    return ready;
}

// Satori puts padding outside the box, so a page is the canvas less its padding.
const PAD = { x: 72, top: 56, bottom: 52 };
const page = {
    width: W - 2 * PAD.x,
    height: H - PAD.top - PAD.bottom,
    padding: `${PAD.top}px ${PAD.x}px ${PAD.bottom}px`,
};

const el = (type, style, children = '') => ({ type, props: { style: { display: 'flex', ...style }, children } });
const FONT = 'U, UL';

const levelColor = (level) => C[level] ?? C.cool;

function brand() {
    return el(
        'div',
        { alignItems: 'center', gap: 14, fontFamily: FONT, fontWeight: 700, fontSize: 28, color: C.text },
        [
            el('div', { width: 18, height: 18, borderRadius: 9, background: C.hot }),
            el('div', { color: C.hot, letterSpacing: 2 }, 'НА ЖИВО'),
            el('div', { color: C.muted, fontWeight: 400 }, 'live.gazette.bg'),
        ],
    );
}

async function render(tree) {
    const fonts = await init();
    const svg = await satori(tree, { width: W, height: H, fonts });
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng());
}

export function titleSize(text) {
    const n = String(text).length;
    if (n <= 40) return 60;
    if (n <= 65) return 52;
    if (n <= 95) return 44;
    return 38;
}

// One story: level and temperature on top, the headline, then the evidence.
export async function storyImage({ title, level, levelLabel, temp, outlets, videos, trust }) {
    const color = levelColor(level);
    return render(
        el(
            'div',
            {
                ...page,
                flexDirection: 'column',
                justifyContent: 'space-between',
                background: C.bg,
                backgroundImage: `radial-gradient(circle at 100% 0%, ${color}55 0%, ${C.bg} 55%)`,
                fontFamily: FONT,
                color: C.text,
            },
            [
                el('div', { justifyContent: 'space-between', alignItems: 'center' }, [
                    brand(),
                    el('div', { alignItems: 'baseline', gap: 10, color }, [
                        el('div', { fontSize: 64, fontWeight: 700 }, `${temp}°`),
                        el('div', { fontSize: 24, fontWeight: 700, letterSpacing: 2 }, levelLabel.toUpperCase()),
                    ]),
                ]),
                el(
                    'div',
                    { fontSize: titleSize(title), fontWeight: 700, lineHeight: 1.18, letterSpacing: -1, lineClamp: 4 },
                    title,
                ),
                el('div', { gap: 34, fontSize: 26, color: C.muted, borderTop: `2px solid ${C.line}`, paddingTop: 24 }, [
                    el('div', { color: C.text }, `${outlets} медии`),
                    el('div', {}, trust),
                    el('div', {}, 'обобщено с AI'),
                    videos
                        ? el('div', { alignItems: 'center', gap: 12, color: C.hot }, [
                              // Unbounded has no ▶; a drawn triangle stands in.
                              el('div', {
                                  width: 0,
                                  height: 0,
                                  borderTop: '11px solid transparent',
                                  borderBottom: '11px solid transparent',
                                  borderLeft: `18px solid ${C.hot}`,
                              }),
                              el('div', {}, `${videos} видео`),
                          ])
                        : el('div', {}, ''),
                ]),
            ],
        ),
    );
}

// The front page: what is hottest right now.
export async function homeImage(top) {
    return render(
        el(
            'div',
            {
                ...page,
                flexDirection: 'column',
                background: C.bg,
                backgroundImage: `radial-gradient(circle at 100% 0%, ${C.hot}44 0%, ${C.bg} 55%)`,
                fontFamily: FONT,
                color: C.text,
                gap: 30,
            },
            [
                brand(),
                el(
                    'div',
                    { fontSize: 47, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 },
                    'Какво се случва в България сега',
                ),
                el(
                    'div',
                    { flexDirection: 'column', gap: 16 },
                    top
                        .slice(0, 3)
                        .map((t) =>
                            el('div', { alignItems: 'center', gap: 18, fontSize: 25, color: C.text }, [
                                el(
                                    'div',
                                    { width: 74, color: levelColor(t.level), fontWeight: 700, fontSize: 28 },
                                    `${t.temp}°`,
                                ),
                                el('div', { flex: 1, lineClamp: 1, fontWeight: 400 }, t.title),
                            ]),
                        ),
                ),
            ],
        ),
    );
}

// The app icon: a live dot on the dark board.
export async function iconPng(size, { maskable = false } = {}) {
    await init();
    const r = maskable ? size * 0.22 : size * 0.3;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${maskable ? 0 : size * 0.22}" fill="${C.bg}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r * 1.6}" fill="${C.hot}" opacity=".22"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${C.hot}"/></svg>`;
    return Buffer.from(new Resvg(svg).render().asPng());
}
