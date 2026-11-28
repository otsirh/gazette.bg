// What a story is worth right now: how loud it is (heat), whether that is
// growing, how far its sources can be trusted, and how it spread.
import { outletOf, SOURCE_BY_ID, TIERS, tierOf } from '../sources.js';

// A party's own channel counts like an ordinary outlet for heat, and never as
// first-hand confirmation: it is first-hand for their position only.
const isPartisan = (sourceId) => Boolean(SOURCE_BY_ID.get(sourceId)?.partisan);
const weightOf = (sourceId) =>
    isPartisan(sourceId) ? 1 : SOURCE_BY_ID.get(sourceId)?.independent ? 0.8 : TIERS[tierOf(sourceId)].weight;

const HOUR = 60 * 60 * 1000;

// Each article counts half as much every HALF_LIFE: a story nobody writes
// about any more cools down on its own, and a busy one stays up.
export const HALF_LIFE = 6 * HOUR;
// A second, third… item from the same outlet adds less than a new outlet.
const REPEAT_WEIGHT = 0.35;

export const LEVELS = [
    { id: 'hot', min: 6, label: 'Гореща' },
    { id: 'warm', min: 2.5, label: 'Актуална' },
    { id: 'cool', min: 0, label: 'Утихва' },
];
// Below this a story leaves the page; below DROP_HEAT it leaves the state too.
export const SHOW_HEAT = 0.4;
export const DROP_HEAT = 0.12;

export function heatAt(story, at) {
    const seen = new Set();
    let heat = 0;
    for (const item of [...story.items].sort((a, b) => a.at - b.at)) {
        if (item.at > at) continue;
        const outlet = outletOf(item.source);
        const repeat = seen.has(outlet);
        seen.add(outlet);
        const w = weightOf(item.source) * (repeat ? REPEAT_WEIGHT : 1);
        heat += w * 0.5 ** ((at - item.at) / HALF_LIFE);
    }
    return heat;
}

export function levelOf(heat) {
    return LEVELS.find((l) => heat >= l.min);
}

// Rising, falling or steady: heat now against heat three hours ago. A story
// younger than that is new, which says more.
export function trendOf(story, now) {
    const first = Math.min(...story.items.map((i) => i.at));
    if (now - first < 3 * HOUR) return 'new';
    const before = heatAt(story, now - 3 * HOUR);
    const current = heatAt(story, now);
    if (current > before * 1.15) return 'up';
    if (current < before * 0.85) return 'down';
    return 'steady';
}

// Items per two-hour bucket over the last two days, oldest first.
export function sparkline(story, now, buckets = 24, size = 2 * HOUR) {
    const counts = new Array(buckets).fill(0);
    for (const item of story.items) {
        const age = now - item.at;
        const b = buckets - 1 - Math.floor(age / size);
        if (age >= 0 && b >= 0) counts[b]++;
    }
    return counts;
}

// How far the story can be trusted, from who carries it, never from what it
// says: first-hand word, how many separate outlets, whether they disagree.
export function trustOf(story) {
    const outlets = new Set(story.items.map((i) => outletOf(i.source)));
    const neutral = story.items.filter((i) => !isPartisan(i.source));
    const firstHand =
        neutral.some((i) => tierOf(i.source) === 1) ||
        neutral.some((i) => i.citesKind === 'institution' || i.citesKind === 'person');
    const strong = neutral.some((i) => tierOf(i.source) <= 2);
    let level;
    if (firstHand && outlets.size >= 2) level = { id: 'confirmed', label: 'Потвърдено' };
    else if (outlets.size >= 3 && strong) level = { id: 'confirmed', label: 'Потвърдено' };
    else if (outlets.size >= 2) level = { id: 'several', label: 'Няколко източника' };
    else level = { id: 'single', label: 'Само един източник' };
    return { ...level, outlets: outlets.size, firstHand, disputed: story.disputed || '' };
}

// Who broke the story: the earliest item, or the institution it cites.
export function originOf(story) {
    const first = [...story.items].sort((a, b) => a.at - b.at)[0];
    if (!first) return null;
    if ((first.citesKind === 'institution' || first.citesKind === 'person') && first.cites) {
        return { name: first.cites, kind: first.citesKind, at: first.at, via: first.source };
    }
    return { name: SOURCE_BY_ID.get(first.source)?.name ?? first.source, kind: 'media', at: first.at, via: null };
}

// The spread as a tree: an item hangs under the earlier item of the outlet it
// names as its source, or under the institution it quotes; the rest stand on
// their own at the top. Returns [{ item | name, children }] in time order.
export function spreadTree(story) {
    const items = [...story.items].sort((a, b) => a.at - b.at);
    const nodes = new Map(items.map((i) => [i.id, { item: i, children: [] }]));
    const firstByOutlet = new Map();
    const roots = [];
    const institutions = new Map();
    for (const item of items) {
        const node = nodes.get(item.id);
        const parentItem = item.citesSource ? firstByOutlet.get(outletOf(item.citesSource)) : null;
        if (parentItem && parentItem.id !== item.id && outletOf(parentItem.source) !== outletOf(item.source)) {
            nodes.get(parentItem.id).children.push(node);
        } else if ((item.citesKind === 'institution' || item.citesKind === 'person') && item.cites) {
            const key = item.cites.toLowerCase();
            if (!institutions.has(key)) {
                const inst = { name: item.cites, kind: item.citesKind, at: item.at, children: [] };
                institutions.set(key, inst);
                roots.push(inst);
            }
            institutions.get(key).children.push(node);
        } else {
            roots.push(node);
        }
        const outlet = outletOf(item.source);
        if (!firstByOutlet.has(outlet)) firstByOutlet.set(outlet, item);
    }
    return roots;
}

// Ranks stories for the page, hottest first, with what the page shows.
export function rankStories(stories, now) {
    return stories
        .map((s) => {
            const heat = heatAt(s, now);
            return { story: s, heat, level: levelOf(heat), trend: trendOf(s, now), trust: trustOf(s) };
        })
        .filter((r) => r.heat >= SHOW_HEAT)
        .sort((a, b) => b.heat - a.heat);
}

// Stories nobody talks about any more leave the state; so does any story
// older than a week, however it is kept alive.
export function pruneStories(stories, now) {
    return stories.filter((s) => heatAt(s, now) >= DROP_HEAT && now - s.createdAt < 7 * 24 * HOUR);
}

export function lastAt(story) {
    return Math.max(...story.items.map((i) => i.at));
}

// ─── The outlets' track record ──────────────────────────────────────────

// What one story says about each outlet that carried it: was it first, how
// far behind the first it came, whether its items say where they got the
// news, and how often others cite it. Only stories with three or more
// outlets count: with fewer there is no race to be first.
export function outletContributions(story) {
    const items = [...story.items].sort((a, b) => a.at - b.at);
    const out = new Map();
    if (new Set(items.map((i) => outletOf(i.source))).size < 3) return out;
    const t0 = items[0].at;
    for (const it of items) {
        const o = outletOf(it.source);
        if (!out.has(o)) {
            out.set(o, {
                stories: 1,
                first: out.size === 0 ? 1 : 0,
                delayMin: Math.round((it.at - t0) / 60000),
                items: 0,
                attributed: 0,
                own: 0,
                citedBy: 0,
            });
        }
        const c = out.get(o);
        c.items++;
        if (['media', 'institution', 'person'].includes(it.citesKind)) c.attributed++;
        if (it.citesKind === 'own') c.own++;
    }
    // Cited by others: counted only for outlets that carried the story too.
    for (const it of items) {
        if (!it.citesSource) continue;
        const cited = outletOf(it.citesSource);
        if (cited !== outletOf(it.source) && out.has(cited)) out.get(cited).citedBy++;
    }
    return out;
}

// Adds one story's contributions to the running totals (kept across updates).
export function addContributions(totals, story) {
    for (const [o, c] of outletContributions(story)) {
        if (!totals[o]) totals[o] = { stories: 0, first: 0, delaySum: 0, items: 0, attributed: 0, own: 0, citedBy: 0 };
        const t = totals[o];
        t.stories += c.stories;
        t.first += c.first;
        t.delaySum += Math.min(c.delayMin, 6 * 60);
        t.items += c.items;
        t.attributed += c.attributed;
        t.own += c.own;
        t.citedBy += c.citedBy;
    }
    return totals;
}
