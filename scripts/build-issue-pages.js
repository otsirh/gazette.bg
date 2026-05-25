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

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

const SITE_ORIGIN = 'https://gazette.bg';
const PAGE_TITLE_BASE = 'Обобщения на Държавен вестник';

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function formatReadTime(minutes) {
    if (minutes < 1) return 'по-малко от 1 мин';
    if (minutes === 1) return '1 мин четене';
    if (minutes < 60) return minutes + ' мин четене';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (m === 0) return h + ' ч четене';
    return h + ' ч ' + m + ' мин четене';
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

function processRenderedContent(html) {
    // Promote any h1 to h2, assign unique heading IDs, collect TOC items
    html = html.replace(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
    const used = new Set();
    const tocItems = [];
    html = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (m, level, attrs, inner) => {
        const text = inner.replace(/<[^>]+>/g, '').trim();
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

function renderIssueCard(item, variant) {
    const readTime = item.readMinutes != null ? `<span class="read-time">${escapeHtml(formatReadTime(item.readMinutes))}</span>` : '';
    const variantClass = variant ? ' issue-card-' + variant : '';
    const displayDate = formatDateForHomepage(formatDateBulgarian(item.date));
    const href = `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}`;
    return `<a class="issue-card${variantClass}" href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}">
            <span class="num">Брой ${escapeHtml(String(item.issue))}</span>
            <span class="date">${escapeHtml(displayDate)}</span>
            ${readTime}
        </a>`;
}

function replaceHomeContent(html, content) {
    return html.replace(/(<!--HOME-CONTENT-START-->)[\s\S]*?(<!--HOME-CONTENT-END-->)/, `$1${content}$2`);
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

const SHARE_ICONS = {
    fb: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.3-1.5 1.6-1.5h1.7V3.6c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1V9.9H7.7V13h2.7v8h3.1z"/></svg>',
    li: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 2h-17C2.7 2 2 2.7 2 3.5v17c0 .8.7 1.5 1.5 1.5h17c.8 0 1.5-.7 1.5-1.5v-17c0-.8-.7-1.5-1.5-1.5zM8 19H5V9h3v10zM6.5 7.7C5.5 7.7 4.7 7 4.7 6S5.5 4.3 6.5 4.3 8.3 5 8.3 6s-.8 1.7-1.8 1.7zM19 19h-3v-5c0-1.2-.4-2-1.5-2-.8 0-1.3.6-1.5 1.1-.1.2-.1.5-.1.7V19h-3V9h3v1.3c.4-.6 1.1-1.5 2.7-1.5 2 0 3.4 1.3 3.4 4V19z"/></svg>',
    x: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
};

function renderShareLinks(url, title) {
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(title);
    return `<div class="issue-share" id="issue-share" aria-label="Споделяне">
                    <span class="issue-share-label">Споделете:</span>
                    <a class="share-link share-fb" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener" aria-label="Споделяне във Facebook" title="Споделяне във Facebook">${SHARE_ICONS.fb}</a>
                    <a class="share-link share-li" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener" aria-label="Споделяне в LinkedIn" title="Споделяне в LinkedIn">${SHARE_ICONS.li}</a>
                    <a class="share-link share-x" href="https://twitter.com/intent/tweet?url=${u}&text=${t}" target="_blank" rel="noopener" aria-label="Споделяне в X" title="Споделяне в X">${SHARE_ICONS.x}</a>
                </div>`;
}

function buildIssueViewInner(item, prev, next, related) {
    const formattedDate = formatDateBulgarian(item.date);
    const titleDate = stripDateSuffix(formattedDate);
    const readTimeStr = item.readMinutes != null ? ` · ${escapeHtml(formatReadTime(item.readMinutes))}` : '';
    const headerHtml = `<div class="meta">Брой ${escapeHtml(String(item.issue))}<span class="issue-read-time" id="issue-read-time">${readTimeStr}</span></div><div class="title">${escapeHtml(titleDate)}</div>`;
    const canonicalUrl = `${SITE_ORIGIN}/issue/${item.year}/${item.issue}`;
    const shareTitle = `Държавен вестник, брой ${item.issue} · ${titleDate} — обобщение`;
    const shareHtml = renderShareLinks(canonicalUrl, shareTitle);

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
    const navAttrs = (prev || next) ? '' : ' style="display:none;"';

    let relatedHtml = '';
    if (related && related.length) {
        let cards = '';
        related.forEach((it) => { cards += renderIssueCard(it, 'row'); });
        relatedHtml = `<section class="issue-related" id="issue-related" aria-label="Скорошни броеве"><h2 class="section-title">Скорошни броеве</h2><div class="issue-list">${cards}</div><p class="issue-related-all"><a href="/">Виж всички броеве →</a></p></section>`;
    }

    return `
                <div class="read-progress-bar" id="read-progress-bar" role="progressbar" aria-label="Прогрес при четене" aria-valuemin="0" aria-valuemax="100">
                    <div class="read-progress-fill" id="read-progress-fill"></div>
                </div>
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>
                <div class="issue-header" id="issue-header">${headerHtml}</div>
                ${shareHtml}
                <div class="content" id="content">${contentHtml}</div>
                <div id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве"${navAttrs}>${navHtml}</div>
                ${relatedHtml}
                <div class="back-bar back-bar-bottom">
                    <button type="button" class="back-btn" id="back-btn-bottom" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>`;
}

function buildIssuePage(template, item, prev, next, related) {
    const formattedDate = formatDateBulgarian(item.date);
    const titleDate = stripDateSuffix(formattedDate);
    const pageTitle = `Брой ${item.issue} · ${titleDate} — ${PAGE_TITLE_BASE}`;
    const canonicalUrl = `${SITE_ORIGIN}/issue/${item.year}/${item.issue}`;

    let html = template;

    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(pageTitle)}$2`);
    html = html.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${escapeHtml(canonicalUrl)}$2`);

    // Pre-apply the issue-open and issue-ready classes so initial paint shows the article.
    html = html.replace(/<body(\s|>)/, '<body class="issue-open issue-ready"$1');

    // Hide home-view inline so it doesn't flash before CSS computed styles apply.
    html = html.replace('<div id="home-view" class="home-section">', '<div id="home-view" class="home-section" style="display:none;">');

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
        const loc = `${SITE_ORIGIN}/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}`;
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

    console.log(`[build-issue-pages] Wrote ${count} pages to ${OUTPUT_DIR}, updated ${TEMPLATE_PATH}, wrote ${SITEMAP_PATH}`);
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
