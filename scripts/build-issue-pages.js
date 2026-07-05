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
const CSS_PATH = path.join(ROOT, 'src', 'css', 'styles.css');
const NOT_FOUND_PATH = path.join(ROOT, '404.html');

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

const SITE_ORIGIN = 'https://gazette.bg';
const PAGE_TITLE_BASE = 'Обобщения на Държавен вестник';

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

function formatDateForHomepage(str) {
    if (!str || typeof str !== 'string') return str;
    const s = stripDateSuffix(str);
    return lowercaseMonthInDate(s.replace(/\s+\d{4}\s*$/, '').trim());
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

function buildTocHtml(tocItems) {
    const mainItems = tocItems.filter((item) => item.level <= 2);
    if (!mainItems.length) return '';
    let html = '<nav class="issue-toc" aria-label="Съдържание на броя"><div class="issue-toc-title">Съдържание</div><ul class="issue-toc-list">';
    for (const item of mainItems) {
        html += `<li class="issue-toc-item"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
    }
    html += '</ul></nav>';
    return html;
}

const HERO_TOPIC_LIMIT = 5;

function renderIssueCard(item, variant) {
    const variantClass = variant ? ' issue-card-' + variant : '';
    const displayDate = formatDateForHomepage(formatDateBulgarian(item.date));
    const href = `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const attrs = `href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}"`;
    const num = `<span class="num">Брой ${escapeHtml(String(item.issue))}</span>`;
    const date = `<span class="date">${escapeHtml(displayDate)}</span>`;

    if (variant === 'hero') {
        let body = '';
        if (item.lead) body += `<span class="issue-card-lead">${escapeHtml(item.lead)}</span>`;
        if (topics.length) {
            const shown = topics.slice(0, HERO_TOPIC_LIMIT);
            const rest = topics.length - shown.length;
            let items = shown.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
            if (rest > 0) items += `<li class="more">+ още ${rest} ${rest === 1 ? 'тема' : 'теми'}</li>`;
            body += `<span class="issue-card-topics-label">В броя</span><ul class="issue-card-topics">${items}</ul>`;
        }
        return `<a class="issue-card${variantClass}" ${attrs}>${num}${date}${body}</a>`;
    }

    if (variant === 'row') {
        const preview = item.lead || topics[0] || '';
        const previewHtml = preview ? `<span class="row-preview">${escapeHtml(preview)}</span>` : '';
        return `<a class="issue-card${variantClass}" ${attrs}>${num}<span class="row-body">${date}${previewHtml}</span></a>`;
    }

    return `<a class="issue-card${variantClass}" ${attrs}>${num}${date}</a>`;
}

function replaceHomeContent(html, content) {
    return html.replace(/(<!--HOME-CONTENT-START-->)[\s\S]*?(<!--HOME-CONTENT-END-->)/, `$1${content}$2`);
}

function buildNotFoundHtml(cleanTemplate) {
    const body = `<section class="not-found-section">
                    <p class="not-found-eyebrow">404</p>
                    <h2 class="not-found-title">Страницата не е намерена</h2>
                    <p class="not-found-text">Възможно е броят, който търсите, никога да не е съществувал или връзката да е остаряла. Върнете се към началната страница, за да разгледате наличните броеве на Държавен вестник.</p>
                    <p class="not-found-actions"><a class="not-found-link" href="/">← Към началната страница</a></p>
                </section>`;
    let html = cleanTemplate;
    html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>Страницата не е намерена — Държавен вестник</title>');
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, '$1Страницата не е намерена — Държавен вестник$2');
    html = replaceHomeContent(html, body);
    return html;
}

function inlineCriticalCss(html) {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    return html.replace(
        /(<!--CRITICAL-CSS-START-->)[\s\S]*?(<!--CRITICAL-CSS-END-->)/,
        `$1<style>${css}</style>$2`
    );
}

function buildHomeContentHtml(catalog) {
    const all = getAllIssuesNewestFirst(catalog);
    if (all.length === 0) {
        return '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
    }
    const latest = all[0];
    const older = all.slice(1);
    const byYear = {};
    older.forEach((item) => {
        if (!byYear[item.year]) byYear[item.year] = [];
        byYear[item.year].push(item);
    });
    const yearKeys = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));

    let html = '<section class="hero-section">';
    html += '<div class="section-eyebrow">Последен брой</div>';
    html += renderIssueCard(latest, 'hero');
    html += '</section>';

    if (yearKeys.length) {
        html += '<section class="archive-section">';
        html += '<h2 class="section-title">Архив</h2>';
        html += '<div class="archive-search"><input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене по тема, дата или брой…" aria-label="Търсене в архива" autocomplete="off" spellcheck="false" /></div>';
        yearKeys.forEach((year) => {
            html += `<div class="year-group"><h3 class="year-title">${escapeHtml(year)}</h3><div class="issue-list">`;
            byYear[year].forEach((item) => { html += renderIssueCard(item, 'row'); });
            html += '</div></div>';
        });
        html += '</section>';
    }
    return html;
}

function getAllIssuesNewestFirst(catalog) {
    if (!catalog || !catalog.years) return [];
    const years = Object.keys(catalog.years).sort((a, b) => Number(b) - Number(a));
    const list = [];
    years.forEach((year) => {
        const issues = catalog.years[year].slice().sort((a, b) => Number(b.issue) - Number(a.issue));
        issues.forEach((item) => list.push({ ...item, year }));
    });
    return list;
}

const CONTENT_DISCLAIMER = '<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';

function buildIssueViewInner(item, prev, next, related) {
    const formattedDate = formatDateBulgarian(item.date);
    const titleDate = stripDateSuffix(formattedDate);
    const headerHtml = `<div class="meta">Брой ${escapeHtml(String(item.issue))}</div><div class="title">${escapeHtml(titleDate)}</div>`;

    const mdPath = path.join(ROOT, item.file);
    const md = fs.readFileSync(mdPath, 'utf8');
    const rawHtml = marked.parse(md);
    const { html: processedHtml, tocItems } = processRenderedContent(rawHtml);
    const tocHtml = buildTocHtml(tocItems);
    const contentHtml = CONTENT_DISCLAIMER + tocHtml + processedHtml;

    let navHtml = '';
    if (prev) {
        navHtml += `<div class="issue-nav-group"><div class="issue-nav-title">← Предишен брой</div><div class="issue-cards">${renderIssueCard(prev)}</div></div>`;
    }
    if (next) {
        navHtml += `<div class="issue-nav-group"><div class="issue-nav-title">Следващ брой →</div><div class="issue-cards">${renderIssueCard(next)}</div></div>`;
    }
    let relatedHtml = '';
    if (related && related.length) {
        let cards = '';
        related.forEach((it) => { cards += renderIssueCard(it, 'row'); });
        relatedHtml = `<section class="issue-related" id="issue-related" aria-label="Скорошни броеве"><h2 class="section-title">Скорошни броеве</h2><div class="issue-list">${cards}</div><p class="issue-related-all"><a href="/">Виж всички броеве →</a></p></section>`;
    }

    return `
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>
                <div class="issue-header" id="issue-header">${headerHtml}</div>
                <div class="content" id="content">${contentHtml}</div>
                <div id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве">${navHtml}</div>
                ${relatedHtml}
                <div class="back-bar back-bar-bottom">
                    <button type="button" class="back-btn" id="back-btn-bottom" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>`;
}

function buildIssuePage(template, item, prev, next, related) {
    const formattedDate = formatDateBulgarian(item.date);
    const titleDate = stripDateSuffix(formattedDate);
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

    const innerHtml = buildIssueViewInner(item, prev, next, related);
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
        const monthName = bgMatch[2].toLowerCase();
        const monthIdx = BG_MONTHS.indexOf(monthName);
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
    for (const item of all) {
        const iso = issueDateToIso(item.date) || today;
        const loc = `${SITE_ORIGIN}/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
        urls.push(`  <url>\n    <loc>${loc}</loc>\n    <lastmod>${iso}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
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
    for (const entry of all) {
        const idx = all.findIndex((it) => it.year === entry.year && it.issue === entry.issue);
        const prev = idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null;
        const next = idx > 0 ? all[idx - 1] : null;
        const related = all.filter((_, i) => i !== idx && i !== idx - 1 && i !== idx + 1).slice(0, 6);

        const html = buildIssuePage(cleanTemplate, entry, prev, next, related);
        const dir = path.join(OUTPUT_DIR, String(entry.year), String(entry.issue));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
        count++;
    }

    // Pre-render homepage with the full issue list so crawlers see all internal links.
    const homeHtml = replaceHomeContent(cleanTemplate, buildHomeContentHtml(catalog));
    fs.writeFileSync(TEMPLATE_PATH, homeHtml, 'utf8');

    fs.writeFileSync(SITEMAP_PATH, buildSitemapXml(catalog), 'utf8');
    fs.writeFileSync(NOT_FOUND_PATH, buildNotFoundHtml(cleanTemplate), 'utf8');

    console.log(`[build-issue-pages] Wrote ${count} pages to ${OUTPUT_DIR}, updated ${TEMPLATE_PATH}, wrote ${SITEMAP_PATH} and ${NOT_FOUND_PATH}`);
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
