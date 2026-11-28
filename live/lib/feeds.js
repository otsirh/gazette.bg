// Reading RSS and Atom feeds (YouTube's channel feeds are Atom) without a
// parser dependency: the feeds we read are small and regular, and every value
// taken from them is treated as text, never markup.
import { execFile } from 'node:child_process';
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

function decode(buf, contentType) {
    // Most Bulgarian sites are UTF-8; a few older ones still send cp1251.
    const declared = (contentType ?? '').match(/charset=([\w-]+)/i)?.[1];
    const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    const inDoc = head.match(/encoding="([\w-]+)"|charset=["']?([\w-]+)/i);
    const charset = (declared || inDoc?.[1] || inDoc?.[2] || 'utf-8').toLowerCase();
    try {
        return new TextDecoder(charset).decode(buf);
    } catch {
        return new TextDecoder('utf-8').decode(buf);
    }
}

const MAX_BYTES = 5 * 1024 * 1024;

// The registrable part of a host ("www.dnevnik.bg" → "dnevnik.bg"), to keep
// fetches on the source's own site.
export function siteOf(url) {
    try {
        return new URL(url).hostname.split('.').slice(-2).join('.');
    } catch {
        return null;
    }
}

function onSite(url, site) {
    if (!site) return true;
    try {
        const host = new URL(url).hostname;
        return host === site || host.endsWith(`.${site}`);
    } catch {
        return false;
    }
}

// Through a SOCKS5 proxy, which Node's fetch cannot use: curl can, and is on
// every runner. Status, final address and type come after the body, on a line
// of their own.
function fetchViaProxy(url, { timeoutMs, accept, proxy, site }) {
    const { host } = new URL(proxy);
    const args = ['-sS', '-L', '--max-redirs', '5', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    args.push('--proto', '=http,https', '--proto-redir', '=http,https', '--max-filesize', String(MAX_BYTES));
    args.push(
        '--socks5-hostname',
        host,
        '-A',
        USER_AGENT,
        '-H',
        `Accept: ${accept}`,
        '-H',
        'Accept-Language: bg,en;q=0.5',
    );
    args.push('-w', '\n%{http_code} %{url_effective} %{content_type}', '--', url);
    return new Promise((resolve, reject) => {
        execFile('curl', args, { encoding: 'buffer', maxBuffer: MAX_BYTES + 65536 }, (err, stdout) => {
            if (err) return reject(new Error(`via proxy: ${String(err.message).split('\n')[0]}`));
            const cut = stdout.lastIndexOf(10);
            const [code, finalUrl, ...type] = stdout
                .subarray(cut + 1)
                .toString('latin1')
                .split(' ');
            if (code !== '200') return reject(new Error(`HTTP ${code} via proxy`));
            if (!onSite(finalUrl, site)) return reject(new Error('redirected off the source site'));
            resolve(decode(new Uint8Array(stdout.subarray(0, cut)), type.join(' ')));
        });
    });
}

// `proxy` (socks5://host:port) is used when given; otherwise a direct fetch.
// `site`, when given, is the only site the request may end up on.
export async function fetchText(url, { timeoutMs = 15000, accept = '*/*', proxy = null, site = null } = {}) {
    if (!onSite(url, site)) throw new Error('not on the source site');
    if (proxy) return fetchViaProxy(url, { timeoutMs, accept, proxy, site });
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'bg,en;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!onSite(res.url, site)) throw new Error('redirected off the source site');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('too large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('too large');
    return decode(buf, res.headers.get('content-type'));
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

// ─── News list pages (institutions without a feed) ──────────────────────

const BG_MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];

// A date in any of the forms Bulgarian institution sites print, as ms
// (noon Sofia time when no hour is given), or null.
export function parseBgDate(text) {
    const t = String(text);
    let m = t.match(/(20\d\d)-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/);
    if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '12'}:${m[5] ?? '00'}:00+02:00`);
    m = t.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d\d)(?:\D{1,4}(\d{1,2}):(\d\d))?/);
    if (m) {
        const [, d, mo, y, h, mi] = m;
        return Date.parse(
            `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(h ?? '12').padStart(2, '0')}:${mi ?? '00'}:00+02:00`,
        );
    }
    m = t.match(/\b(\d{1,2})\s+([А-Яа-я]{3})[а-я]*\.?\s+(20\d\d)/);
    if (m) {
        const mo = BG_MONTHS.indexOf(m[2].toLowerCase());
        if (mo >= 0)
            return Date.parse(`${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00+02:00`);
    }
    m = t.match(/(?:^|[^А-Яа-я])([А-Яа-я]{3})[а-я]*\s+(\d{1,2}),\s*(20\d\d)/);
    if (m) {
        const mo = BG_MONTHS.indexOf(m[1].toLowerCase());
        if (mo >= 0)
            return Date.parse(`${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}T12:00:00+02:00`);
    }
    return null;
}

// The news items on a list page: links whose address matches `pattern`,
// their text as the headline, and the nearest date printed around them.
export function parseList(html, baseUrl, pattern, now = Date.now()) {
    const re = new RegExp(pattern);
    const out = new Map();
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const attrs = m[1];
        const href = attrs.match(/href\s*=\s*["']([^"'#]+)["']/i)?.[1];
        if (!href) continue;
        let url;
        try {
            url = new URL(decodeEntities(href), baseUrl);
        } catch {
            continue;
        }
        if (!isWebUrl(url.href)) continue;
        const path = decodeURIComponent(url.pathname) + url.search;
        if (!re.test(path)) continue;
        const titleAttr = decodeEntities(attrs.match(/title\s*=\s*["']([^"']+)["']/i)?.[1] ?? '');
        let title = toText(m[2]) || titleAttr;
        if (titleAttr.length > title.length) title = titleAttr;
        // Some lists print the date inside the link: keep it for the date,
        // drop it from the headline.
        const around = html.slice(Math.max(0, m.index - 500), m.index + m[0].length + 500);
        const at = parseBgDate(m[2]) ?? parseBgDate(path) ?? parseBgDate(around);
        title = title
            .replace(/^\s*(\d{1,2}[./-]\d{1,2}[./-]20\d\d|\d{1,2}\s+[А-Яа-я]{3}[а-я]*\.?\s+20\d\d)\s*/, '')
            .replace(/^\s*\d{1,2}:\d\d\s+/, '')
            .trim();
        if (title.length < 20) continue;
        const key = url.href;
        if (out.has(key)) continue;
        out.set(key, {
            url: key,
            title: title.slice(0, 300),
            description: '',
            at: at && at <= now + 10 * 60 * 1000 ? at : now,
            category: '',
            videoId: null,
            thumb: null,
            dated: Boolean(at),
        });
    }
    return [...out.values()];
}
