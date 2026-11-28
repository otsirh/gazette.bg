// The slower layers of a story, done after it is written up: where it
// happens, what came before it, how each side tells it, what was said about
// it in parliament, and the outlets' track record once it is over.

import { outletOf, SOURCE_BY_ID, tierOf } from '../sources.js';
import { classifyPlaces, findSameStories, frameStory, parliamentQuotes, stillSensitive } from './ai.js';
import { fetchText, toText } from './feeds.js';
import { rankStories } from './stories.js';
import { clip, tidy } from './text.js';
import { videoDetails, videoIdOf } from './youtube.js';

const DAY = 24 * 3600 * 1000;
const MEMORY_DAYS = 90;
const MEMORY_MAX = 600;

// Stories leaving the page are remembered briefly (title, summary, dates)
// so a new story can say what came before it. Nothing else is kept: no
// archive.
export function retire(state, dropped, now) {
    state.memory ??= [];
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

const KIND_LABEL = (id) => {
    const s = SOURCE_BY_ID.get(id);
    if (s?.partisan) return 'партиен канал';
    if (s?.independent) return 'независим автор';
    return ['първоизточник', 'първоизточник', 'обществена медия', 'редакционна медия', 'непроверен'][tierOf(id)];
};

// How each side tells it: for the busiest stories, again once two more
// outlets have joined since the last look.
export async function frameStories(state, now, meter, canSpend, log, proof = []) {
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
            for (const a of framing.angles) {
                a.label = tidy(a.label);
                a.summary = tidy(a.summary);
                proof.push([a, 'label'], [a, 'summary']);
            }
            framing.missing = tidy(framing.missing);
            r.story.framing = { ...framing, outlets: r.trust.outlets, at: now };
            proof.push([r.story.framing, 'missing']);
        } catch (err) {
            log(`Framing ${r.story.id} failed: ${err.message}`, 'WARN');
        }
    }
}

// ─── One event, two stories ─────────────────────────────────────────────

// Folds `others` into `keep`: their items, timeline and context, and their
// ids, so links to the old pages still find the story.
export function mergeInto(keep, others) {
    const itemIds = new Set(keep.items.map((i) => i.id));
    const quotes = new Set(keep.timeline.map((e) => `${e.who}|${e.what}`));
    for (const o of others) {
        for (const it of o.items) {
            if (itemIds.has(it.id)) continue;
            keep.items.push(it);
            itemIds.add(it.id);
        }
        for (const e of o.timeline) {
            const key = `${e.who}|${e.what}`;
            if (quotes.has(key)) continue;
            keep.timeline.push(e);
            quotes.add(key);
        }
        keep.createdAt = Math.min(keep.createdAt, o.createdAt);
        keep.aliases = [...new Set([...(keep.aliases ?? []), o.id, ...(o.aliases ?? [])])];
        keep.context ??= o.context;
        if (!keep.place && o.place) keep.place = o.place;
    }
    keep.timeline.sort((a, b) => a.at - b.at);
    if (keep.timeline.length > 80) keep.timeline = keep.timeline.slice(-80);
    // The angles were read from fewer outlets; look again.
    delete keep.framing;
}

export async function mergeSame(state, now, meter, log) {
    const active = rankStories(state.stories, now)
        .filter((r) => r.story.summary && (r.trust.outlets >= 2 || r.trust.firstHand))
        .slice(0, 100)
        .map((r) => r.story);
    if (active.length < 2) return;
    let groups;
    try {
        groups = await findSameStories({ stories: active, meter });
    } catch (err) {
        log(`Same-story check failed: ${err.message}`, 'WARN');
        return;
    }
    for (const g of groups) {
        const keep = state.stories.find((s) => s.id === g.keep);
        const others = state.stories.filter((s) => g.merge.includes(s.id));
        if (!keep || !others.length) continue;
        mergeInto(keep, others);
        state.stories = state.stories.filter((s) => !g.merge.includes(s.id));
        log(`Merged ${g.merge.join(', ')} into ${g.keep}: ${keep.title}`);
    }
}

// ─── The narrower sensitive rule (2) ────────────────────────────────────

// Once: stories flagged under the first, broader rule (any victim of
// violence) are checked again under the narrower one. A story that no longer
// qualifies gets its videos back, with title and "made for kids" read again
// from YouTube. Outlet headlines removed under the old rule stay removed.
export async function recheckSensitive(state, meter, log, ytKey) {
    if ((state.sensitiveRule ?? 1) >= 2) return;
    const flagged = state.stories.filter((s) => s.sensitive);
    if (!flagged.length) {
        state.sensitiveRule = 2;
        return;
    }
    if (!ytKey) return;
    let keep;
    let details;
    const cleared = [];
    try {
        keep = await stillSensitive({ stories: flagged, meter });
        for (const s of flagged) if (!keep.has(s.id)) cleared.push(s);
        const ids = cleared.flatMap((s) => s.items.filter((i) => i.kind === 'video').map((i) => videoIdOf(i.url)));
        details = await videoDetails([...new Set(ids.filter(Boolean))], ytKey);
    } catch (err) {
        log(`Sensitive recheck failed: ${err.message}`, 'WARN');
        return;
    }
    for (const s of cleared) {
        delete s.sensitive;
        for (const i of s.items) {
            const d = i.kind === 'video' && details.get(videoIdOf(i.url));
            if (!d) continue;
            i.videoId = videoIdOf(i.url);
            i.title = d.title;
            if (d.forKids) i.forKids = true;
        }
        log(`No longer sensitive under the narrower rule: ${s.title}`);
    }
    state.sensitiveRule = 2;
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
export async function readParliament(state, now, meter, canSpend, log, proof = []) {
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
        // The sitting's morning; the record gives no hours.
        const at = Date.parse(`${sitting.t_date}T08:00:00Z`);
        const video =
            rec.video?.default && /^https:\/\/(www\.)?parliament\.bg\//.test(rec.video.default)
                ? rec.video.default
                : null;
        let added = 0;
        let incomplete = false;
        for (let i = 0; i < text.length; i += CHUNK) {
            if (!canSpend()) {
                incomplete = true;
                break;
            }
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
                incomplete = true;
                continue;
            }
            for (const q of quotes) {
                const story = state.stories.find((s) => s.id === q.story);
                if (!story || story.timeline.some((e) => e.quote === q.quote.trim().slice(0, 400))) continue;
                const event = {
                    at,
                    actor: clip(nameCase(q.speaker), 100),
                    who: clip(tidy([nameCase(q.speaker), q.role.trim()].filter(Boolean).join(', ')), 160),
                    what: clip(tidy(q.what), 300),
                    quote: q.quote.trim().slice(0, 400),
                    items: [],
                    source: 'parliament',
                    url: 'https://www.parliament.bg/bg/plenaryst',
                    label: `Стенограма, ${sitting.t_date.split('-').reverse().join('.')}`,
                    video,
                };
                story.timeline.push(event);
                proof.push([event, 'what']);
                story.timeline.sort((a, b) => a.at - b.at);
                added++;
            }
        }
        // A sitting read only in part is read again next time, whole.
        if (!incomplete) state.parliament.done = [...state.parliament.done, sitting.t_id].slice(-200);
        log(`Parliament ${sitting.t_date}: ${added} quotes${incomplete ? ', incomplete' : ''}.`);
        return; // one sitting per update
    }
}
