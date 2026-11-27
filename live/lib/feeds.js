// Reading RSS and Atom feeds (YouTube's channel feeds are Atom) without a
// parser dependency: the feeds we read are small and regular, and every value
// taken from them is treated as text, never markup.
import { createHash } from 'node:crypto';

export const USER_AGENT = 'Mozilla/5.0 (compatible; live.gazette.bg/1.0; +https://live.gazette.bg)';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»' };
Object.assign(NAMED_ENTITIES, { bdquo: '„', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' });

export function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code =
                e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
        }
        return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
}

// Markup out, entities decoded, whitespace collapsed: plain text.
export function toText(s) {
    return decodeEntities(
        String(s ?? '')
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]*>/g, ' '),
    )
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tag(block, name) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = block.match(re);
    if (!m) return '';
    return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function attr(block, name, attribute, where = '') {
    const re = new RegExp(`<${name}\\b(?=[^>]*${where})[^>]*\\b${attribute}="([^"]+)"`, 'i');
    return decodeEntities(block.match(re)?.[1] ?? '');
}

export function isWebUrl(u) {
    try {
        const url = new URL(u);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

export function itemId(url) {
    return createHash('sha256').update(url).digest('base64url').slice(0, 12);
}

// Feed entries as { url, title, description, at, category, videoId, thumb }.
// `now` bounds the dates: a feed that stamps items in the future (a wrong
// time zone) gets them stamped with the moment we read them.
export function parseFeed(xml, now = Date.now()) {
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    const out = [];
    for (const b of blocks) {
        const title = toText(tag(b, 'title'));
        let url = toText(tag(b, 'link')) || attr(b, 'link', 'href', 'rel="alternate"') || attr(b, 'link', 'href');
        const guid = toText(tag(b, 'guid'));
        if (!isWebUrl(url) && isWebUrl(guid)) url = guid;
        if (!title || !isWebUrl(url)) continue;
        const rawDate = toText(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'dc:date') || tag(b, 'updated'));
        let at = Date.parse(rawDate);
        if (!Number.isFinite(at) || at > now + 10 * 60 * 1000) at = now;
        const description = toText(
            tag(b, 'description') || tag(b, 'media:description') || tag(b, 'summary') || tag(b, 'content:encoded'),
        ).slice(0, 600);
        const videoId = toText(tag(b, 'yt:videoId')) || null;
        const thumb = attr(b, 'media:thumbnail', 'url') || null;
        out.push({ url, title, description, at, category: toText(tag(b, 'category')), videoId, thumb });
    }
    return out;
}

// Sport, show business, horoscopes and the like never tell what is happening
// to the country; dropping them before the model sees them saves its time.
const OFF_TOPIC =
    /\/(sport|sports|futbol|football|tenis|showbiz|shoubiznes|zvezdi|horoskop|horoscope|lifestyle|krasota|recepti|lyubopitno|avto|auto|tehnologii|tech)\b/i;
const OFF_TOPIC_CATEGORY =
    /^(спорт|футбол|тенис|баскетбол|волейбол|бокс|формула 1|шоубизнес|звезди|хороскоп|любопитно|лайфстайл|красота|рецепти|авто|технологии)/i;

export function isOffTopic(entry) {
    try {
        if (OFF_TOPIC.test(new URL(entry.url).pathname)) return true;
    } catch {
        return true;
    }
    return OFF_TOPIC_CATEGORY.test(entry.category ?? '');
}

export async function fetchText(url, { timeoutMs = 15000, accept = '*/*' } = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'bg,en;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Most Bulgarian sites are UTF-8; a few older ones still send cp1251.
    const declared = (res.headers.get('content-type') ?? '').match(/charset=([\w-]+)/i)?.[1];
    const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    const inDoc = head.match(/encoding="([\w-]+)"|charset=["']?([\w-]+)/i);
    const charset = (declared || inDoc?.[1] || inDoc?.[2] || 'utf-8').toLowerCase();
    try {
        return new TextDecoder(charset).decode(buf);
    } catch {
        return new TextDecoder('utf-8').decode(buf);
    }
}

// Runs fn over items, at most `limit` at a time.
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// The readable text of an article page: its paragraphs, in order. Enough for
// the model to see who is quoted and whom the outlet cites; never published.
export function articleText(html, max = 2500) {
    const body = html.replace(/<(script|style|nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ');
    const paras = [];
    for (const m of body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)) {
        const t = toText(m[1]);
        if (t.length >= 40 && !/©|бисквитк|cookie|абонир/i.test(t)) paras.push(t);
    }
    let text = '';
    for (const p of paras) {
        if (text.length + p.length > max) {
            text += ` ${p.slice(0, Math.max(0, max - text.length))}`;
            break;
        }
        text += (text ? '\n' : '') + p;
    }
    return text.trim();
}
