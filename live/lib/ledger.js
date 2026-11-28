// „Казано – направено“: every deadline, promise and scheduled event the
// stories mention, word for word, with who answers for it and the date, so
// the site can later check whether it happened. For now it is only
// collected (state.ledger) and checked by hand; nothing is shown.
import { createHash } from 'node:crypto';
import { squash } from './policy.js';
import { tidy } from './text.js';

const DAY = 24 * 3600 * 1000;
const MONTHS =
    /януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември|края на|началото на|средата на/i;

// The calendar day in Sofia, as YYYY-MM-DD.
const sofiaDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});
export const sofiaDate = (ms) => sofiaDay.format(ms);

// What the model proposed, kept only if it holds up: someone answers for
// it, the words are in one of its materials word for word and carry the
// date, and the date is a real one, not before the material and within
// three years. Only the words that carry the deadline are kept (at most
// 200 characters): the site keeps no article text. A sensitive story gives
// none, even one flagged in this very write: it names no one it need not.
export function acceptCommitments({ result, story, pending, texts, now }) {
    if (story.sensitive || result.sensitive === true) return [];
    const out = [];
    for (const c of result.commitments ?? []) {
        const refs = (c.n ?? []).map((n) => pending[n]).filter(Boolean);
        if (!refs.length) continue;
        const owner = tidy(String(c.owner ?? '')).trim();
        const quote = String(c.quote ?? '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!owner || owner.length > 120 || quote.length > 200) continue;
        const words = squash(quote);
        if (words.split(' ').length < 4 || !(/\d/.test(quote) || MONTHS.test(quote))) continue;
        const said = refs.some((it) =>
            ` ${squash(`${texts.get(it.id) ?? ''} ${it.title ?? ''} ${it.description ?? ''}`)} `.includes(` ${words} `),
        );
        if (!said) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(c.due ?? '')) continue;
        const due = Date.parse(`${c.due}T12:00:00Z`);
        if (Number.isNaN(due) || sofiaDate(due) !== c.due) continue;
        const madeAt = Math.min(...refs.map((r) => r.at));
        if (c.due < sofiaDate(madeAt) || due > now + 3 * 365 * DAY) continue;
        out.push({
            kind: c.kind,
            owner,
            quote,
            due: c.due,
            dueKind: c.dueKind,
            madeAt,
            story: story.id,
            sources: refs.map((r) => ({ url: r.url, source: r.source, at: r.at })),
        });
    }
    return out;
}

// Long words two quotes share, against the shorter one: the same promise
// retold by another outlet shares most of them.
function overlap(a, b) {
    const wa = new Set(
        squash(a)
            .split(' ')
            .filter((w) => w.length >= 4),
    );
    const wb = new Set(
        squash(b)
            .split(' ')
            .filter((w) => w.length >= 4),
    );
    if (!wa.size || !wb.size) return 0;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / Math.min(wa.size, wb.size);
}

// Into the ledger: the same date and kind with words in common is the same
// entry, which gains the new sources; anything else is new. The owner is
// compared too, but an owner written two ways („Столичният общински
// съвет“, „Столичен общински съвет“) still matches when the words agree.
// Returns the entries added.
export function recordCommitments(state, entries, now) {
    state.ledger ??= [];
    const added = [];
    for (const e of entries) {
        const same = state.ledger.find(
            (x) =>
                x.due === e.due &&
                x.kind === e.kind &&
                (squash(x.owner) === squash(e.owner)
                    ? overlap(x.quote, e.quote) >= 0.4
                    : overlap(x.owner, e.owner) >= 0.5 && overlap(x.quote, e.quote) >= 0.6),
        );
        if (same) {
            const urls = new Set(same.sources.map((s) => s.url));
            for (const s of e.sources) if (!urls.has(s.url) && same.sources.length < 20) same.sources.push(s);
            continue;
        }
        const id = createHash('sha1')
            .update(`${squash(e.owner)}|${e.due}|${e.kind}|${squash(e.quote)}`)
            .digest('base64url')
            .slice(0, 10);
        const entry = { id, ...e, addedAt: now, status: 'open' };
        state.ledger.push(entry);
        added.push(entry);
    }
    return added;
}
