#!/usr/bin/env node
// Builds live.gazette.bg from the state.
//
// The page answers three questions in this order: what is happening (the
// brief), what is hottest (temperature, colour, size), and can I trust it
// (who carries it, who said it first). A story page then lets you hear the
// people themselves, see who said what, and watch how the news spread.
// Every value from a feed or the model is escaped.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain as isMainModule } from '../scripts/lib/cli.js';
import { isWebUrl } from './lib/feeds.js';
import { homeImage, iconPng, storyImage } from './lib/og.js';
import { MAP, OUTLINE, placeOf } from './lib/places.js';
import { inElectionSilence, loadPolicy, POLL, silenceFilter } from './lib/policy.js';
import { addContributions, lastAt, originOf, rankStories, sparkline, spreadTree } from './lib/stories.js';
import { outletOf, SOURCE_BY_ID, SOURCES, tierOf } from './sources.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const OUT_DIR = path.join(ROOT, 'dist-live');
export const SITE_ORIGIN = 'https://live.gazette.bg';
// Where readers ask for a correction or a removal (GitHub variable LIVE_CONTACT).
// Who runs the site (GitHub variables LIVE_OPERATOR and, if wished, LIVE_ADDRESS).
const OPERATOR = (process.env.LIVE_OPERATOR ?? '').trim().slice(0, 120);
const ADDRESS = (process.env.LIVE_ADDRESS ?? '').trim().slice(0, 200);
const CONTACT = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(process.env.LIVE_CONTACT ?? '')
    ? process.env.LIVE_CONTACT
    : '';
const HOUR = 3600 * 1000;

// Bumped by hand when style.css or live.js change, so browsers fetch them anew.
const ASSET_VERSION = '17';

const esc = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const href = (u) => (isWebUrl(u) ? esc(u) : '#');
const ext = (u, text) => `<a href="${href(u)}" rel="noopener" target="_blank">${text}</a>`;

const sofia = (opts) => new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', ...opts });
const fmtClock = sofia({ hour: '2-digit', minute: '2-digit' });
const fmtDay = sofia({ day: 'numeric', month: 'short' });
const fmtLongDay = sofia({ weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = sofia({ year: 'numeric', month: '2-digit', day: '2-digit' });

export function relTime(ms, now) {
    const min = Math.max(0, Math.round((now - ms) / 60000));
    if (min < 1) return 'току-що';
    if (min < 60) return `преди ${min} мин`;
    const h = Math.round(min / 60);
    if (h < 24) return `преди ${h} ч`;
    const d = Math.round(h / 24);
    return d === 1 ? 'вчера' : `преди ${d} дни`;
}

// "14:05" today, "вчера 14:05" or "26 ноем. 14:05" further back.
function when(ms, now) {
    const k = dayKey.format(ms);
    const clock = fmtClock.format(ms);
    if (k === dayKey.format(now)) return clock;
    if (k === dayKey.format(now - 24 * HOUR)) return `вчера ${clock}`;
    return `${fmtDay.format(ms)} ${clock}`;
}

const timeEl = (ms, now, rel = false) =>
    `<time datetime="${new Date(ms).toISOString()}" data-ts="${ms}"${rel ? ' data-rel' : ''}>${esc(rel ? relTime(ms, now) : when(ms, now))}</time>`;

// The outlet's name; its YouTube channel is the same outlet, shown with ▶
// where it matters rather than "(видео)" after every name.
const displayName = (id) => (SOURCE_BY_ID.get(id)?.name ?? id).replace(/ \(видео\)$/, '');
const sourceLabel = (id) => esc(displayName(id));
// An outlet's headline, or, where a story touches a child or a victim and the
// headline is withheld, just whose material it is.
const itemTitle = (it) => it.title || `Материал на ${displayName(it.source)}`;
const capFirst = (t) => String(t).replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── What kind of voice a source is ─────────────────────────────────────

const KINDS = {
    first: {
        one: 'първоизточник',
        many: 'първоизточника',
        title: 'Първоизточници',
        long: 'Първоизточник — институцията или човекът говорят сами',
    },
    public: { one: 'обществена медия', many: 'обществени медии', long: 'Агенция или обществена медия' },
    editorial: { one: 'редакционна медия', many: 'редакционни медии', long: 'Редакционна медия с известен собственик' },
    independent: {
        one: 'независим автор',
        many: 'независими автори',
        long: 'Независим автор — известен човек, без редакция зад него',
    },
    partisan: {
        one: 'партиен канал',
        many: 'партийни канала',
        title: 'Партийни канали',
        long: 'Партиен канал — позиция, не проверен факт',
    },
    unverified: {
        one: 'непроверен източник',
        many: 'непроверени източника',
        title: 'Непроверени източници',
        long: 'Непроверен източник или без подпис',
    },
};
const kindCount = (k, n) => `${n} ${n === 1 ? KINDS[k].one : KINDS[k].many}`;
const KIND_ORDER = ['first', 'public', 'editorial', 'independent', 'partisan', 'unverified'];

function kindOf(sourceId) {
    if (SOURCE_BY_ID.get(sourceId)?.partisan) return 'partisan';
    if (SOURCE_BY_ID.get(sourceId)?.independent) return 'independent';
    return ['first', 'first', 'public', 'editorial', 'unverified'][tierOf(sourceId)] ?? 'unverified';
}

// Outlets with an icon in site/icons/ (fetched by scripts/fetch-icons.js).
const ICON_DIR = path.join(HERE, 'site', 'icons');
const ICONS_FOUND = new Set(
    fs.existsSync(ICON_DIR)
        ? fs
              .readdirSync(ICON_DIR)
              .filter((f) => f.endsWith('.png'))
              .map((f) => f.slice(0, -4))
        : [],
);

// The outlet's icon, ringed in the colour of its kind; the plain dot when
// it has no icon.
function srcMark(sourceId) {
    const o = outletOf(sourceId);
    const k = kindOf(sourceId);
    if (!ICONS_FOUND.has(o)) {
        // No icon to show: the outlet's initials, in the same frame.
        const ini = displayName(sourceId)
            .replace(/[„“"«»()]/g, '')
            .split(/[\s,.-]+/)
            .filter((w) => w && /\p{L}/u.test(w[0]))
            .slice(0, 2)
            .map((w) => w[0].toUpperCase())
            .join('');
        return `<span class="src-ico src-ini kr-${k}" aria-hidden="true" title="${esc(KINDS[k].long)}">${esc(ini || '•')}</span>`;
    }
    return `<img class="src-ico kr-${k}" src="/icons/${esc(o)}.png" alt="" width="16" height="16" loading="lazy" decoding="async" title="${esc(KINDS[k].long)}">`;
}

// Separate outlets per kind: the shape of who carries a story.
function coverage(story) {
    const byOutlet = new Map();
    for (const it of story.items) {
        const o = outletOf(it.source);
        const k = kindOf(it.source);
        const prev = byOutlet.get(o);
        if (!prev || KIND_ORDER.indexOf(k) < KIND_ORDER.indexOf(prev)) byOutlet.set(o, k);
    }
    const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0]));
    for (const k of byOutlet.values()) counts[k]++;
    return { counts, total: byOutlet.size };
}

function coverageBar(story, { legend = false } = {}) {
    const { counts, total } = coverage(story);
    if (!total) return '';
    const present = KIND_ORDER.filter((k) => counts[k]);
    const parts = present
        .map((k) => `<i class="k-${k}" style="flex:${counts[k]}" title="${esc(kindCount(k, counts[k]))}"></i>`)
        .join('');
    const leg = legend
        ? `<span class="cov-legend">${present.map((k) => `<span><i class="kd k-${k}"></i>${esc(kindCount(k, counts[k]))}</span>`).join('')}</span>`
        : '';
    const label = present.map((k) => kindCount(k, counts[k])).join(', ');
    return `<span class="cov" role="img" aria-label="Кой я отразява: ${esc(label)}"><span class="cov-bar">${parts}</span>${leg}</span>`;
}

// ─── Heat ───────────────────────────────────────────────────────────────

// 0–100 "degrees"; logarithmic, since a big story is ten times louder.
export const tempOf = (heat) => Math.max(1, Math.min(99, Math.round((Math.log1p(heat) / Math.log1p(40)) * 100)));

const TREND = {
    new: { sym: '✦', label: 'нова' },
    up: { sym: '▲', label: 'разгаря се' },
    steady: { sym: '■', label: 'държи се' },
    down: { sym: '▼', label: 'утихва' },
};

function sparkSvg(counts) {
    const w = 120;
    const h = 28;
    const max = Math.max(1, ...counts);
    const step = w / counts.length;
    const bars = counts
        .map((c, i) => {
            if (!c) return '';
            const bh = Math.max(2, (c / max) * (h - 2));
            return `<rect x="${(i * step).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(step - 1.4).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
        })
        .join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Колко се пише за историята през последните 48 часа">${bars}</svg>`;
}

function tempBadge(r) {
    return `<span class="temp heat-${r.level.id}" title="Нажеженост: колко се говори в момента"><b>${tempOf(r.heat)}°</b></span>`;
}

function chips(r, now) {
    const t = TREND[r.trend];
    const lastHour = r.story.items.filter((i) => now - i.at < HOUR).length;
    return `<span class="lvl heat-${r.level.id}">${esc(r.level.label)}</span><span class="trend trend-${r.trend}">${t.sym} ${esc(t.label)}</span>${lastHour ? `<span class="fresh">+${lastHour} за последния час</span>` : ''}`;
}

const videosOf = (story) =>
    story.items
        .filter((i) => i.kind === 'video' && !i.forKids && /^[\w-]{6,20}$/.test(i.videoId ?? ''))
        .sort((a, b) => b.at - a.at);

const thumb = (videoId) => `https://i.ytimg.com/vi/${esc(videoId)}/mqdefault.jpg`;

const ICONS = {
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zm0-9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>',
};

// ─── Page frame ─────────────────────────────────────────────────────────

// JSON inside <script>: a "<" in a headline must not end the element.
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function head({ title, description, canonical, image, ld = null }) {
    return `<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="live.gazette.bg" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:locale" content="bg_BG" />
    <meta property="og:image" content="${esc(image)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f3f4f7" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0d12" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-180.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/unbounded-cyrillic-700.woff2" crossorigin />
    <link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}" />
    <script type="module" src="/live.js?v=${ASSET_VERSION}"></script>
    ${ld ? jsonLd(ld) : ''}
</head>`;
}

function topbar(state, now) {
    return `<header class="topbar">
    <div class="wrap topbar-inner">
        <a class="skip" href="#main">Към съдържанието</a>
        <a class="brand" href="/"><span class="live-dot" aria-hidden="true"></span><span class="brand-live">НА ЖИВО</span><span class="brand-name">live.gazette.bg</span></a>
        <span class="status" data-status>обновено ${timeEl(state.updatedAt || now, now, true)}</span>
        <button type="button" class="icon-btn" data-share data-share-title="Какво се случва в България сега" data-share-url="${SITE_ORIGIN}/" aria-label="Сподели сайта">${ICONS.share}</button>
    </div>
</header>`;
}

function footer() {
    return `<footer class="footer">
    <div class="wrap footer-inner">
        <div class="footer-brand"><span class="live-dot" aria-hidden="true"></span> live.gazette.bg</div>
        <ul class="legend">${KIND_ORDER.map((k) => `<li><i class="kd k-${k}"></i>${esc(KINDS[k].long)}</li>`).join('')}</ul>
        <p>Историите, обобщенията и хронологиите се съставят автоматично с изкуствен интелект (Claude на Anthropic) от ${SOURCES.length} източника и може да съдържат грешки. Всяко твърдение води към материала, от който е взето.</p>
        <p><a href="/about/">За сайта, поправки и поверителност</a> · <a href="/corrections/">Поправки</a> · <a href="/sources/">Източници и как се оценяват</a> · <a href="/media/">Досие на медиите</a></p>
    </div>
</footer>`;
}

// ─── Front page ─────────────────────────────────────────────────────────

function cardData(r) {
    const s = r.story;
    return `data-story="${esc(s.id)}" data-first="${Math.min(...s.items.map((i) => i.at))}" data-last="${lastAt(s)}" data-level="${r.level.id}" data-trust="${r.trust.id}" data-video="${videosOf(s).length ? 1 : 0}"`;
}

function cardMeta(r, now) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    const place = placeOf(s.place);
    return [
        `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>`,
        place ? `<span class="place">${ICONS.pin}${esc(place.name)}</span>` : '',
        `<span>${plural(r.trust.outlets, 'медия', 'медии')}</span>`,
        origin
            ? `<span class="origin">първо: ${origin.source ? srcMark(origin.source) : ''}<b>${esc(origin.name)}</b> ${timeEl(origin.at, now)}</span>`
            : '',
        videos ? `<span class="has-video">▶ ${videos}</span>` : '',
        r.trust.disputed ? '<span class="has-dispute">⚠ противоречия</span>' : '',
    ]
        .filter(Boolean)
        .join('');
}

// Which hot cards take the whole row in the two-column grid: the first, every
// card with a video (it lies on its side), and a text card with no text card
// next to it. Two text cards share a row, so no card is stretched to match a
// taller neighbour. live.js does the same after a filter hides cards.
export function wideCards(hasVideo) {
    const wide = hasVideo.map(() => true);
    for (let i = 1; i < hasVideo.length; i++) {
        if (hasVideo[i] || i + 1 >= hasVideo.length || hasVideo[i + 1]) continue;
        wide[i] = wide[i + 1] = false;
        i++;
    }
    return wide;
}

function storyCard(r, now, { big = false, wide = false } = {}) {
    const s = r.story;
    const video = big ? videosOf(s)[0] : null;
    return `<li class="card heat-${r.level.id}${big ? ' big' : ''}${wide ? ' wide' : ''}${video ? ' with-video' : ''}" ${cardData(r)}>
    <a class="card-link" href="/s/${esc(s.id)}/">
        ${video ? `<span class="card-thumb"><img src="${thumb(video.videoId)}" alt="" loading="lazy" width="320" height="180" /><span class="play" aria-hidden="true">${ICONS.play}</span><span class="thumb-src">YouTube</span></span>` : ''}
        <span class="card-body">
            <span class="card-top">${tempBadge(r)}${chips(r, now)}<span class="ago">${timeEl(lastAt(s), now, true)}</span></span>
            <span class="card-title">${esc(s.title)}</span>
            ${s.summary ? `<span class="card-summary">${esc(s.summary)}</span>` : ''}
            ${coverageBar(s)}
            <span class="card-foot"><span class="meta">${cardMeta(r, now)}</span>${sparkSvg(sparkline(s, now))}</span>
        </span>
    </a>
    <button type="button" class="icon-btn card-share" data-share data-share-title="${esc(s.title)}" data-share-url="${SITE_ORIGIN}/s/${esc(s.id)}/" aria-label="Сподели">${ICONS.share}</button>
</li>`;
}

function rowItem(r, now, note = '') {
    return `<li class="row heat-${r.level.id}" ${cardData(r)}><a href="/s/${esc(r.story.id)}/">${tempBadge(r)}<span class="row-title">${esc(r.story.title)}</span><span class="row-meta">${note}${timeEl(lastAt(r.story), now, true)}</span></a></li>`;
}

function heroBlock(state, ranked, mainCount, now) {
    const byId = new Map(ranked.map((r) => [r.story.id, r]));
    const lines = (state.overview?.lines ?? []).filter((l) => byId.has(l.story));
    const hot = ranked.filter((r) => r.level.id === 'hot').length;
    const outletsToday = new Set(
        ranked.flatMap((r) => r.story.items.filter((i) => now - i.at < 24 * HOUR).map((i) => outletOf(i.source))),
    ).size;
    const brief = lines.length
        ? `<ol class="brief" data-brief>${lines
              .map((l) => {
                  const r = byId.get(l.story);
                  return `<li class="heat-${r.level.id}"><a href="/s/${esc(l.story)}/"><span class="brief-temp">${tempOf(r.heat)}°</span><span class="brief-text">${esc(l.text)}</span></a></li>`;
              })
              .join(
                  '',
              )}</ol>${lines.length > 4 ? `<button type="button" class="brief-more" data-brief-more>Още ${lines.length - 4} ↓</button>` : ''}`
        : '';
    return `<section class="hero" aria-labelledby="hero-title">
    <p class="hero-kicker"><span class="live-dot" aria-hidden="true"></span>${esc(fmtLongDay.format(now))}</p>
    <h1 id="hero-title" class="hero-title">Какво се случва<br>в България сега</h1>
    <p class="hero-stats"><span><b>${mainCount}</b> ${mainCount === 1 ? 'актуална история' : 'актуални истории'}</span><span><b class="t-hot">${hot}</b> ${hot === 1 ? 'гореща' : 'горещи'}</span><span><b>${outletsToday}</b> ${outletsToday === 1 ? 'медия' : 'медии'} днес</span><span>обновено ${timeEl(state.updatedAt || now, now, true)}</span></p>
    ${brief}
</section>`;
}

function welcomeBlock() {
    // Shown by live.js on a first visit only.
    return `<section class="welcome" data-welcome hidden aria-label="Как се чете страницата">
    <p class="welcome-title">Тук за минута виждаш какво става в държавата.</p>
    <ul class="welcome-points">
        <li><span class="wp-icon wp-hot">87°</span><span><b>Горещото е отгоре.</b> Колкото повече медии пишат, толкова по-високо. Щом спрат, историята изстива и изчезва.</span></li>
        <li><span class="wp-icon wp-ok">✓</span><span><b>Знаеш на кого да вярваш.</b> Кой пръв е съобщил новината, колко медии я потвърждават и какви са.</span></li>
        <li><span class="wp-icon wp-vid">▶</span><span><b>Чуваш хората сами.</b> Видеата от телевизиите, институциите и партиите, на едно място.</span></li>
    </ul>
    <button type="button" class="btn" data-welcome-close>Ясно, покажи ми</button>
</section>`;
}

function filters() {
    const f = [
        ['all', 'Всички'],
        ['hot', 'Горещи'],
        ['video', '▶ С видео'],
        ['confirmed', '✓ Потвърдени'],
        ['mine', 'Нови за мен'],
        ['follow', '★ Следени'],
    ];
    return `<div class="filters" role="toolbar" aria-label="Покажи">${f
        .map(
            ([id, label], i) =>
                `<button type="button" class="filter${i === 0 ? ' on' : ''}" data-filter="${id}"${id === 'mine' || id === 'follow' ? ' hidden' : ''} aria-pressed="${i === 0}">${label}</button>`,
        )
        .join('')}</div>`;
}

function justIn(ranked, now) {
    const latest = ranked
        .filter((r) => r.trust.outlets >= 2 || r.trust.firstHand)
        .flatMap((r) => r.story.items.map((it) => ({ it, r })))
        .sort((a, b) => b.it.at - a.it.at)
        .slice(0, 14);
    if (!latest.length) return '';
    return `<section class="rail-box" aria-labelledby="justin">
    <h2 id="justin" class="rail-title"><span class="live-dot" aria-hidden="true"></span>Току-що</h2>
    <ol class="justin">${latest
        .map(
            ({ it, r }) =>
                `<li><a href="/s/${esc(r.story.id)}/"><span class="ji-meta">${srcMark(it.source)}${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} · ${timeEl(it.at, now, true)}</span><span class="ji-title">${esc(itemTitle(it))}</span></a></li>`,
        )
        .join('')}</ol>
</section>`;
}

function howBox() {
    return `<section class="rail-box how" aria-labelledby="how">
    <h2 id="how" class="rail-title">Как да четеш</h2>
    <p><b class="t-hot">87°</b> Нажеженост: колко се пише сега. Пада наполовина на всеки 6 часа без нови материали.</p>
    <p><span class="cov cov-mini"><span class="cov-bar"><i class="k-first" style="flex:1"></i><i class="k-public" style="flex:1"></i><i class="k-editorial" style="flex:3"></i><i class="k-independent" style="flex:1"></i><i class="k-partisan" style="flex:1"></i><i class="k-unverified" style="flex:1"></i></span></span>Кой отразява историята: първоизточници, обществени и редакционни медии, независими автори, партийни канали, непроверени.</p>
    <p><kbd>J</kbd> <kbd>K</kbd> — следваща и предишна история, <kbd>Enter</kbd> — отвори.</p>
    <p><a href="/sources/">Всички ${SOURCES.length} източника →</a></p>
</section>`;
}

const isMain = (r) => r.trust.outlets >= 2 || r.trust.firstHand;

// Local stories on a map: one dot per oblast, as big as its stories are hot,
// the colour of the hottest one.
function mapBlock(ranked, now) {
    const byPlace = new Map();
    for (const r of ranked) {
        const p = placeOf(r.story.place);
        if (!p) continue;
        if (!byPlace.has(p.name)) byPlace.set(p.name, { p, list: [] });
        byPlace.get(p.name).list.push(r);
    }
    if (!byPlace.size) return '';
    const places = [...byPlace.values()].sort((a, b) => b.list[0].heat - a.list[0].heat);
    const dots = places
        .map(({ p, list }) => {
            const heat = list.reduce((sum, r) => sum + r.heat, 0);
            const rad = Math.min(34, 9 + Math.sqrt(heat) * 5);
            const [x, y] = p.xy.map((v) => v.toFixed(0));
            const titles = list.map((r) => r.story.title).join('\n');
            return `<a href="/s/${esc(list[0].story.id)}/"><title>${esc(`${p.name}: ${titles}`)}</title><circle class="map-dot heat-${list[0].level.id}" cx="${x}" cy="${y}" r="${rad.toFixed(0)}"/><text class="map-label" x="${x}" y="${(Number(y) + rad + 22).toFixed(0)}" text-anchor="middle">${esc(p.seat)}${list.length > 1 ? ` · ${list.length}` : ''}</text></a>`;
        })
        .join('');
    const rows = places
        .flatMap(({ p, list }) =>
            list
                .slice(0, 3)
                .map(
                    (r) =>
                        `<li class="heat-${r.level.id}"><a href="/s/${esc(r.story.id)}/"><span class="map-place">${esc(p.name)}</span><span class="map-title">${esc(r.story.title)}</span>${timeEl(lastAt(r.story), now, true)}</a></li>`,
                ),
        )
        .slice(0, 12)
        .join('');
    return `<section class="group map-group" aria-labelledby="g-map"><h2 id="g-map" class="group-title">По места <span>местните истории в момента</span></h2>
<div class="map-wrap">
    <svg class="map" role="group" viewBox="-20 -20 ${MAP.width + 40} ${MAP.height + 40}" aria-label="Карта на България с местните истории"><path class="map-land" d="${OUTLINE}"/>${dots}</svg>
    <ol class="map-list">${rows}</ol>
</div></section>`;
}

function frontPage(state, ranked, now) {
    const main = ranked.filter(isMain);
    const hot = main.filter((r) => r.level.id === 'hot');
    const warm = main.filter((r) => r.level.id === 'warm');
    const cool = main.filter((r) => r.level.id === 'cool').slice(0, 24);
    const singles = ranked
        .filter((r) => !isMain(r))
        .sort((a, b) => lastAt(b.story) - lastAt(a.story))
        .slice(0, 15);
    const groups = [];
    if (hot.length) {
        groups.push(`<section class="group" aria-labelledby="g-hot"><h2 id="g-hot" class="group-title t-hot">Горещо <span>за това се говори най-много</span></h2>
<ol class="cards cards-big">${(() => {
            const wide = wideCards(hot.map((r) => videosOf(r.story).length > 0));
            return hot.map((r, i) => storyCard(r, now, { big: true, wide: wide[i] })).join('');
        })()}</ol></section>`);
    }
    if (warm.length) {
        groups.push(`<section class="group" aria-labelledby="g-warm"><h2 id="g-warm" class="group-title t-warm">Актуално</h2>
<ol class="cards">${warm.map((r) => storyCard(r, now)).join('')}</ol></section>`);
    }
    const map = mapBlock(main, now);
    if (map) groups.push(map);
    if (cool.length) {
        groups.push(`<section class="group" aria-labelledby="g-cool"><h2 id="g-cool" class="group-title">Утихва <span>вече се пише по-малко</span></h2>
<ol class="rows">${cool.map((r) => rowItem(r, now, `${plural(r.trust.outlets, 'медия', 'медии')} · `)).join('')}</ol></section>`);
    }
    if (singles.length) {
        groups.push(`<section class="group" aria-labelledby="g-single"><h2 id="g-single" class="group-title">Само от един източник <span>още непотвърдени</span></h2>
<ol class="rows rows-single">${singles.map((r) => rowItem(r, now, `${sourceLabel(r.story.items[0].source)} · `)).join('')}</ol></section>`);
    }
    const body = groups.length
        ? groups.join('\n')
        : '<p class="empty">Все още няма събрани истории. Първото обновяване идва до 10 минути.</p>';
    const top = main[0];
    return `${head({
        title: 'Какво се случва в България сега — live.gazette.bg',
        description: top
            ? `Сега най-горещо: ${top.story.title}. Всички актуални новини, подредени по това колко се говори за тях, с първоизточника и видеата.`
            : 'Актуалните новини в България, подредени по това колко се говори за тях, с първоизточника и видеата.',
        canonical: `${SITE_ORIGIN}/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
        ld: {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'live.gazette.bg',
            url: `${SITE_ORIGIN}/`,
            inLanguage: 'bg',
            description: 'Какво се случва в България сега: новините, подредени по това колко се говори за тях.',
            mainEntity: {
                '@type': 'ItemList',
                itemListElement: main.slice(0, 20).map((r, i) => ({
                    '@type': 'ListItem',
                    position: i + 1,
                    url: `${SITE_ORIGIN}/s/${r.story.id}/`,
                    name: r.story.title,
                })),
            },
        },
    })}
<body class="home" data-version="${state.updatedAt}">
${topbar(state, now)}
<main id="main" class="wrap">
${welcomeBlock()}
${state.silence ? '<p class="silence">Изборен ден: до края на гласуването не показваме социологически проучвания и партийни канали (Изборен кодекс, чл. 182 и 205).</p>' : ''}
${heroBlock(state, ranked, main.length, now)}
<div class="since" data-since hidden></div>
<div class="layout">
    <div class="feed">
        ${filters()}
        ${body}
        <p class="filter-empty" data-filter-empty hidden>Няма такива истории в момента.</p>
    </div>
    <aside class="rail">
        ${justIn(ranked, now)}
        ${howBox()}
    </aside>
</div>
</main>
${footer()}
</body>
</html>
`;
}

// ─── Story page ─────────────────────────────────────────────────────────

function actorsOf(story) {
    const groups = new Map();
    for (const e of story.timeline) {
        const name = (e.actor || (e.who ?? '').split(',')[0]).trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!groups.has(key)) groups.set(key, { name, role: '', events: [] });
        const g = groups.get(key);
        g.events.push(e);
        const role = (e.who ?? '').includes(',') ? e.who.split(',').slice(1).join(',').trim() : '';
        if (role && !g.role) g.role = role;
    }
    return [...groups.values()]
        .map((g) => ({ ...g, events: g.events.sort((a, b) => b.at - a.at) }))
        .sort((a, b) => b.events.length - a.events.length || b.events[0].at - a.events[0].at);
}

function initials(name) {
    return esc(
        name
            .replace(/[„“"«»()]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((w) => w[0])
            .join('')
            .toUpperCase(),
    );
}

// A quote from the parliament's verbatim record: where it is, and the
// sitting's video.
function recordLinks(e) {
    const parts = [ext(e.url, `🏛 ${esc(e.label || 'Стенограма')}`)];
    if (e.video) parts.push(ext(e.video, '▶ запис на заседанието'));
    return parts.join(' · ');
}

function contextBlock(story, now) {
    const c = story.context;
    if (!c?.background) return '';
    const rel = (c.related ?? [])
        .map(
            (p) => `<li><time>${esc(when(p.at, now))}</time> <b>${esc(p.title)}</b><span>${esc(p.summary)}</span></li>`,
        )
        .join('');
    return `<section class="context" aria-labelledby="context">
    <h2 id="context" class="context-title">Какво стана преди</h2>
    <p>${esc(c.background)}</p>
    ${rel ? `<details><summary>${plural(c.related.length, 'по-ранна история', 'по-ранни истории')}</summary><ul>${rel}</ul></details>` : ''}
</section>`;
}

function framingBlock(story, now) {
    const f = story.framing;
    if (!f?.angles?.length) return '';
    const byId = new Map(story.items.map((i) => [i.id, i]));
    const angles = f.angles
        .map((a) => {
            const outlets = new Map();
            for (const id of a.items) {
                const it = byId.get(id);
                if (it && !outlets.has(outletOf(it.source))) outlets.set(outletOf(it.source), it);
            }
            const chipsHtml = [...outlets.values()]
                .map(
                    (it) =>
                        `<a class="src-chip" href="${href(it.url)}" target="_blank" rel="noopener" title="${esc(itemTitle(it))}">${srcMark(it.source)}${sourceLabel(it.source)}</a>`,
                )
                .join('');
            return `<li class="angle"><b>${esc(a.label)}</b><p>${esc(a.summary)}</p><div class="src-chips">${chipsHtml}</div></li>`;
        })
        .join('');
    // Every outlet's first headline, side by side, by kind of source.
    const seen = new Set();
    const firsts = [];
    for (const it of [...story.items].sort((a, b) => a.at - b.at)) {
        const o = outletOf(it.source);
        if (seen.has(o)) continue;
        seen.add(o);
        firsts.push(it);
    }
    const byKind = KIND_ORDER.map((k) => {
        const list = firsts.filter((it) => kindOf(it.source) === k);
        if (!list.length) return '';
        return `<div class="hl-group"><h3><i class="kd k-${k}"></i>${esc(KINDS[k].title ?? capFirst(KINDS[k].many))}</h3><ul>${list
            .map(
                (it) =>
                    `<li><span>${srcMark(it.source)}${sourceLabel(it.source)}</span>${ext(it.url, esc(itemTitle(it)))}</li>`,
            )
            .join('')}</ul></div>`;
    }).join('');
    return `<section class="panel" aria-labelledby="framing">
    <h2 id="framing" class="panel-title">Как го представят <span>една и съща новина, различни ъгли</span></h2>
    <ul class="angles">${angles}</ul>
    ${f.missing ? `<p class="missing"><b>Никой не казва:</b> ${esc(f.missing)}</p>` : ''}
    <details class="headlines"><summary>Заглавията един до друг (${firsts.length})</summary><div class="hl-grid">${byKind}</div></details>
    <p class="quiet small">Описанието е автоматично, по заглавията; ${timeEl(f.at, now, true)}.</p>
</section>`;
}

function actorsBlock(story, now) {
    const actors = actorsOf(story);
    if (actors.length < 2) return '';
    const byId = new Map(story.items.map((i) => [i.id, i]));
    const cards = actors.slice(0, 9).map((a) => {
        const latest = a.events[0];
        const src = latest.items
            .map((id) => byId.get(id))
            .filter(Boolean)
            .slice(0, 2)
            .map((i) => ext(i.url, sourceLabel(i.source)))
            .join(', ');
        const more =
            a.events.length > 1
                ? `<details class="voice-more"><summary>още ${a.events.length - 1}</summary><ul>${a.events
                      .slice(1)
                      .map((e) => `<li>${timeEl(e.at, now)} ${esc(capFirst(e.what))}</li>`)
                      .join('')}</ul></details>`
                : '';
        return `<li class="voice">
    <div class="voice-head"><span class="avatar" aria-hidden="true">${initials(a.name)}</span><span><b>${esc(a.name)}</b>${a.role ? `<small>${esc(a.role)}</small>` : ''}</span></div>
    <p class="voice-what">${latest.quote ? `<q class="quote">${esc(latest.quote)}</q>` : esc(capFirst(latest.what))}</p>
    <p class="voice-src">${timeEl(latest.at, now)}${latest.source === 'parliament' ? ` · ${recordLinks(latest)}` : src ? ` · ${src}` : ''}</p>
    ${more}
</li>`;
    });
    return `<section class="panel" aria-labelledby="voices">
    <h2 id="voices" class="panel-title">Кой какво казва <span>${plural(actors.length, 'страна', 'страни')} в историята</span></h2>
    <ul class="voices">${cards.join('')}</ul>
</section>`;
}

const isOriginCite = (it) => (it.citesKind === 'institution' || it.citesKind === 'person') && it.cites;

// The spread as a picture: time runs left to right, each outlet has its own
// lane, and a line joins an item to the earlier one it cites. The first-hand
// sources (institutions, people) sit in a lane of their own on top.
export function spreadSvg(story, now) {
    const items = [...story.items].sort((a, b) => a.at - b.at);
    if (items.length < 2) return '';
    const lanes = [];
    const laneOf = new Map();
    if (items.some(isOriginCite)) lanes.push({ label: 'Първоизточник', kind: 'first' });
    for (const it of items) {
        const o = outletOf(it.source);
        if (!laneOf.has(o) && lanes.length < 18) {
            laneOf.set(o, lanes.length);
            const name = SOURCE_BY_ID.get(it.source)?.name.replace(/ \(видео\)$/, '') ?? o;
            lanes.push({ label: name, kind: kindOf(it.source) });
        }
    }
    const t0 = items[0].at;
    const t1 = Math.max(items.at(-1).at, t0 + HOUR);
    const LABEL = 150;
    const W = 860;
    const ROW = 26;
    const TOP = 30;
    const H = TOP + lanes.length * ROW + 12;
    const x = (t) => LABEL + 14 + ((t - t0) / (t1 - t0)) * (W - LABEL - 30);
    const y = (lane) => TOP + lane * ROW + ROW / 2;
    const f = (n) => n.toFixed(1);
    const pos = new Map();
    const origins = new Map();
    const marks = [];
    const links = [];
    for (const it of items) {
        const lane = laneOf.get(outletOf(it.source));
        if (lane === undefined) continue;
        const p = { x: x(it.at), y: y(lane) };
        pos.set(it.id, p);
        if (isOriginCite(it)) {
            const key = it.cites.toLowerCase();
            if (!origins.has(key)) {
                const op = { x: x(it.at), y: y(0) };
                origins.set(key, op);
                marks.push(
                    `<g class="sp-origin"><title>${esc(it.cites)} — първоизточник</title><rect x="${f(op.x - 5)}" y="${f(op.y - 5)}" width="10" height="10" rx="2" transform="rotate(45 ${f(op.x)} ${f(op.y)})"/></g>`,
                );
            }
            const op = origins.get(key);
            const my = (op.y + p.y) / 2;
            links.push(
                `<path class="sp-link sp-link-origin" d="M${f(op.x)} ${f(op.y)} C ${f(op.x)} ${f(my)}, ${f(p.x)} ${f(my)}, ${f(p.x)} ${f(p.y)}"/>`,
            );
        } else if (it.citesSource) {
            const parent = items.find(
                (j) => outletOf(j.source) === outletOf(it.citesSource) && j.at <= it.at && pos.has(j.id),
            );
            if (parent) {
                const pp = pos.get(parent.id);
                const mx = (pp.x + p.x) / 2;
                links.push(
                    `<path class="sp-link" d="M${f(pp.x)} ${f(pp.y)} C ${f(mx)} ${f(pp.y)}, ${f(mx)} ${f(p.y)}, ${f(p.x)} ${f(p.y)}"/>`,
                );
            }
        }
        const label = `${displayName(it.source)} · ${when(it.at, now)} — ${itemTitle(it)}`;
        marks.push(
            `<a href="${href(it.url)}" target="_blank" rel="noopener"><title>${esc(label)}</title><circle class="sp-dot k-${kindOf(it.source)}${it.kind === 'video' ? ' sp-video' : ''}" cx="${f(p.x)}" cy="${f(p.y)}" r="${it.id === items[0].id ? 7 : 5}"/></a>`,
        );
    }
    const laneEls = lanes
        .map((l, i) => {
            const label = l.label.length > 20 ? `${l.label.slice(0, 19)}…` : l.label;
            return `<g class="sp-lane"><line x1="${LABEL}" x2="${W - 8}" y1="${y(i)}" y2="${y(i)}"/><text x="${LABEL - 10}" y="${y(i) + 4}" text-anchor="end" class="sp-label kt-${l.kind}">${esc(label)}</text></g>`;
        })
        .join('');
    const ticks = [0, 1 / 3, 2 / 3, 1]
        .map((fr) => {
            const t = t0 + fr * (t1 - t0);
            const anchor = fr === 0 ? 'start' : fr === 1 ? 'end' : 'middle';
            return `<text class="sp-tick" x="${f(x(t))}" y="16" text-anchor="${anchor}">${esc(when(t, now))}</text>`;
        })
        .join('');
    return `<div class="spread-scroll"><svg class="spread-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Как се разпространи новината във времето, медия по медия">${ticks}${laneEls}${links.join('')}${marks.join('')}</svg></div>`;
}

function treeHtml(nodes, now) {
    if (!nodes.length) return '';
    return `<ul>${nodes
        .map((n) => {
            const kids = treeHtml(n.children, now);
            if (!n.item) {
                const kind = n.kind === 'person' ? 'говори пряко' : 'официален източник';
                return `<li class="origin"><span class="node"><span class="node-src">◆ ${esc(n.name)}</span><span class="node-how">${kind}</span></span>${kids}</li>`;
            }
            const it = n.item;
            const how = it.citesSource
                ? `цитира ${sourceLabel(it.citesSource)}`
                : it.citesKind === 'own'
                  ? 'собствен материал'
                  : it.cites && it.citesKind === 'media'
                    ? `цитира ${esc(it.cites)}`
                    : '';
            return `<li><span class="node"><span class="node-src">${srcMark(it.source)}${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} ${timeEl(it.at, now)}</span>${how ? `<span class="node-how">${how}</span>` : ''}${ext(it.url, esc(itemTitle(it)))}</span>${kids}</li>`;
        })
        .join('')}</ul>`;
}

function spreadBlock(story, now) {
    const svg = spreadSvg(story, now);
    if (!svg) return '';
    return `<section class="panel" aria-labelledby="spread">
    <h2 id="spread" class="panel-title">Как тръгна и как се разнесе <span>всяка точка е материал; линията води към този, когото цитира</span></h2>
    ${svg}
    ${story.items.length <= LIST_MAX ? `<details class="tree-details"><summary>Като дърво, с всички заглавия</summary><div class="tree">${treeHtml(spreadTree(story), now)}</div></details>` : ''}
</section>`;
}

function videoTile(v, now) {
    return `<li class="video">
    <button type="button" class="video-play" data-video="${esc(v.videoId)}" aria-label="Пусни: ${esc(v.title)}">
        <img src="${thumb(v.videoId)}" alt="" loading="lazy" width="320" height="180" />
        <span class="play" aria-hidden="true">${ICONS.play}</span>
    </button>
    <span class="video-title">${ext(v.url, esc(v.title))}</span>
    <span class="video-meta">${srcMark(v.source)}${sourceLabel(v.source)} · ${timeEl(v.at, now)} · <span class="yt-src">YouTube</span></span>
</li>`;
}

function videoBlock(story, now) {
    if (story.sensitive) return '';
    const vids = videosOf(story);
    if (!vids.length) return '';
    return `<section class="panel panel-video" aria-labelledby="videos">
    <h2 id="videos" class="panel-title">▶ Чуй какво казват <span>${plural(vids.length, 'видео', 'видеа')}, най-новото първо</span></h2>
    <p class="quiet small yt-note">Видеата са от YouTube и се зареждат едва при пускане; тогава важат <a href="https://www.youtube.com/t/terms" rel="noopener" target="_blank">Условията на YouTube</a> и <a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Политиката за поверителност на Google</a>.</p>
    <ul class="videos">${vids
        .slice(0, 4)
        .map((v) => videoTile(v, now))
        .join('')}</ul>
    ${
        vids.length > 4
            ? `<details class="more"><summary>Още ${plural(vids.length - 4, 'видео', 'видеа')}</summary><ul class="videos">${vids
                  .slice(4)
                  .map((v) => videoTile(v, now))
                  .join('')}</ul></details>`
            : ''
    }
</section>`;
}

function timelineBlock(story) {
    if (!story.timeline.length) {
        return `<section class="panel" aria-labelledby="timeline"><h2 id="timeline" class="panel-title">Хронология</h2><p class="quiet">Хронологията се попълва при следващото обновяване.</p></section>`;
    }
    const byId = new Map(story.items.map((i) => [i.id, i]));
    let lastDay = '';
    const rows = [...story.timeline]
        .sort((a, b) => b.at - a.at)
        .map((e) => {
            const refs = e.items.map((id) => byId.get(id)).filter(Boolean);
            const kind = e.source === 'parliament' ? 'first' : refs.length ? kindOf(refs[0].source) : 'editorial';
            let links = refs.map((i) => ext(i.url, sourceLabel(i.source))).join(', ');
            if (e.source === 'parliament') links = recordLinks(e);
            const day = dayKey.format(e.at);
            const sep = day !== lastDay ? `<li class="tl-day">${esc(fmtLongDay.format(e.at))}</li>` : '';
            lastDay = day;
            return `${sep}<li class="tl tl-${kind}" data-at="${e.at}">
    <span class="tl-time">${esc(fmtClock.format(e.at))}</span>
    <span class="tl-body"><b class="tl-who">${esc(capFirst(e.who))}</b><span class="tl-what">${esc(capFirst(e.what))}</span>${e.quote ? `<q class="quote">${esc(e.quote)}</q>` : ''}${links ? `<span class="tl-src">${links}</span>` : ''}</span>
</li>`;
        });
    return `<section class="panel" aria-labelledby="timeline">
    <h2 id="timeline" class="panel-title">Хронология <span>най-новото отгоре · часът е на материала, който го съобщава</span></h2>
    <ol class="timeline">${rows.join('')}</ol>
</section>`;
}

const LIST_MAX = 120;

function sourcesBlock(story, now) {
    const sorted = [...story.items].sort((a, b) => a.at - b.at);
    const rows = sorted
        .slice(0, LIST_MAX)
        .map(
            (i) =>
                `<li>${timeEl(i.at, now)} ${srcMark(i.source)}<b>${sourceLabel(i.source)}</b>${i.kind === 'video' ? ' ▶' : ''} ${ext(i.url, esc(itemTitle(i)))}</li>`,
        );
    return `<details class="panel all-items">
    <summary class="panel-title">Всички ${plural(sorted.length, 'материал', 'материала')} <span>най-старото първо</span></summary>
    <ul class="item-list">${rows.join('')}</ul>
    ${sorted.length > LIST_MAX ? `<p class="quiet small">Показани са първите ${LIST_MAX} от ${sorted.length}.</p>` : ''}
</details>`;
}

function stat(label, value) {
    return `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function moreBlock(r, ranked, now) {
    const others = ranked.filter((o) => o.story.id !== r.story.id && isMain(o)).slice(0, 4);
    if (!others.length) return '';
    return `<section class="group more-stories" aria-labelledby="more"><h2 id="more" class="group-title t-hot">Още за това се говори сега</h2>
<ol class="cards">${others.map((o) => storyCard(o, now)).join('')}</ol></section>`;
}

// Answers from people or parties a story names (Изборен кодекс чл. 188, and
// anyone else who asks), published as received, without comment.
let REPLIES = [];
function repliesBlock(story) {
    const ids = new Set([story.id, ...(story.aliases ?? [])]);
    const mine = REPLIES.filter((r) => ids.has(r.story));
    if (!mine.length) return '';
    return `<section class="panel replies" aria-labelledby="replies">
    <h2 id="replies" class="panel-title">Отговор <span>публикуван без коментар</span></h2>
    ${mine.map((r) => `<blockquote class="reply"><p>${esc(r.text)}</p><footer>— ${esc(r.from)}${r.date ? `, ${esc(r.date)}` : ''}</footer></blockquote>`).join('')}
</section>`;
}

function storyPage(state, r, ranked, now) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    const url = `${SITE_ORIGIN}/s/${s.id}/`;
    const blocks = {
        context: contextBlock(s, now),
        videos: videoBlock(s, now),
        framing: framingBlock(s, now),
        voices: actorsBlock(s, now),
        spread: spreadBlock(s, now),
        timeline: timelineBlock(s),
    };
    const nav = [
        ['videos', `▶ ${plural(videos, 'видео', 'видеа')}`],
        ['framing', 'Как го представят'],
        ['voices', 'Кой какво казва'],
        ['spread', 'Разпространение'],
        ['timeline', 'Хронология'],
    ]
        .filter(([id]) => blocks[id] && (id !== 'timeline' || s.timeline.length))
        .map(([id, label]) => `<a class="btn btn-ghost" href="#${id}">${label}</a>`)
        .join('');
    const originStat = origin
        ? stat(
              'Първи съобщи',
              `${esc(origin.name)}<small>${timeEl(origin.at, now)}${origin.via && sourceLabel(origin.via) !== esc(origin.name) ? ` · по материал на ${sourceLabel(origin.via)}` : ''}</small>`,
          )
        : '';
    return `${head({
        title: `${s.title} — live.gazette.bg`,
        description: s.summary || s.title,
        canonical: url,
        ld: {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline: s.title.slice(0, 110),
            description: s.summary || s.title,
            datePublished: new Date(Math.min(...s.items.map((i) => i.at))).toISOString(),
            dateModified: new Date(lastAt(s)).toISOString(),
            inLanguage: 'bg',
            mainEntityOfPage: url,
            image: [`${SITE_ORIGIN}/og/${s.id}.png`],
            author: { '@type': 'Organization', name: 'live.gazette.bg', url: `${SITE_ORIGIN}/about/` },
            publisher: { '@type': 'Organization', name: 'live.gazette.bg', url: `${SITE_ORIGIN}/` },
            isBasedOn: s.items.slice(0, 30).map((i) => i.url),
            ...(placeOf(s.place) ? { contentLocation: { '@type': 'Place', name: placeOf(s.place).name } } : {}),
        },
        image: `${SITE_ORIGIN}/og/${s.id}.png?v=${tempOf(r.heat)}-${r.trust.outlets}`,
    })}
<body class="story heat-${r.level.id}" data-version="${state.updatedAt}" ${cardData(r)}>
${topbar(state, now)}
<main id="main" class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head">
    <div class="card-top">${tempBadge(r)}${chips(r, now)}</div>
    <h1>${esc(s.title)}</h1>
    ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
    <p class="ai-note">Обобщено автоматично с изкуствен интелект от ${plural(s.items.length, 'материал', 'материала')} на ${plural(r.trust.outlets, 'медия', 'медии')}. Всяко твърдение води към материала, от който е взето — проверявай там. <a href="/about/">Как работи</a></p>
    <div class="actions">
        <button type="button" class="btn" data-share data-share-title="${esc(s.title)}" data-share-url="${url}">${ICONS.share} Сподели</button>
        <button type="button" class="btn btn-ghost" data-follow="${esc(s.id)}" aria-pressed="false">☆ Следи</button>
        ${nav}
    </div>
    <dl class="stats">
        ${stat('Достоверност', `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>${coverageBar(s, { legend: true })}`)}
        ${originStat}
        ${stat('Медии', `${r.trust.outlets}<small>${plural(s.items.length, 'материал', 'материала')}${videos ? `, ${plural(videos, 'видео', 'видеа')}` : ''}</small>`)}
        ${stat('Нажеженост', `<span class="stat-temp heat-${r.level.id}">${tempOf(r.heat)}°</span>${sparkSvg(sparkline(s, now))}<small>колко се пише, последни 48 ч</small>`)}
    </dl>
    ${r.trust.disputed ? `<p class="disputed"><b>⚠ Спорно:</b> ${esc(r.trust.disputed)}</p>` : ''}
</header>
${blocks.context}
${blocks.videos}
${blocks.framing}
${blocks.voices}
${blocks.spread}
${repliesBlock(s)}
${blocks.timeline}
${sourcesBlock(s, now)}
${moreBlock(r, ranked, now)}
</main>
${footer()}
</body>
</html>
`;
}

// ─── The outlets' track record ──────────────────────────────────────────

const outletName = (o) =>
    SOURCE_BY_ID.get(o)?.name ?? SOURCE_BY_ID.get(`${o}-yt`)?.name.replace(/ \(видео\)$/, '') ?? o;

export function outletTotals(state) {
    const totals = structuredClone(state.outletStats?.outlets ?? {});
    for (const s of state.stories) addContributions(totals, s);
    return totals;
}

function fmtDelay(min) {
    if (min < 60) return `${Math.round(min)} мин`;
    if (min < 24 * 60) return `${(min / 60).toFixed(min < 600 ? 1 : 0).replace('.', ',')} ч`;
    return '1+ ден';
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function mediaPage(state, now) {
    const totals = outletTotals(state);
    const rows = Object.entries(totals)
        .filter(([, t]) => t.stories >= 2)
        .sort((a, b) => b[1].stories - a[1].stories)
        .map(([o, t]) => {
            const delay = t.delaySum / t.stories;
            return `<tr>
    <th scope="row">${srcMark(SOURCE_BY_ID.has(o) ? o : `${o}-yt`)}${esc(outletName(o))}</th>
    <td data-label="Истории" data-v="${t.stories}">${t.stories}</td>
    <td data-label="Първа" data-v="${pct(t.first, t.stories)}">${t.first}<small>${pct(t.first, t.stories)}%</small></td>
    <td data-label="Закъснение" data-v="${Math.round(delay)}">${fmtDelay(delay)}</td>
    <td data-label="Посочва източник" data-v="${pct(t.attributed, t.items)}"><span class="bar"><i style="width:${pct(t.attributed, t.items)}%"></i></span>${pct(t.attributed, t.items)}%</td>
    <td data-label="Собствени" data-v="${pct(t.own, t.items)}">${pct(t.own, t.items)}%</td>
    <td data-label="Цитирана" data-v="${t.citedBy}">${t.citedBy}</td>
</tr>`;
        })
        .join('');
    const since = state.outletStats?.since ?? state.updatedAt;
    return `${head({
        title: 'Досие на медиите — live.gazette.bg',
        description:
            'Коя медия съобщава първа, коя посочва откъде знае и коя цитират другите — по данни, не по мнение.',
        canonical: `${SITE_ORIGIN}/media/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="media" data-version="${state.updatedAt}">
${topbar(state, now)}
<main id="main" class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Досие на медиите</h1>
<p class="lede">Как всяка медия се държи в новините, които следим: съобщава ли първа, посочва ли откъде знае, цитират ли я другите. Само данни, събирани от ${esc(fmtLongDay.format(since))}, насам, без мнение. С всеки ден картината е по-точна.</p></header>
<div class="panel table-panel">
<table class="dossier" data-sortable>
    <thead><tr>
        <th scope="col">Медия</th>
        <th scope="col" data-sort title="В колко истории с поне 3 медии участва">Истории</th>
        <th scope="col" data-sort title="Колко пъти е съобщила първа">Първа</th>
        <th scope="col" data-sort title="Средно колко след първия материал по историята (до 6 часа)">Закъснение</th>
        <th scope="col" data-sort title="Каква част от материалите ѝ казват откъде е информацията">Посочва източник</th>
        <th scope="col" data-sort title="Собствен репортаж или разследване">Собствени</th>
        <th scope="col" data-sort title="Колко пъти други медии я цитират">Цитирана</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="quiet">Още няма достатъчно данни.</td></tr>'}</tbody>
</table>
</div>
<div class="prose panel">
<p><b>Истории</b> — само истории, отразени от поне 3 медии: там има кой да е пръв. <b>Първа</b> — най-ранният материал по историята. <b>Закъснение</b> — средно колко след първия излиза нейният материал (бавно не е лошо, ако е проверено).</p>
<p><b>Посочва източник</b> — материалите, които казват откъде е новината: друга медия, институция или човек, който говори. <b>Собствени</b> — собствен репортаж без чужд източник. <b>Цитирана</b> — колко пъти други материали я посочват като източник.</p>
<p>Кой кого цитира, определя автоматично изкуствен интелект по текста на материалите, така че в отделни случаи може да греши. Подреди таблицата, като кликнеш върху заглавието на колона.</p>
</div>
</main>
${footer()}
</body>
</html>
`;
}

// ─── Sources page ───────────────────────────────────────────────────────

function sourcesPage(state, now) {
    const groups = KIND_ORDER.map((k) => {
        const list = SOURCES.filter((s) => kindOf(s.id) === k);
        if (!list.length) return '';
        const rows = list
            .map((s) => {
                const st = state.sources?.[s.id];
                const status = st && !st.ok ? ' <span class="down">не отговаря в момента</span>' : '';
                return `<li>${srcMark(s.id)}${ext(s.home, `<b>${sourceLabel(s.id)}</b>`)}${s.kind === 'video' ? ' <span class="yt-tag">YouTube</span>' : ''}${status} — ${esc(s.why)}</li>`;
            })
            .join('');
        return `<section class="panel"><h2 class="panel-title"><i class="kd k-${k}"></i>${esc(KINDS[k].long)} <span>${list.length}</span></h2><ul class="item-list">${rows}</ul></section>`;
    }).join('\n');
    return `${head({
        title: 'Източници и как се оценяват — live.gazette.bg',
        description: `Кои ${SOURCES.length} източника чете live.gazette.bg и колко тежи думата на всеки.`,
        canonical: `${SITE_ORIGIN}/sources/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="sources" data-version="${state.updatedAt}">
${topbar(state, now)}
<main id="main" class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Източници и как се оценяват</h1>
<p class="lede">Четем ${SOURCES.length} източника от всички страни: медии, телевизии, независими автори, институции и партии. Колкото повече гледни точки, толкова по-ясна картина.</p></header>
<div class="prose panel">
<p><b>Тежестта на източника</b> идва от проверими неща, не от политическата му линия: дали говори самата институция или човек, дали медията отговаря по закон за точността си, дали има известен собственик и подписани материали.</p>
<p><b>Независимите автори</b> са журналисти, коментатори и малки екипи без медия зад тях: известен човек отговаря за казаното, но няма редакция, която да го проверява. Тежат малко по-малко от редакционните медии.</p>
<p><b>Партийните канали</b> са първоизточник за това какво казват политиците, но казаното е тяхна позиция. Затова сами никога не потвърждават история.</p>
<p><b>„Потвърдено“</b> значи: има първоизточник (институция или човек говорят сами) и още една медия, или поне три отделни медии, сред които агенция или обществена медия. „Противоречия“ значи, че източниците си противоречат за съществен факт.</p>
<p><b>Нажежеността</b> (°) расте с всеки нов материал — повече от нова медия, по-малко от същата — и пада наполовина на всеки 6 часа. Щом за една история спре да се пише, тя изстива и изчезва.</p>
</div>
${groups}
</main>
${footer()}
</body>
</html>
`;
}

// ─── About, corrections, privacy ────────────────────────────────────────

function aboutPage(state, now) {
    const mail = CONTACT
        ? `<a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>`
        : 'адреса за връзка, който ще бъде публикуван тук';
    const operator = OPERATOR
        ? `<p>Сайтът се списва и поддържа от <b>${esc(OPERATOR)}</b>, физическо лице, с нестопанска цел.${ADDRESS ? ` Адрес за кореспонденция: ${esc(ADDRESS)}.` : ''} Връзка: ${CONTACT ? mail : 'ще бъде публикувана тук'}.</p>`
        : `<p>Връзка: ${CONTACT ? mail : 'ще бъде публикувана тук'}.</p>`;
    return `${head({
        title: 'За сайта — live.gazette.bg',
        description: 'Какво е live.gazette.bg, как работи, поправки и отговори, авторски права и лични данни.',
        canonical: `${SITE_ORIGIN}/about/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="about" data-version="${state.updatedAt}">
${topbar(state, now)}
<main id="main" class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>За сайта</h1>
<p class="lede">live.gazette.bg показва какво се случва в България сега: новините от ${SOURCES.length} източника, подредени по това колко се говори за тях, с първоизточника, хронологията и видеата.</p></header>
<div class="prose panel">
<h2 class="panel-title">Кой стои зад сайта</h2>
${operator}
<p>Сайтът няма реклами, не взима пари и няма абонамент.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Как работи</h2>
<p>На всеки 10 минути сайтът чете публичните емисии (RSS) на медиите и YouTube каналите от <a href="/sources/">списъка с източници</a>. Изкуствен интелект (Claude на Anthropic) подрежда материалите в истории и пише кратко обобщение, хронология и кой какво е казал. <b>Текстовете са генерирани от изкуствен интелект, без човешка редакция, и може да съдържат грешки.</b> Затова всяко твърдение води към материала, от който е взето, и показваме колко и какви медии потвърждават всяка история.</p>
<p>Правилата, които изкуственият интелект спазва: всяко твърдение има източник; никой не се представя за виновен без окончателна присъда; не се назовават деца, пострадали, свидетели и заподозрени, които не са публични личности; не се цитират числа от социологически проучвания. При история, която засяга дете или пострадал от сексуално или домашно насилие, не показваме заглавията и видеата на медиите. В деня преди изборите и в изборния ден не показваме проучвания и партийни канали (Изборен кодекс, чл. 182 и 205).</p>
<p>„Тежестта“ на източниците и „Досието на медиите“ са автоматична статистика по проверими признаци, а не оценка на медиите. Описанията на това как медиите представят една история казват само какво подчертават заглавията им.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Поправки, премахване и отговор</h2>
<p>Ако нещо е невярно, назовава човек, който не бива да бъде назован, или е съдържание, което трябва да махнем, пиши на ${mail} с връзката към страницата. Отговаряме до 24 часа; невярното поправяме или махаме, а поправките записваме в <a href="/corrections/">дневника на поправките</a>.</p>
<p>Всеки, когото една история засяга — включително кандидати и партии по време на избори (Изборен кодекс, чл. 188), — може да изпрати отговор. Публикуваме го незабавно, на страницата на историята, без коментар.</p>
<p>Медия, която не иска да бъде четена или да бъде показвана с лого, може да ни пише или просто да го забрани в robots.txt — спираме сами.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Авторски права</h2>
<p>Правата върху материалите, заглавията, видеата и логата принадлежат на техните собственици. Показваме само заглавие и връзка към оригинала, а видеата — чрез официалния плейър на YouTube; не публикуваме текстове на статии. Обобщенията са със свои думи, по фактите от няколко източника.</p>
<p>Четем само сайтове, които позволяват съдържанието им да се анализира автоматично: всеки ден проверяваме техния robots.txt (за целия сайт и за емисията), Content-Signal и TDM резервация (ЗАПСП, чл. 26е, ал. 4) и спираме да четем сайт, който откаже. Сайтове, чиито условия забраняват роботи или извличане на текст, ползваме само със заглавие и връзка, без да отваряме статиите. Текстът на статиите се използва само за анализа и не се пази.</p>
<p>Видеата от YouTube четем през официалния YouTube Data API и ги показваме с официалния плейър на YouTube; за тях важат <a href="https://www.youtube.com/t/terms" rel="noopener" target="_blank">Условията на YouTube</a> и <a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Политиката за поверителност на Google</a>. Видео, отбелязано от YouTube като „за деца“, не вграждаме.</p>
<p>Логата и иконите са на съответните медии и служат само да се разпознае източникът; сайтът не е свързан с тях. Махаме лого при поискване.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Лични данни</h2>
<p><b>За посетителите.</b> Сайтът няма бисквитки, реклами, анализи на посещенията и проследяване. Страниците се доставят от Cloudflare, който обработва IP адреса на всеки посетител, за да ги достави и защити. Кои истории са отворени, кои се следят и дали обясненията са затворени, се пази само в браузъра на посетителя (localStorage) и не се изпраща никъде; може да се изтрие с бутона по-долу. Видео от YouTube се зарежда едва когато бъде пуснато; тогава YouTube (Google) получава данни за посещението по своите правила.</p>
<p><b>За хората в новините.</b> Историите съдържат имена и изявления на хора от публикувани материали. Те се обработват за журналистически цели, за свободата на изразяване и правото на информация (чл. 85 от Регламент (ЕС) 2016/679 и чл. 25з от Закона за защита на личните данни). Текстовете на материалите се обработват от Anthropic като обработващ лични данни. Всеки може да поиска поправка или премахване на ${mail}.</p>
<p><button type="button" class="btn btn-ghost" data-forget>Изтрий какво помни браузърът ми за сайта</button></p>
</div>
</main>
${footer()}
</body>
</html>
`;
}

function correctionsPage(state, now, corrections) {
    const rows = [...corrections]
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map(
            (c) =>
                `<li><time>${esc(c.date)}</time><p>${esc(c.text)}</p>${c.story ? `<a href="/s/${esc(c.story)}/">Историята</a>` : ''}</li>`,
        )
        .join('');
    return `${head({
        title: 'Поправки — live.gazette.bg',
        description: 'Дневник на поправките в live.gazette.bg.',
        canonical: `${SITE_ORIGIN}/corrections/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="corrections" data-version="${state.updatedAt}">
${topbar(state, now)}
<main id="main" class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Поправки</h1>
<p class="lede">Всичко, което сме поправили или махнали след сигнал, с дата. Сигнали: ${CONTACT ? `<a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>` : 'виж „За сайта“'}.</p></header>
<div class="panel"><ul class="item-list corrections-list">${rows || '<li class="quiet">Още няма поправки.</li>'}</ul></div>
</main>
${footer()}
</body>
</html>
`;
}

// ─── Output ─────────────────────────────────────────────────────────────

const HEADERS = `/*
  Strict-Transport-Security: max-age=31536000
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src https://www.youtube-nocookie.com; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cache-Control: public, max-age=60

/state.json
  ! Cache-Control
  Cache-Control: no-cache
/version.json
  ! Cache-Control
  Cache-Control: no-cache
/sw.js
  ! Cache-Control
  Cache-Control: no-cache
/fonts/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`;

const MANIFEST = {
    name: 'live.gazette.bg — какво се случва в България',
    short_name: 'НА ЖИВО',
    description: 'Актуалните новини в България, подредени по това колко се говори за тях.',
    lang: 'bg',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0d12',
    theme_color: '#0b0d12',
    icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
};

const FONTS = [
    ['unbounded-cyrillic-700-normal.woff2', 'unbounded-cyrillic-700.woff2'],
    ['unbounded-latin-700-normal.woff2', 'unbounded-latin-700.woff2'],
];

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// Share pictures: one per story on the page and one for the front page, plus
// the app icons. They are the slow part of a build; `images: false` skips them.
async function writeImages(ranked, outDir) {
    const main = ranked.filter(isMain);
    try {
        const top = main.slice(0, 3).map((r) => ({ title: r.story.title, temp: tempOf(r.heat), level: r.level.id }));
        write(path.join(outDir, 'og', 'home.png'), await homeImage(top));
        for (const r of ranked) {
            const png = await storyImage({
                title: r.story.title,
                level: r.level.id,
                levelLabel: r.level.label,
                temp: tempOf(r.heat),
                outlets: r.trust.outlets,
                videos: videosOf(r.story).length,
                trust: r.trust.label,
            });
            write(path.join(outDir, 'og', `${r.story.id}.png`), png);
        }
        write(path.join(outDir, 'icon-192.png'), await iconPng(192));
        write(path.join(outDir, 'icon-512.png'), await iconPng(512));
        write(path.join(outDir, 'icon-maskable.png'), await iconPng(512, { maskable: true }));
        write(path.join(outDir, 'icon-180.png'), await iconPng(180, { maskable: true }));
    } catch (err) {
        console.warn(`[live] WARN: share images: ${err.message}`);
    }
}

export async function buildSite(state, { now = Date.now(), outDir = OUT_DIR, images = true } = {}) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const policy = loadPolicy();
    REPLIES = policy.replies;
    // Election silence: the pages show no polls and no party channels.
    if (inElectionSilence(policy, now)) {
        state = {
            ...state,
            stories: silenceFilter(state.stories),
            overview: state.overview && {
                ...state.overview,
                lines: state.overview.lines.filter((l) => !POLL.test(l.text)),
            },
            silence: true,
        };
    }
    const ranked = rankStories(state.stories, now);
    write(path.join(outDir, 'index.html'), frontPage(state, ranked, now));
    for (const r of ranked) {
        write(path.join(outDir, 's', r.story.id, 'index.html'), storyPage(state, r, ranked, now));
        // A story merged into this one keeps its address: it points here.
        for (const alias of r.story.aliases ?? []) {
            if (!/^[a-z0-9]{4,16}$/.test(alias)) continue;
            const to = `/s/${r.story.id}/`;
            write(
                path.join(outDir, 's', alias, 'index.html'),
                `<!DOCTYPE html><html lang="bg"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${SITE_ORIGIN}${to}"><meta name="robots" content="noindex"><title>${esc(r.story.title)}</title></head><body><a href="${to}">${esc(r.story.title)}</a></body></html>\n`,
            );
        }
    }
    const urls = ['/', '/about/', '/corrections/', '/sources/', '/media/', ...ranked.map((r) => `/s/${r.story.id}/`)];
    write(
        path.join(outDir, 'sitemap.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE_ORIGIN}${u}</loc></url>`).join('\n')}\n</urlset>\n`,
    );
    write(path.join(outDir, 'sources', 'index.html'), sourcesPage(state, now));
    write(path.join(outDir, 'media', 'index.html'), mediaPage(state, now));
    write(path.join(outDir, 'about', 'index.html'), aboutPage(state, now));
    write(path.join(outDir, 'corrections', 'index.html'), correctionsPage(state, now, policy.corrections));
    // During the silence the published state carries no polls either.
    write(path.join(outDir, 'state.json'), JSON.stringify(state));
    write(path.join(outDir, 'version.json'), JSON.stringify({ updatedAt: state.updatedAt }));
    write(path.join(outDir, '_headers'), HEADERS);
    write(path.join(outDir, 'manifest.webmanifest'), JSON.stringify(MANIFEST, null, 2));
    write(
        path.join(outDir, 'robots.txt'),
        `User-agent: *\nAllow: /\nDisallow: /state.json\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    );
    write(
        path.join(outDir, '404.html'),
        `${head({ title: 'Няма такава страница — live.gazette.bg', description: 'Тази история вече не е актуална.', canonical: `${SITE_ORIGIN}/`, image: `${SITE_ORIGIN}/og/home.png` })}
<body data-version="${state.updatedAt}">${topbar(state, now)}<main id="main" class="wrap narrow"><header class="story-head"><h1>Тази история изстина</h1><p class="lede">За нея отдавна не се пише, затова е махната. Но точно сега се случва друго.</p><p><a class="btn" href="/">Виж какво се случва сега →</a></p></header></main>${footer()}</body></html>\n`,
    );
    for (const f of ['style.css', 'live.js', 'sw.js', 'favicon.svg']) {
        fs.copyFileSync(path.join(HERE, 'site', f), path.join(outDir, f));
    }
    if (ICONS_FOUND.size) fs.cpSync(ICON_DIR, path.join(outDir, 'icons'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'fonts'), { recursive: true });
    for (const [from, to] of FONTS) {
        fs.copyFileSync(require.resolve(`@fontsource/unbounded/files/${from}`), path.join(outDir, 'fonts', to));
    }
    if (images) await writeImages(ranked, outDir);
}

if (isMainModule(import.meta.url)) {
    const file = process.argv[2] ?? path.join(ROOT, '.live-state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = Date.now();
    await buildSite(state);
    console.log(`Built ${OUT_DIR} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
