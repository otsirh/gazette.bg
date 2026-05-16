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
    return `<button type="button" class="issue-card${variantClass}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}">
            <span class="num">Брой ${escapeHtml(String(item.issue))}</span>
            <span class="date">${escapeHtml(displayDate)}</span>
            ${readTime}
        </button>`;
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

function buildIssueViewInner(item, prev, next) {
    const formattedDate = formatDateBulgarian(item.date);
    const titleDate = stripDateSuffix(formattedDate);
    const readTimeStr = item.readMinutes != null ? ` · ${escapeHtml(formatReadTime(item.readMinutes))}` : '';
    const headerHtml = `<div class="meta">Брой ${escapeHtml(String(item.issue))}<span class="issue-read-time" id="issue-read-time">${readTimeStr}</span></div><div class="title">${escapeHtml(titleDate)}</div>`;

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

    return `
                <div class="read-progress-bar" id="read-progress-bar" role="progressbar" aria-label="Прогрес при четене" aria-valuemin="0" aria-valuemax="100">
                    <div class="read-progress-fill" id="read-progress-fill"></div>
                </div>
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>
                <div class="issue-header" id="issue-header">${headerHtml}</div>
                <div class="content" id="content">${contentHtml}</div>
                <div id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве"${navAttrs}>${navHtml}</div>
                <div class="back-bar back-bar-bottom">
                    <button type="button" class="back-btn" id="back-btn-bottom" aria-label="Обратно към началната страница">← Обратно към началната страница</button>
                </div>`;
}

function buildIssuePage(template, item, prev, next) {
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

    const innerHtml = buildIssueViewInner(item, prev, next);
    html = html.replace(/(<div id="issue-view">)[\s\S]*?(<\/div>\s*<div class="loading")/, `$1${innerHtml}\n            $2`);

    return html;
}

function build() {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const all = getAllIssuesNewestFirst(catalog);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let count = 0;
    for (const entry of all) {
        const idx = all.findIndex((it) => it.year === entry.year && it.issue === entry.issue);
        const prev = idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null;
        const next = idx > 0 ? all[idx - 1] : null;

        const html = buildIssuePage(template, entry, prev, next);
        const dir = path.join(OUTPUT_DIR, String(entry.year), String(entry.issue));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
        count++;
    }

    console.log(`[build-issue-pages] Wrote ${count} pages to ${OUTPUT_DIR}`);
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
