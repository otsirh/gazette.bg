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
import { axisTicks, buckets, contributors, dayStats, flowOf, heatCurve, outletCounts } from './lib/pulse.js';
import { publicState } from './lib/seal.js';
import { heatAt, LEVELS, lastAt, newsClock, rankStories, scoreStories, sparkline, WALL_CLOCK } from './lib/stories.js';
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
const ASSET_VERSION = '41';

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

// Every text the model writes is marked as such where it begins (AI Act,
// Art. 50(4); the Commission's guidelines ask for it on each output, not
// once per site): a tag on each topic and page, and the words in front of
// every summary that travels on its own (RSS, search and share previews).
const AI_TAG =
    '<span class="ai-tag" title="Написано автоматично от изкуствен интелект"><span aria-hidden="true">ИИ</span><span class="sr-only">Написано от изкуствен интелект:</span></span>';
const aiText = (t) => `Обобщено от изкуствен интелект: ${t}`;

// ─── What kind of voice a source is ─────────────────────────────────────

const KINDS = {
    first: {
        one: 'от първа ръка',
        many: 'от първа ръка',
        label: 'От първа ръка',
        title: 'От първа ръка',
        long: 'От първа ръка – самата институция или човекът казват това',
    },
    public: {
        one: 'обществена медия',
        many: 'обществени медии',
        label: 'Обществени медии',
        long: 'Обществена медия или агенция (БНТ, БНР, БТА)',
    },
    editorial: {
        one: 'частна медия',
        many: 'частни медии',
        label: 'Частни медии',
        long: 'Частна медия с редакция и известен собственик',
    },
    independent: {
        one: 'автор на своя страница',
        many: 'автори на свои страници',
        label: 'Автори на свои страници',
        long: 'Журналист на своя страница или малка редакция',
    },
    partisan: {
        one: 'канал на партия',
        many: 'канала на партии',
        label: 'Канали на партии',
        title: 'Канали на партии',
        long: 'Канал на партия – мнението на партията, не проверен факт',
    },
    unverified: {
        // Tier 4. Every source has a known owner (SOURCES-POLICY.md, rule 2),
        // so this says only what anyone can check on the page: the items are
        // mostly unsigned. Never a judgment of the outlet.
        one: 'медия без подписи',
        many: 'медии без подписи',
        label: 'Медии без подписани материали',
        title: 'Медии без подписани материали',
        long: 'Медия с известен собственик, чиито материали обикновено не са подписани',
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

// A video's face before it is played: whose video it is and a play button,
// drawn here. Nothing loads from YouTube (not even its picture, which would
// hand every visitor's address to Google) until the reader presses play.
const videoFace = (v) =>
    `<span class="vface"><span class="vface-src">${sourceLabel(v.source)}</span><span class="play" aria-hidden="true">${ICONS.play}</span><span class="thumb-src">YouTube</span></span>`;

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
        <p><button type="button" class="btn btn-ghost btn-small" data-since-toggle aria-pressed="false">Отбелязвай ми новото от последното посещение (пази се само в браузъра)</button></p>
    </div>
</footer>`;
}

// ─── Front page ─────────────────────────────────────────────────────────
//
// Read top to bottom, it answers: what is happening (the numbers of the
// day), how the news comes in and where it goes (the flow), which topics are
// hot and why (the board), and where it all comes from (the outlets).

// data-step: when the story last gained a step in its timeline, a real new
// development; a new article retelling what is known does not count.
function cardData(r) {
    const s = r.story;
    const step = Math.max(0, ...s.timeline.map((e) => e.at));
    return `data-story="${esc(s.id)}" data-first="${Math.min(...s.items.map((i) => i.at))}" data-last="${lastAt(s)}" data-step="${step}" data-level="${r.level.id}" data-trust="${r.trust.id}" data-video="${videosOf(s).length ? 1 : 0}"`;
}

// The day in one sentence: how much came in, from how many, into how many
// topics, and how many of them are hot.
function heroBlock(state, main, now) {
    const d = dayStats(state.stories, now);
    const shown = main.filter((r) => r.level.id !== 'cool').length;
    const hot = main.filter((r) => r.level.id === 'hot').length;
    let topics = '';
    if (shown === 1) topics = ` Сега се говори най-много за <b>една тема</b>${hot ? ' и тя е гореща' : ''}.`;
    else if (shown > 1) {
        topics = ` Сега се говори най-много за <b>${shown} теми</b>`;
        if (hot === shown) topics += ' и всички са горещи';
        else if (hot === 1) topics += ' – <b>една</b> от тях е гореща';
        else if (hot > 1) topics += ` – <b>${hot}</b> от тях са горещи`;
        topics += '.';
    }
    return `<section class="hero" aria-labelledby="hero-title">
    <h1 id="hero-title" class="hero-title">Какво се случва в България сега</h1>
    ${
        d.items
            ? `<p class="hero-sub">За последните 24 часа: <b>${plural(d.items, 'публикация', 'публикации')}</b> от <b>${plural(d.outlets, 'източник', 'източника')}</b>.${topics} Последната публикация дойде ${timeEl(d.last, now, true)}.</p>`
            : ''
    }
</section>`;
}

// How the news comes in: the newest items on the left, each line running to
// the topic it joined on the right. A dot travels along every line, so the
// page shows what it does: new items keep coming and gather into topics.
const FLOW_ROWS = 8;
const FLOW_TOPICS = 5;

function flowBlock(main, now) {
    const { top, latest } = flowOf(main, now, { rows: FLOW_ROWS, topics: FLOW_TOPICS });
    if (!latest.length) return '';
    // The other topics on the board below; an item may also go to a quieter
    // one that is not on it.
    const others = main.filter((r) => r.level.id !== 'cool').length - top.length;
    const otherNode = others > 0 || latest.some((x) => x.topic < 0);
    const nodes = top.length + (otherNode ? 1 : 0);
    const y = (i, n) => (((i + 0.5) * 100) / n).toFixed(2);
    const levelOfTopic = (t) => (t < 0 ? 'other' : top[t].level.id);
    const lines = latest
        .map((x, i) => {
            const y0 = y(i, latest.length);
            const y1 = y(x.topic < 0 ? top.length : x.topic, nodes);
            return `M0 ${y0} C55 ${y0} 45 ${y1} 100 ${y1}`;
        })
        .map((d, i) => ({ d, lvl: levelOfTopic(latest[i].topic) }));
    const svg = `<svg class="flow-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines
        .map(
            ({ d, lvl }) => `<path class="fl fl-${lvl}" d="${d}" pathLength="100" vector-effect="non-scaling-stroke"/>`,
        )
        .join('')}${lines
        .map(
            ({ d, lvl }, i) =>
                `<path class="fd fl-${lvl}" d="${d}" pathLength="100" vector-effect="non-scaling-stroke" style="animation-delay:${(i * 0.9).toFixed(1)}s"/>`,
        )
        .join('')}</svg>`;
    const inRows = latest
        .map(
            ({ item: it, story, topic }) =>
                `<li class="fi fl-${levelOfTopic(topic)}"><a href="${href(it.url)}" rel="noopener" target="_blank"><span class="fi-meta">${srcMark(it.source)}<b>${sourceLabel(it.source)}</b>${it.kind === 'video' ? ' ▶' : ''}<span class="fi-time"> · ${timeEl(it.at, now, true)}</span></span><span class="fi-title">${esc(it.title?.trim() ? itemTitle(it) : story.title)}</span></a></li>`,
        )
        .join('');
    const topicRows = top
        .map((r) => {
            const lastHour = r.story.items.filter((i) => i.at <= now && now - i.at < HOUR).length;
            return `<li class="fn heat-${r.level.id}"><a href="/s/${esc(r.story.id)}/"><span class="fn-temp">${tempOf(r.heat)}°</span><span class="fn-text"><span class="fn-title">${esc(r.story.title)}</span>${lastHour ? `<span class="fn-in">+${plural(lastHour, 'нова', 'нови')} за час</span>` : ''}</span></a></li>`;
        })
        .join('');
    const other = otherNode
        ? `<li class="fn fn-other"><a href="${others > 0 ? '#topics' : '/'}"><span class="fn-text"><span class="fn-title">Други теми</span>${others > 0 ? `<span class="fn-in">още ${plural(others, 'тема', 'теми')} по-долу</span>` : ''}</span></a></li>`
        : '';
    return `<section class="flow" aria-labelledby="flow-title" style="--rows:${latest.length};--nodes:${nodes}">
    <h2 id="flow-title" class="sec-title"><span class="live-dot" aria-hidden="true"></span>Как влизат новините <span>отляво: най-новите публикации; отдясно: темата, в която отиде всяка</span></h2>
    <div class="flow-grid">
        <ol class="flow-in" aria-label="Най-новите публикации">${inRows}</ol>
        ${svg}
        <ol class="flow-topics" aria-label="Темите, в които отиват">${topicRows}${other}</ol>
    </div>
</section>`;
}

// A day in 24 bars, one an hour, the last one this hour. Every story on the
// board uses the same scale, so a taller bar is really more.
function hourBars(counts, max) {
    const w = 240;
    const h = 40;
    const step = w / counts.length;
    const bars = counts
        .map((c, i) => {
            if (!c) return '';
            const bh = Math.max(2, (c / max) * h);
            return `<rect${i === counts.length - 1 ? ' class="now"' : ''} x="${(i * step + 0.7).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(step - 1.4).toFixed(1)}" height="${bh.toFixed(1)}"/>`;
        })
        .join('');
    const label = `Публикации по часове за последните 24 часа; за последния час: ${counts.at(-1)}`;
    return `<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}"/>${bars}</svg>`;
}

// Who carries the story: the icons of the outlets that make it hot, most
// first.
function outletIcons(r, now, clock, max = 8) {
    const list = contributors(r.story, now, clock);
    const more = list.length - max;
    return `<span class="topic-src" role="img" aria-label="${esc(`Пишат: ${list.map((c) => displayName(c.source)).join(', ')}`)}">${list
        .slice(0, max)
        .map((c) => srcMark(c.source))
        .join('')}${more > 0 ? `<span class="more-n">+${more}</span>` : ''}</span>`;
}

function topicRow(r, now, clock, max, { summary = false } = {}) {
    const s = r.story;
    const counts = sparkline(s, now, 24, HOUR);
    const lastHour = counts.at(-1);
    const vids = videosOf(s).length;
    const temp = tempOf(r.heat);
    const why = [
        `<b>${plural(r.trust.outlets, 'медия', 'медии')}</b>`,
        lastHour ? `<b>+${plural(lastHour, 'нова', 'нови')}</b> за последния час` : '',
        vids ? `▶ ${plural(vids, 'видео', 'видеа')}` : '',
    ].filter(Boolean);
    return `<li class="topic heat-${r.level.id}" ${cardData(r)}>
    <a class="topic-link" href="/s/${esc(s.id)}/">
        <span class="therm" style="--t:${temp}" title="Колко се пише за темата сега (градусите не са времето навън)"><b>${temp}°</b><i aria-hidden="true"><i></i></i></span>
        <span class="topic-body">
            <span class="topic-top">${AI_TAG}${cardTrend(r)}<span class="ago">${timeEl(lastAt(s), now, true)}</span></span>
            <h3 class="topic-title">${esc(s.title)}</h3>
            ${summary && s.summary ? `<span class="topic-summary">${esc(s.summary)}</span>` : ''}
            <span class="topic-why">${why.join('<span class="sep"> · </span>')}</span>
        </span>
        <span class="topic-chart">
            ${hourBars(counts, max)}
            <span class="topic-axis" aria-hidden="true"><span>преди 24 ч</span><span>сега</span></span>
            ${outletIcons(r, now, clock)}
        </span>
    </a>
</li>`;
}

// The same scale for every row on a page.
const barsMax = (rows, now) => Math.max(1, ...rows.map((r) => Math.max(...sparkline(r.story, now, 24, HOUR))));

function boardBlock(main, now, clock) {
    const hot = main.filter((r) => r.level.id === 'hot');
    const warm = main.filter((r) => r.level.id === 'warm');
    const max = barsMax([...hot, ...warm], now);
    const groups = [];
    if (hot.length) {
        groups.push(`<section class="board" aria-labelledby="topics"><h2 id="topics" class="sec-title t-hot">Горещите теми <span>градусите растат с всяка медия, която пише по темата, и падат, когато спрат да пишат; всяко стълбче е един час</span></h2>
<ol class="topics">${hot.map((r) => topicRow(r, now, clock, max, { summary: true })).join('')}</ol></section>`);
    }
    if (warm.length) {
        groups.push(`<section class="board" aria-labelledby="${hot.length ? 'g-warm' : 'topics'}"><h2 id="${hot.length ? 'g-warm' : 'topics'}" class="sec-title t-warm">Още теми <span>пише се за тях, но не колкото за горещите</span></h2>
<ol class="topics topics-small">${warm.map((r) => topicRow(r, now, clock, max)).join('')}</ol></section>`);
    }
    return groups.length
        ? `<div class="feed">${groups.join('\n')}</div>`
        : '<p class="empty">Все още няма събрани теми. Първото обновяване идва до 10 минути.</p>';
}

// Where it all comes from: the outlets that published the most in the last
// day, each with how many items. Plain counts, no judgement of the outlets.
const ORIGIN_MAX = 24;

function originsBlock(stories, now) {
    const outlets = outletCounts(stories, now);
    if (!outlets.length) return '';
    const total = outlets.reduce((a, o) => a + o.count, 0);
    const top = outlets.slice(0, ORIGIN_MAX);
    const max = top[0].count;
    return `<section class="origins" aria-labelledby="origins">
    <h2 id="origins" class="sec-title">Откъде идва информацията <span>${plural(total, 'публикация', 'публикации')} от ${plural(outlets.length, 'източник', 'източника')} за последните 24 часа; тук са тези, които публикуваха най-много</span></h2>
    <ol class="outlets">${top
        .map(
            (o) =>
                `<li>${srcMark(o.source)}<span class="o-name">${sourceLabel(o.source)}</span><span class="o-bar"><i style="width:${((o.count / max) * 100).toFixed(1)}%"></i></span><b class="o-n">${o.count}</b></li>`,
        )
        .join('')}</ol>
    <p class="origins-more"><a href="/sources/">Всички ${SOURCES.length} източника и как ги подбираме →</a></p>
</section>`;
}

const isMain = (r) => r.trust.outlets >= 2 || r.trust.firstHand;

function frontPage(state, ranked, now, clock) {
    const main = ranked.filter(isMain);
    const top = main[0];
    return `${head({
        title: 'Какво се случва в България сега — live.gazette.bg',
        description: top
            ? `Сега най-горещо: ${top.story.title} (заглавие от изкуствен интелект). Всички актуални теми, подредени по това колко се говори за тях, с първоизточника и видеата.`
            : 'Актуалните теми в България, подредени по това колко се говори за тях, с първоизточника и видеата.',
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
${heroBlock(state, main, now)}
<p class="ai-note home-ai">Темите, заглавията и обобщенията им са написани автоматично от изкуствен интелект, без човешка редакция, и може да има грешки. Всяко твърдение води към публикацията, от която е взето. <a href="/about/">Как работи</a></p>
<div class="since" data-since hidden></div>
${flowBlock(main, now)}
${boardBlock(main, now, clock)}
${originsBlock(state.stories, now)}
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
        ${videoFace(v)}
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
    <p class="quiet small yt-note">Видеата са от YouTube и нищо от тях не се зарежда, преди да натиснеш „пусни“; щом пуснеш видео, YouTube (Google) получава данни за посещението и важат <a href="https://www.youtube.com/t/terms" rel="noopener" target="_blank">Условията на YouTube</a> и <a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Политиката за поверителност на Google</a>.</p>
    <ul class="videos">${vids.map((v) => videoTile(v, now)).join('')}</ul>
</section>`;
}

const LIST_MAX = 120;

// The articles everything on the page is taken from, newest first, each
// linked to the outlet's own page: open, to read them and see the source.
function sourcesBlock(story, now) {
    const sorted = story.items.filter((i) => i.kind !== 'video').sort((a, b) => b.at - a.at);
    if (!sorted.length) return '';
    const rows = sorted
        .slice(0, LIST_MAX)
        .map(
            (i) =>
                `<li>${timeEl(i.at, now)} ${srcMark(i.source)}<b>${sourceLabel(i.source)}</b> ${ext(i.url, esc(itemTitle(i)))}</li>`,
        );
    return `<section class="panel all-items" aria-labelledby="articles">
    <h2 id="articles" class="panel-title">Прочети статиите <span>${plural(sorted.length, 'статия', 'статии')}, от които е взето всичко тук; най-новата първа</span></h2>
    <ul class="item-list">${rows.join('')}</ul>
    ${sorted.length > LIST_MAX ? `<p class="quiet small">Показани са последните ${LIST_MAX} от ${sorted.length}.</p>` : ''}
</section>`;
}

// Why the story is as hot as it is, in numbers anyone reads: how many
// outlets, how many items, how many in the last hour, how it changed, and
// who adds the most.
const WHY_TITLE = { hot: 'Защо е гореща', warm: 'Защо се говори за нея', cool: 'Колко се говори за нея' };

function whyBlock(r, ranked, now, clock) {
    const s = r.story;
    const items = s.items.filter((i) => i.at <= now);
    const lastHour = items.filter((i) => now - i.at < HOUR).length;
    const vids = s.sensitive ? 0 : videosOf(s).length;
    const temp = tempOf(r.heat);
    const tiles = [
        [r.trust.outlets, r.trust.outlets === 1 ? 'медия пише по темата' : 'медии пишат по темата'],
        [items.length, items.length === 1 ? 'публикация общо' : 'публикации общо'],
        [`+${lastHour}`, 'за последния час'],
        ...(vids ? [[vids, vids === 1 ? 'видео' : 'видеа']] : []),
    ];
    const first = Math.min(...items.map((i) => i.at));
    let change;
    if (r.trend === 'new') {
        change = `Темата е нова: първата публикация дойде ${timeEl(first, now, true)}.`;
    } else {
        const before = tempOf(heatAt(s, now - 3 * HOUR, clock));
        const how = { up: 'пишат все повече', down: 'пишат все по-малко', steady: 'пишат все така' }[r.trend];
        change = `Преди 3 часа беше <b>${before}°</b>, сега е <b>${temp}°</b>: ${how}.`;
    }
    const lead =
        ranked[0]?.story.id === s.id && r.level.id === 'hot'
            ? '<p class="why-lead">Това е най-горещата тема в момента.</p>'
            : '';
    const list = contributors(s, now, clock);
    const top = list.slice(0, 8);
    const maxShare = top[0]?.share || 1;
    const rest = list.length - top.length;
    return `<section class="panel why" aria-labelledby="why">
    <h2 id="why" class="panel-title">${WHY_TITLE[r.level.id]}</h2>
    ${lead}
    <ul class="why-tiles">${tiles.map(([n, label]) => `<li><b>${n}</b><span>${label}</span></li>`).join('')}</ul>
    <p class="why-change${r.trend === 'up' ? ' up' : ''}">${change}</p>
    ${growthChart(s, now, clock)}
    <div class="contrib">
        <h3 class="sub-title">Кой вдига градусите <span>всяка медия, която пише, добавя градуси; най-много тежат новите публикации</span></h3>
        <ol class="contrib-list">${top
            .map(
                (c) =>
                    `<li>${srcMark(c.source)}<span class="c-name">${sourceLabel(c.source)}</span><span class="c-bar"><i style="width:${Math.max(2, (c.share / maxShare) * 100).toFixed(1)}%"></i></span><span class="c-n">${plural(c.count, 'публикация', 'публикации')}</span></li>`,
            )
            .join('')}</ol>
        ${rest > 0 ? `<p class="quiet small">И още ${plural(rest, 'медия', 'медии')}.</p>` : ''}
    </div>
    <p class="why-trust">Може ли да се вярва: <span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>${coverageBar(s, { legend: true })}</p>
</section>`;
}

// How the story caught fire, from its first item to now: its degrees as a
// line, and under it how many items came out.
const fmtAxisDay = sofia({ day: 'numeric', month: 'long' });

function growthChart(s, now, clock) {
    const items = s.items.filter((i) => i.at <= now);
    if (!items.length) return '';
    const curve = heatCurve(s, now, clock, 120);
    const start = curve[0].at;
    const span = now - start;
    const x = (t) => ((t - start) / span) * 1000;
    const temps = curve.map((p) => tempOf(p.heat));
    const pts = curve.map((p, k) => `${x(p.at).toFixed(1)} ${(100 - temps[k]).toFixed(1)}`);
    const line = `M${pts.join(' L')}`;
    const area = `${line} L1000 100 L0 100 Z`;
    let peak = 0;
    for (let k = 1; k < temps.length; k++) if (temps[k] >= temps[peak]) peak = k;
    // Bars: about one every half hour, between 12 and 72 of them.
    const n = Math.max(12, Math.min(72, Math.round(span / (HOUR / 2))));
    const bs = buckets(items, start, now, n);
    const bmax = Math.max(1, ...bs);
    const bw = 1000 / n;
    const bars = bs
        .map((c, k) => {
            if (!c) return '';
            const h = Math.max(2, (c / bmax) * 58);
            return `<rect x="${(k * bw + bw * 0.12).toFixed(1)}" y="${(60 - h).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}"/>`;
        })
        .join('');
    const pct = (t) => `${((x(t) / 1000) * 100).toFixed(2)}%`;
    const { ticks, step } = axisTicks(start, now, 5);
    const tickLabel = (t) =>
        step >= 24 * HOUR || fmtClock.format(t) === '00:00' ? fmtAxisDay.format(t) : fmtClock.format(t);
    const axis = ticks
        .filter((t) => x(t) > 70 && x(t) < 930)
        .map((t) => `<span style="left:${pct(t)}">${esc(tickLabel(t))}</span>`)
        .join('');
    // The peak is named when it was clearly hotter than now; near the
    // start it takes the start's place, near now it would say the same.
    const peakX = x(curve[peak].at);
    const showPeak = temps[peak] > temps.at(-1) + 3 && peakX < 780;
    const peakLabel = `<b>Най-горещо: ${temps[peak]}°</b>${esc(when(curve[peak].at, now))}`;
    const marks = [
        showPeak && peakX <= 220
            ? `<span class="gm gm-start">${peakLabel}</span>`
            : `<span class="gm gm-start"><b>Начало</b>${esc(when(start, now))}</span>`,
        showPeak && peakX > 220
            ? `<span class="gm gm-peak" style="left:${pct(curve[peak].at)}">${peakLabel}</span>`
            : '',
        `<span class="gm gm-now"><b>Сега: ${temps.at(-1)}°</b>${esc(fmtClock.format(now))}</span>`,
    ].join('');
    const dots = [...(showPeak ? [[peakX, temps[peak], 'peak']] : []), [1000, temps.at(-1), 'now']]
        .map(([px, t, c]) => `<i class="gp gp-${c}" style="left:${(px / 10).toFixed(2)}%;top:${100 - t}%"></i>`)
        .join('');
    return `<figure class="growth">
    <figcaption class="sub-title">Как се разгоря <span>от първата публикация до сега</span></figcaption>
    <div class="growth-marks">${marks}</div>
    <div class="growth-plot" role="img" aria-label="${esc(`Градусите на темата от ${when(start, now)} до сега; най-много ${temps[peak]}°, сега ${temps.at(-1)}°`)}">
        <svg class="growth-heat heat-${tempLevel(temps.at(-1))}" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path class="ga" d="${area}"/><path class="gl" d="${line}" vector-effect="non-scaling-stroke"/></svg>
        ${dots}
    </div>
    <svg class="growth-bars heat-${tempLevel(temps.at(-1))}" viewBox="0 0 1000 60" preserveAspectRatio="none" role="img" aria-label="${esc(`Колко публикации излизаха във времето: ${plural(items.length, 'публикация', 'публикации')} общо`)}">${bars}</svg>
    <div class="growth-axis" aria-hidden="true">${axis}</div>
    <p class="growth-key small"><span class="gk"><i class="gk-line"></i>градуси: колко се пише сега</span><span class="gk"><i class="gk-bar"></i>публикации: колко излизаха</span></p>
</figure>`;
}

// The colour of a temperature, the way the levels colour a story.
const tempLevel = (t) => (t >= tempOf(LEVELS[0].min) ? 'hot' : t >= tempOf(LEVELS[1].min) ? 'warm' : 'cool');

// A quote from the parliament's verbatim record: where it is, and the
// sitting's video.
function recordLinks(e) {
    const parts = [ext(e.url, `🏛 ${esc(e.label || 'Стенограма')}`)];
    if (e.video) parts.push(ext(e.video, '▶ запис на заседанието'));
    return parts.join(' ');
}

const capFirst = (t) => String(t).replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
const fmtLongDay = sofia({ weekday: 'long', day: 'numeric', month: 'long' });

function dayLabel(ms, now) {
    const k = dayKey.format(ms);
    if (k === dayKey.format(now)) return 'Днес';
    if (k === dayKey.format(now - 24 * HOUR)) return 'Вчера';
    return capFirst(fmtLongDay.format(ms));
}

// How the story unfolded, from the first item to now, oldest first. A long
// one keeps its start and its newest steps in view; the middle opens on a tap.
const TL_HEAD = 4;
const TL_TAIL = 8;

function timelineBlock(r, now) {
    const s = r.story;
    const items = s.items.filter((i) => i.at <= now);
    if (!items.length) return '';
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const first = [...items].sort((a, b) => a.at - b.at)[0];
    const steps = [...s.timeline].filter((e) => e.at <= now).sort((a, b) => a.at - b.at);
    const srcLink = (i) =>
        ext(i.url, `${srcMark(i.source)}${sourceLabel(i.source)}${i.kind === 'video' && !s.sensitive ? ' ▶' : ''}`);
    const entries = [
        {
            at: first.at,
            html: `<b class="tl-who">Първата публикация</b>${first.title ? `<span class="tl-what">${ext(first.url, esc(first.title))}</span>` : ''}<span class="tl-src">${srcLink(first)}</span>`,
            cls: 'tl-start',
        },
        ...steps.map((e) => {
            const refs = (e.items ?? []).map((id) => byId.get(id)).filter(Boolean);
            const links = e.source === 'parliament' ? recordLinks(e) : refs.map(srcLink).join('');
            return {
                at: e.at,
                html: `<b class="tl-who">${esc(capFirst(e.who || e.actor || ''))}</b><span class="tl-what">${esc(capFirst(e.what ?? ''))}</span>${e.quote ? `<q class="quote">${esc(e.quote)}</q>` : ''}${links ? `<span class="tl-src">${links}</span>` : ''}`,
                cls: '',
            };
        }),
    ];
    // Each part repeats the day it starts in, so a reader never loses the date.
    const render = (list) => {
        let day = '';
        return list
            .map((e) => {
                const k = dayKey.format(e.at);
                const sep = k !== day ? `<li class="tl-day">${esc(dayLabel(e.at, now))}</li>` : '';
                day = k;
                return `${sep}<li class="tl-step${e.cls ? ` ${e.cls}` : ''}"><time datetime="${new Date(e.at).toISOString()}">${esc(fmtClock.format(e.at))}</time><div class="tl-body">${e.html}</div></li>`;
            })
            .join('');
    };
    const fold = entries.length > TL_HEAD + TL_TAIL + 2;
    const head = fold ? entries.slice(0, TL_HEAD) : entries;
    const middle = fold ? entries.slice(TL_HEAD, -TL_TAIL) : [];
    const tail = fold ? entries.slice(-TL_TAIL) : [];
    const nowRow = `<li class="tl-step tl-now"><time>${esc(fmtClock.format(now))}</time><div class="tl-body"><b class="tl-who">Сега: ${tempOf(r.heat)}°</b><span class="tl-what">${plural(items.length, 'публикация', 'публикации')} от ${plural(r.trust.outlets, 'медия', 'медии')} досега</span></div></li>`;
    return `<section class="panel tl-panel" aria-labelledby="timeline">
    <h2 id="timeline" class="panel-title">Хронология <span>как се разви темата, от началото до сега; часът е на публикацията, която го съобщава</span></h2>
    <ol class="tl">${render(head)}</ol>
    ${fold ? `<details class="tl-fold"><summary>Покажи още ${plural(middle.length, 'стъпка', 'стъпки')}</summary><ol class="tl">${render(middle)}</ol></details><ol class="tl">${render(tail)}</ol>` : ''}
    <ol class="tl tl-end">${nowRow}</ol>
</section>`;
}

function moreBlock(r, ranked, now, clock) {
    const others = ranked.filter((o) => o.story.id !== r.story.id && isMain(o)).slice(0, 4);
    if (!others.length) return '';
    const max = barsMax(others, now);
    return `<section class="board more-stories" aria-labelledby="more"><h2 id="more" class="sec-title t-hot">Още за това се пише сега</h2>
<ol class="topics topics-small">${others.map((o) => topicRow(o, now, clock, max)).join('')}</ol></section>`;
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
//
// The page goes from why it is hot, to the videos (most people would rather
// watch and listen than read), to how it unfolded, to the articles
// themselves; the chips at the top jump to each.
function storyPage(state, r, ranked, now, { cold = false, clock = WALL_CLOCK } = {}) {
    const s = r.story;
    const url = `${SITE_ORIGIN}/s/${s.id}/`;
    const videos = videoBlock(s, now);
    const articles = s.items.filter((i) => i.kind !== 'video').length;
    const image = cold ? `${SITE_ORIGIN}/og/home.png` : `${SITE_ORIGIN}/og/${s.id}.png`;
    const jump = [
        `<a href="#why">${WHY_TITLE[r.level.id]}</a>`,
        videos ? `<a href="#videos">▶ ${plural(videosOf(s).length, 'видео', 'видеа')}</a>` : '',
        '<a href="#timeline">Хронология</a>',
        articles ? `<a href="#articles">${plural(articles, 'статия', 'статии')}</a>` : '',
    ].join('');
    return `${head({
        title: `${s.title} — live.gazette.bg`,
        description: aiText(s.summary || s.title),
        canonical: url,
        noindex: cold,
        ld: {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline: s.title.slice(0, 110),
            description: aiText(s.summary || s.title),
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
<main id="main" class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
${cold ? '<p class="cold-note">Тази новина изстина: за нея вече почти не се пише и я няма на началната страница. Страницата остава, за да работят споделените линкове.</p>' : ''}
<header class="story-head">
    <div class="card-top">${tempBadge(r)}${chips(r, now)}</div>
    <p class="ai-note ai-top">${AI_TAG}Заглавието и всичко на тази страница освен заглавията на медиите е написано автоматично от изкуствен интелект по ${plural(s.items.length, 'публикация', 'публикации')} на ${plural(r.trust.outlets, 'медия', 'медии')}, без човешка редакция. Може да има грешки: всяко твърдение води към публикацията, от която е взето, проверявай там. <a href="/about/">Как работи</a></p>
    <h1>${esc(s.title)}</h1>
    ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
    <nav class="jump" aria-label="На тази страница">${jump}</nav>
</header>
${whyBlock(r, ranked, now, clock)}
${videos}
${timelineBlock(r, now)}
${sourcesBlock(s, now)}
${repliesBlock(s)}
${moreBlock(r, ranked, now, clock)}
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
        description: aiText(m.summary || m.title),
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
    <p class="ai-note ai-top">${AI_TAG}Написано автоматично от изкуствен интелект, без човешка редакция. <a href="/about/">Как работи</a></p>
    <h1>${esc(m.title)}</h1>
    ${m.summary ? `<p class="lede">${esc(m.summary)}</p>` : ''}
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
            return `<item><title>${esc(s.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(lastAt(s)).toUTCString()}</pubDate><description>${esc(aiText(s.summary || s.title))}</description></item>`;
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
                return `<li>${srcMark(s.id)}${ext(s.home, `<b>${sourceLabel(s.id)}</b>`)}${s.kind === 'video' ? ' <span class="yt-tag">YouTube</span>' : ''}${status}</li>`;
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
<p class="lede">Четем ${SOURCES.length} източника от всички страни: медии, телевизии, независими автори, институции и партии.</p></header>
<div class="prose panel">
<p><b>Тежестта на източника</b> идва от проверими неща, не от политическата му линия: дали говори самата институция или човек, дали медията отговаря по закон за точността си, дали има известен собственик и подписани материали.</p>
<p><b>Независимите автори</b> са журналисти и малки редакции без голяма медия зад тях: известен човек отговаря за казаното, но няма голяма редакция, която да го проверява. Тежат малко по-малко от редакционните медии. Канал или блог на човек, който не работи като журналист, не четем.</p>
<p><b>Медиите без подписи</b> имат известен собственик, но материалите им обикновено не са подписани. Тежат по-малко. Това казва само какво се вижда на страниците им, не е оценка на медията.</p>
<p><b>Партийните канали</b> са първоизточник за това какво казват политиците, но казаното е тяхна позиция. Затова сами никога не потвърждават история.</p>
<p><b>„Потвърдено“</b> значи: има първоизточник (институцията говори сама или медия съобщава какво е обявила) и още една медия, която пише от свое име, или поне три такива медии, сред които агенция или обществена медия. Медия, която само преразказва друга („според БТА“), разпространява новината, но не я потвърждава; интервю е мнение, не потвърден факт. Ако източниците си противоречат за съществен факт, историята не е „Потвърдено“, докато спорът не се разреши.</p>
<p><b>Кого четем.</b> Източник влиза, ако го позволяват законът и самият той (robots.txt, условията за ползване: не четем медия, чиито условия забраняват дори заглавие и връзка, агрегиране или автоматично четене), ако някой отговаря за него (известен собственик или автор с име), ако редовно пише за България и ако е активен. Не четем източник, за който независима проверка е установила дезинформация или разпространение на санкционирани медии, нито такъв, който системно използва език на омразата, обиди, внушения без доказателства, клюки или скрита реклама. Политическата позиция, шумните заглавия и малката аудитория не са причина да махнем някого — те влияят само на тежестта му.</p>
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
<p>Сайтът няма реклами, не взима пари и няма абонамент. Няма други собственици и не получава финансиране от никого, включително от държавата, партии или чужди институции.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Как работи</h2>
<p>На всеки 10 минути през деня и на всеки 30 през нощта сайтът чете публичните емисии (RSS) на медиите и YouTube каналите от <a href="/sources/">списъка с източници</a>. Изкуствен интелект (Claude на Anthropic) подрежда материалите в истории и пише кратко обобщение. <b>Текстовете са генерирани от изкуствен интелект, без човешка редакция, и може да съдържат грешки.</b> Затова всяко твърдение води към материала, от който е взето, и показваме колко и какви медии потвърждават всяка история.</p>
<p>Правилата, които изкуственият интелект спазва: всяко твърдение има източник; никой не се представя за виновен без окончателна присъда; не се назовават деца, пострадали, свидетели и заподозрени, които не са публични личности; не се цитират числа от социологически проучвания. При история, която засяга дете или пострадал от сексуално или домашно насилие, не показваме заглавията и видеата на медиите. В деня преди изборите и в изборния ден не показваме проучвания и партийни канали (Изборен кодекс, чл. 182 и 205).</p>
<p>„Тежестта“ на източниците е автоматична статистика по проверими признаци, а не оценка на медиите.</p>
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
<p>Видеата от YouTube четем през официалния YouTube Data API (сайтът използва YouTube API Services) и ги показваме с официалния плейър на YouTube. Като пускаш видео тук, се съгласяваш с <a href="https://www.youtube.com/t/terms" rel="noopener" target="_blank">Условията на YouTube</a>; за данните важи <a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Политиката за поверителност на Google</a>. Видео, отбелязано от YouTube като „за деца“, не вграждаме.</p>
<p>Логата и иконите са на съответните медии и служат само да се разпознае източникът до неговите собствени заглавия; не са променени и сайтът не е свързан с тях. Махаме лого при поискване.</p>
<p>Anthropic не използва текстовете, които сайтът му изпраща, за обучение на моделите си. Сайтът не обучава модели.</p>
</div>
<div class="prose panel">
<h2 class="panel-title">Лични данни</h2>
<p><b>Кой отговаря.</b> Администратор на личните данни е ${OPERATOR ? esc(OPERATOR) : 'лицето, което поддържа сайта'}; връзка: ${mail}.</p>
<p><b>Какво става при посещение.</b> Сайтът няма бисквитки, реклами, анализи на посещенията и проследяване и не пази журнали на посещенията. Страниците се доставят от Cloudflare (обработващ лични данни), който вижда IP адреса и браузъра на всеки посетител, за да достави страницата и да спре атаки, и пази тези данни за кратко по своите правила. Основание: законният интерес сайтът да работи и да е защитен (чл. 6, ал. 1, буква „е“ от Регламент (ЕС) 2016/679). Cloudflare е в САЩ; предаването е по Рамката за защита на данните между ЕС и САЩ.</p>
<p><b>В браузъра ти.</b> Нищо не се записва на устройството ти, докато сам не го поискаш. Ако включиш „Отбелязвай ми новото от последното посещение“, браузърът пази кога си бил тук (localStorage) и не го изпраща никъде; изключиш ли го, се изтрива.</p>
<p><b>Видеата.</b> Докато не натиснеш „пусни“, от YouTube не се зарежда нищо, дори картинката. Пуснеш ли видео, браузърът ти се свързва с YouTube (Google), който получава данни за посещението и може да запише бисквитки по своите правила (<a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Политика за поверителност на Google</a>).</p>
<p><b>Хората в новините.</b> Историите съдържат имена и изявления на хора от публикувани материали. Те се обработват за журналистически цели, за свободата на изразяване и правото на информация (чл. 85 от Регламента и чл. 25з от Закона за защита на личните данни). Текстовете на материалите се изпращат на Anthropic (обработващ лични данни, САЩ, при стандартните договорни клаузи на ЕС) само за да се напише обобщението и не се пазят след това.</p>
<p><b>Твоите права.</b> Можеш да поискаш достъп до данните си, поправка, изтриване, ограничаване или да възразиш срещу обработването (чл. 15–21 от Регламента) на ${mail}. Имаш право на жалба до Комисията за защита на личните данни (<a href="https://www.cpdp.bg" rel="noopener" target="_blank">cpdp.bg</a>, София 1592, бул. „Проф. Цветан Лазаров“ 2).</p>
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
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src https://www.youtube-nocookie.com; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
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
    const clock = newsClock(state.stories, now);
    write(path.join(outDir, 'index.html'), frontPage(state, ranked, now, clock));
    // Every story in the state has a page, the cold ones too; then every
    // remembered one. An address, once shared, keeps working.
    const shown = new Set(ranked.map((r) => r.story.id));
    const cold = scoreStories(state.stories, now).filter((r) => !shown.has(r.story.id));
    const built = new Set();
    for (const r of [...ranked, ...cold]) {
        built.add(r.story.id);
        write(
            path.join(outDir, 's', r.story.id, 'index.html'),
            storyPage(state, r, ranked, now, { cold: !shown.has(r.story.id), clock }),
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
