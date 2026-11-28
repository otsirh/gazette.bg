// The river of the day: the last 24 hours as a stream, one band a story,
// as wide as the number of its items in each half hour. Drawn once at build
// time as plain SVG (no library, nothing for the reader to download); the
// page's script only reads it out as the reader moves along it.

export const RIVER = { bins: 48, binMs: 30 * 60 * 1000, top: 10, bottom: 26 };

// Half-hour counts for the stories, smoothed 1-2-1 (a half hour is jumpy).
export function riverData(stories, now, { max = 20 } = {}) {
    const start = now - RIVER.bins * RIVER.binMs;
    const series = stories.slice(0, max).map((r) => {
        const raw = new Array(RIVER.bins).fill(0);
        for (const i of r.story.items) {
            const b = Math.floor((i.at - start) / RIVER.binMs);
            if (b >= 0 && b < RIVER.bins) raw[b]++;
        }
        const bins = raw.map((v, b) => (raw[Math.max(0, b - 1)] + 2 * v + raw[Math.min(RIVER.bins - 1, b + 1)]) / 4);
        return { r, raw, bins, total: raw.reduce((a, b) => a + b, 0) };
    });
    return { start, series: series.filter((s) => s.total > 0) };
}

// Catmull-Rom through the points, as cubic Béziers: a smooth line that
// passes through every point.
function smooth(points) {
    let d = '';
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${c1[0].toFixed(0)},${c1[1].toFixed(0)} ${c2[0].toFixed(0)},${c2[1].toFixed(0)} ${p2[0].toFixed(0)},${p2[1].toFixed(0)}`;
    }
    return d;
}

// Stacked around the middle (the biggest stories in the centre, smaller
// ones outward), so the river's width is the whole day's volume.
export function riverLayout({ series }, w, h) {
    const { bins, top, bottom } = RIVER;
    const order = [...series].sort((a, b) => b.total - a.total);
    // inside out: the biggest in the middle, then alternating above and below
    const arranged = [];
    order.forEach((s, i) => {
        if (i % 2) arranged.push(s);
        else arranged.unshift(s);
    });
    const totals = Array.from({ length: bins }, (_, b) => arranged.reduce((sum, s) => sum + s.bins[b], 0));
    const peak = Math.max(1, ...totals);
    const scale = (h - top - bottom) / peak;
    const mid = top + (h - top - bottom) / 2;
    const x = (b) => (b / (bins - 1)) * w;
    const floor = totals.map((t) => mid - (t * scale) / 2);
    const bands = arranged.map((s) => {
        const y0 = floor.slice();
        const y1 = y0.map((y, b) => y + s.bins[b] * scale);
        for (let b = 0; b < bins; b++) floor[b] = y1[b];
        return { s, y0, y1 };
    });
    return { bands, x, scale };
}

// The colour of a band: important stories cold, the rest by heat.
function colorOf(r, i, important) {
    if (important) return ['#3fb3e0', '#5b8def', '#36c2c2'][i % 3];
    if (r.level.id === 'hot') return ['#ff5a3c', '#ff7a45', '#f0442b', '#ff9157'][i % 4];
    if (r.level.id === 'warm') return ['#f5a524', '#e8913a', '#f2b84b'][i % 3];
    return ['#9aa3b1', '#8a94a3'][i % 2];
}

const esc = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

// The SVG, with labels on the biggest bands where they fit, the night
// shaded, and the hours along the bottom. `isImportant(story)` colours a
// band cold; `clock(ms)` writes an hour.
export function riverSvg(
    data,
    { isImportant = () => false, clock, w = 1200, h = 280, labels = 5, every = 6, fs = 13, cls = '' },
) {
    const { bands, x } = riverLayout(data, w, h);
    const { bins, binMs } = RIVER;
    const parts = [];
    for (let b = 0; b < bins; b++) {
        const hour = Number(clock(data.start + b * binMs, true));
        if (hour >= 23 || hour < 6) {
            parts.push(
                `<rect class="river-night" x="${x(b).toFixed(0)}" y="0" width="${(w / (bins - 1) + 0.5).toFixed(0)}" height="${h}"/>`,
            );
        }
    }
    bands.forEach(({ s, y0, y1 }, i) => {
        const upper = y1.map((y, b) => [x(b), y]);
        const lower = y0.map((y, b) => [x(b), y]).reverse();
        const d = `M${upper[0][0]},${upper[0][1].toFixed(0)}${smooth(upper)} L${lower[0][0]},${lower[0][1].toFixed(0)}${smooth(lower)} Z`;
        const st = s.r.story;
        parts.push(
            `<a href="/s/${esc(st.id)}/" tabindex="-1"><path class="river-band" d="${d}" fill="${colorOf(s.r, i, isImportant(st))}"><title>${esc(st.title)}</title></path></a>`,
        );
    });
    // labels: the loudest first, where the band is thick enough and the
    // whole label fits, never over another label
    const boxes = [];
    for (const { s, y0, y1 } of [...bands].sort((a, b) => b.s.r.heat - a.s.r.heat).slice(0, labels * 2)) {
        if (boxes.length >= labels) break;
        const title = s.r.story.title;
        const text = title.length > 42 ? `${title.slice(0, 40).trimEnd()}…` : title;
        const tw = text.length * fs * 0.6;
        // where the band is thickest along the label's whole length, so the
        // text stays inside its band
        const half = Math.ceil(tw / 2 / (w / (bins - 1)));
        let best = -1;
        let at = -1;
        for (let b = half; b < bins - half; b++) {
            const cx = x(b);
            if (cx - tw / 2 < 8 || cx + tw / 2 > w - 8) continue;
            let thin = Number.POSITIVE_INFINITY;
            for (let k = b - half; k <= b + half; k++) thin = Math.min(thin, y1[k] - y0[k]);
            if (thin > best) {
                best = thin;
                at = b;
            }
        }
        if (at < 0 || best < fs * 1.4) continue;
        const cy = (y0[at] + y1[at]) / 2 + fs * 0.35;
        const box = [x(at) - tw / 2, cy - fs, x(at) + tw / 2, cy + 3];
        if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
        boxes.push(box);
        parts.push(
            `<text class="river-label" x="${x(at).toFixed(0)}" y="${cy.toFixed(0)}" font-size="${fs}">${esc(text)}</text>`,
        );
    }
    for (let b = 0; b < bins; b += every) {
        parts.push(
            `<text class="river-tick" x="${Math.max(fs * 1.6, x(b)).toFixed(0)}" y="${h - 8}" font-size="${(fs * 0.85).toFixed(0)}">${esc(clock(data.start + b * binMs))}</text>`,
        );
    }
    parts.push(`<line class="river-cursor" x1="${w}" x2="${w}" y1="0" y2="${h - RIVER.bottom + 4}"/>`);
    return `<svg class="river${cls ? ` ${cls}` : ''}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Реката на деня: всяка лента е история; колкото е по-широка, толкова повече се пише за нея">${parts.join('')}</svg>`;
}

// The river in plain words, for anyone who does not read charts: what was
// written about most 12 hours ago, 6 hours ago and in the last two hours.
// [{ when, title, id }]; one line when the same story led the whole day.
export function riverSay(data) {
    const { bins } = RIVER;
    const windows = [
        ['Преди 12 часа', bins - 26, bins - 22],
        ['Преди 6 часа', bins - 14, bins - 10],
        ['Сега', bins - 4, bins],
    ];
    const lead = windows.map(([when, from, to]) => {
        let best = null;
        let most = 0;
        for (const s of data.series) {
            const n = s.raw.slice(Math.max(0, from), to).reduce((a, b) => a + b, 0);
            if (n > most) {
                most = n;
                best = s;
            }
        }
        return best && { when, title: best.r.story.title, id: best.r.story.id };
    });
    if (lead.some((l) => !l)) return lead.filter(Boolean);
    if (lead.every((l) => l.id === lead[0].id))
        return [{ when: 'През целия ден', title: lead[0].title, id: lead[0].id }];
    return lead;
}

// What the page's script needs to read the river out: per story its id,
// title and raw half-hour counts.
export function riverJson(data) {
    return JSON.stringify({
        start: data.start,
        binMs: RIVER.binMs,
        bins: RIVER.bins,
        s: data.series.map((s) => ({ id: s.r.story.id, t: s.r.story.title, b: s.raw })),
    }).replace(/</g, '\\u003c');
}
