#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { appendLog, flushAlertEmail } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = 'build-issue-pages';
const ROOT = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'index.html');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');
const OUTPUT_DIR = path.join(ROOT, 'issue');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');
const RSS_PATH = path.join(ROOT, 'feed.xml');
const DEADLINES_PAGE_DIR = path.join(ROOT, 'deadlines');
const CSS_PATH = path.join(ROOT, 'src', 'css', 'styles.css');
const NOT_FOUND_PATH = path.join(ROOT, '404.html');

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

const SITE_ORIGIN = 'https://gazette.bg';
const PAGE_TITLE_BASE = 'Обобщения на Държавен вестник';
const WORDS_PER_MINUTE = 180;
const LEAD_TOPIC_LIMIT = 5;

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// marked emits HTML entities (&quot;, &amp;, …) inside heading markup. Decode
// them back to text before deriving slugs/TOC labels, otherwise escapeHtml
// double-encodes (&amp;quot;) and slugify leaks "quot" into anchor ids —
// which also desyncs the pre-rendered ids from the client-generated ones.
function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function htmlToText(html) {
    return decodeEntities(String(html).replace(/<[^>]+>/g, '')).trim();
}

function stripDateSuffix(str) {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/\s*г\.\s*$/, '').trim();
}

function capitalizeMonthInDate(str) {
    if (!str || typeof str !== 'string') return str;
    let s = str;
    for (let i = 0; i < BG_MONTHS.length; i++) s = s.replace(BG_MONTHS[i], BG_MONTHS_CAP[i]);
    return s;
}

function lowercaseMonthInDate(str) {
    if (!str || typeof str !== 'string') return str;
    let s = str;
    for (let i = 0; i < BG_MONTHS_CAP.length; i++) s = s.replace(BG_MONTHS_CAP[i], BG_MONTHS[i]);
    return s;
}

function formatDateBulgarian(str) {
    if (!str || typeof str !== 'string') return str;
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г\.?$/);
    if (!m) return capitalizeMonthInDate(stripDateSuffix(str));
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = m[3];
    if (month < 1 || month > 12) return capitalizeMonthInDate(stripDateSuffix(str));
    return day + ' ' + BG_MONTHS_CAP[month - 1] + ' ' + year;
}

// Long form ("10 юли 2026") for datelines; short form drops the year for the
// archive register, where the year is already the running head.
function formatDateLong(str) {
    return lowercaseMonthInDate(stripDateSuffix(formatDateBulgarian(str)));
}

function formatDateShort(str) {
    return formatDateLong(str).replace(/\s+\d{4}\s*$/, '').trim();
}

function stripMarkdownInline(s) {
    return String(s)
        .replace(/\*+|\_+/g, '')
        .replace(/`+/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim();
}

function slugify(text) {
    return stripMarkdownInline(text)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'section';
}

function readingMinutes(markdown) {
    const words = stripMarkdownInline(String(markdown)).split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function pluralTopics(n) {
    return n === 1 ? '1 тема' : n + ' теми';
}

// Level-2 markdown headings are the issue's topics — used to build a unique
// meta description and JSON-LD articleSection per page.
function extractTopicsFromFile(file) {
    try {
        const md = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const topics = [];
        for (const line of md.split('\n')) {
            const m = /^##\s+(.+?)\s*$/.exec(line);
            if (m) topics.push(stripMarkdownInline(m[1]));
        }
        return topics;
    } catch (_) {
        return [];
    }
}

function truncate(s, max) {
    const clean = String(s).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return clean.slice(0, max - 1).replace(/[\s.,;:–-]+$/, '') + '…';
}

function processRenderedContent(html) {
    // Promote any h1 to h2, assign unique heading IDs, collect TOC items
    html = html.replace(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
    const used = new Set();
    const tocItems = [];
    html = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (m, level, attrs, inner) => {
        const text = htmlToText(inner);
        let id = slugify(text);
        if (used.has(id)) {
            let n = 2;
            while (used.has(id + '-' + n)) n++;
            id = id + '-' + n;
        }
        used.add(id);
        tocItems.push({ level: parseInt(level, 10), text, id });
        const attrStr = attrs || '';
        return `<h${level}${attrStr} id="${escapeHtml(id)}">${inner}</h${level}>`;
    });
    return { html, tocItems };
}

// Drops a row of "who this is for" tags under every heading it has tags for, so
// the reader can skip a section without reading it.
function injectSectionTags(html, sections) {
    if (!Array.isArray(sections) || !sections.length) return html;
    const byTitle = new Map(sections.map((s) => [s.title.trim(), s.audiences || []]));
    return html.replace(/<h2([^>]*)>([\s\S]*?)<\/h2>/gi, (match, attrs, inner) => {
        const audiences = byTitle.get(htmlToText(inner));
        return audiences && audiences.length ? match + renderTags(audiences) : match;
    });
}

function buildTocHtml(tocItems) {
    const mainItems = tocItems.filter((item) => item.level <= 2);
    if (!mainItems.length) return '';
    let html = '<nav class="issue-toc" aria-label="Съдържание на броя"><p class="issue-toc-title">Съдържание</p><ul class="issue-toc-list">';
    for (const item of mainItems) {
        html += `<li class="issue-toc-item"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
    }
    html += '</ul></nav>';
    return html;
}

/* ─── Cards (mirrors src/js/app.js — keep the two in step) ─── */

function cardAttrs(item) {
    const href = `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
    return `href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}"`;
}

// The front page. Headline is the issue's first topic; the lead sentence, when
// there is one, runs underneath as the standfirst.
function renderLeadCard(item) {
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const headline = topics[0] || item.lead || `Брой ${item.issue}`;
    const standfirst = item.lead && item.lead !== headline ? item.lead : '';
    const rest = topics.slice(1);

    let contents = '';
    if (rest.length) {
        const shown = rest.slice(0, LEAD_TOPIC_LIMIT);
        const hidden = rest.length - shown.length;
        let items = shown.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
        if (hidden > 0) items += `<li class="more">още ${pluralTopics(hidden)}</li>`;
        contents = `<div class="lead-contents"><p class="contents-label">Още в броя</p><ol class="contents-list">${items}</ol></div>`;
    }

    const standfirstHtml = standfirst ? `<p class="lead-standfirst">${escapeHtml(standfirst)}</p>` : '';
    const gridClass = standfirst ? 'lead-grid' : 'lead-grid no-standfirst';

    return `<section class="lead-section">
<p class="lead-dateline"><span>Последен брой</span><span class="rule"></span><span>Брой ${escapeHtml(String(item.issue))} · ${escapeHtml(formatDateLong(item.date))}</span></p>
<a class="issue-card issue-card-lead" ${cardAttrs(item)}>
<h2 class="lead-title">${escapeHtml(headline)}</h2>
${renderTags(item.audiences)}
<div class="${gridClass}">
<div class="lead-main">${standfirstHtml}<span class="lead-read">Прочети обобщението →</span></div>
${contents}
</div>
</a>
</section>`;
}

// The register shows a bare number and one headline, but readers search for
// things it does not print — "брой 63", the year, the lead sentence, a topic
// further down the issue. Carry all of it in a hidden haystack.
function searchHaystack(item) {
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const places = Array.isArray(item.places) ? item.places : [];
    return [`Брой ${item.issue}`, formatDateLong(item.date), item.lead || '', ...topics, ...places]
        .join(' ')
        .toLowerCase();
}

function renderRowCard(item) {
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const title = topics[0] || item.lead || `Брой ${item.issue}`;
    const auds = Array.isArray(item.audiences) ? item.audiences : [];
    return `<a class="issue-card issue-card-row" ${cardAttrs(item)} data-search="${escapeHtml(searchHaystack(item))}" data-audiences="${escapeHtml(auds.join('|'))}">` +
        `<span class="num">${escapeHtml(String(item.issue))}</span>` +
        `<span class="row-body"><span class="row-title">${escapeHtml(title)}</span><span class="date">${escapeHtml(formatDateShort(item.date))}</span></span>` +
        `</a>`;
}

function renderNavCard(item) {
    return `<a class="issue-card" ${cardAttrs(item)}>` +
        `<span class="num">Брой ${escapeHtml(String(item.issue))}</span>` +
        `<span class="date">${escapeHtml(formatDateShort(item.date))}</span>` +
        `</a>`;
}

/* ─── Tags and deadlines (mirrors src/js/app.js) ─── */

function renderTags(audiences) {
    if (!Array.isArray(audiences) || !audiences.length) return '';
    return `<p class="tags">${audiences.map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join('')}</p>`;
}

// The places a brief names (towns, municipalities, regions). Each links to the
// archive pre-filtered to that place — "what else touched my area?".
function renderPlaces(places) {
    if (!Array.isArray(places) || !places.length) return '';
    const chips = places
        .map((pl) => `<a class="place-chip" href="/?q=${encodeURIComponent(pl)}#archive">${escapeHtml(pl)}</a>`)
        .join('');
    return `<p class="issue-places"><span class="issue-places-label">Места в броя</span>${chips}</p>`;
}

// A static "до 24 юли" is rendered here; the browser turns it into "след 4 дни"
// and drops what has expired. Without JS the reader still sees the date.
// A deadline as a downloadable all-day calendar event. Encoded as a data: URI
// so the link works without JS and needs no server; DTSTAMP/UID derive from the
// deadline date, so a rebuild produces byte-identical output (no churn).
function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// Fold to stay under the 75-octet line limit; 37 chars is safe even for
// all-Cyrillic (2 bytes each), and continuation lines begin with a space.
function icsFold(line) {
    if (line.length <= 37) return line;
    let out = line.slice(0, 37), rest = line.slice(37);
    while (rest.length) { out += '\r\n ' + rest.slice(0, 36); rest = rest.slice(36); }
    return out;
}
function icsAddDay(iso) {
    const dt = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(dt.getTime())) return iso;
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
}
function deadlineIcs(d, item) {
    const start = String(d.expires || '').replace(/-/g, '');
    const end = icsAddDay(d.expires).replace(/-/g, '');
    const url = `${SITE_ORIGIN}/issue/${item.year}/${item.issue}/`;
    const uid = `${item.year}-${item.issue}-${d.expires}-${String(d.what || '').length}@gazette.bg`;
    const details = [d.who, `Държавен вестник, брой ${item.issue}`, url].filter(Boolean).join(' · ');
    return [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gazette.bg//deadlines//BG', 'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        icsFold('UID:' + uid),
        'DTSTAMP:' + start + 'T000000Z',
        'DTSTART;VALUE=DATE:' + start,
        'DTEND;VALUE=DATE:' + end,
        icsFold('SUMMARY:Срок — ' + icsEscape(d.what || '')),
        icsFold('DESCRIPTION:' + icsEscape(details)),
        icsFold('URL:' + url),
        'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
}
function renderDeadlineCal(d, item) {
    if (!d.expires) return '';
    const href = 'data:text/calendar;charset=utf-8;base64,' + Buffer.from(deadlineIcs(d, item), 'utf8').toString('base64');
    return `<a class="deadline-cal" download="gazette-deadline-${escapeHtml(String(item.issue))}.ics" href="${href}" aria-label="Добави срока в календара">＋ Календар</a>`;
}

function renderDeadlineRow(d, item, withIssue = true) {
    const href = `/issue/${item.year}/${item.issue}/`;
    // Inside the issue itself, saying which issue it came from is noise.
    const who = [d.who, withIssue ? `брой ${item.issue}` : ''].filter(Boolean).join(' · ');
    return `<li class="deadline" data-expires="${escapeHtml(d.expires)}">` +
        `<span class="deadline-left">до ${escapeHtml(formatDateShort(isoToBg(d.expires)))}</span>` +
        `<span class="deadline-body">` +
        `<a class="deadline-what" href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}">${escapeHtml(d.what)}</a>` +
        `<span class="deadline-who">${escapeHtml(who)}</span>` +
        renderDeadlineCal(d, item) +
        `</span></li>`;
}

function collectDeadlines(all, todayIso) {
    const rows = [];
    for (const item of all) {
        for (const d of item.deadlines || []) {
            if (d.expires >= todayIso) rows.push({ d, item });
        }
    }
    return rows.sort((a, b) => a.d.expires.localeCompare(b.d.expires));
}

// Only the soonest few are actionable; the rest would be a wall. The list is
// sorted by date, so the top of it is exactly what is about to run out.
const DEADLINES_SHOWN = 8;

function renderDeadlinesSection(all, todayIso) {
    const rows = collectDeadlines(all, todayIso);
    if (!rows.length) return '';
    const shown = rows.slice(0, DEADLINES_SHOWN);
    const rest = rows.length - shown.length;
    const moreLabel = rest > 0
        ? `Всички срокове · още ${rest} ${rest === 1 ? 'срок' : 'срока'} →`
        : 'Всички срокове →';
    const restNote = `<p class="deadlines-rest"><a class="deadlines-more" href="/deadlines/">${moreLabel}</a></p>`;
    return '<section class="deadlines-section" id="deadlines">' +
        '<div class="section-head"><h2 class="section-title">Срокове, които текат</h2>' +
        `<span class="section-count" id="deadline-count">${rows.length} ${rows.length === 1 ? 'срок' : 'срока'}</span></div>` +
        '<p class="deadlines-note">Изчислени от датата на броя. Срокът е ориентировъчен — за сигурност проверете самия брой.</p>' +
        `<ul class="deadline-list">${shown.map(({ d, item }) => renderDeadlineRow(d, item)).join('')}</ul>` +
        restNote +
        '</section>';
}

const BG_MONTHS_LOWER = BG_MONTHS;

function isoToBg(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso;
    return `${parseInt(m[3], 10)} ${BG_MONTHS_LOWER[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

function renderShare(item) {
    const url = `${SITE_ORIGIN}/issue/${item.year}/${item.issue}/`;
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(`Държавен вестник, брой ${item.issue} — обобщение`);
    return '<span class="share-label">Сподели</span>' +
        `<button type="button" class="share-btn" id="share-copy" data-url="${escapeHtml(url)}">Копирай връзка</button>` +
        `<a class="share-btn" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">Facebook</a>` +
        `<a class="share-btn" href="https://twitter.com/intent/tweet?url=${u}&amp;text=${t}" target="_blank" rel="noopener">X</a>` +
        `<a class="share-btn" href="mailto:?subject=${t}&amp;body=${u}">Имейл</a>`;
}

function replaceHomeContent(html, content) {
    return html.replace(/(<!--HOME-CONTENT-START-->)[\s\S]*?(<!--HOME-CONTENT-END-->)/, `$1${content}$2`);
}

function buildNotFoundHtml(cleanTemplate) {
    const title = 'Страницата не е намерена — Държавен вестник';
    const desc = 'Тази страница не съществува. Върнете се към началната страница, за да разгледате обобщенията на броевете на Държавен вестник.';
    const body = `<section class="not-found-section">
                    <p class="not-found-eyebrow">Грешка 404</p>
                    <h2 class="not-found-title">Тази страница я няма в изданието</h2>
                    <p class="not-found-text">Възможно е броят, който търсите, никога да не е съществувал или връзката да е остаряла. Върнете се към началната страница, за да разгледате наличните броеве.</p>
                    <p><a class="not-found-link" href="/">Към началната страница →</a></p>
                </section>`;
    let html = cleanTemplate;
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(title)}$2`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(desc)}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(desc)}$2`);

    // 404.html is served under whatever URL the visitor asked for, so it must
    // not claim the homepage as its canonical — that reads as a soft 404. Drop
    // the canonical and og:url outright and keep the page out of the index.
    html = html.replace(/\s*<link rel="canonical" href="[^"]*"\s*\/>/, '');
    html = html.replace(/\s*<meta property="og:url" content="[^"]*"\s*\/>/, '');
    html = html.replace('</head>', '    <meta name="robots" content="noindex" />\n</head>');

    return replaceHomeContent(html, body);
}

function inlineCriticalCss(html) {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    return html.replace(
        /(<!--CRITICAL-CSS-START-->)[\s\S]*?(<!--CRITICAL-CSS-END-->)/,
        `$1<style>${css}</style>$2`
    );
}

function getAllIssuesNewestFirst(catalog) {
    if (!catalog || !catalog.years) return [];
    const years = Object.keys(catalog.years).sort((a, b) => Number(b) - Number(a));
    const list = [];
    years.forEach((year) => {
        catalog.years[year]
            .slice()
            .sort((a, b) => Number(b.issue) - Number(a.issue))
            .forEach((item) => list.push({ ...item, year }));
    });
    return list;
}

function buildHomeContentHtml(catalog) {
    const all = getAllIssuesNewestFirst(catalog);
    if (!all.length) {
        return '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
    }

    const older = all.slice(1);
    let html = renderLeadCard(all[0]);
    html += renderDeadlinesSection(all, new Date().toISOString().slice(0, 10));

    if (older.length) {
        const byYear = {};
        older.forEach((item) => {
            if (!byYear[item.year]) byYear[item.year] = [];
            byYear[item.year].push(item);
        });
        const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
        const total = older.length;

        html += '<section class="archive-section" id="archive">';
        html += `<div class="section-head"><h2 class="section-title">Архив</h2><span class="section-count">${total} ${total === 1 ? 'брой' : 'броя'}</span></div>`;
        html += '<div class="archive-search"><input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене по тема, дата или номер на брой…" aria-label="Търсене в архива" autocomplete="off" spellcheck="false" /></div>';
        years.forEach((year) => {
            html += `<div class="year-group"><h3 class="year-title"><span>${escapeHtml(year)}</span></h3><div class="issue-list">`;
            byYear[year].forEach((item) => { html += renderRowCard(item); });
            html += '</div></div>';
        });
        html += '</section>';
    }

    return html;
}

const CONTENT_DISCLAIMER = '<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';
const END_MARK = '<p class="end-mark" aria-hidden="true">◼</p>';

function buildIssueViewInner(item, prev, next) {
    const md = fs.readFileSync(path.join(ROOT, item.file), 'utf8');
    const rawHtml = marked.parse(md);
    const { html: processedHtml, tocItems } = processRenderedContent(rawHtml);
    const taggedHtml = injectSectionTags(processedHtml, item.sections);
    const contentHtml = CONTENT_DISCLAIMER + buildTocHtml(tocItems) + taggedHtml + END_MARK;

    const topics = Array.isArray(item.topics) ? item.topics : [];
    const meta = ['Обобщение с AI'];
    if (topics.length) meta.push(pluralTopics(topics.length));
    meta.push('≈ ' + readingMinutes(md) + ' мин четене');
    const metaHtml = meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('<span class="sep">·</span>');

    const headerHtml = `<p class="issue-kicker"><span>Брой ${escapeHtml(String(item.issue))}</span><span class="rule"></span><span>Държавен вестник</span></p>` +
        `<h1 class="title"><span class="visually-hidden">Държавен вестник, брой ${escapeHtml(String(item.issue))} — </span>${escapeHtml(formatDateLong(item.date))}</h1>` +
        `<p class="issue-meta" id="issue-meta">${metaHtml}</p>` +
        renderTags(item.audiences) +
        renderPlaces(item.places);

    // The deadlines this issue starts, in the issue itself — a reader who lands
    // here from a search should not have to go back to the front page for them.
    const openDeadlines = (item.deadlines || []).filter((d) => d.expires >= new Date().toISOString().slice(0, 10));
    const deadlinesHtml = openDeadlines.length
        ? `<section class="issue-deadlines"><p class="issue-deadlines-title">Срокове от този брой</p><ul class="deadline-list">${openDeadlines.map((d) => renderDeadlineRow(d, item, false)).join('')}</ul></section>`
        : '';

    let navHtml = '';
    if (prev) navHtml += `<div class="issue-nav-group is-prev"><span class="nav-label">← Предишен брой</span>${renderNavCard(prev)}</div>`;
    if (next) navHtml += `<div class="issue-nav-group is-next"><span class="nav-label">Следващ брой →</span>${renderNavCard(next)}</div>`;

    return `
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към всички броеве">← Всички броеве</button>
                </div>
                <div class="issue-header" id="issue-header">${headerHtml}</div>
                <div id="issue-deadlines">${deadlinesHtml}</div>
                <article class="content" id="content">${contentHtml}</article>
                <div class="issue-share" id="issue-share">${renderShare(item)}</div>
                <div id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве">${navHtml}</div>
                <div class="back-bar back-bar-bottom">
                    <button type="button" class="back-btn" id="back-btn-bottom" aria-label="Обратно към всички броеве">← Всички броеве</button>
                </div>`;
}

function buildIssuePage(template, item, prev, next) {
    const titleDate = formatDateLong(item.date);
    const pageTitle = `Брой ${item.issue} · ${titleDate} — ${PAGE_TITLE_BASE}`;
    const canonicalUrl = `${SITE_ORIGIN}/issue/${item.year}/${item.issue}/`;
    const ogImage = `${SITE_ORIGIN}/og-image.png`;
    const isoDate = issueDateToIso(item.date);

    // Unique, content-rich description per issue (kills duplicate snippets).
    const topics = extractTopicsFromFile(item.file);
    const lead = topics[0] || `Брой ${item.issue}`;
    const metaDesc = truncate(
        `Държавен вестник, брой ${item.issue} от ${titleDate}: ` + (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.'),
        160
    );

    let html = template;

    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(metaDesc)}$2`);
    html = html.replace(/(<meta property="og:type" content=")[^"]*("\s*\/>)/, `$1article$2`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(pageTitle)}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(metaDesc)}$2`);
    html = html.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(canonicalUrl)}$2`);
    html = html.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${escapeHtml(canonicalUrl)}$2`);

    const articleLd = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: truncate(`Държавен вестник, брой ${item.issue} · ${titleDate}` + (topics.length ? ` — ${lead}` : ''), 110),
        description: metaDesc,
        url: canonicalUrl,
        mainEntityOfPage: canonicalUrl,
        inLanguage: 'bg',
        image: [ogImage],
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
        publisher: { '@id': `${SITE_ORIGIN}/#org` },
        author: { '@id': `${SITE_ORIGIN}/#org` }
    };
    if (topics.length) articleLd.articleSection = topics.slice(0, 12);
    if (isoDate) {
        articleLd.datePublished = isoDate;
        articleLd.dateModified = isoDate;
    }
    let headExtras = `<script type="application/ld+json">${JSON.stringify(articleLd)}</script>`;
    if (isoDate) headExtras = `<meta property="article:published_time" content="${isoDate}" />\n    ${headExtras}`;
    html = html.replace('</head>', `    ${headExtras}\n</head>`);

    // Pre-apply the issue-open and issue-ready classes so initial paint shows the article.
    html = html.replace(/<body(\s|>)/, '<body class="issue-open issue-ready"$1');

    // The nameplate is only hidden by CSS here, so its <h1> stays in the markup.
    // Demote it: an issue page's one heading is the article's own.
    html = html.replace('<h1 class="masthead-title">', '<p class="masthead-title">')
        .replace(/(<p class="masthead-title">[\s\S]*?)<\/h1>/, '$1</p>');

    const innerHtml = buildIssueViewInner(item, prev, next);
    html = html.replace(/(<div id="issue-view">)[\s\S]*?(<\/div>\s*<div class="loading")/, `$1${innerHtml}\n            $2`);

    return html;
}

function issueDateToIso(str) {
    if (!str || typeof str !== 'string') return null;
    const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (dotMatch) {
        return `${dotMatch[3]}-${dotMatch[2].padStart(2, '0')}-${dotMatch[1].padStart(2, '0')}`;
    }
    const bgMatch = str.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})/);
    if (bgMatch) {
        const day = bgMatch[1].padStart(2, '0');
        const monthIdx = BG_MONTHS.indexOf(bgMatch[2].toLowerCase());
        if (monthIdx >= 0) {
            const mm = String(monthIdx + 1).padStart(2, '0');
            return `${bgMatch[3]}-${mm}-${day}`;
        }
    }
    return null;
}

function buildSitemapXml(catalog) {
    const all = getAllIssuesNewestFirst(catalog);
    const today = new Date().toISOString().slice(0, 10);
    const latestIso = all.length ? (issueDateToIso(all[0].date) || today) : today;
    const urls = [];
    urls.push(`  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${latestIso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`);
    urls.push(`  <url>\n    <loc>${SITE_ORIGIN}/deadlines/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`);
    for (const item of all) {
        const iso = issueDateToIso(item.date) || today;
        const loc = `${SITE_ORIGIN}/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
        urls.push(`  <url>\n    <loc>${loc}</loc>\n    <lastmod>${iso}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

const FEED_TITLE = 'Държавен вестник — обобщения на броеве';
const FEED_DESC = 'Кратки обобщения на всеки брой на Държавен вестник, генерирани с изкуствен интелект — новите закони, правила и решения, обяснени ясно.';
const RSS_ITEM_LIMIT = 50;

// Issue dates are day-precision; noon UTC keeps the item on the right calendar
// day in every timezone a reader's feed app might render it in.
function issueDateToRfc822(item, todayIso) {
    const iso = issueDateToIso(item.date) || todayIso;
    const d = new Date(iso + 'T12:00:00Z');
    return Number.isNaN(d.getTime()) ? new Date(todayIso + 'T12:00:00Z').toUTCString() : d.toUTCString();
}

// A standard RSS 2.0 feed, newest issues first — for readers and journalists
// who follow the gazette rather than visiting the site.
function buildRssXml(catalog) {
    const all = getAllIssuesNewestFirst(catalog).slice(0, RSS_ITEM_LIMIT);
    const todayIso = new Date().toISOString().slice(0, 10);
    const lastBuild = all.length ? issueDateToRfc822(all[0], todayIso) : new Date(todayIso + 'T12:00:00Z').toUTCString();
    const items = all.map((item) => {
        const topics = Array.isArray(item.topics) ? item.topics : [];
        const title = topics[0] || item.lead || `Брой ${item.issue}`;
        const link = `${SITE_ORIGIN}/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
        const desc = truncate(
            `Държавен вестник, брой ${item.issue} от ${formatDateLong(item.date)}: ` + (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.'),
            500
        );
        return `  <item>\n    <title>${escapeHtml(title)}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${issueDateToRfc822(item, todayIso)}</pubDate>\n    <description>${escapeHtml(desc)}</description>\n  </item>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n  <title>${escapeHtml(FEED_TITLE)}</title>\n  <link>${SITE_ORIGIN}/</link>\n  <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />\n  <description>${escapeHtml(FEED_DESC)}</description>\n  <language>bg</language>\n  <lastBuildDate>${lastBuild}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`;
}

// ─── Deadlines page (/deadlines/) ───
// Every open deadline across all issues, one place, grouped by month. Reuses
// the same row (incl. the "＋ Календар" .ics) the homepage and issues render.

function deadlineMonthLabel(iso) {
    const m = /^(\d{4})-(\d{2})/.exec(iso || '');
    if (!m) return { key: '0000-00', label: '' };
    return { key: `${m[1]}-${m[2]}`, label: `${BG_MONTHS_CAP[parseInt(m[2], 10) - 1]} ${m[1]}` };
}

function buildDeadlinesPageInner(catalog, todayIso) {
    const all = getAllIssuesNewestFirst(catalog);
    const rows = collectDeadlines(all, todayIso);
    const total = rows.length;
    const head = '<div class="deadlines-page-top"><a class="deadlines-back" href="/">← Начало</a></div>' +
        '<div class="section-head"><h1 class="section-title">Срокове, които текат</h1>' +
        `<span class="section-count">${total} ${total === 1 ? 'срок' : 'срока'}</span></div>` +
        '<p class="deadlines-note">Всички срокове, в които все още можеш да направиш нещо — възражение, обжалване, заявление. Изчислени от датата на броя; за сигурност проверете самия брой.</p>';
    if (!total) {
        return `<section class="deadlines-page" id="deadlines-page">${head}<p class="empty">В момента няма отворени срокове.</p></section>`;
    }
    const order = [];
    const byKey = new Map();
    for (const { d, item } of rows) {
        const { key, label } = deadlineMonthLabel(d.expires);
        if (!byKey.has(key)) { byKey.set(key, { label, items: [] }); order.push(key); }
        byKey.get(key).items.push({ d, item });
    }
    const groups = order.map((key) => {
        const g = byKey.get(key);
        const list = g.items.map(({ d, item }) => renderDeadlineRow(d, item)).join('');
        return `<div class="month-group"><h2 class="month-title">${escapeHtml(g.label)}</h2><ul class="deadline-list">${list}</ul></div>`;
    }).join('');
    return `<section class="deadlines-page" id="deadlines-page">${head}${groups}</section>`;
}

function buildDeadlinesPage(cleanTemplate, catalog) {
    const title = 'Срокове, които текат — Държавен вестник';
    const desc = 'Всички отворени срокове от Държавен вестник, групирани по месец — възражения, обжалвания и заявления, докато все още можеш да ги подадеш.';
    const canonicalUrl = `${SITE_ORIGIN}/deadlines/`;
    let html = cleanTemplate;
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(desc)}$2`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(title)}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(desc)}$2`);
    html = html.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(canonicalUrl)}$2`);
    html = html.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${escapeHtml(canonicalUrl)}$2`);

    // The page's one heading is "Срокове…", so demote the nameplate to a <p>
    // (as issue pages do). A body class hides the masthead and tells app.js to
    // leave the pre-rendered content alone instead of rendering the home over it.
    html = html.replace('<h1 class="masthead-title">', '<p class="masthead-title">')
        .replace(/(<p class="masthead-title">[\s\S]*?)<\/h1>/, '$1</p>');
    html = html.replace(/<body(\s|>)/, '<body class="deadlines-route"$1');

    return replaceHomeContent(html, buildDeadlinesPageInner(catalog, new Date().toISOString().slice(0, 10)));
}

function build() {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const rawTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // Strip any pre-rendered home content so the template is clean for issue pages
    // and as the base for a fresh homepage build. Inline the stylesheet so it
    // doesn't block initial render.
    const cleanTemplate = inlineCriticalCss(replaceHomeContent(rawTemplate, ''));
    const all = getAllIssuesNewestFirst(catalog);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let count = 0;
    for (let idx = 0; idx < all.length; idx++) {
        const entry = all[idx];
        const prev = idx + 1 < all.length ? all[idx + 1] : null;
        const next = idx > 0 ? all[idx - 1] : null;

        const html = buildIssuePage(cleanTemplate, entry, prev, next);
        const dir = path.join(OUTPUT_DIR, String(entry.year), String(entry.issue));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
        count++;
    }

    // Pre-render homepage with the full issue list so crawlers see all internal links.
    const homeHtml = replaceHomeContent(cleanTemplate, buildHomeContentHtml(catalog));
    fs.writeFileSync(TEMPLATE_PATH, homeHtml, 'utf8');

    fs.mkdirSync(DEADLINES_PAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEADLINES_PAGE_DIR, 'index.html'), buildDeadlinesPage(cleanTemplate, catalog), 'utf8');

    fs.writeFileSync(SITEMAP_PATH, buildSitemapXml(catalog), 'utf8');
    fs.writeFileSync(RSS_PATH, buildRssXml(catalog), 'utf8');
    fs.writeFileSync(NOT_FOUND_PATH, buildNotFoundHtml(cleanTemplate), 'utf8');

    console.log(`[build-issue-pages] Wrote ${count} pages to ${OUTPUT_DIR}, updated ${TEMPLATE_PATH}, wrote ${SITEMAP_PATH}, ${RSS_PATH}, deadlines/index.html and ${NOT_FOUND_PATH}`);
    return count;
}

(async () => {
    try {
        appendLog(SCRIPT_NAME, 'Starting issue pages build', 'INFO');
        const n = build();
        appendLog(SCRIPT_NAME, `Wrote ${n} issue pages`, 'OK');
    } catch (e) {
        appendLog(SCRIPT_NAME, 'Failed: ' + (e && (e.message || String(e))), 'ERROR');
        console.error('[build-issue-pages]', e.message || e);
        await flushAlertEmail();
        process.exit(1);
    }
})();
