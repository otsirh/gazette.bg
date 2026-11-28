// The editorial and legal rules in live/policy.json, applied to the state on
// every update and to the pages on every build:
// - election silence (Изборен кодекс чл. 182(4) and 205(5)): from 00:00 the
//   day before an election day until the end of that day, no poll results,
//   no party channels and no calls to vote, from anyone;
// - the blocklist, for corrections and removal requests;
// - the public corrections log and replies (ИК чл. 188).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_BY_ID } from '../sources.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'policy.json');

export function loadPolicy() {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
        elections: p.elections ?? [],
        blocklist: { stories: [], items: [], outlets: [], names: [], ...(p.blocklist ?? {}) },
        corrections: p.corrections ?? [],
        replies: p.replies ?? [],
    };
}

const sofiaDay = (ms) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Sofia',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(ms);

// True from 00:00 Sofia time on the day before an election day until the end
// of the election day itself (voting may be extended past 20:00).
export function inElectionSilence(policy, now) {
    const today = sofiaDay(now);
    const tomorrow = sofiaDay(now + 24 * 3600 * 1000);
    return policy.elections.some((d) => d === today || d === tomorrow);
}

// Polls, by the words any report of one uses.
export const POLL =
    /социолог|проучван|анкет|рейтинг|галъп|алфа рисърч|тренд|маркет линкс|медиана|екзакта|„мяра“|агенция „мяра“|exit ?poll|екзитпол|паралелно преброяване|\d+(,\d+)?\s?%\s*(подкрепа|от гласовете|за )/i;

// Calls to vote for or against someone (ИК § 1, т. 17 ДР: „призив за
// подкрепа или за неподкрепа“), whoever reports them: none on the day
// before an election and on the day itself (ИК чл. 182, ал. 4).
export const APPEAL =
    /(?<!\p{L})(гласувай(те)?|подкрепете|дай(те)? (си )?гласа?)(?!\p{L})|за кого да гласува|призова(ха)? .{0,40}(да гласува|да подкрепят|да не гласува)/iu;

const isPartisan = (sourceId) => Boolean(SOURCE_BY_ID.get(sourceId)?.partisan);

export function isPollStory(story) {
    return POLL.test(`${story.title} ${story.summary}`);
}

// What a story shows during the silence: nothing about polls, nothing from
// a party's own channel. A story left with nothing is hidden.
export function silenceFilter(stories) {
    return stories
        .filter((s) => !isPollStory(s) && !APPEAL.test(`${s.title} ${s.summary}`))
        .map((s) => ({
            ...s,
            items: s.items.filter((i) => !isPartisan(i.source) && !POLL.test(i.title) && !APPEAL.test(i.title)),
            timeline: s.timeline.filter(
                (e) => !POLL.test(`${e.who} ${e.what}`) && !APPEAL.test(`${e.what} ${e.quote ?? ''}`),
            ),
        }))
        .filter((s) => s.items.length);
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes what the blocklist names from the state: whole stories, single
// items, whole outlets, and names from every text.
export function applyBlocklist(state, policy) {
    const b = policy.blocklist;
    const stories = new Set(b.stories);
    const items = new Set(b.items);
    const outlets = new Set(b.outlets);
    state.stories = state.stories.filter((s) => !stories.has(s.id) && !(s.aliases ?? []).some((a) => stories.has(a)));
    for (const s of state.stories) {
        s.items = s.items.filter((i) => !items.has(i.url) && !outlets.has(i.source));
    }
    state.stories = state.stories.filter((s) => s.items.length);
    // A remembered story has a page too: a blocked one has none.
    state.memory = (state.memory ?? []).filter((m) => !stories.has(m.id));
    if (state.ledger) state.ledger = state.ledger.filter((e) => !stories.has(e.story));
    const names = b.names.filter((n) => n.trim().length >= 3);
    if (!names.length) return;
    const re = new RegExp(names.map(escapeRe).join('|'), 'gi');
    // A deadline is kept word for word, so one that names a blocked person
    // is not scrubbed but dropped.
    const named = new RegExp(names.map(escapeRe).join('|'), 'i');
    if (state.ledger) state.ledger = state.ledger.filter((e) => !named.test(`${e.owner} ${e.quote}`));
    const scrub = (t) => (typeof t === 'string' ? t.replace(re, '[името е премахнато]') : t);
    for (const s of state.stories) {
        s.title = scrub(s.title);
        s.summary = scrub(s.summary);
        s.disputed = scrub(s.disputed);
        for (const i of s.items) {
            if (re.test(i.title)) i.title = '';
            re.lastIndex = 0;
        }
        for (const e of s.timeline) {
            e.who = scrub(e.who);
            e.actor = scrub(e.actor);
            e.what = scrub(e.what);
            e.quote = scrub(e.quote);
        }
        if (s.context) s.context.background = scrub(s.context.background);
        if (s.weight) s.weight.why = scrub(s.weight.why);
        if (s.framing) {
            for (const a of s.framing.angles ?? []) {
                a.label = scrub(a.label);
                a.summary = scrub(a.summary);
            }
        }
    }
    for (const l of state.overview?.lines ?? []) l.text = scrub(l.text);
    state.memory = (state.memory ?? []).map((m) => ({ ...m, title: scrub(m.title), summary: scrub(m.summary) }));
}

// The quotes in a text that no source says word for word. A quote is what
// stands in „…“ or "…" and has at least four words; a shorter one is a name
// („Топлофикация София“). An ellipsis inside marks a cut, so each part is
// looked for on its own. Case, punctuation and spacing do not matter.
export const squash = (t) =>
    String(t ?? '')
        .toLowerCase()
        .split(/[^\p{L}\d]+/u)
        .filter(Boolean)
        .join(' ');

export function unverifiedQuotes(text, sources) {
    const quotes = [...String(text ?? '').matchAll(/„([^“”"]+)[“”"]|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    const long = quotes.filter((q) => squash(q).split(' ').length >= 4);
    if (!long.length) return [];
    const haystack = ` ${sources.map(squash).join(' | ')} `;
    return long.filter((q) =>
        q
            .split(/…|\.\.\./)
            .map(squash)
            .filter(Boolean)
            .some((part) => !haystack.includes(` ${part} `)),
    );
}

// A text with every unverified quote turned into plain words: the marks go,
// the words stay, and nothing on the page claims to be said word for word.
export function unquote(text, quotes) {
    let t = String(text ?? '');
    for (const q of quotes) t = t.replace(new RegExp(`[„"]${escapeRe(q)}[“”"]`, 'g'), q);
    return t;
}

// Twelve words in a row taken from a source, outside a quote, is copying.
export function copiesSource(text, sources, run = 12) {
    const words = (t) =>
        String(t)
            .toLowerCase()
            .replace(/„[^“]*“|"[^"]*"/g, ' ')
            .split(/[^\p{L}\d]+/u)
            .filter(Boolean);
    const out = words(text);
    if (out.length < run) return false;
    const grams = new Set();
    for (const src of sources) {
        const w = words(src);
        for (let i = 0; i + run <= w.length; i++) grams.add(w.slice(i, i + run).join(' '));
    }
    for (let i = 0; i + run <= out.length; i++) if (grams.has(out.slice(i, i + run).join(' '))) return true;
    return false;
}
