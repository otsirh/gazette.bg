const EMPTY_MARKER = 'В този брой няма промени, които засягат директно гражданите.';

const META_INTRO_RE = /^(В\s+(този|настоящия)\s+брой|Този\s+брой|Настоящият\s+брой)[^\n]*$/;
const META_OUTRO_RE = /^(В\s+останалата\s+част|Останалата\s+част|Останалото\s+съдържание|Останалите\s+документи)[^\n]*$/;

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

export { cleanMarkdown, EMPTY_MARKER };
