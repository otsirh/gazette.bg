// The picture a link to a story shows when it is shared (Open Graph): the
// headline on the site's paper, with the issue and the topic above it and the
// AI notice below. Made at build time, so nothing is committed and nothing runs
// on a server. A failure here never fails the build: the story keeps the
// site's own picture.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { ROOT } from './issues.js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(ROOT, 'fonts', 'og');
const WIDTH = 1200;
const HEIGHT = 630;
const PAD_X = 72;
const PAD_TOP = 56;
const PAD_BOTTOM = 48;

const C = { paper: '#fbf8f2', ink: '#14120d', soft: '#46413a', muted: '#6f6a5e', rule: '#14120d', accent: '#ad2c20' };

let ready = null;

function loadFonts() {
    const font = (file, name, weight) => ({
        name,
        weight,
        style: 'normal',
        data: fs.readFileSync(path.join(FONT_DIR, file)),
    });
    return [
        // Each subset under its own name: the latin one carries the digits and
        // punctuation the cyrillic one lacks, and is reached by fallback.
        font('playfair-display-cyrillic-700.woff', 'Playfair', 700),
        font('playfair-display-latin-700.woff', 'PlayfairLatin', 700),
        font('source-serif-4-cyrillic-400.woff', 'Serif', 400),
        font('source-serif-4-latin-400.woff', 'SerifLatin', 400),
        font('jetbrains-mono-cyrillic-500.woff', 'Mono', 500),
        font('jetbrains-mono-latin-500.woff', 'MonoLatin', 500),
    ];
}

async function init() {
    ready ??= (async () => {
        await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
        return loadFonts();
    })();
    return ready;
}

// Longer headlines get a smaller size, so every one fits in four lines.
export function headlineSize(text) {
    const n = String(text).length;
    if (n <= 45) return 76;
    if (n <= 70) return 66;
    if (n <= 100) return 56;
    return 48;
}

const el = (type, style, children) => ({ type, props: { style, children } });
const DISPLAY = 'Playfair, PlayfairLatin';
const TEXT = 'Serif, SerifLatin';
const MONO = 'Mono, MonoLatin';

function mono(text, color, extra = {}) {
    return el(
        'div',
        { fontFamily: MONO, fontSize: 21, letterSpacing: 2, textTransform: 'uppercase', color, ...extra },
        text,
    );
}

export async function renderShareImage({ headline, kicker, topic }) {
    const fonts = await init();
    const tree = el(
        'div',
        {
            // Satori adds padding outside the box, so the box is the canvas
            // less its margins.
            width: WIDTH - 2 * PAD_X,
            height: HEIGHT - PAD_TOP - PAD_BOTTOM,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: `${PAD_TOP}px ${PAD_X}px ${PAD_BOTTOM}px`,
            background: C.paper,
            color: C.ink,
        },
        [
            el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24, height: 32 }, [
                mono(kicker, C.muted, { flexShrink: 0 }),
                topic ? mono(topic, C.accent, { fontSize: 19, textAlign: 'right' }) : el('div', {}, ''),
            ]),
            el(
                'div',
                {
                    display: 'flex',
                    flexGrow: 1,
                    alignItems: 'center',
                    fontFamily: DISPLAY,
                    fontWeight: 700,
                    fontSize: headlineSize(headline),
                    lineHeight: 1.08,
                    letterSpacing: -1,
                    color: C.ink,
                    lineClamp: 4,
                },
                headline,
            ),
            el('div', { display: 'flex', flexDirection: 'column', gap: 18, height: 64, flexShrink: 0 }, [
                el('div', { display: 'flex', height: 2, background: C.rule }, ''),
                el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, [
                    el('div', { display: 'flex', fontFamily: MONO, fontSize: 30, color: C.ink, letterSpacing: 1 }, [
                        el('span', {}, 'gazette'),
                        el('span', { color: C.accent }, '.'),
                        el('span', {}, 'bg'),
                    ]),
                    el('div', { fontFamily: TEXT, fontSize: 24, color: C.soft }, 'Неофициално обобщение с AI'),
                ]),
            ]),
        ],
    );
    const svg = await satori(tree, { width: WIDTH, height: HEIGHT, fonts });
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng());
}
