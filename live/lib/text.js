// The mechanical part of writing Bulgarian well, applied to everything the
// model writes before it reaches a page. What needs judgment (spelling,
// grammar, commas) is the proofreading step's job; this is what a rule can
// fix for certain.

// Latin letters that look like Cyrillic ones. A model sometimes mixes them
// into a Cyrillic word ("тpaнcпopт"), which reads the same but breaks search,
// copying and screen readers.
const LOOKALIKE = {
    a: 'а',
    c: 'с',
    e: 'е',
    o: 'о',
    p: 'р',
    x: 'х',
    y: 'у',
    A: 'А',
    B: 'В',
    C: 'С',
    E: 'Е',
    H: 'Н',
    K: 'К',
    M: 'М',
    O: 'О',
    P: 'Р',
    T: 'Т',
    X: 'Х',
};

function fixMixedWord(word) {
    const cyr = (word.match(/[Ѐ-ӿ]/g) ?? []).length;
    const lat = (word.match(/[A-Za-z]/g) ?? []).length;
    if (!cyr || !lat) return word;
    // Only when every Latin letter has a Cyrillic twin: "iPhone-а" stays.
    if (!/^[^A-Za-z]*(?:[acexopyABCEHKMOPTX][^A-Za-z]*)+$/.test(word)) return word;
    return word.replace(/[A-Za-z]/g, (ch) => LOOKALIKE[ch]);
}

export function tidy(text) {
    if (typeof text !== 'string') return text;
    let t = text.replace(/\s+/g, ' ').trim();
    t = t.replace(/[\p{L}-]+/gu, fixMixedWord);
    // Bulgarian quotes: „…“. Straight pairs first, then English curly ones.
    t = t.replace(/"([^"]+)"/g, '„$1“');
    t = t.replace(/“([^”]*)”/g, '„$1“');
    // A dash between words is an en dash with spaces, not a hyphen.
    t = t.replace(/(\S) - (\S)/g, '$1 – $2');
    t = t.replace(/(\S) — (\S)/g, '$1 – $2');
    // No space before punctuation, one after.
    t = t.replace(/\s+([,.;:!?…])/g, '$1');
    t = t.replace(/([,;:])(?=[^\s\d"„“»)/])/g, '$1 ');
    t = t.replace(/\.{3}/g, '…');
    // A decimal comma before a unit: "9.5 км" is "9,5 км" (dates and times,
    // "28.11" or "9.30 ч.", have no unit and are left alone).
    t = t.replace(UNIT_DECIMAL, '$1,$2');
    // A percent sign sits right after the number: "40%".
    t = t.replace(/(\d) %/g, '$1%');
    // A range of numbers takes an en dash without spaces: "5–10".
    t = t.replace(/(?<![\d.,–-])(\d{1,4})-(\d{1,4})(?![\d-])/g, '$1–$2');
    t = t.replace(/ {2,}/g, ' ');
    return t;
}

const UNIT_DECIMAL =
    /(?<![\d.,])(\d+)\.(\d+)(?=\s?(?:км|м|см|мм|кг|т|л|%|‰|°|млн|млрд|хил|лв|евро|долара|пъти|промила|процента|градуса|бала|точки|милиона|милиарда|хиляди|часа)(?!\p{L}))/gu;

// Cut to at most max characters at a word, with "…": never mid-word.
export function clip(text, max) {
    const t = String(text ?? '');
    if (t.length <= max) return t;
    let cut = t.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    if (space > max * 0.6) cut = cut.slice(0, space);
    cut = `${cut.replace(/[\s,;:–—-]+$/, '')}…`;
    // A quote opened and not closed is closed after the cut.
    const open = (cut.match(/„/g) ?? []).length - (cut.match(/“/g) ?? []).length;
    return open > 0 ? `${cut}“` : cut;
}

// Every text the model has written, in the state: tidied on every update,
// so a rule added here reaches what is already on the site too. Outlet
// headlines are theirs and verbatim quotes are quotes: neither is touched.
export function aiTexts(state) {
    const out = [];
    const add = (o, f) => {
        if (o && typeof o[f] === 'string' && o[f].trim()) out.push([o, f]);
    };
    for (const s of state.stories ?? []) {
        for (const f of ['title', 'summary', 'disputed']) add(s, f);
        add(s.context, 'background');
        for (const a of s.framing?.angles ?? []) for (const f of ['label', 'summary']) add(a, f);
        add(s.framing, 'missing');
        for (const e of s.timeline ?? []) for (const f of ['actor', 'who', 'what']) add(e, f);
        for (const i of s.items ?? []) add(i, 'cites');
    }
    for (const l of state.overview?.lines ?? []) add(l, 'text');
    return out;
}

export function tidyState(state) {
    for (const [o, f] of aiTexts(state)) o[f] = tidy(o[f]);
}

// Once: the old limits cut names and roles mid-word ("федерация по лека").
// A text that long is cut again at a word, with "…".
const OLD_CUT = { who: 120, actor: 60 };
export function recutOld(state) {
    for (const [o, f] of aiTexts(state)) {
        if (OLD_CUT[f] && o[f].length >= OLD_CUT[f] - 1 && !/[.)“»…]$/.test(o[f])) o[f] = clip(o[f], OLD_CUT[f] - 2);
    }
}
