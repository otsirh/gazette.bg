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
import { addContributions, lastAt, originOf, rankStories, sparkline, spreadTree } from './lib/stories.js';
import { outletOf, SOURCE_BY_ID, SOURCES, tierOf } from './sources.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const OUT_DIR = path.join(ROOT, 'dist-live');
export const SITE_ORIGIN = 'https://live.gazette.bg';
const HOUR = 3600 * 1000;

// Bumped by hand when style.css or live.js change, so browsers fetch them anew.
const ASSET_VERSION = '5';

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

const sourceLabel = (id) => esc(SOURCE_BY_ID.get(id)?.name ?? id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── What kind of voice a source is ─────────────────────────────────────

const KINDS = {
    first: {
        one: 'първоизточник',
        many: 'първоизточника',
        long: 'Първоизточник — институцията или човекът говорят сами',
    },
    public: { one: 'обществена медия', many: 'обществени медии', long: 'Агенция или обществена медия' },
    editorial: { one: 'редакционна медия', many: 'редакционни медии', long: 'Редакционна медия с известен собственик' },
    partisan: { one: 'партиен канал', many: 'партийни канала', long: 'Партиен канал — позиция, не проверен факт' },
    unverified: {
        one: 'непроверен източник',
        many: 'непроверени източника',
        long: 'Непроверен източник или без подпис',
    },
};
const kindCount = (k, n) => `${n} ${n === 1 ? KINDS[k].one : KINDS[k].many}`;
const KIND_ORDER = ['first', 'public', 'editorial', 'partisan', 'unverified'];

function kindOf(sourceId) {
    if (SOURCE_BY_ID.get(sourceId)?.partisan) return 'partisan';
    return ['first', 'first', 'public', 'editorial', 'unverified'][tierOf(sourceId)] ?? 'unverified';
}

const kindDot = (sourceId) => {
    const k = kindOf(sourceId);
    return `<i class="kd k-${k}" title="${esc(KINDS[k].long)}"></i>`;
};

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
    const place = placeOf(r.story.place);
    return `<span class="lvl heat-${r.level.id}">${esc(r.level.label)}</span><span class="trend trend-${r.trend}">${t.sym} ${esc(t.label)}</span>${lastHour ? `<span class="fresh">+${lastHour} за последния час</span>` : ''}${place ? `<span class="place">${ICONS.pin}${esc(place.name)}</span>` : ''}`;
}

const videosOf = (story) =>
    story.items.filter((i) => i.kind === 'video' && /^[\w-]{6,20}$/.test(i.videoId ?? '')).sort((a, b) => b.at - a.at);

const thumb = (videoId) => `https://i.ytimg.com/vi/${esc(videoId)}/mqdefault.jpg`;

const ICONS = {
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zm0-9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>',
};

// ─── Page frame ─────────────────────────────────────────────────────────

function head({ title, description, canonical, image }) {
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
</head>`;
}

function topbar(state, now) {
    return `<header class="topbar">
    <div class="wrap topbar-inner">
        <a class="brand" href="/" aria-label="live.gazette.bg — начало"><span class="live-dot" aria-hidden="true"></span><span class="brand-live">НА ЖИВО</span><span class="brand-name">live.gazette.bg</span></a>
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
        <p>Историите, обобщенията и хронологиите се съставят автоматично с изкуствен интелект (Claude на Anthropic) от ${SOURCES.length} медии, телевизии и официални канала и може да съдържат грешки. Всяко твърдение води към материала, от който е взето.</p>
        <p><a href="/sources/">Източници и как се оценяват</a> · <a href="/media/">Досие на медиите</a></p>
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
    return [
        `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>`,
        `<span>${plural(r.trust.outlets, 'медия', 'медии')}</span>`,
        origin ? `<span class="origin">първо: <b>${esc(origin.name)}</b> ${timeEl(origin.at, now)}</span>` : '',
        videos ? `<span class="has-video">▶ ${videos}</span>` : '',
        r.trust.disputed ? '<span class="has-dispute">⚠ противоречия</span>' : '',
    ]
        .filter(Boolean)
        .join('');
}

function storyCard(r, now, { big = false } = {}) {
    const s = r.story;
    const video = big ? videosOf(s)[0] : null;
    return `<li class="card heat-${r.level.id}${big ? ' big' : ''}${video ? ' with-video' : ''}" ${cardData(r)}>
    <a class="card-link" href="/s/${esc(s.id)}/">
        ${video ? `<span class="card-thumb"><img src="${thumb(video.videoId)}" alt="" loading="lazy" width="320" height="180" /><span class="play" aria-hidden="true">${ICONS.play}</span></span>` : ''}
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
        ? `<ol class="brief">${lines
              .map((l) => {
                  const r = byId.get(l.story);
                  return `<li class="heat-${r.level.id}"><a href="/s/${esc(l.story)}/"><span class="brief-temp">${tempOf(r.heat)}°</span><span class="brief-text">${esc(l.text)}</span></a></li>`;
              })
              .join('')}</ol>`
        : '';
    return `<section class="hero" aria-labelledby="hero-title">
    <p class="hero-kicker"><span class="live-dot" aria-hidden="true"></span>${esc(fmtLongDay.format(now))}</p>
    <h1 id="hero-title" class="hero-title">Какво се случва<br>в България сега</h1>
    <p class="hero-stats"><span><b>${mainCount}</b> актуални истории</span><span><b class="t-hot">${hot}</b> горещи</span><span><b>${outletsToday}</b> медии днес</span><span>обновено ${timeEl(state.updatedAt || now, now, true)}</span></p>
    ${brief}
</section>`;
}

function welcomeBlock() {
    // Shown by live.js on a first visit only.
    return `<section class="welcome" data-welcome hidden aria-label="Как се чете страницата">
    <p class="welcome-title">Тук за минута виждаш какво става в държавата.</p>
    <ul class="welcome-points">
        <li><span class="wp-icon wp-hot">87°</span><span><b>Горещото е отгоре.</b> Колкото повече медии пишат, толкова по-високо. Щом спрат, историята изстива и изчезва.</span></li>
        <li><span class="wp-icon wp-ok">✓</span><span><b>Знаеш на кого да вярваш.</b> Кой я каза първи, колко медии я потвърждават и какви са.</span></li>
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
    ];
    return `<div class="filters" role="toolbar" aria-label="Покажи">${f
        .map(
            ([id, label], i) =>
                `<button type="button" class="filter${i === 0 ? ' on' : ''}" data-filter="${id}"${id === 'mine' ? ' hidden' : ''} aria-pressed="${i === 0}">${label}</button>`,
        )
        .join('')}</div>`;
}

function justIn(ranked, now) {
    const latest = ranked
        .flatMap((r) => r.story.items.map((it) => ({ it, r })))
        .sort((a, b) => b.it.at - a.it.at)
        .slice(0, 14);
    if (!latest.length) return '';
    return `<section class="rail-box" aria-labelledby="justin">
    <h2 id="justin" class="rail-title"><span class="live-dot" aria-hidden="true"></span>Току-що</h2>
    <ol class="justin">${latest
        .map(
            ({ it, r }) =>
                `<li><a href="/s/${esc(r.story.id)}/"><span class="ji-meta">${kindDot(it.source)}${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} · ${timeEl(it.at, now, true)}</span><span class="ji-title">${esc(it.title)}</span></a></li>`,
        )
        .join('')}</ol>
</section>`;
}

function howBox() {
    return `<section class="rail-box how" aria-labelledby="how">
    <h2 id="how" class="rail-title">Как да четеш</h2>
    <p><b class="t-hot">87°</b> Нажеженост: колко се пише сега. Пада наполовина на всеки 6 часа без нови материали.</p>
    <p><span class="cov cov-mini"><span class="cov-bar"><i class="k-first" style="flex:1"></i><i class="k-public" style="flex:1"></i><i class="k-editorial" style="flex:3"></i><i class="k-partisan" style="flex:1"></i><i class="k-unverified" style="flex:1"></i></span></span>Кой отразява историята: първоизточници, обществени и редакционни медии, партийни канали, непроверени.</p>
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
    <svg class="map" viewBox="-20 -20 ${MAP.width + 40} ${MAP.height + 40}" role="img" aria-label="Карта на България с местните истории"><path class="map-land" d="${OUTLINE}"/>${dots}</svg>
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
<ol class="cards cards-big">${hot.map((r) => storyCard(r, now, { big: true })).join('')}</ol></section>`);
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
        : '<p class="empty">Все още няма събрани истории. Първото обновяване идва до 20 минути.</p>';
    const top = main[0];
    return `${head({
        title: 'Какво се случва в България сега — live.gazette.bg',
        description: top
            ? `Сега най-горещо: ${top.story.title}. Всички актуални новини, подредени по това колко се говори за тях, с първоизточника и видеата.`
            : 'Актуалните новини в България, подредени по това колко се говори за тях, с първоизточника и видеата.',
        canonical: `${SITE_ORIGIN}/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="home" data-version="${state.updatedAt}">
${topbar(state, now)}
<main class="wrap">
${welcomeBlock()}
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
                        `<a class="src-chip" href="${href(it.url)}" target="_blank" rel="noopener" title="${esc(it.title)}">${kindDot(it.source)}${sourceLabel(it.source)}</a>`,
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
        return `<div class="hl-group"><h3><i class="kd k-${k}"></i>${esc(KINDS[k].many[0].toUpperCase() + KINDS[k].many.slice(1))}</h3><ul>${list
            .map((it) => `<li><span>${sourceLabel(it.source)}</span>${ext(it.url, esc(it.title))}</li>`)
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
                      .map((e) => `<li>${timeEl(e.at, now)} ${esc(e.what)}</li>`)
                      .join('')}</ul></details>`
                : '';
        return `<li class="voice">
    <div class="voice-head"><span class="avatar" aria-hidden="true">${initials(a.name)}</span><span><b>${esc(a.name)}</b>${a.role ? `<small>${esc(a.role)}</small>` : ''}</span></div>
    <p class="voice-what">${latest.quote ? `<q class="quote">${esc(latest.quote)}</q>` : esc(latest.what)}</p>
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
        const label = `${SOURCE_BY_ID.get(it.source)?.name ?? it.source} · ${when(it.at, now)} — ${it.title}`;
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
    return `<div class="spread-scroll"><svg class="spread-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Как се разпространи новината във времето, медия по медия">${ticks}${laneEls}${links.join('')}${marks.join('')}</svg></div>`;
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
            return `<li><span class="node"><span class="node-src">${kindDot(it.source)}${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} ${timeEl(it.at, now)}</span>${how ? `<span class="node-how">${how}</span>` : ''}${ext(it.url, esc(it.title))}</span>${kids}</li>`;
        })
        .join('')}</ul>`;
}

function spreadBlock(story, now) {
    const svg = spreadSvg(story, now);
    if (!svg) return '';
    return `<section class="panel" aria-labelledby="spread">
    <h2 id="spread" class="panel-title">Как тръгна и как се разнесе <span>всяка точка е материал; линията води към този, когото цитира</span></h2>
    ${svg}
    <details class="tree-details"><summary>Като дърво, с всички заглавия</summary><div class="tree">${treeHtml(spreadTree(story), now)}</div></details>
</section>`;
}

function videoTile(v, now) {
    return `<li class="video">
    <button type="button" class="video-play" data-video="${esc(v.videoId)}" aria-label="Пусни: ${esc(v.title)}">
        <img src="${thumb(v.videoId)}" alt="" loading="lazy" width="320" height="180" />
        <span class="play" aria-hidden="true">${ICONS.play}</span>
    </button>
    <span class="video-title">${ext(v.url, esc(v.title))}</span>
    <span class="video-meta">${kindDot(v.source)}${sourceLabel(v.source)} · ${timeEl(v.at, now)}</span>
</li>`;
}

function videoBlock(story, now) {
    const vids = videosOf(story);
    if (!vids.length) return '';
    return `<section class="panel panel-video" aria-labelledby="videos">
    <h2 id="videos" class="panel-title">▶ Чуйте сами <span>${plural(vids.length, 'видео', 'видеа')}, най-новото първо</span></h2>
    <ul class="videos">${vids
        .slice(0, 4)
        .map((v) => videoTile(v, now))
        .join('')}</ul>
    ${
        vids.length > 4
            ? `<details class="more"><summary>Още ${vids.length - 4} видео</summary><ul class="videos">${vids
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
            return `${sep}<li class="tl tl-${kind}">
    <span class="tl-time">${esc(fmtClock.format(e.at))}</span>
    <span class="tl-body"><b class="tl-who">${esc(e.who)}</b> ${esc(e.what)}${e.quote ? `<q class="quote">${esc(e.quote)}</q>` : ''}${links ? `<span class="tl-src">${links}</span>` : ''}</span>
</li>`;
        });
    return `<section class="panel" aria-labelledby="timeline">
    <h2 id="timeline" class="panel-title">Хронология <span>най-новото отгоре · часът е на материала, който го съобщава</span></h2>
    <ol class="timeline">${rows.join('')}</ol>
</section>`;
}

function sourcesBlock(story, now) {
    const rows = [...story.items]
        .sort((a, b) => a.at - b.at)
        .map(
            (i) =>
                `<li>${timeEl(i.at, now)} ${kindDot(i.source)}<b>${sourceLabel(i.source)}</b>${i.kind === 'video' ? ' ▶' : ''} ${ext(i.url, esc(i.title))}</li>`,
        );
    return `<details class="panel all-items">
    <summary class="panel-title">Всички ${plural(rows.length, 'материал', 'материала')} <span>най-старото първо</span></summary>
    <ul class="item-list">${rows.join('')}</ul>
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

function storyPage(state, r, ranked, now) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    const url = `${SITE_ORIGIN}/s/${s.id}/`;
    const originStat = origin
        ? stat(
              'Първи съобщи',
              `${esc(origin.name)}<small>${timeEl(origin.at, now)}${origin.via ? ` · по ${sourceLabel(origin.via)}` : ''}</small>`,
          )
        : '';
    return `${head({
        title: `${s.title} — live.gazette.bg`,
        description: s.summary || s.title,
        canonical: url,
        image: `${SITE_ORIGIN}/og/${s.id}.png?v=${tempOf(r.heat)}-${r.trust.outlets}`,
    })}
<body class="story heat-${r.level.id}" data-version="${state.updatedAt}" ${cardData(r)}>
${topbar(state, now)}
<main class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head">
    <div class="card-top">${tempBadge(r)}${chips(r, now)}</div>
    <h1>${esc(s.title)}</h1>
    ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
    <div class="actions">
        <button type="button" class="btn" data-share data-share-title="${esc(s.title)}" data-share-url="${url}">${ICONS.share} Сподели</button>
        ${videos ? `<a class="btn btn-ghost" href="#videos">▶ ${plural(videos, 'видео', 'видеа')}</a>` : ''}
        <a class="btn btn-ghost" href="#timeline">Хронология</a>
    </div>
    <dl class="stats">
        ${stat('Достоверност', `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>${coverageBar(s, { legend: true })}`)}
        ${originStat}
        ${stat('Медии', `${r.trust.outlets}<small>${plural(s.items.length, 'материал', 'материала')}${videos ? `, ${videos} видео` : ''}</small>`)}
        ${stat('Нажеженост', `<span class="stat-temp heat-${r.level.id}">${tempOf(r.heat)}°</span>${sparkSvg(sparkline(s, now))}<small>колко се пише, последни 48 ч</small>`)}
    </dl>
    ${r.trust.disputed ? `<p class="disputed"><b>⚠ Спорно:</b> ${esc(r.trust.disputed)}</p>` : ''}
</header>
${contextBlock(s, now)}
${videoBlock(s, now)}
${framingBlock(s, now)}
${actorsBlock(s, now)}
${spreadBlock(s, now)}
${timelineBlock(s)}
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
const outletKind = (o) => kindOf(SOURCE_BY_ID.has(o) ? o : `${o}-yt`);

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
            const k = outletKind(o);
            return `<tr>
    <th scope="row"><i class="kd k-${k}" title="${esc(KINDS[k].long)}"></i>${esc(outletName(o))}</th>
    <td data-v="${t.stories}">${t.stories}</td>
    <td data-v="${pct(t.first, t.stories)}">${t.first}<small>${pct(t.first, t.stories)}%</small></td>
    <td data-v="${Math.round(delay)}">${fmtDelay(delay)}</td>
    <td data-v="${pct(t.attributed, t.items)}"><span class="bar"><i style="width:${pct(t.attributed, t.items)}%"></i></span>${pct(t.attributed, t.items)}%</td>
    <td data-v="${pct(t.own, t.items)}">${pct(t.own, t.items)}%</td>
    <td data-v="${t.citedBy}">${t.citedBy}</td>
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
<main class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Досие на медиите</h1>
<p class="lede">Как всяка медия се държи в новините, които следим: съобщава ли първа, посочва ли откъде знае, цитират ли я другите. Само данни, събирани от ${esc(fmtLongDay.format(since))} насам, без мнение. С всеки ден картината е по-точна.</p></header>
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
<p>Кой какво цитира, определя автоматично изкуствен интелект по текста на материалите и може да греши в отделни случаи. Сортирай с клик върху заглавие на колона.</p>
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
                return `<li>${ext(s.home, `<b>${esc(s.name)}</b>`)}${status} — ${esc(s.why)}</li>`;
            })
            .join('');
        return `<section class="panel"><h2 class="panel-title"><i class="kd k-${k}"></i>${esc(KINDS[k].long)} <span>${list.length}</span></h2><ul class="item-list">${rows}</ul></section>`;
    }).join('\n');
    return `${head({
        title: 'Източници и как се оценяват — live.gazette.bg',
        description: `Кои ${SOURCES.length} медии, телевизии и официални канала чете live.gazette.bg и колко тежи думата на всеки.`,
        canonical: `${SITE_ORIGIN}/sources/`,
        image: `${SITE_ORIGIN}/og/home.png?v=${state.updatedAt}`,
    })}
<body class="sources" data-version="${state.updatedAt}">
${topbar(state, now)}
<main class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Източници и как се оценяват</h1>
<p class="lede">Четем ${SOURCES.length} медии, телевизии и официални канала от всички страни: колкото повече гледни точки, толкова по-ясна картина.</p></header>
<div class="prose panel">
<p><b>Тежестта на източника</b> идва от проверими неща, не от политическата му линия: дали говори самата институция или човек, дали медията отговаря по закон за точността си, дали има известен собственик и подписани материали.</p>
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

// ─── Output ─────────────────────────────────────────────────────────────

const HEADERS = `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cache-Control: public, max-age=60

/state.json
  Cache-Control: no-cache
/version.json
  Cache-Control: no-cache
/fonts/*
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
    const ranked = rankStories(state.stories, now);
    write(path.join(outDir, 'index.html'), frontPage(state, ranked, now));
    for (const r of ranked) write(path.join(outDir, 's', r.story.id, 'index.html'), storyPage(state, r, ranked, now));
    write(path.join(outDir, 'sources', 'index.html'), sourcesPage(state, now));
    write(path.join(outDir, 'media', 'index.html'), mediaPage(state, now));
    write(path.join(outDir, 'state.json'), JSON.stringify(state));
    write(path.join(outDir, 'version.json'), JSON.stringify({ updatedAt: state.updatedAt }));
    write(path.join(outDir, '_headers'), HEADERS);
    write(path.join(outDir, 'manifest.webmanifest'), JSON.stringify(MANIFEST, null, 2));
    write(path.join(outDir, 'robots.txt'), 'User-agent: *\nAllow: /\nDisallow: /state.json\n');
    write(
        path.join(outDir, '404.html'),
        `${head({ title: 'Няма я — live.gazette.bg', description: 'Тази история вече не е актуална.', canonical: `${SITE_ORIGIN}/`, image: `${SITE_ORIGIN}/og/home.png` })}
<body data-version="${state.updatedAt}">${topbar(state, now)}<main class="wrap narrow"><header class="story-head"><h1>Тази история изстина</h1><p class="lede">За нея отдавна не се пише, затова е махната. Но точно сега се случва друго.</p><p><a class="btn" href="/">Виж какво се случва сега →</a></p></header></main>${footer()}</body></html>\n`,
    );
    for (const f of ['style.css', 'live.js', 'favicon.svg']) {
        fs.copyFileSync(path.join(HERE, 'site', f), path.join(outDir, f));
    }
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
