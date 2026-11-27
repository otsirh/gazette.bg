#!/usr/bin/env node
// Builds live.gazette.bg from the state. The page is a live board, not a
// newspaper: what burns is red and on top, what cools fades to grey and sinks,
// and every story opens on its videos, its timeline and how it spread.
// Every value from a feed or the model is escaped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain as isMainModule } from '../scripts/lib/cli.js';
import { isWebUrl } from './lib/feeds.js';
import { lastAt, originOf, rankStories, sparkline, spreadTree } from './lib/stories.js';
import { SOURCE_BY_ID, SOURCES, TIERS, tierOf } from './sources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const OUT_DIR = path.join(ROOT, 'dist-live');
export const SITE_ORIGIN = 'https://live.gazette.bg';
const HOUR = 3600 * 1000;

// Bumped by hand when style.css or live.js change, so browsers fetch them anew.
const ASSET_VERSION = '3';

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

const tierMark = (t) => `<span class="tier tier-${t}" title="${esc(TIERS[t].label)}">${t}</span>`;
const tierBadge = (sourceId) => tierMark(tierOf(sourceId));
const sourceLabel = (id) => esc(SOURCE_BY_ID.get(id)?.name ?? id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const TREND = {
    new: { sym: '✦', label: 'нова' },
    up: { sym: '↑', label: 'разгаря се' },
    steady: { sym: '→', label: 'държи се' },
    down: { sym: '↓', label: 'утихва' },
};

const videosOf = (story) =>
    story.items.filter((i) => i.kind === 'video' && /^[\w-]{6,20}$/.test(i.videoId ?? '')).sort((a, b) => b.at - a.at);

const thumb = (videoId, size = 'mqdefault') => `https://i.ytimg.com/vi/${esc(videoId)}/${size}.jpg`;

function sparkSvg(counts, label = 'Колко се пише за историята през последните 48 часа') {
    const w = 120;
    const h = 26;
    const max = Math.max(1, ...counts);
    const step = w / counts.length;
    const bars = counts
        .map((c, i) => {
            if (!c) return '';
            const bh = Math.max(2, (c / max) * (h - 2));
            return `<rect x="${(i * step).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(step - 1.2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
        })
        .join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">${bars}</svg>`;
}

// 0–100 for the heat meter; logarithmic, since a big story is ten times louder.
const heatPct = (heat) => Math.max(5, Math.min(100, Math.round((Math.log1p(heat) / Math.log1p(40)) * 100)));

function heatMeter(r) {
    return `<span class="meter" role="img" aria-label="Нажеженост ${heatPct(r.heat)} от 100"><span style="width:${heatPct(r.heat)}%"></span></span>`;
}

function chips(r, now) {
    const t = TREND[r.trend];
    const lastHour = r.story.items.filter((i) => now - i.at < HOUR).length;
    return `<span class="chip heat-${r.level.id}">${esc(r.level.label)}</span>
            <span class="trend trend-${r.trend}">${t.sym} ${esc(t.label)}</span>
            ${lastHour ? `<span class="fresh">+${lastHour} за последния час</span>` : ''}`;
}

function head({ title, description, canonical }) {
    return `<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:locale" content="bg_BG" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f5f7" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c0f13" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}" />
    <script type="module" src="/live.js?v=${ASSET_VERSION}"></script>
</head>`;
}

function topbar(state, now, count = null) {
    return `<header class="topbar">
    <div class="wrap topbar-inner">
        <a class="brand" href="/"><span class="live-dot" aria-hidden="true"></span><span class="brand-live">НА ЖИВО</span><span class="brand-name">live.gazette.bg</span></a>
        <span class="status">${count !== null ? `<span class="status-count">${plural(count, 'история', 'истории')} · </span>` : ''}обновено ${timeEl(state.updatedAt || now, now, true)}</span>
    </div>
</header>`;
}

function footer() {
    const tiers = Object.entries(TIERS)
        .map(([n, t]) => `<li>${tierMark(Number(n))} ${esc(t.label)}</li>`)
        .join('');
    return `<footer class="footer">
    <div class="wrap">
        <ul class="legend">${tiers}</ul>
        <p>Историите, обобщенията и хронологиите се съставят автоматично с изкуствен интелект (Claude на Anthropic) от материалите на изброените медии и може да съдържат грешки. Всяко твърдение води към материала, от който е взето.</p>
        <p><a href="/sources/">Източници и как се оценяват</a> · <a href="https://gazette.bg">gazette.bg — Държавен вестник накратко</a></p>
    </div>
</footer>`;
}

// ─── Front page ─────────────────────────────────────────────────────────

function cardMeta(r, now) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    return [
        `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>`,
        `<span>${plural(r.trust.outlets, 'медия', 'медии')}</span>`,
        origin ? `<span>първо: <b>${esc(origin.name)}</b> ${timeEl(origin.at, now)}</span>` : '',
        videos ? `<span class="has-video">▶ ${videos}</span>` : '',
        r.trust.disputed ? '<span class="has-dispute">⚠ противоречия</span>' : '',
    ]
        .filter(Boolean)
        .join('');
}

function storyCard(r, now, big = false) {
    const s = r.story;
    const video = big ? videosOf(s)[0] : null;
    return `<li class="card heat-${r.level.id}${big ? ' big' : ''}${video ? ' with-video' : ''}">
    <a class="card-link" href="/s/${esc(s.id)}/">
        ${video ? `<span class="card-thumb"><img src="${thumb(video.videoId)}" alt="" loading="lazy" width="320" height="180" /><span class="play" aria-hidden="true">▶</span></span>` : ''}
        <span class="card-body">
            <span class="card-top">${chips(r, now)}<span class="ago">${timeEl(lastAt(s), now, true)}</span></span>
            <span class="card-title">${esc(s.title)}</span>
            ${s.summary ? `<span class="card-summary">${esc(s.summary)}</span>` : ''}
            <span class="card-foot"><span class="meta">${cardMeta(r, now)}</span>${heatMeter(r)}</span>
        </span>
    </a>
</li>`;
}

function rowItem(r, now, note = '') {
    return `<li class="row heat-${r.level.id}"><a href="/s/${esc(r.story.id)}/"><span class="row-title">${esc(r.story.title)}</span><span class="row-meta">${note}${timeEl(lastAt(r.story), now, true)}</span></a></li>`;
}

function overviewBlock(state, ranked, now) {
    const byId = new Map(ranked.map((r) => [r.story.id, r]));
    const lines = (state.overview?.lines ?? []).filter((l) => byId.has(l.story));
    if (!lines.length) return '';
    return `<section class="brief" aria-labelledby="brief-title">
    <div class="brief-head">
        <h1 id="brief-title">Какво се случва в България сега</h1>
        <span class="brief-at">обобщено ${timeEl(state.overview.at, now, true)}</span>
    </div>
    <ol class="brief-list">
        ${lines.map((l) => `<li class="heat-${byId.get(l.story).level.id}"><a href="/s/${esc(l.story)}/">${esc(l.text)}</a></li>`).join('\n        ')}
    </ol>
</section>`;
}

function section(id, title, note, body) {
    return `<section class="group" aria-labelledby="${id}">
    <h2 id="${id}" class="group-title">${title}${note ? ` <span>${note}</span>` : ''}</h2>
    ${body}
</section>`;
}

// A story only one outlet carries is not yet news the country talks about:
// it waits in a short list below until a second one picks it up.
const isMain = (r) => r.trust.outlets >= 2 || r.trust.firstHand;

function frontPage(state, ranked, now) {
    const main = ranked.filter(isMain);
    const hot = main.filter((r) => r.level.id === 'hot');
    const warm = main.filter((r) => r.level.id === 'warm');
    const cool = main.filter((r) => r.level.id === 'cool').slice(0, 20);
    const singles = ranked
        .filter((r) => !isMain(r))
        .sort((a, b) => lastAt(b.story) - lastAt(a.story))
        .slice(0, 15);
    const parts = [];
    if (hot.length) {
        parts.push(
            section(
                'hot',
                'Горещо',
                'за това се говори най-много',
                `<ol class="cards cards-big">${hot.map((r) => storyCard(r, now, true)).join('')}</ol>`,
            ),
        );
    }
    if (warm.length) {
        parts.push(
            section('warm', 'Актуално', '', `<ol class="cards">${warm.map((r) => storyCard(r, now)).join('')}</ol>`),
        );
    }
    if (cool.length) {
        parts.push(
            section(
                'cool',
                'Утихва',
                'вече се пише по-малко',
                `<ol class="rows">${cool.map((r) => rowItem(r, now, `${plural(r.trust.outlets, 'медия', 'медии')} · `)).join('')}</ol>`,
            ),
        );
    }
    if (singles.length) {
        parts.push(
            section(
                'single',
                'Само от един източник',
                'още непотвърдени от друга медия',
                `<ol class="rows rows-single">${singles.map((r) => rowItem(r, now, `${sourceLabel(r.story.items[0].source)} · `)).join('')}</ol>`,
            ),
        );
    }
    const body = parts.length
        ? parts.join('\n')
        : '<p class="empty">Все още няма събрани истории. Първото обновяване идва до 20 минути.</p>';
    return `${head({
        title: 'Какво се случва в България сега — live.gazette.bg',
        description:
            'Актуалните новини в България, подредени по това колко се говори за тях: кой ги съобщи първи, кой какво каза и колко да вярвате на източника.',
        canonical: `${SITE_ORIGIN}/`,
    })}
<body class="home" data-version="${state.updatedAt}">
${topbar(state, now, main.length)}
<main class="wrap">
${overviewBlock(state, ranked, now)}
${body}
</main>
${footer()}
</body>
</html>
`;
}

// ─── Story page ─────────────────────────────────────────────────────────

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
            return `<li><span class="node"><span class="node-src">${tierBadge(it.source)} ${sourceLabel(it.source)}${it.kind === 'video' ? ' ▶' : ''} ${timeEl(it.at, now)}</span>${how ? `<span class="node-how">${how}</span>` : ''}${ext(it.url, esc(it.title))}</span>${kids}</li>`;
        })
        .join('')}</ul>`;
}

function videoTile(v, now) {
    return `<li class="video">
    <button type="button" class="video-play" data-video="${esc(v.videoId)}" aria-label="Пусни: ${esc(v.title)}">
        <img src="${thumb(v.videoId)}" alt="" loading="lazy" width="320" height="180" />
        <span class="play" aria-hidden="true">▶</span>
    </button>
    <span class="video-title">${ext(v.url, esc(v.title))}</span>
    <span class="video-meta">${tierBadge(v.source)} ${sourceLabel(v.source)} · ${timeEl(v.at, now)}</span>
</li>`;
}

function videoBlock(story, now) {
    const vids = videosOf(story);
    if (!vids.length) return '';
    const tiles = vids.map((v) => videoTile(v, now));
    const more =
        tiles.length > 4
            ? `<details class="more"><summary>Още ${tiles.length - 4} видео</summary><ul class="videos">${tiles.slice(4).join('')}</ul></details>`
            : '';
    return `<section class="panel" aria-labelledby="videos">
    <h2 id="videos" class="panel-title">▶ Видео <span>чуйте сами какво казват</span></h2>
    <ul class="videos">${tiles.slice(0, 4).join('')}</ul>
    ${more}
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
            const tier = refs.length ? Math.min(...refs.map((i) => tierOf(i.source))) : 3;
            const links = refs.map((i) => ext(i.url, sourceLabel(i.source))).join(', ');
            const day = dayKey.format(e.at);
            const sep =
                day !== lastDay
                    ? `<li class="tl-day">${esc(sofia({ weekday: 'long', day: 'numeric', month: 'long' }).format(e.at))}</li>`
                    : '';
            lastDay = day;
            return `${sep}<li class="tl tl-tier-${tier}">
    <span class="tl-time">${esc(fmtClock.format(e.at))}</span>
    <span class="tl-body"><b class="tl-who">${esc(e.who)}</b> ${esc(e.what)}${links ? `<span class="tl-src">${links}</span>` : ''}</span>
</li>`;
        });
    return `<section class="panel" aria-labelledby="timeline">
    <h2 id="timeline" class="panel-title">Хронология <span>кой какво каза и направи, най-новото отгоре</span></h2>
    <ol class="timeline">${rows.join('')}</ol>
</section>`;
}

function sourcesBlock(story, now) {
    const rows = [...story.items]
        .sort((a, b) => a.at - b.at)
        .map(
            (i) =>
                `<li>${timeEl(i.at, now)} ${tierBadge(i.source)} <b>${sourceLabel(i.source)}</b>${i.kind === 'video' ? ' ▶' : ''} ${ext(i.url, esc(i.title))}</li>`,
        );
    return `<details class="panel all-items">
    <summary class="panel-title">Всички ${plural(rows.length, 'материал', 'материала')} <span>най-старото първо</span></summary>
    <ul class="item-list">${rows.join('')}</ul>
</details>`;
}

function stat(label, value) {
    return `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function storyPage(state, r, now) {
    const s = r.story;
    const origin = originOf(s);
    const videos = videosOf(s).length;
    return `${head({
        title: `${s.title} — live.gazette.bg`,
        description: s.summary || s.title,
        canonical: `${SITE_ORIGIN}/s/${s.id}/`,
    })}
<body class="story heat-${r.level.id}" data-version="${state.updatedAt}">
${topbar(state, now)}
<main class="wrap">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head">
    <div class="card-top">${chips(r, now)}</div>
    <h1>${esc(s.title)}</h1>
    ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
    <dl class="stats">
        ${stat('Достоверност', `<span class="trust trust-${r.trust.id}">${esc(r.trust.label)}</span>${r.trust.firstHand ? '<small>има първоизточник</small>' : ''}`)}
        ${stat('Медии', `${r.trust.outlets}<small>${plural(s.items.length, 'материал', 'материала')}${videos ? `, ${videos} видео` : ''}</small>`)}
        ${origin ? stat('Първи съобщи', `${esc(origin.name)}<small>${timeEl(origin.at, now)}${origin.via ? ` · по ${sourceLabel(origin.via)}` : ''}</small>`) : ''}
        ${stat('Нажеженост', `${heatMeter(r)}${sparkSvg(sparkline(s, now))}<small>последни 48 часа</small>`)}
    </dl>
    ${r.trust.disputed ? `<p class="disputed"><b>⚠ Спорно:</b> ${esc(r.trust.disputed)}</p>` : ''}
</header>
${videoBlock(s, now)}
<div class="story-grid">
    ${timelineBlock(s)}
    <section class="panel spread" aria-labelledby="spread">
        <h2 id="spread" class="panel-title">Как се разпространи <span>всеки материал стои под този, когото цитира</span></h2>
        <div class="tree">${treeHtml(spreadTree(s), now)}</div>
    </section>
</div>
${sourcesBlock(s, now)}
</main>
${footer()}
</body>
</html>
`;
}

// ─── Sources page ───────────────────────────────────────────────────────

function sourcesPage(state, now) {
    const groups = Object.entries(TIERS)
        .map(([n, t]) => {
            const list = SOURCES.filter((s) => s.tier === Number(n));
            if (!list.length) return '';
            return `<section class="panel"><h2 class="panel-title">${tierMark(Number(n))} ${esc(t.label)}</h2><ul class="item-list">${list
                .map((s) => {
                    const st = state.sources?.[s.id];
                    const status = st && !st.ok ? ' <span class="down">не отговаря в момента</span>' : '';
                    return `<li>${ext(s.home, `<b>${esc(s.name)}</b>`)}${status} — ${esc(s.why)}</li>`;
                })
                .join('')}</ul></section>`;
        })
        .join('\n');
    return `${head({
        title: 'Източници и как се оценяват — live.gazette.bg',
        description: 'Кои медии чете live.gazette.bg и колко тежи думата на всяка.',
        canonical: `${SITE_ORIGIN}/sources/`,
    })}
<body class="sources" data-version="${state.updatedAt}">
${topbar(state, now)}
<main class="wrap narrow">
<a class="back" href="/">← Всичко, което се случва сега</a>
<header class="story-head"><h1>Източници и как се оценяват</h1></header>
<div class="prose">
<p><b>Тежестта на източника</b> идва от проверими неща, не от политическата му линия: дали говори самата институция или човек, дали медията отговаря по закон за точността си, дали има известен собственик и подписани материали.</p>
<p><b>Достоверността на историята</b> е „Потвърдено“, когато има първоизточник (институцията или човекът говорят сами) и още една медия, или поне три отделни медии, сред които агенция или обществена медия. „Противоречия“ значи, че източниците си противоречат за съществен факт.</p>
<p><b>Нажежеността</b> расте с всеки нов материал — повече от нова медия, по-малко от същата — и пада наполовина на всеки 6 часа. Щом за една история спре да се пише, тя слиза надолу, избледнява и изчезва.</p>
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
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cache-Control: public, max-age=60

/state.json
  Cache-Control: no-cache
/version.json
  Cache-Control: no-cache
`;

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

export function buildSite(state, { now = Date.now(), outDir = OUT_DIR } = {}) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const ranked = rankStories(state.stories, now);
    write(path.join(outDir, 'index.html'), frontPage(state, ranked, now));
    for (const r of ranked) write(path.join(outDir, 's', r.story.id, 'index.html'), storyPage(state, r, now));
    write(path.join(outDir, 'sources', 'index.html'), sourcesPage(state, now));
    write(path.join(outDir, 'state.json'), JSON.stringify(state));
    write(path.join(outDir, 'version.json'), JSON.stringify({ updatedAt: state.updatedAt }));
    write(path.join(outDir, '_headers'), HEADERS);
    write(path.join(outDir, 'robots.txt'), 'User-agent: *\nAllow: /\nDisallow: /state.json\n');
    write(
        path.join(outDir, '404.html'),
        `${head({ title: 'Няма я — live.gazette.bg', description: 'Тази история вече не е актуална.', canonical: `${SITE_ORIGIN}/` })}
<body data-version="${state.updatedAt}">${topbar(state, now)}<main class="wrap narrow"><header class="story-head"><h1>Тази история вече не е актуална</h1><p class="lede">За нея отдавна не се пише, затова е махната.</p><p><a class="back" href="/">Вижте какво се случва сега →</a></p></header></main>${footer()}</body></html>\n`,
    );
    for (const f of ['style.css', 'live.js', 'favicon.svg']) {
        fs.copyFileSync(path.join(HERE, 'site', f), path.join(outDir, f));
    }
}

if (isMainModule(import.meta.url)) {
    const file = process.argv[2] ?? path.join(ROOT, '.live-state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    buildSite(state);
    console.log(`Built ${OUT_DIR}`);
}
