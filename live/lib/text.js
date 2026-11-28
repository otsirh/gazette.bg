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
    t = t.replace(/ {2,}/g, ' ');
    return t;
}
