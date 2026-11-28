// What the pages draw: how the news comes in, where it comes from, and how a
// story heats up. Numbers only; build.js turns them into pictures.
import { outletOf } from '../sources.js';
import { heatAt, heatByOutlet } from './stories.js';

const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

// The last day across every story: how many items, from how many outlets,
// and when the newest came in.
export function dayStats(stories, now) {
    const items = stories.flatMap((s) => s.items).filter((i) => i.at <= now && now - i.at < DAY);
    return {
        items: items.length,
        outlets: new Set(items.map((i) => outletOf(i.source))).size,
        last: items.length ? Math.max(...items.map((i) => i.at)) : 0,
    };
}

// The newest items of the stories on the page, each with the topic it went
// into: one of the `topics` hottest stories, or -1 for any other.
export function flowOf(ranked, now, { rows = 8, topics = 5 } = {}) {
    const top = ranked.slice(0, topics);
    const index = new Map(top.map((r, i) => [r.story.id, i]));
    const latest = ranked
        .flatMap((r) => r.story.items.filter((it) => it.at <= now).map((it) => ({ item: it, story: r.story })))
        .sort((a, b) => b.item.at - a.item.at)
        .slice(0, rows)
        .map((x) => ({ ...x, topic: index.get(x.story.id) ?? -1 }));
    return { top, latest };
}

// Items per outlet over the last day, most first: [{ outlet, source, count }].
// `source` is one of the outlet's own source ids, for its name and icon.
export function outletCounts(stories, now) {
    const by = new Map();
    for (const s of stories) {
        for (const i of s.items) {
            if (i.at > now || now - i.at >= DAY) continue;
            const o = outletOf(i.source);
            const e = by.get(o) ?? { outlet: o, source: i.source, count: 0 };
            // The outlet's site names it better than its video channel.
            if (e.source.endsWith('-yt') && !i.source.endsWith('-yt')) e.source = i.source;
            e.count++;
            by.set(o, e);
        }
    }
    return [...by.values()].sort((a, b) => b.count - a.count || a.outlet.localeCompare(b.outlet));
}

// The story's heat from its first item to now, in `samples` steps:
// [{ at, heat }], oldest first.
export function heatCurve(story, now, clock, samples = 120) {
    const first = Math.min(...story.items.map((i) => i.at));
    const start = Math.min(first, now - HOUR);
    const out = [];
    for (let k = 0; k <= samples; k++) {
        const at = start + ((now - start) * k) / samples;
        out.push({ at, heat: heatAt(story, at, clock) });
    }
    return out;
}

// Who makes the story hot now, most first: [{ outlet, source, count, share }],
// share being the part of the heat that outlet gives.
export function contributors(story, now, clock) {
    const heat = heatByOutlet(story, now, clock);
    const total = [...heat.values()].reduce((a, b) => a + b, 0) || 1;
    const by = new Map();
    for (const i of story.items) {
        if (i.at > now) continue;
        const o = outletOf(i.source);
        const e = by.get(o) ?? { outlet: o, source: i.source, count: 0, share: (heat.get(o) ?? 0) / total };
        if (e.source.endsWith('-yt') && !i.source.endsWith('-yt')) e.source = i.source;
        e.count++;
        by.set(o, e);
    }
    return [...by.values()].sort((a, b) => b.share - a.share || b.count - a.count);
}

// Items per time bucket from `start` to `end`, oldest first.
export function buckets(items, start, end, n) {
    const size = (end - start) / n;
    const out = new Array(n).fill(0);
    for (const i of items) {
        if (i.at < start || i.at > end) continue;
        out[Math.min(n - 1, Math.floor((i.at - start) / size))]++;
    }
    return out;
}

// Round times for an axis from `start` to `end`: at most `max` ticks, on a
// whole hour of Sofia time, the step one of 1, 2, 3, 6, 12 or 24 hours.
export function axisTicks(start, end, max = 6, offsetOf = sofiaOffset) {
    const span = end - start;
    const step = [1, 2, 3, 6, 12, 24, 48].map((h) => h * HOUR).find((s) => span / s <= max) ?? 48 * HOUR;
    const ticks = [];
    // Whole steps in local time: shift by the offset, round, shift back.
    // Each tick takes its own offset, so a change of summer time keeps them
    // on the hour.
    let local = Math.ceil((start + offsetOf(start)) / step) * step;
    for (;;) {
        let t = local - offsetOf(local);
        if (t + offsetOf(t) !== local) t = local - offsetOf(t);
        if (t > end) break;
        if (t >= start) ticks.push(t);
        local += step;
    }
    return { ticks, step };
}

// Sofia's offset from UTC at a moment, in ms.
export function sofiaOffset(ms) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Sofia',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).formatToParts(ms);
    const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
    const local = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute);
    return local - Math.floor(ms / 60000) * 60000;
}
