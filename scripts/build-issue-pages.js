#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import {
    buildTocHtml,
    CONTENT_DISCLAIMER,
    END_MARK,
    escapeHtml,
    formatDateLong,
    issueDateToIso,
    issuePath,
    issuesNewestFirst,
    issueTitle,
    readingMinutes,
    renderHomeContent,
    renderIssueHeader,
    renderIssueNav,
    slugify,
    stripMarkdownInline,
} from '../src/js/shared.js';
import { isMain } from './lib/cli.js';
import { ROOT } from './lib/issues.js';

const TEMPLATE_PATH = path.join(ROOT, 'src', 'index.html');
const CSS_PATH = path.join(ROOT, 'src', 'css', 'styles.css');
// dist/ is the site. Only what is written or copied here is published —
// scripts, prompts and workflow files stay in the repo and off the web.
const DIST_DIR = path.join(ROOT, 'dist');
// Files the pages load by URL, copied as-is to the same path under dist/,
// plus _headers, which Pages reads from the output root. The summaries
// themselves are copied per issue from the catalog.
const STATIC_ASSETS = [
    '_headers',
    'apple-touch-icon.png',
    'favicon.ico',
    'favicon.svg',
    'og-image.png',
    'robots.txt',
    'fonts',
    'src/js/app.js',
    'src/js/shared.js',
];

const SITE_ORIGIN = 'https://gazette.bg';

// Anything spliced into a String.replace() replacement is data, not a pattern.
// A summary that writes "глоба до $1 000 лв." would otherwise have its "$1"
// read as a capture reference and rewrite the page around it — and "$&" or "$'"
// would splice whole chunks of the template into the article. Escaping the
// dollar makes the value literal; the $1/$2 written in the templates below stay
// capture references, which is what they are meant to be.
function lit(s) {
    return String(s).replace(/\$/g, '$$$$');
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
    } catch {
        return [];
    }
}

function truncate(s, max) {
    const clean = String(s).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).replace(/[\s.,;:–-]+$/, '')}…`;
}

function processRenderedContent(html) {
    // Promote any h1 to h2, assign unique heading IDs, collect TOC items
    html = html.replace(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
    const used = new Set();
    const tocItems = [];
    html = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_m, level, attrs, inner) => {
        const text = htmlToText(inner);
        let id = slugify(text);
        if (used.has(id)) {
            let n = 2;
            while (used.has(`${id}-${n}`)) n++;
            id = `${id}-${n}`;
        }
        used.add(id);
        tocItems.push({ level: parseInt(level, 10), text, id });
        const attrStr = attrs || '';
        return `<h${level}${attrStr} id="${escapeHtml(id)}">${inner}</h${level}>`;
    });
    return { html, tocItems };
}

function replaceHomeContent(html, content) {
    return html.replace(/(<!--HOME-CONTENT-START-->)[\s\S]*?(<!--HOME-CONTENT-END-->)/, `$1${lit(content)}$2`);
}

function buildNotFoundHtml(cleanTemplate) {
    const title = 'Страницата не е намерена — Държавен вестник';
    const desc =
        'Тази страница не съществува. Върнете се към началната страница, за да разгледате обобщенията на броевете на Държавен вестник.';
    const body = `<section class="not-found-section">
                    <p class="not-found-eyebrow">Грешка 404</p>
                    <h2 class="not-found-title">Тази страница я няма в изданието</h2>
                    <p class="not-found-text">Възможно е броят, който търсите, никога да не е съществувал или връзката да е остаряла. Върнете се към началната страница, за да разгледате наличните броеве.</p>
                    <p><a class="not-found-link" href="/">Към началната страница →</a></p>
                </section>`;
    let html = cleanTemplate;
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${lit(title)}</title>`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(title))}$2`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(desc))}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(desc))}$2`);

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
        `$1<style>${lit(css)}</style>$2`,
    );
}

function buildIssueViewInner(item, prev, next) {
    const md = fs.readFileSync(path.join(ROOT, item.file), 'utf8');
    const { html: processedHtml, tocItems } = processRenderedContent(marked.parse(md));
    const contentHtml = CONTENT_DISCLAIMER + buildTocHtml(tocItems) + processedHtml + END_MARK;

    return `
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към всички броеве">← Всички броеве</button>
                </div>
                <div class="issue-header" id="issue-header">${renderIssueHeader(item, readingMinutes(md))}</div>
                <article class="content" id="content">${contentHtml}</article>
                <nav id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве">${renderIssueNav(prev, next)}</nav>
                <div class="back-bar back-bar-bottom">
                    <button type="button" class="back-btn" id="back-btn-bottom" aria-label="Обратно към всички броеве">← Всички броеве</button>
                </div>`;
}

function buildIssuePage(template, item, prev, next) {
    const titleDate = formatDateLong(item.date);
    const pageTitle = issueTitle(item);
    const canonicalUrl = SITE_ORIGIN + issuePath(item);
    const ogImage = `${SITE_ORIGIN}/og-image.png`;
    const isoDate = issueDateToIso(item.date);

    // Unique, content-rich description per issue (kills duplicate snippets).
    const topics = extractTopicsFromFile(item.file);
    const lead = topics[0] || `Брой ${item.issue}`;
    const metaDesc = truncate(
        `Държавен вестник, брой ${item.issue} от ${titleDate}: ` +
            (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.'),
        160,
    );

    let html = template;

    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${lit(escapeHtml(pageTitle))}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(metaDesc))}$2`);
    html = html.replace(/(<meta property="og:type" content=")[^"]*("\s*\/>)/, '$1article$2');
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(pageTitle))}$2`);
    html = html.replace(
        /(<meta property="og:description" content=")[^"]*("\s*\/>)/,
        `$1${lit(escapeHtml(metaDesc))}$2`,
    );
    html = html.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(canonicalUrl))}$2`);
    html = html.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${lit(escapeHtml(canonicalUrl))}$2`);

    const articleLd = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: truncate(
            `Държавен вестник, брой ${item.issue} · ${titleDate}${topics.length ? ` — ${lead}` : ''}`,
            110,
        ),
        description: metaDesc,
        url: canonicalUrl,
        mainEntityOfPage: canonicalUrl,
        inLanguage: 'bg',
        image: [ogImage],
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
        publisher: { '@id': `${SITE_ORIGIN}/#org` },
        author: { '@id': `${SITE_ORIGIN}/#org` },
    };
    if (topics.length) articleLd.articleSection = topics.slice(0, 12);
    if (isoDate) {
        articleLd.datePublished = isoDate;
        articleLd.dateModified = isoDate;
    }
    let headExtras = `<script type="application/ld+json">${JSON.stringify(articleLd)}</script>`;
    if (isoDate) headExtras = `<meta property="article:published_time" content="${isoDate}" />\n    ${headExtras}`;
    html = html.replace('</head>', `    ${lit(headExtras)}\n</head>`);

    // Pre-apply the issue-open and issue-ready classes so initial paint shows the article.
    html = html.replace(/<body(\s|>)/, '<body class="issue-open issue-ready"$1');

    // The nameplate is only hidden by CSS here, so its <h1> stays in the markup.
    // Demote it: an issue page's one heading is the article's own.
    html = html
        .replace('<h1 class="masthead-title">', '<p class="masthead-title">')
        .replace(/(<p class="masthead-title">[\s\S]*?)<\/h1>/, '$1</p>');

    const innerHtml = buildIssueViewInner(item, prev, next);
    html = html.replace(
        /(<div id="issue-view">)[\s\S]*?(<\/div>\s*<div class="loading")/,
        `$1${lit(innerHtml)}\n            $2`,
    );

    return html;
}

function buildSitemapXml(all) {
    const today = new Date().toISOString().slice(0, 10);
    const latestIso = all.length ? issueDateToIso(all[0].date) || today : today;
    const urls = [];
    urls.push(
        `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${latestIso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    );
    for (const item of all) {
        const iso = issueDateToIso(item.date) || today;
        urls.push(
            `  <url>\n    <loc>${SITE_ORIGIN}${issuePath(item)}</loc>\n    <lastmod>${iso}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
        );
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

const FEED_TITLE = 'Държавен вестник — обобщения на броеве';
const FEED_DESC =
    'Кратки обобщения на всеки брой на Държавен вестник, генерирани с изкуствен интелект — новите закони, правила и решения, обяснени ясно.';
const RSS_ITEM_LIMIT = 50;

// Issue dates are day-precision; noon UTC keeps the item on the right calendar
// day in every timezone a reader's feed app might render it in.
function issueDateToRfc822(item, todayIso) {
    const iso = issueDateToIso(item.date) || todayIso;
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? new Date(`${todayIso}T12:00:00Z`).toUTCString() : d.toUTCString();
}

// A standard RSS 2.0 feed, newest issues first — for readers and journalists
// who follow the gazette rather than visiting the site.
function buildRssXml(all) {
    const latest = all.slice(0, RSS_ITEM_LIMIT);
    const todayIso = new Date().toISOString().slice(0, 10);
    const lastBuild = latest.length
        ? issueDateToRfc822(latest[0], todayIso)
        : new Date(`${todayIso}T12:00:00Z`).toUTCString();
    const items = latest
        .map((item) => {
            const topics = Array.isArray(item.topics) ? item.topics : [];
            const title = topics[0] || item.lead || `Брой ${item.issue}`;
            const link = SITE_ORIGIN + issuePath(item);
            const desc = truncate(
                `Държавен вестник, брой ${item.issue} от ${formatDateLong(item.date)}: ` +
                    (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.'),
                500,
            );
            return `  <item>\n    <title>${escapeHtml(title)}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${issueDateToRfc822(item, todayIso)}</pubDate>\n    <description>${escapeHtml(desc)}</description>\n  </item>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n  <title>${escapeHtml(FEED_TITLE)}</title>\n  <link>${SITE_ORIGIN}/</link>\n  <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />\n  <description>${escapeHtml(FEED_DESC)}</description>\n  <language>bg</language>\n  <lastBuildDate>${lastBuild}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`;
}

// ─── Full-text search index ───
// The searchable plain text of every summary, keyed by "year/issue". Fetched
// lazily by the client on first search, so it never weighs on a normal visit.
function toPlainText(md) {
    return String(md)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSearchIndex(all) {
    const index = {};
    for (const item of all) {
        try {
            index[`${item.year}/${item.issue}`] = toPlainText(fs.readFileSync(path.join(ROOT, item.file), 'utf8'));
        } catch {
            // A summary that can't be read is left out of search, not fatal.
        }
    }
    return JSON.stringify(index);
}

// Writes the whole site into distDir, starting from an empty folder so nothing
// outlives the build that made it. The one survivor is catalog.json, which the
// catalog step just wrote there.
export function buildSite({ distDir = DIST_DIR } = {}) {
    const catalog = JSON.parse(fs.readFileSync(path.join(distDir, 'catalog.json'), 'utf8'));
    // Inline the stylesheet so it doesn't block initial render.
    const cleanTemplate = inlineCriticalCss(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const all = issuesNewestFirst(catalog);
    const write = (relPath, content) => {
        const dest = path.join(distDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf8');
    };
    const copy = (relPath) => {
        const dest = path.join(distDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(path.join(ROOT, relPath), dest, { recursive: true });
    };

    for (const name of fs.readdirSync(distDir)) {
        if (name !== 'catalog.json') fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
    }
    STATIC_ASSETS.forEach(copy);

    all.forEach((item, idx) => {
        const prev = all[idx + 1] || null;
        const next = all[idx - 1] || null;
        write(path.join(issuePath(item), 'index.html'), buildIssuePage(cleanTemplate, item, prev, next));
        // The client fetches the raw summary when it navigates between issues.
        copy(item.file);
    });

    // Pre-render homepage with the full issue list so crawlers see all internal links.
    write('index.html', replaceHomeContent(cleanTemplate, renderHomeContent(all)));
    write('sitemap.xml', buildSitemapXml(all));
    write('feed.xml', buildRssXml(all));
    write('search-index.json', buildSearchIndex(all));
    write('404.html', buildNotFoundHtml(cleanTemplate));

    console.log(
        `[build-issue-pages] Wrote the site to ${distDir}: home page, ${all.length} issue pages, sitemap, feed, search index and 404`,
    );
    return all.length;
}

export { lit, processRenderedContent };

if (isMain(import.meta.url)) {
    try {
        buildSite();
    } catch (e) {
        console.error('[build-issue-pages]', e.message || e);
        process.exit(1);
    }
}
