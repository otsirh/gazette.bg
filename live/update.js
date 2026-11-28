#!/usr/bin/env node
import { createHash } from 'node:crypto';
// One update of live.gazette.bg: read every feed, sort what is new into
// stories, write the touched stories up, refresh the overview, build the site.
//
// The state lives in the published site itself (state.json), so an update
// needs no database: it reads the last one back, changes it, and publishes.
//
// Env:
//   ANTHROPIC_API_KEY     required for anything new to be sorted
//   LIVE_STATE_URL        where the published state.json is; without it the
//                         state is kept in .live-state.json (local runs)
//   LIVE_MONTHLY_BUDGET   US$ a month the updates may spend (default 40)
//   LIVE_RUN_BUDGET       US$ one update may spend (default 1.5)
//   LIVE_NO_AI=1          read feeds and rebuild, without calling Claude
//   LIVE_PROXY            socks5://host:port in Bulgaria, for the sources
//                         marked viaBulgaria; set by the workflow only when
//                         the Mac mini answers. Without it they go direct.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, isMain } from '../scripts/lib/cli.js';
import { buildSite, OUT_DIR } from './build.js';
import { clusterItems, writeOverview, writeStory } from './lib/ai.js';
import { fillPlaces, frameStories, pastFor, readParliament, retire } from './lib/depth.js';
import { articleText, fetchText, isOffTopic, itemId, mapLimit, parseFeed } from './lib/feeds.js';
import { pruneStories, rankStories } from './lib/stories.js';
import { SOURCE_BY_ID, SOURCES, sourceIdForName } from './sources.js';

const log = createLogger('live');
const HOUR = 60 * 60 * 1000;
const LOCAL_STATE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.live-state.json');

// Older than this when first seen, an article is history, not news.
const MAX_AGE = 36 * HOUR;
const CLUSTER_BATCH = 50;
// Oldest first, so the timeline is built in the order things happened.
const MAX_ITEMS_PER_WRITE = 15;
const MAX_WRITES_PER_RUN = 20;
const MAX_TRIES = 3;
const SEEN_TTL = 4 * 24 * HOUR;

const sourceName = (id) => SOURCE_BY_ID.get(id)?.name ?? id;
const proxyFor = (sourceId) => (SOURCE_BY_ID.get(sourceId)?.viaBulgaria && process.env.LIVE_PROXY) || null;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';

// Direct first (or through Bulgaria for the sites known to need it); a site
// that turns the direct request away gets a second try through Bulgaria, so
// a newly blocked site is read without anyone marking it.
async function fetchSmart(url, sourceId, opts) {
    const proxy = proxyFor(sourceId);
    try {
        return await fetchText(url, { ...opts, proxy });
    } catch (err) {
        if (proxy || !process.env.LIVE_PROXY) throw err;
        return fetchText(url, { ...opts, proxy: process.env.LIVE_PROXY });
    }
}

export function emptyState() {
    return {
        version: 1,
        updatedAt: 0,
        spend: { month: '', usd: 0 },
        seen: {},
        stories: [],
        overview: null,
        sources: {},
        memory: [],
        outletStats: null,
        parliament: { done: [] },
    };
}

async function loadState() {
    const url = process.env.LIVE_STATE_URL;
    if (url) {
        const res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
        if (res.status === 404) {
            log('No published state yet; starting fresh.', 'WARN');
            return emptyState();
        }
        // Anything else is not "no state": starting fresh would wipe every
        // story, so the update stops instead.
        if (!res.ok) throw new Error(`Could not read ${url}: HTTP ${res.status}`);
        return { ...emptyState(), ...(await res.json()) };
    }
    if (fs.existsSync(LOCAL_STATE)) return { ...emptyState(), ...JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8')) };
    return emptyState();
}

async function readFeeds(state, now) {
    const results = await mapLimit(SOURCES, 8, async (source) => {
        try {
            const xml = await fetchSmart(source.feed, source.id, { accept: FEED_ACCEPT });
            const entries = parseFeed(xml, now);
            state.sources[source.id] = { ok: true, at: now, count: entries.length };
            return entries.map((e) => ({ ...e, source: source.id, kind: source.kind }));
        } catch (err) {
            const prev = state.sources[source.id] ?? {};
            state.sources[source.id] = { ...prev, ok: false, at: now, error: String(err.message ?? err).slice(0, 120) };
            log(`${source.id}: ${err.message}`, 'WARN');
            return [];
        }
    });
    return results.flat();
}

function newStoryId(seed) {
    return createHash('sha256').update(seed).digest('base64url').replace(/[-_]/g, '').slice(0, 8).toLowerCase();
}

function toItem(e) {
    const item = {
        id: itemId(e.url),
        source: e.source,
        kind: e.kind,
        title: e.title,
        url: e.url,
        at: e.at,
        description: e.description,
        pending: true,
    };
    if (e.videoId) item.videoId = e.videoId;
    if (e.thumb) item.thumb = e.thumb;
    return item;
}

function monthOf(ms) {
    return new Date(ms).toISOString().slice(0, 7);
}

export async function update({ now = Date.now() } = {}) {
    const state = await loadState();
    const meter = { usd: 0, calls: 0 };
    const month = monthOf(now);
    if (state.spend.month !== month) state.spend = { month, usd: 0 };
    const monthly = Number(process.env.LIVE_MONTHLY_BUDGET ?? 40);
    const perRun = Number(process.env.LIVE_RUN_BUDGET ?? 1.5);
    const canSpend = () =>
        !process.env.LIVE_NO_AI &&
        Boolean(process.env.ANTHROPIC_API_KEY) &&
        state.spend.usd + meter.usd < monthly &&
        meter.usd < perRun;
    if (!canSpend()) log('Claude is off for this update (no key, LIVE_NO_AI, or the budget is used up).', 'WARN');

    const kept = pruneStories(state.stories, now);
    retire(
        state,
        state.stories.filter((s) => !kept.includes(s)),
        now,
    );
    state.stories = kept;
    for (const [id, at] of Object.entries(state.seen)) if (now - at > SEEN_TTL) delete state.seen[id];

    // ─── New items ───────────────────────────────────────────────────────
    const entries = await readFeeds(state, now);
    const known = new Set(state.stories.flatMap((s) => s.items.map((i) => i.id)));
    const fresh = [];
    const batchIds = new Set();
    for (const e of entries) {
        const id = itemId(e.url);
        // A "?id" mark only means "asked once, not answered": ask again.
        if (state.seen[id] || known.has(id) || batchIds.has(id)) continue;
        batchIds.add(id);
        if (now - e.at > MAX_AGE || isOffTopic(e)) {
            state.seen[id] = now;
            continue;
        }
        fresh.push(toItem(e));
    }
    fresh.sort((a, b) => a.at - b.at);
    log(`${entries.length} entries read, ${fresh.length} new.`);

    // ─── Sorting into stories ────────────────────────────────────────────
    let sorted = 0;
    let skipped = 0;
    let unanswered = 0;
    for (let i = 0; i < fresh.length && canSpend(); i += CLUSTER_BATCH) {
        const batch = fresh.slice(i, i + CLUSTER_BATCH);
        const active = rankStories(state.stories, now)
            .slice(0, 120)
            .map((r) => r.story);
        let decisions;
        try {
            decisions = await clusterItems({ stories: active, items: batch, sourceName, meter });
        } catch (err) {
            // Left unseen, these items are tried again next update.
            log(`Sorting failed: ${err.message}`, 'WARN');
            continue;
        }
        const created = new Map();
        batch.forEach((item, n) => {
            const d = decisions.get(n);
            if (d === undefined) {
                // Not answered: asked again next update, then let go.
                unanswered++;
                if (state.seen[`?${item.id}`]) state.seen[item.id] = now;
                else state.seen[`?${item.id}`] = now;
                return;
            }
            state.seen[item.id] = now;
            if (d === 'skip') {
                skipped++;
                return;
            }
            let story;
            if (typeof d === 'string') story = state.stories.find((s) => s.id === d);
            else {
                story = created.get(d.key);
                if (!story) {
                    story = {
                        id: newStoryId(`${item.id}:${now}`),
                        title: d.title,
                        summary: '',
                        disputed: '',
                        createdAt: now,
                        updatedAt: now,
                        items: [],
                        timeline: [],
                    };
                    created.set(d.key, story);
                    state.stories.push(story);
                }
            }
            if (!story) return;
            story.items.push(item);
            story.updatedAt = now;
            sorted++;
        });
    }
    log(`${sorted} sorted into stories, ${skipped} not about the country, ${unanswered} not answered.`);

    // ─── Writing stories up ──────────────────────────────────────────────
    const toWrite = state.stories
        .filter((s) => s.items.some((i) => i.pending))
        .sort((a, b) => b.items.filter((i) => i.pending).length - a.items.filter((i) => i.pending).length)
        .slice(0, MAX_WRITES_PER_RUN);
    await mapLimit(toWrite, 4, async (story) => {
        if (!canSpend()) return;
        const pending = story.items
            .filter((i) => i.pending)
            .sort((a, b) => a.at - b.at)
            .slice(0, MAX_ITEMS_PER_WRITE);
        const texts = new Map();
        await mapLimit(
            pending.filter((i) => i.kind === 'article'),
            4,
            async (it) => {
                try {
                    const page = await fetchSmart(it.url, it.source, { timeoutMs: 12000, accept: 'text/html' });
                    texts.set(it.id, articleText(page));
                } catch {
                    // The feed's own excerpt stands in.
                }
            },
        );
        let result;
        try {
            // A story written for the first time may continue an earlier one.
            const past = story.summary ? [] : pastFor(state, story, now);
            result = await writeStory({ story, newItems: pending, texts, sourceName, meter, past });
            result.past = past;
        } catch (err) {
            log(`Writing ${story.id} failed: ${err.message}`, 'WARN');
            for (const it of pending) {
                it.tries = (it.tries ?? 0) + 1;
                if (it.tries >= MAX_TRIES) delete it.pending;
            }
            return;
        }
        applyWrite(story, pending, result, now);
    });
    // An item the writer never got to (too many at once) still counts for heat.
    for (const s of state.stories) {
        for (const it of s.items) {
            if (it.pending && (it.tries ?? 0) >= MAX_TRIES) delete it.pending;
        }
    }

    // ─── Depth: places, how each side tells it, parliament ──────────────
    if (canSpend()) await fillPlaces(state, meter, log);
    await frameStories(state, now, meter, canSpend, log);
    await readParliament(state, now, meter, canSpend, log);

    // ─── Overview ────────────────────────────────────────────────────────
    const ranked = rankStories(state.stories, now)
        .filter((r) => r.trust.outlets >= 2 || r.trust.firstHand)
        .slice(0, 12);
    const topKey = ranked
        .slice(0, 7)
        .map((r) => r.story.id)
        .join(',');
    const last = state.overview?.at ?? 0;
    const due = (topKey !== state.overview?.topKey && now - last > 30 * 60 * 1000) || now - last > 2 * HOUR;
    if (ranked.length && due && canSpend()) {
        try {
            const lines = await writeOverview({ ranked, meter });
            if (lines.length) state.overview = { at: now, topKey, lines };
        } catch (err) {
            log(`Overview failed: ${err.message}`, 'WARN');
        }
    }

    state.spend.usd = Math.round((state.spend.usd + meter.usd) * 10000) / 10000;
    // The time readers see is when this version was finished, not begun.
    state.updatedAt = Date.now();
    log(
        `Claude: ${meter.calls} calls, $${meter.usd.toFixed(3)} this update, $${state.spend.usd.toFixed(2)} in ${month}.`,
    );

    if (!process.env.LIVE_STATE_URL) fs.writeFileSync(LOCAL_STATE, JSON.stringify(state));
    await buildSite(state, { now });
    log(`Built ${OUT_DIR} with ${rankStories(state.stories, now).length} stories on the page.`);
    return state;
}

export function applyWrite(story, pending, result, now) {
    if (result.title?.trim()) story.title = result.title.trim().slice(0, 140);
    if (result.summary?.trim()) story.summary = result.summary.trim().slice(0, 600);
    story.disputed = (result.disputed ?? '').trim().slice(0, 400);
    if (typeof result.place === 'string') story.place = result.place;
    const related = (result.related ?? []).map((n) => result.past?.[n]).filter(Boolean);
    if (related.length && result.background?.trim()) {
        story.context = {
            background: result.background.trim().slice(0, 500),
            related: related.slice(0, 3).map((p) => ({ title: p.title, summary: p.summary, at: p.at })),
        };
    }
    for (const r of result.items ?? []) {
        const it = pending[r.n];
        if (!it) continue;
        const cites = (r.cites ?? '').trim().slice(0, 80);
        it.cites = cites || null;
        it.citesKind = r.citesKind;
        const citesSource = r.citesKind === 'media' ? sourceIdForName(cites) : null;
        if (citesSource && citesSource !== it.source) it.citesSource = citesSource;
    }
    for (const e of result.events ?? []) {
        const refs = (e.n ?? []).map((n) => pending[n]).filter(Boolean);
        if (!refs.length || !e.what?.trim()) continue;
        story.timeline.push({
            at: Math.min(...refs.map((r) => r.at)),
            actor: (e.actor ?? '').trim().slice(0, 60),
            who: (e.who ?? '').trim().slice(0, 120),
            what: e.what.trim().slice(0, 400),
            items: refs.map((r) => r.id),
        });
    }
    story.timeline.sort((a, b) => a.at - b.at);
    if (story.timeline.length > 60) story.timeline = story.timeline.slice(-60);
    for (const it of pending) {
        delete it.pending;
        delete it.tries;
        // The excerpt was only for the model; the page links to the article.
        delete it.description;
    }
    story.updatedAt = now;
}

if (isMain(import.meta.url)) {
    update().catch((err) => {
        log(err.stack ?? String(err), 'ERROR');
        process.exit(1);
    });
}
