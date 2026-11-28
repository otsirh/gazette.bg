#!/usr/bin/env node
import { createHash } from 'node:crypto';
// One update of live.gazette.bg: read every feed, sort what is new into
// stories, write the touched stories up, build the site.
//
// The state lives in the published site itself (state.json), so an update
// needs no database: it reads the last one back, changes it, and publishes.
//
// Env:
//   ANTHROPIC_API_KEY     required for anything new to be sorted
//   LIVE_STATE_URL        where the published state.json is; without it the
//                         state is kept in .live-state.json (local runs)
//   LIVE_MONTHLY_BUDGET   US$ a month the updates may spend (default 100)
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
import { clusterItems, OVERVIEW_MODEL, proofread, rewordSummary, writeStory } from './lib/ai.js';
import { fillPlaces, fillWeights, mergeSame, pastFor, readParliament, recheckSensitive, retire } from './lib/depth.js';
import { articleText, fetchText, isOffTopic, itemId, mapLimit, parseFeed, parseList, siteOf } from './lib/feeds.js';
import { acceptCommitments, recordCommitments } from './lib/ledger.js';
import {
    applyBlocklist,
    copiesSource,
    inElectionSilence,
    loadPolicy,
    unquote,
    unverifiedQuotes,
} from './lib/policy.js';
import { aiRefused, pathAllowed, tdmReserved } from './lib/robots.js';
import { openSeals, publicState } from './lib/seal.js';
import { pruneStories, rankStories, scoreStories } from './lib/stories.js';
import { aiTexts, clip, recutOld, tidy, tidyState } from './lib/text.js';
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
// How hard the proofreader thinks. In a blind test on 24 stories (Opus as
// judge, scripts/eval-writing.js 24 proof) Sonnet left 6.5 errors per 1000
// words at "high", 4.1 at "medium" and 2.4 at "low", and "low" cost 58% less
// than "high": more thinking rewrote more, not better.
const PROOF_EFFORT = 'low';

// The API busy, overloaded or out of reach: nothing wrong with the request.
// An answer that cannot be read is not this: asking again costs again.
export function isTransient(err) {
    const status = err?.status;
    if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;
    return /APIConnection|Timeout|Abort/.test(err?.name ?? '');
}
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
        // Read the way the site's news is read (through Bulgaria where it needs
        // that). A missing file allows; any other failure is unknown.
        const get = async (p) => {
            try {
                return await fetchSmart(new URL(p, source.home).href, source.id, { timeoutMs: 12000 });
            } catch (err) {
                if (/HTTP 404|HTTP 410/.test(err.message)) return '';
                throw err;
            }
        };
        try {
            const robots = await get('/robots.txt');
            // Refused for the whole site, or just for the feed we read.
            let refused = aiRefused(robots) || !pathAllowed(robots, new URL(source.feed).pathname);
            const tdm = await get('/.well-known/tdmrep.json').catch(() => '');
            if (tdm) refused ||= tdmReserved(tdm, '/');
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
// workflow as an artifact for 90 days). The repository is public, so anyone
// signed in to GitHub can download it: sensitive items go sealed.
function keepEvidence(stories, now) {
    if (!stories.length) return;
    const dir = path.join(path.dirname(LOCAL_STATE), '.evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `retired-${now}.json`), JSON.stringify(publicState({ stories }).stories));
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
            // A news list page instead of a feed: only items with a printed
            // date, so an old notice is never taken for news.
            let entries = source.list
                ? parseList(xml, source.feed, source.list, now).filter((e) => e.dated)
                : parseFeed(xml, now);
            // A feed shared by several papers of one publisher: only this one's.
            if (source.onlyHost) entries = entries.filter((e) => siteHost(e.url) === source.onlyHost);
            // Keep what the daily robots check knows (aiRefused, robotsAt).
            state.sources[source.id] = { ...state.sources[source.id], ok: true, at: now, count: entries.length };
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

function siteHost(url) {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

function newStoryId(seed) {
    return createHash('sha256').update(seed).digest('base64url').replace(/[-_]/g, '').slice(0, 8).toLowerCase();
}

export function toItem(e) {
    const item = {
        id: itemId(e.url),
        source: e.source,
        kind: e.kind,
        title: e.title,
        url: e.url,
        at: e.at,
        // A source whose terms allow only its headline and link gives the
        // model nothing more, not even its feed's excerpt.
        description: SOURCE_BY_ID.get(e.source)?.headlinesOnly ? '' : e.description,
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
    openSeals(state);
    const policy = loadPolicy();
    const silence = inElectionSilence(policy, now);
    if (silence) log('Election silence: no poll stories, no party channels (Изборен кодекс чл. 182, 205).', 'WARN');
    applyBlocklist(state, policy);
    // „Никой не казва“ was judged from headlines alone and was often wrong.
    for (const s of state.stories) if (s.framing) delete s.framing.missing;
    // Every text on the site now was proofread when it was written, except
    // what a failed or unpaid pass left (state.unproofed).
    const unproofed = new Set(state.unproofed ?? []);
    const proofedBefore = new Set(
        aiTexts(state)
            .map(([o, f]) => o[f])
            .filter((t) => !unproofed.has(t)),
    );
    const meter = { usd: 0, calls: 0 };
    // Every text the model writes in this update, to be proofread at the end.
    const proof = [];
    const month = monthOf(now);
    if (state.spend.month !== month) state.spend = { month, usd: 0 };
    const monthly = Number(process.env.LIVE_MONTHLY_BUDGET ?? 100);
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
    let createdAny = false;
    for (let i = 0; i < fresh.length && canSpend(); i += CLUSTER_BATCH) {
        const batch = fresh.slice(i, i + CLUSTER_BATCH);
        // Every story still in the state, the cold ones too: a new item about
        // one that has left the page joins it instead of starting a twin.
        const active = scoreStories(state.stories, now)
            .slice(0, 160)
            .map((r) => r.story);
        let decisions;
        try {
            decisions = await clusterItems({ stories: active, items: batch, sourceName, meter });
        } catch (err) {
            log(`Sorting failed: ${err.message}`, 'WARN');
            // The API busy or unreachable: the items are simply new again next
            // update, however long that takes (until they are too old).
            if (isTransient(err)) continue;
            // Anything else is asked once more next update, then let go, like
            // an unanswered item: the same failing batch must not come back
            // for 36 hours.
            for (const it of batch) state.seen[state.seen[`?${it.id}`] ? it.id : `?${it.id}`] = now;
            continue;
        }
        const created = new Map();
        createdAny ||= batch.some((_, n) => decisions.get(n)?.key);
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
            const past = story.summary ? [] : pastFor(state, story, now, pending);
            result = await writeStory({ story, newItems: pending, texts, sourceName, meter, past });
            result.past = past;
            // Our own words only: anything that copies twelve words in a row
            // from a source, outside a quote, is dropped.
            const sources = [...texts.values(), ...pending.map((i) => `${i.title} ${i.description ?? ''}`)];
            // A story with no summary yet gets one in other words, rather
            // than none: a card without a summary says nothing.
            if (copiesSource(result.summary, sources) && !story.summary && canSpend()) {
                try {
                    result.summary = await rewordSummary({
                        summary: result.summary,
                        meter,
                        label: `reword ${story.id}`,
                    });
                } catch (err) {
                    log(`Rewording ${story.id} failed: ${err.message}`, 'WARN');
                }
            }
            if (copiesSource(result.summary, sources)) result.summary = '';
            if (copiesSource(result.background, sources)) result.background = '';
            result.events = (result.events ?? []).filter((e) => !copiesSource(e.what, sources));
            for (const q of checkQuotes(result, story, sources)) {
                log(`${story.id}: not in any source, unquoted: ${q}`, 'WARN');
            }
            // „Казано – направено“: deadlines and promises, collected quietly.
            const proposed = result.commitments?.length ?? 0;
            // Not during an election silence: no campaign promise goes in then.
            const accepted = silence ? [] : acceptCommitments({ result, story, pending, texts, now });
            const added = recordCommitments(state, accepted, now);
            if (proposed) log(`${story.id}: ${proposed} deadlines proposed, ${added.length} new in the ledger.`);
            for (const e of added) log(`  ledger: ${e.owner} · ${e.kind} · ${e.due} · ${e.quote.slice(0, 120)}`);
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
    // Twins are born when a new story is: look for them then, and at least
    // once an hour in case two stories grew into one.
    if (canSpend() && (createdAny || now - (state.sameAt ?? 0) > HOUR)) {
        await mergeSame(state, now, meter, log);
        state.sameAt = now;
    }
    if (canSpend()) await recheckSensitive(state, meter, log, process.env.YOUTUBE_API_KEY);
    if (canSpend()) await fillPlaces(state, meter, log);
    if (canSpend()) await fillWeights(state, meter, log, proof);
    await readParliament(state, now, meter, canSpend, log, proof);

    // The overview at the top of the page is gone (the list below says the
    // same); an old one is not kept.
    state.overview = null;

    applyBlocklist(state, policy);

    // ─── Proofreading: once, every new text of this update ──────────────
    // A text already on the site was proofread when it was written: the model
    // writes the same title or name again and again, and it is not read
    // twice. Each distinct text goes once; what a failed pass left is tried
    // again on the next update.
    const { queued, distinct } = proofQueue(proof, state, proofedBefore, unproofed);
    if (distinct.length && canSpend()) {
        try {
            // Sonnet: in a blind test it halved the language errors Haiku leaves
            // (10.6 → 5.0 per 1000 words; scripts/eval-writing.js).
            const fixes = await proofread({ texts: distinct, meter, model: OVERVIEW_MODEL, effort: PROOF_EFFORT });
            const fixed = new Map([...fixes].map(([i, text]) => [distinct[i], tidy(text)]));
            for (const [o, f] of queued) if (fixed.has(o[f])) o[f] = fixed.get(o[f]);
            for (const [before, after] of fixed) log(`  proof: ${before.slice(0, 120)} → ${after.slice(0, 120)}`);
            log(`Proofread ${distinct.length} texts (${proof.length} written), corrected ${fixed.size}.`);
            state.unproofed = [];
        } catch (err) {
            log(`Proofreading failed: ${err.message}`, 'WARN');
            state.unproofed = distinct.slice(-300);
        }
    } else if (distinct.length) {
        state.unproofed = distinct.slice(-300);
    }

    // Once: every text already on the site, proofread by the stronger model
    // (the rules above came after some of them were written).
    if ((state.fullProof ?? 0) < 1 && canSpend()) {
        tidyState(state);
        recutOld(state);
        const all = aiTexts(state);
        // Each distinct text once: actors repeat across a timeline.
        const distinct = [...new Set(all.map(([o, f]) => o[f]))];
        try {
            const fixes = await proofread({ texts: distinct, meter, model: OVERVIEW_MODEL });
            const fixed = new Map([...fixes].map(([i, text]) => [distinct[i], tidy(text)]));
            for (const [o, f] of all) if (fixed.has(o[f])) o[f] = fixed.get(o[f]);
            for (const [before, after] of fixed) log(`  full proof: ${before.slice(0, 100)} → ${after.slice(0, 100)}`);
            log(`Full proofreading: ${distinct.length} texts, corrected ${fixed.size}.`);
            state.fullProof = 1;
        } catch (err) {
            log(`Full proofreading failed: ${err.message}`, 'WARN');
        }
    }

    tidyState(state);
    delete state.outletStats;

    state.spend.usd = Math.round((state.spend.usd + meter.usd) * 10000) / 10000;
    // The time readers see is when this version was finished, not begun.
    state.updatedAt = Date.now();
    log(
        `Claude: ${meter.calls} calls, $${meter.usd.toFixed(3)} this update, $${state.spend.usd.toFixed(2)} in ${month}; cache ${meter.cacheRead ?? 0} read / ${meter.cacheWrite ?? 0} written / ${meter.input ?? 0} uncached input tokens.`,
    );

    if (!process.env.LIVE_STATE_URL) fs.writeFileSync(LOCAL_STATE, JSON.stringify(state));
    await buildSite(state, { now });
    log(`Built ${OUT_DIR} with ${rankStories(state.stories, now).length} stories on the page.`);
    return state;
}

// What the proofreader reads in this update: what was written now, and what
// a failed pass left (unproofed), minus every text that was on the site
// before (proofread then); each distinct text once.
export function proofQueue(proof, state, proofedBefore, unproofed) {
    const retry = aiTexts(state).filter(([o, f]) => unproofed.has(o[f]));
    const queued = [...proof, ...retry].filter(
        ([o, f]) => typeof o?.[f] === 'string' && o[f].trim() && !proofedBefore.has(o[f]),
    );
    return { queued, distinct: [...new Set(queued.map(([o, f]) => o[f]))] };
}

// A quote is said word for word in a source (or in what the story already
// says, checked before), or it is not a quote: the marks go and the words
// stay, so nothing on the page claims to be someone's exact words when no
// source has them. Not dropped: a long name in quotes („Асоциацията на
// европейските автомобилостроители“) may differ from the article by an
// ending, and the step must not be lost for that. Returns what was unquoted.
export function checkQuotes(result, story, sources) {
    const known = [
        ...sources,
        story.title,
        story.summary,
        story.disputed,
        ...story.timeline.map((e) => `${e.what} ${e.quote ?? ''}`),
    ];
    const out = [];
    const fix = (o, f) => {
        const loose = unverifiedQuotes(o?.[f], known);
        if (!loose.length) return;
        o[f] = unquote(o[f], loose);
        out.push(...loose);
    };
    for (const f of ['title', 'summary', 'disputed', 'background']) fix(result, f);
    for (const e of result.events ?? []) fix(e, 'what');
    return out;
}

export function applyWrite(story, pending, result, now, proof = []) {
    if (result.title?.trim()) story.title = clip(tidy(result.title), 140);
    if (result.summary?.trim()) story.summary = clip(tidy(result.summary), 600);
    story.disputed = clip(tidy(result.disputed ?? ''), 400);
    proof.push([story, 'title'], [story, 'summary'], [story, 'disputed']);
    if (typeof result.place === 'string') story.place = result.place;
    // A story about a child or a victim of violence shows no outlet's
    // headline and no pictures: a headline may name or show them. They are
    // hidden when the site is built and sealed in the published state
    // (lib/seal.js), not deleted, so one wrong flag costs nothing for good.
    if (result.sensitive === true) story.sensitive = true;
    const related = (result.related ?? []).map((n) => result.past?.[n]).filter(Boolean);
    if (related.length && result.background?.trim()) {
        story.context = {
            background: clip(tidy(result.background), 500),
            related: related.slice(0, 3).map((p) => ({ title: p.title, summary: p.summary, at: p.at })),
        };
        proof.push([story.context, 'background']);
    }
    for (const r of result.items ?? []) {
        const it = pending[r.n];
        if (!it) continue;
        const cites = clip(tidy(r.cites ?? ''), 80);
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
            actor: clip(tidy(e.actor ?? ''), 100),
            who: clip(tidy(e.who ?? ''), 160),
            what: clip(tidy(e.what), 400),
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
