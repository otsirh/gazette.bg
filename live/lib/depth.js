// The slower layers of a story, done after it is written up: where it
// happens, what came before it, how each side tells it, what was said about
// it in parliament, and the outlets' track record once it is over.

import { outletOf, SOURCE_BY_ID, tierOf } from '../sources.js';
import { classifyPlaces, frameStory, parliamentQuotes } from './ai.js';
import { fetchText, toText } from './feeds.js';
import { addContributions, rankStories } from './stories.js';

const DAY = 24 * 3600 * 1000;
const MEMORY_DAYS = 90;
const MEMORY_MAX = 600;

// Stories leaving the page are remembered briefly (title, summary, dates)
// so a new story can say what came before it, and their outlets' record is
// added to the totals. Nothing else is kept: no archive.
export function retire(state, dropped, now) {
    state.memory ??= [];
    state.outletStats ??= { since: now, outlets: {} };
    for (const s of dropped) {
        if (s.summary) {
            state.memory.push({
                id: s.id,
                title: s.title,
                summary: s.summary,
                at: Math.min(...s.items.map((i) => i.at)),
                place: s.place || '',
            });
        }
        addContributions(state.outletStats.outlets, s);
    }
    state.memory = state.memory.filter((m) => now - m.at < MEMORY_DAYS * DAY).slice(-MEMORY_MAX);
}

// Earlier stories a new one may continue: the remembered ones and the older
// ones still on the page, newest first.
export function pastFor(state, story, now) {
    const active = state.stories
        .filter((s) => s.id !== story.id && s.summary && now - s.createdAt > 6 * 3600 * 1000)
        .map((s) => ({ id: s.id, title: s.title, summary: s.summary, at: Math.min(...s.items.map((i) => i.at)) }));
    return [...(state.memory ?? []), ...active].sort((a, b) => b.at - a.at).slice(0, 120);
}

export async function fillPlaces(state, meter, log) {
    const missing = state.stories.filter((s) => s.place === undefined && s.summary).slice(0, 80);
    if (!missing.length) return;
    try {
        const places = await classifyPlaces({ stories: missing, meter });
        for (const s of missing) s.place = places.get(s.id) ?? '';
    } catch (err) {
        log(`Places failed: ${err.message}`, 'WARN');
    }
}

const KIND_LABEL = (id) =>
    SOURCE_BY_ID.get(id)?.partisan
        ? 'партиен канал'
        : ['първоизточник', 'първоизточник', 'обществена медия', 'редакционна медия', 'непроверен'][tierOf(id)];

// How each side tells it: for the busiest stories, again once two more
// outlets have joined since the last look.
export async function frameStories(state, now, meter, canSpend, log) {
    const due = rankStories(state.stories, now)
        .filter((r) => r.trust.outlets >= 4)
        .filter((r) => !r.story.framing || r.trust.outlets - r.story.framing.outlets >= 2)
        .slice(0, 5);
    for (const r of due) {
        if (!canSpend()) return;
        // One headline per outlet, the earliest: the first take is the framing.
        const seen = new Set();
        const lines = [];
        for (const it of [...r.story.items].sort((a, b) => a.at - b.at)) {
            const o = outletOf(it.source);
            if (seen.has(o)) continue;
            seen.add(o);
            lines.push({
                item: it,
                sourceName: SOURCE_BY_ID.get(it.source)?.name ?? it.source,
                kindLabel: KIND_LABEL(it.source),
            });
        }
        try {
            const framing = await frameStory({ story: r.story, lines: lines.slice(0, 60), meter });
            r.story.framing = { ...framing, outlets: r.trust.outlets, at: now };
        } catch (err) {
            log(`Framing ${r.story.id} failed: ${err.message}`, 'WARN');
        }
    }
}

// ─── Parliament ─────────────────────────────────────────────────────────

const API = 'https://www.parliament.bg/api/v1';

// The record writes speakers in capitals ("НИКОЛАЙ ДЕНКОВ"); the page does not shout.
export function nameCase(s) {
    const t = String(s).trim();
    if (t !== t.toUpperCase()) return t;
    return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}
const CHUNK = 120000;

function monthsBack(now, n) {
    const out = [];
    const d = new Date(now);
    for (let i = 0; i < n; i++) {
        out.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
        d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return out;
}

// One stenogram per update, oldest unread first. The record is published up
// to a week after the sitting, so a sitting is retried until its text is
// there, and given up on after two weeks.
export async function readParliament(state, now, meter, canSpend, log) {
    state.parliament ??= { done: [] };
    const done = new Set(state.parliament.done);
    const list = [];
    try {
        for (const [y, m] of monthsBack(now, 2)) {
            list.push(
                ...JSON.parse(
                    await fetchText(`${API}/archive-period/bg/Pl_StenV/${y}/${m}/0/0`, { accept: 'application/json' }),
                ),
            );
        }
    } catch (err) {
        log(`Parliament list: ${err.message}`, 'WARN');
        return;
    }
    const todo = list
        .filter((s) => !done.has(s.t_id) && now - Date.parse(s.t_date) < 21 * DAY)
        .sort((a, b) => Date.parse(a.t_date) - Date.parse(b.t_date));
    for (const sitting of todo) {
        if (!canSpend()) return;
        let rec;
        try {
            rec = JSON.parse(
                await fetchText(`${API}/pl-sten/${sitting.t_id}`, { accept: 'application/json', timeoutMs: 30000 }),
            );
        } catch (err) {
            log(`Parliament ${sitting.t_id}: ${err.message}`, 'WARN');
            return;
        }
        const text = toText(rec.Pl_Sten_body ?? '');
        if (text.length < 20000) {
            if (now - Date.parse(sitting.t_date) > 14 * DAY) state.parliament.done.push(sitting.t_id);
            continue; // not published yet
        }
        const stories = rankStories(state.stories, now)
            .filter((r) => r.trust.outlets >= 2)
            .slice(0, 40)
            .map((r) => r.story);
        const at = Date.parse(`${sitting.t_date}T10:00:00+02:00`);
        const video =
            rec.video?.default && /^https:\/\/(www\.)?parliament\.bg\//.test(rec.video.default)
                ? rec.video.default
                : null;
        let added = 0;
        for (let i = 0; i < text.length; i += CHUNK) {
            if (!canSpend()) break;
            let quotes;
            try {
                quotes = await parliamentQuotes({
                    text: text.slice(i, i + CHUNK),
                    stories,
                    meter,
                    label: `parliament ${sitting.t_date} ${i / CHUNK + 1}`,
                });
            } catch (err) {
                log(`Parliament quotes: ${err.message}`, 'WARN');
                continue;
            }
            for (const q of quotes) {
                const story = state.stories.find((s) => s.id === q.story);
                if (!story || story.timeline.some((e) => e.quote === q.quote)) continue;
                story.timeline.push({
                    at,
                    actor: nameCase(q.speaker).slice(0, 60),
                    who: [nameCase(q.speaker), q.role.trim()].filter(Boolean).join(', ').slice(0, 120),
                    what: q.what.trim().slice(0, 300),
                    quote: q.quote.trim().slice(0, 400),
                    items: [],
                    source: 'parliament',
                    url: 'https://www.parliament.bg/bg/plenaryst',
                    label: `Стенограма, ${sitting.t_date.split('-').reverse().join('.')}`,
                    video,
                });
                story.timeline.sort((a, b) => a.at - b.at);
                added++;
            }
        }
        state.parliament.done.push(sitting.t_id);
        log(`Parliament ${sitting.t_date}: ${added} quotes.`);
        return; // one sitting per update
    }
}
