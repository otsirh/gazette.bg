#!/usr/bin/env node
// Builds live.gazette.bg from the state.
//
// The page answers three questions in this order: what is happening (the
// brief), what is hottest (temperature, colour, size), and can I trust it
// (who carries it, who said it first). A story page then lets you hear the
// people themselves, and see who said what.
// Every value from a feed or the model is escaped.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain as isMainModule } from '../scripts/lib/cli.js';
import { isWebUrl } from './lib/feeds.js';
import { homeImage, iconPng, storyImage } from './lib/og.js';
import { placeOf } from './lib/places.js';
import { inElectionSilence, isPollStory, loadPolicy, POLL, silenceFilter } from './lib/policy.js';
import { publicState } from './lib/seal.js';
import { IMPORTANT, lastAt, originOf, rankStories, scoreStories, sparkline, storyWeight } from './lib/stories.js';
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
const ASSET_VERSION = '34';

const shortHash = (t) => createHash('sha1').update(String(t)).digest('base64url').slice(0, 8);

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
const fmtDate = sofia({ day: 'numeric', month: 'long', year: 'numeric' });
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
// A name with a number in it reads like a time („24 часа · преди 26 мин“):
// it goes in quotes.
const displayName = (id) => {
    const name = (SOURCE_BY_ID.get(id)?.name ?? id).replace(/ \(видео\)$/, '');
    return /\d/.test(name) && !/[„"]/.test(name) ? `„${name}“` : name;
};
const sourceLabel = (id) => esc(displayName(id));
// An outlet's headline, or, where a story touches a child or a victim and the
// headline is withheld, just whose material it is.
const itemTitle = (it) => it.title || `Публикация на ${displayName(it.source)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── What kind of voice a source is ─────────────────────────────────────

const KINDS = {
    first: {
        one: 'от първа ръка',
        many: 'от първа ръка',
        title: 'От първа ръка',
        long: 'От първа ръка – самата институция или човекът казват това',
    },
    public: {
        one: 'обществена медия',
        many: 'обществени медии',
        long: 'Обществена медия или агенция (БНТ, БНР, БТА)',
    },
    editorial: { one: 'частна медия', many: 'частни медии', long: 'Частна медия с редакция и известен собственик' },
    independent: {
        one: 'автор на своя страница',
        many: 'автори на свои страници',
        long: 'Автор на своя страница – известен човек, без редакция',
    },
    partisan: {
        one: 'канал на партия',
        many: 'канала на партии',
        title: 'Канали на партии',
        long: 'Канал на партия – мнението на партията, не проверен факт',
    },
    unverified: {
        one: 'сайт с неясен собственик',
        many: 'сайта с неясен собственик',
        title: 'Сайтове с неясен собственик',
        long: 'Сайт, за който не знаем кой стои зад него, или текст без автор',
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
    up: { sym: '▲', label: 'пишат все повече' },
    steady: { sym: '●', label: 'пишат все така' },
    down: { sym: '▼', label: 'пишат все по-малко' },
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
    return `<span class="temp heat-${r.level.id}" title="Колко медии пишат за новината сега (градусите не са времето навън)"><b>${tempOf(r.heat)}°</b></span>`;
}

// On a card: only which way it is going. The level ("Гореща") is the group
// the card sits in, and the details are on the story page.
function cardTrend(r) {
    const t = TREND[r.trend];
    return `<span class="trend trend-${r.trend}">${t.sym} ${esc(t.label)}</span>`;
}

function chips(r, now) {
    const t = TREND[r.trend];
    const lastHour = r.story.items.filter((i) => now - i.at < HOUR).length;
    return `<span class="lvl heat-${r.level.id}">${esc(r.level.label)}</span><span class="trend trend-${r.trend}">${t.sym} ${esc(t.label)}</span>${lastHour ? `<span class="fresh">+${plural(lastHour, 'публикация', 'публикации')} за последния час</span>` : ''}`;
}

const videosOf = (story) =>
    story.items
        .filter((i) => i.kind === 'video' && !i.forKids && /^[\w-]{6,20}$/.test(i.videoId ?? ''))
        .sort((a, b) => b.at - a.at);

const thumb = (videoId) => `https://i.ytimg.com/vi/${esc(videoId)}/mqdefault.jpg`;

const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
};

// ─── Page frame ─────────────────────────────────────────────────────────

// JSON inside <script>: a "<" in a headline must not end the element.
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function head({ title, description, canonical, image, ld = null, noindex = false }) {
    return `<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />${noindex ? '\n    <meta name="robots" content="noindex" />' : ''}
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
    <link rel="alternate" type="application/rss+xml" title="live.gazette.bg" href="/rss.xml" />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/unbounded-cyrillic-700.woff2" crossorigin />
    <link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}" />
    <script type="module" src="/live.js?v=${ASSET_VERSION}"></script>
    ${ld ? jsonLd(ld) : ''}
</head>`;
}

// A page that never changes (a remembered story) shows no update time.
function topbar(state, now, { status = true } = {}) {
    return `<header class="topbar">
    <div class="wrap topbar-inner">
        <a class="skip" href="#main">Към съдържанието</a>
        <a class="brand" href="/"><span class="live-dot" aria-hidden="true"></span><span class="brand-live">НА ЖИВО</span><span class="brand-name">live.gazette.bg</span></a>
        ${status ? `<span class="status" data-status>проверено ${timeEl(state.updatedAt || now, now, true)}</span>` : '<span class="status"></span>'}
    </div>
</header>`;
}

function footer() {
    return `<footer class="footer">
    <div class="wrap footer-inner">
        <div class="footer-brand"><span class="live-dot" aria-hidden="true"></span> live.gazette.bg</div>
        <ul class="legend">${KIND_ORDER.map((k) => `<li><i class="kd k-${k}"></i>${esc(KINDS[k].long)}</li>`).join('')}</ul>
        <p>Текстовете тук не ги пише журналист: пише ги компютърна програма с изкуствен интелект (Claude на фирмата Anthropic) по публикациите на ${SOURCES.length} медии и институции. Може да сбърка. Всяко твърдение води към публикацията, от която е взето – проверявай там.</p>
        <p><a href="/about/">За сайта, поправки и поверителност</a> · <a href="/corrections/">Поправки</a> · <a href="/sources/">Източници и как се оценяват</a></p>
    </div>
</footer>`;
}

// ─── Front page ─────────────────────────────────────────────────────────

// data-step: when the story last gained a step in its timeline, a real new
// development; a new article retelling what is known does not count.
function cardData(r) {
    const s = r.story;
    const step = Math.max(0, ...s.timeline.map((e) => e.at));
    return `data-story="${esc(s.id)}" data-first="${Math.min(...s.items.map((i) => i.at))}" data-last="${lastAt(s)}" data-step="${step}" data-weight="${storyWeight(s) ?? ''}" data-level="${r.level.id}" data-trust="${r.trust.id}" data-video="${videosOf(s).length ? 1 : 0}"`;
}

const WEIGHT_LABEL = (w) => (w >= IMPORTANT ? 'Голяма' : w >= 3 ? 'Средна' : 'Малка');

function weightStat(s) {
    const w = storyWeight(s);
    if (w === null) return '';
    return stat(
        'Тежест',
        `<span class="stat-weight${w >= IMPORTANT ? ' big' : ''}">${WEIGHT_LABEL(w)}</span><small>${s.weight.why ? `${esc(s.weight.why)} · ` : ''}колко засяга хората, не колко се пише</small>`,
    );
}

// Why an important story matters, in a line under its summary.
function whyLine(s) {
    const w = storyWeight(s);
    if (w === null || w < IMPORTANT || !s.weight.why) return '';
    return `<span class="card-why"><span aria-hidden="true">⚖</span> ${esc(s.weight.why)}</span>`;
}

function cardMeta(r) {
    const s = r.story;
    const videos = videosOf(s).length;
    return [
        `<span>${plural(r.trust.outlets, 'медия', 'медии')}</span>`,
        videos ? `<span class="has-video">▶ ${plural(videos, 'видео', 'видеа')}</span>` : '',
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
            <span class="card-top">${tempBadge(r)}${cardTrend(r)}<span class="ago">${timeEl(lastAt(s), now, true)}</span></span>
            <h3 class="card-title">${esc(s.title)}</h3>
            ${s.summary ? `<span class="card-summary">${esc(s.summary)}</span>` : ''}
            ${whyLine(s)}
            <span class="card-foot"><span class="meta">${cardMeta(r)}</span></span>
        </span>
    </a>
</li>`;
}

function heroBlock(state, ranked, mainCount, now) {
    const byId = new Map(ranked.map((r) => [r.story.id, r]));
    // Hottest first, like the rest of the page.
    const lines = (state.overview?.lines ?? [])
        .filter((l) => byId.has(l.story))
        .sort((a, b) => byId.get(b.story).heat - byId.get(a.story).heat);
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
              )}</ol>${lines.length > 3 ? `<button type="button" class="brief-more" data-brief-more>Още ${plural(lines.length - 3, 'новина', 'новини')} ↓</button>` : ''}`
        : '';
    return `<section class="hero" aria-labelledby="hero-title">
    <p class="hero-kicker"><span class="live-dot" aria-hidden="true"></span>${esc(fmtLongDay.format(now))}</p>
    <h1 id="hero-title" class="hero-title">Какво се случва<br>в България сега</h1>
    <p class="hero-stats"><span><b>${mainCount}</b> ${mainCount === 1 ? 'новина сега' : 'новини сега'}</span><span><b class="t-hot">${hot}</b> ${hot === 1 ? 'гореща' : 'горещи'}</span><span><b>${outletsToday}</b> ${outletsToday === 1 ? 'медия' : 'медии'} днес</span></p>
    <p class="hero-note"><b class="t-hot">°</b> Градусите показват колко се пише за новината сега, а не времето навън.</p>
    ${brief}
</section>`;
}

function welcomeBlock() {
    // Shown by live.js on a first visit only.
    return `<details class="welcome" data-welcome hidden>
    <summary><span>Нов си тук? <b>Как се чете страницата</b></span></summary>
    <ul class="welcome-points">
        <li><span class="wp-icon wp-hot">87°</span><span><b>Горещото е отгоре.</b> Градусите не са времето навън: колкото повече медии пишат за новината, толкова повече градуса. Щом спрат, новината изстива и изчезва.</span></li>
        <li><span class="wp-icon wp-ok">✓</span><span><b>Знаеш на кого да вярваш.</b> Кой пръв е съобщил новината, колко медии я потвърждават и какви са.</span></li>
        <li><span class="wp-icon wp-vid">▶</span><span><b>Чуваш хората сами.</b> Видеата от телевизиите, институциите и партиите, на едно място.</span></li>
    </ul>
    <button type="button" class="btn" data-welcome-close>Ясно, затвори</button>
</details>`;
}

function justIn(ranked, now) {
    // An item without its own headline (a protected story) shows the story's.
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
                `<li><a href="/s/${esc(r.story.id)}/"><span class="ji-meta">${srcMark(it.source)}${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} · ${timeEl(it.at, now, true)}</span><span class="ji-title">${esc(it.title?.trim() ? itemTitle(it) : r.story.title)}</span></a></li>`,
        )
        .join('')}</ol>
</section>`;
}

function howBox() {
    return `<section class="rail-box how" aria-labelledby="how">
    <h2 id="how" class="rail-title">Как се чете страницата</h2>
    <p><b class="t-hot">87°</b> Градусите показват колко медии пишат за новината сега, не времето навън. Щом спрат да пишат, градусите падат; нощем, когато почти никой не пише, падат бавно.</p>
    <p><span class="cov cov-mini"><span class="cov-bar"><i class="k-first" style="flex:1"></i><i class="k-public" style="flex:1"></i><i class="k-editorial" style="flex:3"></i><i class="k-independent" style="flex:1"></i><i class="k-partisan" style="flex:1"></i><i class="k-unverified" style="flex:1"></i></span></span>Цветната лента показва кой пише: от първа ръка, обществени медии, частни медии, автори на свои страници, канали на партии, сайтове с неясен собственик.</p>
    <p><b class="t-weight">⚖ Засяга много хора</b>: вече приет закон или правило, пари от държавата или общината, последици за дълго. Не зависи от това колко се пише.</p>
    <p>Щом с <kbd>Tab</kbd> стигнеш до новина: <kbd>J</kbd> <kbd>K</kbd> – следваща и предишна, <kbd>Enter</kbd> – отвори.</p>
    <p><a href="/sources/">Всички ${SOURCES.length} източника →</a></p>
</section>`;
}

const isMain = (r) => r.trust.outlets >= 2 || r.trust.firstHand;

function frontPage(state, ranked, now) {
    const main = ranked.filter(isMain);
    const hot = main.filter((r) => r.level.id === 'hot');
    // Important, and not among the loudest: what a page ordered by noise
    // would bury. Shown once, here, and not again lower down.
    const quiet = main
        .filter((r) => r.level.id !== 'hot' && (storyWeight(r.story) ?? 0) >= IMPORTANT)
        .sort((a, b) => storyWeight(b.story) - storyWeight(a.story) || b.heat - a.heat)
        .slice(0, 6);
    const inQuiet = new Set(quiet.map((r) => r.story.id));
    const warm = main.filter((r) => r.level.id === 'warm' && !inQuiet.has(r.story.id));
    const groups = [];
    if (hot.length) {
        groups.push(`<section class="group" aria-labelledby="g-hot"><h2 id="g-hot" class="group-title t-hot">Горещо <span>за това се пише най-много сега</span></h2>
<ol class="cards cards-big">${(() => {
            const wide = wideCards(hot.map((r) => videosOf(r.story).length > 0));
            return hot.map((r, i) => storyCard(r, now, { big: true, wide: wide[i] })).join('');
        })()}</ol></section>`);
    }
    if (quiet.length) {
        groups.push(`<section class="group" aria-labelledby="g-quiet"><h2 id="g-quiet" class="group-title t-weight">Тихо, но важно <span>засяга много хора, а се пише малко</span></h2>
<ol class="cards">${quiet.map((r) => storyCard(r, now)).join('')}</ol></section>`);
    }
    if (warm.length) {
        groups.push(`<section class="group" aria-labelledby="g-warm"><h2 id="g-warm" class="group-title t-warm">Още новини <span>пише се за тях, но не колкото за горещите</span></h2>
<ol class="cards">${warm.map((r) => storyCard(r, now)).join('')}</ol></section>`);
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
${state.silence ? '<p class="silence">Изборен ден: до края на гласуването не показваме социологически проучвания и партийни канали (Изборен кодекс, чл. 182 и 205).</p>' : ''}
${heroBlock(state, ranked, hot.length + quiet.length + warm.length, now)}
${welcomeBlock()}
<div class="since" data-since hidden></div>
<div class="layout">
    <div class="feed">
        ${body}
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
    return `<section class="group more-stories" aria-labelledby="more"><h2 id="more" class="group-title t-hot">Още за това се пише сега</h2>
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

// A cold story (no longer on the front page) keeps its page while it is in
// the state, so a link someone shared still works; it is not indexed, and it
// borrows the site's picture, since its own is no longer made.
function storyPage(state, r, ranked, now, { cold = false } = {}) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    const url = `${SITE_ORIGIN}/s/${s.id}/`;
    const blocks = {
        videos: videoBlock(s, now),
    };
    const originStat = origin
        ? stat(
              'Пръв написа',
              `${esc(origin.name)}<small>${timeEl(origin.at, now)}${origin.via && sourceLabel(origin.via) !== esc(origin.name) ? ` · по материал на ${sourceLabel(origin.via)}` : ''}${origin.words ? ` · по думите на ${esc(origin.words)}` : ''}</small>`,
          )
        : '';
    const image = cold ? `${SITE_ORIGIN}/og/home.png` : `${SITE_ORIGIN}/og/${s.id}.png`;
    return `${head({
        title: `${s.title} — live.gazette.bg`,
        description: s.summary || s.title,
        canonical: url,
        noindex: cold,
        ld: {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline: s.title.slice(0, 110),
            description: s.summary || s.title,
            datePublished: new Date(Math.min(...s.items.map((i) => i.at))).toISOString(),
            dateModified: new Date(lastAt(s)).toISOString(),
            inLanguage: 'bg',
            mainEntityOfPage: url,
            image: [image],
            author: { '@type': 'Organization', name: 'live.gazette.bg', url: `${SITE_ORIGIN}/about/` },
            publisher: { '@type': 'Organization', name: 'live.gazette.bg', url: `${SITE_ORIGIN}/` },
            isBasedOn: s.items.slice(0, 30).map((i) => i.url),
            ...(placeOf(s.place) ? { contentLocation: { '@type': 'Place', name: placeOf(s.place).name } } : {}),
        },
        // A new headline is a new picture for the networks that cache them.
        image: cold ? image : `${image}?v=${shortHash(s.title)}`,
    })}
<body class="story heat-${r.level.id}" data-version="${state.updatedAt}" ${cardData(r)}>
${topbar(state, now)}
<main id="main" class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
${cold ? '<p class="cold-note">Тази новина изстина: за нея вече почти не се пише и я няма на началната страница. Страницата остава, за да работят споделените линкове.</p>' : ''}
<header class="story-head">
    <div class="card-top">${tempBadge(r)}${chips(r, now)}</div>
    <h1>${esc(s.title)}</h1>
    ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
    <p class="ai-note">Написано автоматично от изкуствен интелект по ${plural(s.items.length, 'публикация', 'публикации')} на ${plural(r.trust.outlets, 'медия', 'медии')}. Може да има грешки: всяко твърдение води към публикацията, от която е взето, проверявай там. <a href="/about/">Как работи</a></p>
    <dl class="stats">
        ${stat('Може ли да се вярва', `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>${coverageBar(s, { legend: true })}`)}
        ${originStat}
        ${stat('Пишат', `${plural(r.trust.outlets, 'медия', 'медии')}<small>${plural(s.items.length, 'публикация', 'публикации')}${videos ? `, от тях ${plural(videos, 'видео', 'видеа')}` : ''}</small>`)}
        ${weightStat(s)}
        ${stat('Колко се пише', `<span class="stat-temp heat-${r.level.id}">${tempOf(r.heat)}°</span>${sparkSvg(sparkline(s, now))}<small>колкото повече медии пишат сега, толкова повече градуса; стълбчетата са последните 48 часа</small>`)}
    </dl>
</header>
${blocks.videos}
${repliesBlock(s)}
${sourcesBlock(s, now)}
${moreBlock(r, ranked, now)}
</main>
${footer()}
</body>
</html>
`;
}

// A story that has left the state is remembered for a while with its title
// and summary only: its address shows that much, so a shared link never
// ends in "not found" while the site still knows what it was. The page is
// the same on every update (no update time, no other stories, no polling),
// so it is uploaded once, not on every update.
function memoryPage(m) {
    const url = `${SITE_ORIGIN}/s/${m.id}/`;
    return `${head({
        title: `${m.title} — live.gazette.bg`,
        description: m.summary || m.title,
        canonical: url,
        image: `${SITE_ORIGIN}/og/home.png`,
        noindex: true,
    })}
<body class="story" data-static>
${topbar({}, m.at, { status: false })}
<main id="main" class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<p class="cold-note">Тази новина е от ${esc(fmtDate.format(m.at))}. Вече не се следи и подробностите ѝ не се пазят: тук е само обобщението ѝ.</p>
<header class="story-head">
    <h1>${esc(m.title)}</h1>
    ${m.summary ? `<p class="lede">${esc(m.summary)}</p>` : ''}
    <p class="ai-note">Написано автоматично от изкуствен интелект. <a href="/about/">Как работи</a></p>
    <p><a class="btn" href="/">Виж какво се случва сега →</a></p>
</header>
</main>
${footer()}
</body>
</html>
`;
}

// The stories on the page as a feed, the ones that changed last first: for
// readers and apps that follow sites by RSS.
function rssFeed(state, ranked, now) {
    const stories = ranked
        .filter(isMain)
        .sort((a, b) => lastAt(b.story) - lastAt(a.story))
        .slice(0, 40);
    const items = stories
        .map((r) => {
            const s = r.story;
            const url = `${SITE_ORIGIN}/s/${s.id}/`;
            return `<item><title>${esc(s.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(lastAt(s)).toUTCString()}</pubDate><description>${esc(s.summary || s.title)}</description></item>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>live.gazette.bg — какво се случва в България сега</title>
<link>${SITE_ORIGIN}/</link>
<description>Актуалните новини в България, подредени по това колко се говори за тях. Обобщено автоматично с изкуствен интелект.</description>
<language>bg</language>
<lastBuildDate>${new Date(state.updatedAt || now).toUTCString()}</lastBuildDate>
${items}
</channel></rss>
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
<p><b>„Потвърдено“</b> значи: има първоизточник (институцията говори сама или медия съобщава какво е обявила) и още една медия, която пише от свое име, или поне три такива медии, сред които агенция или обществена медия. Медия, която само преразказва друга („според БТА“), разпространява новината, но не я потвърждава; интервю е мнение, не потвърден факт. Ако източниците си противоречат за съществен факт, историята не е „Потвърдено“, докато спорът не се разреши.</p>
<p><b>Кого четем.</b> Източник влиза, ако го позволява законът (robots.txt, условията за ползване), ако някой отговаря за него (известен собственик или автор с име), ако редовно пише за България и ако е активен. Не четем източник, за който независима проверка е установила дезинформация или разпространение на санкционирани медии, нито такъв, който системно използва език на омразата, обиди, внушения без доказателства, клюки или скрита реклама. Политическата позиция, шумните заглавия и малката аудитория не са причина да махнем някого — те влияят само на тежестта му.</p>
<p><b>Нажежеността</b> (°) расте с всяка медия, която пише по историята; още материали от същата медия добавят все по-малко, така че шумът на една медия не прави история гореща. Пада наполовина за около 6 часа новини: през деня — за около 6 часа, а нощем, когато почти никой не пише, часовникът почти спира. Горещи са най-много 10 истории наведнъж. Щом за една история спре да се пише, тя изстива и изчезва.</p>
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
<p class="lede">live.gazette.bg показва какво се случва в България сега: новините от ${SOURCES.length} източника, подредени по това колко се говори за тях, с първоизточника и видеата.</p></header>
<div class="prose panel">
<h2 class="panel-title">Кой стои зад сайта</h2>
${operator}
<p>Сайтът няма реклами, не взима пари и няма абонамент.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Как работи</h2>
<p>На всеки 10 минути през деня и на всеки 30 през нощта сайтът чете публичните емисии (RSS) на медиите и YouTube каналите от <a href="/sources/">списъка с източници</a>. Изкуствен интелект (Claude на Anthropic) подрежда материалите в истории и пише кратко обобщение. <b>Текстовете са генерирани от изкуствен интелект, без човешка редакция, и може да съдържат грешки.</b> Затова всяко твърдение води към материала, от който е взето, и показваме колко и какви медии потвърждават всяка история.</p>
<p>Правилата, които изкуственият интелект спазва: всяко твърдение има източник; никой не се представя за виновен без окончателна присъда; не се назовават деца, пострадали, свидетели и заподозрени, които не са публични личности; не се цитират числа от социологически проучвания. При история, която засяга дете или пострадал от сексуално или домашно насилие, не показваме заглавията и видеата на медиите. В деня преди изборите и в изборния ден не показваме проучвания и партийни канали (Изборен кодекс, чл. 182 и 205).</p>
<p>„Тежестта“ на източниците е автоматична статистика по проверими признаци, а не оценка на медиите. Описанията на това как медиите представят една история казват само какво подчертават заглавията им.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Поправки, премахване и отговор</h2>
<p>Ако нещо е невярно, назовава човек, който не бива да бъде назован, или е съдържание, което трябва да махнем, пиши на ${mail} с връзката към страницата. Отговаряме до 24 часа; невярното поправяме или махаме, а поправките записваме в <a href="/corrections/">дневника на поправките</a>.</p>
<p>Всеки, когото една история засяга — включително кандидати и партии по време на избори (Изборен кодекс, чл. 188), — може да изпрати отговор. Публикуваме го до 24 часа, на страницата на историята, без коментар.</p>
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
<p><b>За посетителите.</b> Сайтът няма бисквитки, реклами, анализи на посещенията и проследяване. Страниците се доставят от Cloudflare, който обработва IP адреса на всеки посетител, за да ги достави и защити. Кои истории са отворени, кои се следят и дали обясненията са затворени, се пази само в браузъра на посетителя (localStorage) и не се изпраща никъде; може да се изтрие с бутона по-долу. Картинките на видеата се зареждат от сървъра за изображения на YouTube (i.ytimg.com), който вижда IP адреса на посетителя; самото видео се зарежда едва когато бъде пуснато, и тогава YouTube (Google) получава данни за посещението по своите правила.</p>
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
/icons/*
  ! Cache-Control
  Cache-Control: public, max-age=604800
/style.css
  ! Cache-Control
  Cache-Control: public, max-age=86400
/live.js
  ! Cache-Control
  Cache-Control: public, max-age=86400
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
            const png = await storyImage({ title: r.story.title });
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
    // A sensitive story's headlines, pictures and videos are never on a page,
    // and the published state carries them sealed.
    state = publicState(state);
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
    // Every story in the state has a page, the cold ones too; then every
    // remembered one. An address, once shared, keeps working.
    const shown = new Set(ranked.map((r) => r.story.id));
    const cold = scoreStories(state.stories, now).filter((r) => !shown.has(r.story.id));
    const built = new Set();
    for (const r of [...ranked, ...cold]) {
        built.add(r.story.id);
        write(
            path.join(outDir, 's', r.story.id, 'index.html'),
            storyPage(state, r, ranked, now, { cold: !shown.has(r.story.id) }),
        );
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
    for (const r of [...ranked, ...cold]) for (const a of r.story.aliases ?? []) built.add(a);
    for (const m of state.memory ?? []) {
        if (built.has(m.id) || !/^[a-z0-9]{4,16}$/.test(m.id) || !m.title) continue;
        // During an election silence, nothing about polls, here either.
        if (state.silence && isPollStory(m)) continue;
        built.add(m.id);
        write(path.join(outDir, 's', m.id, 'index.html'), memoryPage(m));
    }
    write(path.join(outDir, 'rss.xml'), rssFeed(state, ranked, now));
    const urls = ['/', '/about/', '/corrections/', '/sources/', ...ranked.map((r) => `/s/${r.story.id}/`)];
    write(
        path.join(outDir, 'sitemap.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE_ORIGIN}${u}</loc></url>`).join('\n')}\n</urlset>\n`,
    );
    // The media dossier was removed; an old link leads to the front page.
    write(
        path.join(outDir, 'media', 'index.html'),
        `<!DOCTYPE html><html lang="bg"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=/"><link rel="canonical" href="${SITE_ORIGIN}/"><meta name="robots" content="noindex"><title>live.gazette.bg</title></head><body><a href="/">live.gazette.bg</a></body></html>\n`,
    );
    write(path.join(outDir, 'sources', 'index.html'), sourcesPage(state, now));
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
        `${head({ title: 'Няма такава страница — live.gazette.bg', description: 'Тази новина вече не е актуална.', canonical: `${SITE_ORIGIN}/`, image: `${SITE_ORIGIN}/og/home.png` })}
<body data-version="${state.updatedAt}">${topbar(state, now)}<main id="main" class="wrap narrow"><header class="story-head"><h1>Тази новина изстина</h1><p class="lede">За нея отдавна не се пише, затова е махната. Но точно сега се случва друго.</p><p><a class="btn" href="/">Виж какво се случва сега →</a></p></header></main>${footer()}</body></html>\n`,
    );
    for (const f of ['style.css', 'live.js', 'favicon.svg']) {
        fs.copyFileSync(path.join(HERE, 'site', f), path.join(outDir, f));
    }
    write(
        path.join(outDir, 'sw.js'),
        fs.readFileSync(path.join(HERE, 'site', 'sw.js'), 'utf8').replace('__ASSET_VERSION__', ASSET_VERSION),
    );
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
