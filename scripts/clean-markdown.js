const EMPTY_MARKER = 'В този брой няма промени, които засягат директно гражданите.';

const META_INTRO_RE = /^(В\s+(този|настоящия)\s+брой|Този\s+брой|Настоящият\s+брой)[^\n]*$/;
const META_OUTRO_RE = /^(В\s+останалата\s+част|Останалата\s+част|Останалото\s+съдържание|Останалите\s+документи)[^\n]*$/;

// Bulgarian quotes are a house rule the model mostly follows and occasionally
// forgets. Straight quotes are cheaper to fix here than to police in the prompt.
// Code spans are left alone — a quote inside `...` is code, not prose.
function normalizeQuotes(text) {
    return text
        .split('\n')
        .map((line) => line
            .split('`')
            .map((segment, i) => {
                if (i % 2 === 1) return segment; // inside a code span
                // Decide by what precedes the quote rather than by toggling an
                // open/closed flag: the text may already contain Bulgarian
                // quotes, and a flag would fall out of step with them.
                return segment.replace(/"/g, (m, offset, s) => {
                    const prev = s[offset - 1];
                    return !prev || /[\s(\[{«„—–-]/.test(prev) ? '„' : '“';
                });
            })
            .join('`'))
        .join('\n');
}

function normalizeDashes(text) {
    return text
        .split('\n')
        .map((line) => {
            if (/^\s*(?:[-*+]\s|\d+\.\s)/.test(line)) return line;
            return line.replace(/ [-–] /g, ' — ');
        })
        .join('\n');
}

function cleanMarkdown(text) {
    if (!text) return '';
    let t = String(text).replace(/\r\n/g, '\n');

    t = t.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();

    if (t === EMPTY_MARKER) return t + '\n';

    t = t.replace(/(^|\n)[ \t]*-{3,}[ \t]*(?=\n|$)/g, '$1');

    t = normalizeDashes(t);
    t = normalizeQuotes(t);

    const paragraphs = t.split(/\n{2,}/);

    while (paragraphs.length > 1) {
        const first = paragraphs[0].trim();
        if (META_INTRO_RE.test(first) || first === EMPTY_MARKER) {
            paragraphs.shift();
        } else {
            break;
        }
    }

    while (paragraphs.length > 1) {
        const last = paragraphs[paragraphs.length - 1].trim();
        if (META_OUTRO_RE.test(last)) {
            paragraphs.pop();
        } else {
            break;
        }
    }

    t = paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n');

    return t.trim() + '\n';
}

// The model occasionally types a Bulgarian word with Latin letters — "obhвата"
// for "обхвата", "professionalен" for "професионален". It reads as garbage and
// no prompt reliably prevents it, so catch it here: a word that mixes the two
// alphabets is always a mistake. Whole Latin tokens are fine (iBoxx, MWh, S&P).
function findMixedScriptWords(text) {
    const words = String(text).match(/[\p{L}]+/gu) || [];
    return [...new Set(words.filter((w) => /\p{Script=Cyrillic}/u.test(w) && /\p{Script=Latin}/u.test(w)))];
}

export { cleanMarkdown, findMixedScriptWords, EMPTY_MARKER };
