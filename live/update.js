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
import { fileURLToPath } from 'node:url';
import { createLogger, isMain } from '../scripts/lib/cli.js';
import { buildSite, OUT_DIR } from './build.js';
import { clusterItems, proofread, writeOverview, writeStory } from './lib/ai.js';
import { fillPlaces, frameStories, mergeSame, pastFor, readParliament, retire } from './lib/depth.js';
import { articleText, fetchText, isOffTopic, itemId, mapLimit, parseFeed, siteOf } from './lib/feeds.js';
import { applyBlocklist, copiesSource, inElectionSilence, loadPolicy } from './lib/policy.js';
import { aiRefused, pathAllowed, tdmReserved } from './lib/robots.js';
import { pruneStories, rankStories } from './lib/stories.js';
import { tidy } from './lib/text.js';
import { channelIdOf, channelUploads, madeForKids } from './lib/youtube.js';
import { SOURCE_BY_ID, SOURCES, sourceIdForName } from './sources.js';

const log = createLogger('live');
const HOUR = 60 * 60 * 1000;
const LOCAL_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.live-state.json');

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

// Direct, or through Bulgaria for the sites that serve only Bulgarian
// addresses (marked viaBulgaria by hand, after checking they answer a
// Bulgarian reader). A site that refuses us is never retried another way:
// a refusal is respected, not worked around.
function fetchSmart(url, sourceId, opts) {
    return fetchText(url, { ...opts, proxy: proxyFor(sourceId) });
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

// Once a day per site: does its robots.txt still let AI use its content?
// A refusal stops the source at once; YouTube channels go by YouTube's terms.
async function checkRobots(state, now) {
    await mapLimit(SOURCES, 8, async (source) => {
        if (source.home.includes('youtube.com')) return;
        if (!state.sources[source.id]) state.sources[source.id] = {};
        const st = state.sources[source.id];
        if (st.robotsAt && now - st.robotsAt < 24 * HOUR) return;
        try {
            const res = await fetch(new URL('/robots.txt', source.home), {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; live.gazette.bg/1.0; +https://live.gazette.bg)' },
                signal: AbortSignal.timeout(12000),
            });
            const robots = res.ok ? await res.text() : '';
            // Refused for the whole site, or just for the feed we read.
            let refused = res.ok ? aiRefused(robots) || !pathAllowed(robots, new URL(source.feed).pathname) : false;
            const tdm = await fetch(new URL('/.well-known/tdmrep.json', source.home), {
                signal: AbortSignal.timeout(12000),
            }).catch(() => null);
            if (tdm?.ok) refused ||= tdmReserved(await tdm.text(), '/');
            st.aiRefused = refused;
            st.robotsAt = now;
            if (st.aiRefused) log(`${source.id}: robots.txt refuses AI; not read.`, 'WARN');
        } catch {
            // Unknown this time: keep the last answer.
        }
    });
}

// Per update, per site: robots.txt and tdmrep.json, to ask before reading a page.
const siteRules = new Map();
async function rulesFor(origin, sourceId) {
    if (!siteRules.has(origin)) {
        siteRules.set(
            origin,
            (async () => {
                const get = async (p) => {
                    try {
                        return { ok: true, text: await fetchSmart(`${origin}${p}`, sourceId, { timeoutMs: 10000 }) };
                    } catch (err) {
                        // Missing files allow; anything else is unknown, and unknown means no.
                        return { ok: /HTTP 404|HTTP 410/.test(err.message), text: '' };
                    }
                };
                const [robots, tdm] = await Promise.all([get('/robots.txt'), get('/.well-known/tdmrep.json')]);
                return { known: robots.ok, robots: robots.text, tdm: tdm.text };
            })(),
        );
    }
    return siteRules.get(origin);
}

async function mayRead(url, sourceId) {
    const u = new URL(url);
    const r = await rulesFor(u.origin, sourceId);
    if (!r.known) return false;
    return pathAllowed(r.robots, u.pathname) && !tdmReserved(r.tdm, u.pathname);
}

// A story leaving the page is kept for the record, outside the site: what
// it said and which headlines and links it said it from (uploaded by the
// workflow as a private-to-the-repo artifact for 90 days).
function keepEvidence(stories, now) {
    if (!stories.length) return;
    const dir = path.join(path.dirname(LOCAL_STATE), '.evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `retired-${now}.json`), JSON.stringify(stories));
}

async function readFeeds(state, now, silence) {
    const results = await mapLimit(SOURCES, 8, async (source) => {
        if (state.sources[source.id]?.aiRefused) return [];
        if (silence && source.partisan) return [];
        if (source.kind === 'video') {
            // Only through the YouTube Data API; without a key, not at all.
            const key = process.env.YOUTUBE_API_KEY;
            if (!key) return [];
            try {
                const entries = await channelUploads(channelIdOf(source.feed), key, now);
                state.sources[source.id] = { ...state.sources[source.id], ok: true, at: now, count: entries.length };
                return entries.map((e) => ({ ...e, source: source.id, kind: source.kind }));
            } catch (err) {
                state.sources[source.id] = { ...state.sources[source.id], ok: false, at: now, error: err.message };
                log(`${source.id}: ${err.message}`, 'WARN');
                return [];
            }
        }
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
    if (e.forKids) item.forKids = true;
    if (e.thumb) item.thumb = e.thumb;
    return item;
}

function monthOf(ms) {
    return new Date(ms).toISOString().slice(0, 7);
}

export async function update({ now = Date.now() } = {}) {
    const state = await loadState();
    const policy = loadPolicy();
    const silence = inElectionSilence(policy, now);
    if (silence) log('Election silence: no poll stories, no party channels (Изборен кодекс чл. 182, 205).', 'WARN');
    applyBlocklist(state, policy);
    const meter = { usd: 0, calls: 0 };
    // Every text the model writes in this update, to be proofread at the end.
    const proof = [];
    const month = monthOf(now);
    if (state.spend.month !== month) state.spend = { month, usd: 0 };
    const monthly = Number(process.env.LIVE_MONTHLY_BUDGET ?? 40);
    const perRun = Number(process.env.LIVE_RUN_BUDGET ?? 1.5);
    // A state older than three hours means the last updates did not publish
    // (a broken token, an outage). Writing on top of it would pay again for
    // everything since, every ten minutes, so Claude waits until a plain
    // update has published and the state is fresh again.
    const stale = state.updatedAt > 0 && now - state.updatedAt > 3 * HOUR && !process.env.LIVE_IGNORE_STALE;
    if (stale)
        log(
            `The published state is ${Math.round((now - state.updatedAt) / HOUR)} h old; Claude is off until it publishes.`,
            'ERROR',
        );
    const canSpend = () =>
        !stale &&
        !process.env.LIVE_NO_AI &&
        Boolean(process.env.ANTHROPIC_API_KEY) &&
        state.spend.usd + meter.usd < monthly &&
        meter.usd < perRun;
    if (!canSpend()) log('Claude is off for this update (no key, LIVE_NO_AI, or the budget is used up).', 'WARN');

    const kept = pruneStories(state.stories, now);
    const dropped = state.stories.filter((s) => !kept.includes(s));
    retire(state, dropped, now);
    keepEvidence(dropped, now);
    state.stories = kept;
    for (const [id, at] of Object.entries(state.seen)) if (now - at > SEEN_TTL) delete state.seen[id];

    // ─── New items ───────────────────────────────────────────────────────
    await checkRobots(state, now);
    // Nothing stays from a source we no longer read, or one that now refuses AI.
    const allowed = (id) => SOURCE_BY_ID.has(id) && !state.sources[id]?.aiRefused;
    for (const s of state.stories) s.items = s.items.filter((i) => allowed(i.source));
    state.stories = state.stories.filter((s) => s.items.length);
    for (const id of Object.keys(state.sources)) if (!SOURCE_BY_ID.has(id)) delete state.sources[id];
    const entries = await readFeeds(state, now, silence);
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
    // A video YouTube marks "made for kids" is linked, never embedded.
    const newVideos = fresh.filter((i) => i.kind === 'video').map((i) => i.videoId);
    if (newVideos.length && process.env.YOUTUBE_API_KEY) {
        try {
            const kids = await madeForKids(newVideos, process.env.YOUTUBE_API_KEY);
            for (const i of fresh) if (kids.has(i.videoId)) i.forKids = true;
        } catch (err) {
            // Unknown: treat every new video as made for kids this time.
            log(`Made-for-kids check failed: ${err.message}`, 'WARN');
            for (const i of fresh) if (i.kind === 'video') i.forKids = true;
        }
    }
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
            // Asked once more next update, then let go, like an unanswered item;
            // otherwise the same failing batch would come back for 36 hours.
            log(`Sorting failed: ${err.message}`, 'WARN');
            for (const it of batch) state.seen[state.seen[`?${it.id}`] ? it.id : `?${it.id}`] = now;
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
            pending.filter((i) => i.kind === 'article' && !SOURCE_BY_ID.get(i.source)?.headlinesOnly),
            4,
            async (it) => {
                try {
                    // Only the source's own site: a feed cannot send the job
                    // (or the Mac mini) to any other address.
                    const site = siteOf(SOURCE_BY_ID.get(it.source)?.home);
                    // The site's own rules for this very page: robots.txt
                    // path rules and a TDM reservation, then the page's
                    // own noai / tdm-reservation marks.
                    if (!(await mayRead(it.url, it.source))) return;
                    const page = await fetchSmart(it.url, it.source, { timeoutMs: 12000, accept: 'text/html', site });
                    if (
                        /<meta[^>]+(name=["'](robots|tdm-reservation)["'][^>]+content=["'][^"']*(noai|1)|content=["'][^"']*noai[^"']*["'][^>]+name=["']robots)/i.test(
                            page,
                        )
                    )
                        return;
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
            // Our own words only: anything that copies twelve words in a row
            // from a source, outside a quote, is dropped.
            const sources = [...texts.values(), ...pending.map((i) => `${i.title} ${i.description ?? ''}`)];
            if (copiesSource(result.summary, sources)) result.summary = '';
            if (copiesSource(result.background, sources)) result.background = '';
            result.events = (result.events ?? []).filter((e) => !copiesSource(e.what, sources));
        } catch (err) {
            log(`Writing ${story.id} failed: ${err.message}`, 'WARN');
            for (const it of pending) {
                it.tries = (it.tries ?? 0) + 1;
                if (it.tries >= MAX_TRIES) {
                    delete it.pending;
                    delete it.description;
                }
            }
            return;
        }
        applyWrite(story, pending, result, now, proof);
    });
    // A story keeps its newest 400 items: enough for any page, and the state
    // stays small however long a big story runs.
    for (const s of state.stories) if (s.items.length > 400) s.items = s.items.sort((a, b) => a.at - b.at).slice(-400);

    // ─── Depth: places, how each side tells it, parliament ──────────────
    if (canSpend()) await mergeSame(state, now, meter, log);
    if (canSpend()) await fillPlaces(state, meter, log);
    await frameStories(state, now, meter, canSpend, log, proof);
    await readParliament(state, now, meter, canSpend, log, proof);

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
            if (lines.length) {
                for (const l of lines) {
                    l.text = tidy(l.text);
                    proof.push([l, 'text']);
                }
                state.overview = { at: now, topKey, lines };
            }
        } catch (err) {
            log(`Overview failed: ${err.message}`, 'WARN');
        }
    }

    applyBlocklist(state, policy);

    // ─── Proofreading: one pass over everything written in this update ───
    const queued = proof.filter(([o, f]) => typeof o[f] === 'string' && o[f].trim());
    if (queued.length && canSpend()) {
        try {
            const fixes = await proofread({ texts: queued.map(([o, f]) => o[f]), meter });
            for (const [i, text] of fixes) {
                const [o, f] = queued[i];
                log(`  proof: ${o[f].slice(0, 120)} → ${text.slice(0, 120)}`);
                o[f] = tidy(text);
            }
            log(`Proofread ${queued.length} texts, corrected ${fixes.size}.`);
        } catch (err) {
            log(`Proofreading failed: ${err.message}`, 'WARN');
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

export function applyWrite(story, pending, result, now, proof = []) {
    if (result.title?.trim()) story.title = tidy(result.title).slice(0, 140);
    if (result.summary?.trim()) story.summary = tidy(result.summary).slice(0, 600);
    story.disputed = tidy(result.disputed ?? '').slice(0, 400);
    proof.push([story, 'title'], [story, 'summary'], [story, 'disputed']);
    if (typeof result.place === 'string') story.place = result.place;
    // A story about a child or a victim of violence shows no outlet's
    // headline and no pictures: a headline may name or show them.
    if (result.sensitive === true) story.sensitive = true;
    if (story.sensitive) {
        for (const it of story.items) {
            it.title = '';
            delete it.thumb;
            delete it.videoId;
        }
    }
    const related = (result.related ?? []).map((n) => result.past?.[n]).filter(Boolean);
    if (related.length && result.background?.trim()) {
        story.context = {
            background: tidy(result.background).slice(0, 500),
            related: related.slice(0, 3).map((p) => ({ title: p.title, summary: p.summary, at: p.at })),
        };
        proof.push([story.context, 'background']);
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
        const event = {
            at: Math.min(...refs.map((r) => r.at)),
            actor: tidy(e.actor ?? '').slice(0, 60),
            who: tidy(e.who ?? '').slice(0, 120),
            what: tidy(e.what).slice(0, 400),
            items: refs.map((r) => r.id),
        };
        story.timeline.push(event);
        proof.push([event, 'who'], [event, 'what']);
    }
    story.timeline.sort((a, b) => a.at - b.at);
    // Long timelines keep how it began and the latest 70 steps.
    if (story.timeline.length > 80) story.timeline = [...story.timeline.slice(0, 10), ...story.timeline.slice(-70)];
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
