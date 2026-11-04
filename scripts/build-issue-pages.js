#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import {
    escapeHtml,
    formatDateLong,
    issueDateToIso,
    issuePath,
    issuesNewestFirst,
    issueTitle,
    processRenderedContent,
    readingMinutes,
    renderHomeContent,
    renderIssueArticleHtml,
    renderIssueHeader,
    renderIssueNav,
    renderSourceLines,
    stripMarkdownInline,
    stripSourceLines,
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
    'manifest.webmanifest',
    'og-image.png',
    'robots.txt',
    'fonts',
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

function truncate(s, max) {
    const clean = String(s).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).replace(/[\s.,;:–-]+$/, '')}…`;
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

function shortHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// Safe CSS minifier: protects quoted strings first, strips comments, collapses
// whitespace, and tightens declaration punctuation without touching selector
// spaces before pseudo-classes or arithmetic spaces inside calc().
export function minifyCss(rawCss) {
    const strings = [];
    let s = String(rawCss).replace(/(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/g, (m) => {
        strings.push(m);
        return `\0S${strings.length - 1}\0`;
    });
    s = s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};,])\s*/g, '$1')
        .replace(/([;{}][\w-]+)\s*:\s*/g, '$1:')
        .replace(/;}/g, '}')
        .trim();
    return s.replace(/\0S(\d+)\0/g, (_m, idx) => strings[Number(idx)]);
}

function inlineCriticalCss(html) {
    const css = minifyCss(fs.readFileSync(CSS_PATH, 'utf8'));
    return html.replace(
        /(<!--CRITICAL-CSS-START-->)[\s\S]*?(<!--CRITICAL-CSS-END-->)/,
        `$1<style>${lit(css)}</style>$2`,
    );
}

// The issue's JSON beside its summary: the official PDF and where each act
// starts, for the links under every section.
function readIssueMeta(item) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, item.file.replace(/\.md$/, '.json')), 'utf8'));
    } catch {
        return {};
    }
}

// The summary as the site serves it: each section's "Източник: …" line is
// already the links to the official text, so the browser renders exactly what
// the build did.
function readPublishedMarkdown(item) {
    return renderSourceLines(fs.readFileSync(path.join(ROOT, item.file), 'utf8'), readIssueMeta(item));
}

// Said wherever the AI text is read away from the page that says it already:
// feed readers and link previews (EU AI Act, art. 50).
const AI_NOTICE =
    'Неофициално обобщение, генерирано с AI. Може да съдържа грешки; официалният текст е на dv.parliament.bg.';

function buildIssueViewInner(item, prev, next) {
    const md = readPublishedMarkdown(item);
    const { html: processedHtml, tocItems } = processRenderedContent(marked.parse(md));
    const contentHtml = renderIssueArticleHtml(item, processedHtml, tocItems);

    return `
                <div class="back-bar">
                    <button type="button" class="back-btn" id="back-btn" aria-label="Обратно към всички броеве">← Всички броеве</button>
                </div>
                <div class="issue-header" id="issue-header">${renderIssueHeader(item, readingMinutes(md))}</div>
                <article class="content" id="content">${contentHtml}</article>
                <nav id="issue-nav" class="issue-nav issue-nav-bottom" aria-label="Навигация между броеве">${renderIssueNav(prev, next)}</nav>`;
}

function buildIssuePage(template, item, prev, next) {
    const titleDate = formatDateLong(item.date);
    const pageTitle = issueTitle(item);
    const canonicalUrl = SITE_ORIGIN + issuePath(item);
    const ogImage = `${SITE_ORIGIN}/og-image.png`;
    const isoDate = issueDateToIso(item.date);

    // Unique, content-rich description per issue (kills duplicate snippets).
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const lead = topics[0] || `Брой ${item.issue}`;
    const summaryPreview = item.lead || (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.');
    const metaDesc = truncate(
        `Обобщение с AI на Държавен вестник, брой ${item.issue} от ${titleDate}: ${summaryPreview}`,
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
    const breadcrumbLd = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Държавен вестник', item: `${SITE_ORIGIN}/` },
            {
                '@type': 'ListItem',
                position: 2,
                name: `Брой ${item.issue}${titleDate ? ` · ${titleDate}` : ''}`,
                item: canonicalUrl,
            },
        ],
    };
    let headExtras =
        `<script type="application/ld+json">${JSON.stringify(articleLd)}</script>\n` +
        `    <script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>`;
    if (isoDate) headExtras = `<meta property="article:published_time" content="${isoDate}" />\n    ${headExtras}`;
    html = html.replace('</head>', `    ${lit(headExtras)}\n</head>`);

    // Pre-apply the issue-open and issue-ready classes so initial paint shows the article.
    html = html.replace(/<body(\s|>)/, '<body class="issue-open issue-ready"$1');

    const folioLabel = `Брой ${item.issue}${titleDate ? ` · ${titleDate}` : ''}`;
    html = html.replace(
        '<button type="button" class="folio-context" id="folio-context" aria-label="Обратно към началото на броя" hidden></button>',
        `<button type="button" class="folio-context" id="folio-context" aria-label="Обратно към началото на броя">${lit(escapeHtml(folioLabel))}</button>`,
    );

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
            const title = topics[0] || `Брой ${item.issue}`;
            const link = SITE_ORIGIN + issuePath(item);
            const desc = truncate(
                `Обобщение с AI на Държавен вестник, брой ${item.issue} от ${formatDateLong(item.date)}: ` +
                    (topics.length ? topics.join('; ') : 'обобщение на броя, генерирано с AI.'),
                500,
            );
            let contentTag = '';
            try {
                const notice = `<p><em>${escapeHtml(AI_NOTICE)}</em></p>`;
                const html = `${notice}\n${marked.parse(readPublishedMarkdown(item)).trim()}`.replace(
                    /\]\]>/g,
                    ']]]]><![CDATA[>',
                );
                contentTag = `\n    <content:encoded><![CDATA[${html}]]></content:encoded>`;
            } catch {
                // Keep the item with its short description if the file cannot be read.
            }
            return `  <item>\n    <title>${escapeHtml(title)}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${issueDateToRfc822(item, todayIso)}</pubDate>\n    <description>${escapeHtml(desc)}</description>${contentTag}\n  </item>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n  <title>${escapeHtml(FEED_TITLE)}</title>\n  <link>${SITE_ORIGIN}/</link>\n  <atom:link href="${SITE_ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />\n  <description>${escapeHtml(FEED_DESC)}</description>\n  <language>bg</language>\n  <lastBuildDate>${lastBuild}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`;
}

// ─── Full-text search index ───
// The searchable plain text of every summary, keyed by "year/issue". Fetched
// lazily by the client on first search, so it never weighs on a normal visit.
// Each level-2 section is stored on its own line as "heading\tbody" so the
// client can link a search result directly to the matching #section anchor.
function stripBlockMarkdown(s) {
    return String(s)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function toPlainText(md) {
    return String(md)
        .split(/(?=^##\s+)/m)
        .map((section) => {
            const m = /^##\s+(.+?)\s*(?:\n|$)([\s\S]*)$/.exec(section);
            if (!m) return stripBlockMarkdown(section);
            const heading = stripMarkdownInline(m[1]);
            const body = stripBlockMarkdown(m[2]);
            return body ? `${heading}\t${body}` : heading;
        })
        .filter(Boolean)
        .join('\n');
}

function buildSearchIndex(all) {
    const index = {};
    for (const item of all) {
        try {
            const md = stripSourceLines(fs.readFileSync(path.join(ROOT, item.file), 'utf8'));
            index[`${item.year}/${item.issue}`] = toPlainText(md);
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
    const markedSrc = fs.readFileSync(path.join(ROOT, 'node_modules/marked/lib/marked.esm.js'), 'utf8');
    const sharedSrc = fs.readFileSync(path.join(ROOT, 'src/js/shared.js'), 'utf8');
    const markedHash = shortHash(markedSrc);
    const sharedHash = shortHash(sharedSrc);
    write('src/js/marked.js', markedSrc);

    const appSrc = fs
        .readFileSync(path.join(ROOT, 'src/js/app.js'), 'utf8')
        .replace("from './shared.js'", `from './shared.js?v=${sharedHash}'`)
        .replace("import('./marked.js')", `import('./marked.js?v=${markedHash}')`);
    const appHash = shortHash(appSrc);
    write('src/js/app.js', appSrc);

    const versionedTemplate = cleanTemplate.replace(/\/src\/js\/app\.js(?:\?v=[^"]*)?/, `/src/js/app.js?v=${appHash}`);

    all.forEach((item, idx) => {
        const prev = all[idx + 1] || null;
        const next = all[idx - 1] || null;
        write(path.join(issuePath(item), 'index.html'), buildIssuePage(versionedTemplate, item, prev, next));
        // The client fetches the summary when it navigates between issues.
        write(item.file, readPublishedMarkdown(item));
    });

    // Pre-render homepage with the full issue list so crawlers see all internal links.
    write('index.html', replaceHomeContent(versionedTemplate, renderHomeContent(all)));
    write('sitemap.xml', buildSitemapXml(all));
    write('feed.xml', buildRssXml(all));
    write('search-index.json', buildSearchIndex(all));
    write('404.html', buildNotFoundHtml(versionedTemplate));

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
