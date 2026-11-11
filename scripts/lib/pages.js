// A page per story, so one piece of news can be found and shared on its own.
// Every story is one ## section of an issue's summary (see splitStories in
// src/js/shared.js). Nothing on the site links to these pages; search engines
// and shared links reach them.
import { marked } from 'marked';
import {
    escapeHtml,
    escapeModelHtml,
    formatDateLong,
    issueDateToIso,
    issuePath,
    processRenderedContent,
    readingMinutes,
    renderDisclaimer,
    renderSourceLines,
    storyPath,
    stripMarkdownInline,
    stripTopicLines,
} from '../../src/js/shared.js';

export const SITE_ORIGIN = 'https://gazette.bg';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;
// JSON inside a <script> element: a "<" in a headline could otherwise close
// the element ("</script>") and start markup of its own.
export function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Anything spliced into a String.replace() replacement is data, not a pattern.
export function lit(s) {
    return String(s).replace(/\$/g, '$$$$');
}

export function truncate(s, max) {
    const clean = String(s).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).replace(/[\s.,;:–—-]+$/, '')}…`;
}

// The first paragraph of prose in a story: what a card or a link preview
// shows under the headline.
export function storyLead(body, max = 220) {
    const blocks = stripTopicLines(String(body))
        .split(/\n{2,}/)
        .map((b) => b.trim())
        .filter(Boolean);
    const block = blocks.find((b) => !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|---|Източник:|<)/.test(b)) || '';
    // A paragraph that runs into a list keeps only its opening lines.
    const prose = block.split(/\n(?=\s*(?:[-*+]|\d+\.)\s)/)[0];
    return truncate(stripMarkdownInline(prose), max);
}

// Every story of every issue, newest issue first and in each issue's own order
// (most important first).
export function collectStories(all, readStories) {
    const out = [];
    for (const item of all) {
        for (const [index, story] of readStories(item).entries()) {
            out.push({ item, story, index, iso: issueDateToIso(item.date), lead: storyLead(story.body) });
        }
    }
    return out;
}

// ─── Head ───

// Sets the head of a page made from the site template: title, description,
// canonical address, Open Graph and structured data.
export function setHead(
    template,
    { title, description, url, type = 'article', image = DEFAULT_OG_IMAGE, imageAlt = '', jsonLd = [], extra = '' },
) {
    let html = template;
    const attr = (s) => lit(escapeHtml(s));
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${attr(title)}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/>)/, `$1${attr(description)}$2`);
    html = html.replace(/(<meta property="og:type" content=")[^"]*("\s*\/>)/, `$1${attr(type)}$2`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*("\s*\/>)/, `$1${attr(title)}$2`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*("\s*\/>)/, `$1${attr(description)}$2`);
    html = html.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${attr(url)}$2`);
    html = html.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${attr(url)}$2`);
    html = html.replace(/(<meta property="og:image" content=")[^"]*("\s*\/>)/, `$1${attr(image)}$2`);
    html = html.replace(/(<meta name="twitter:image" content=")[^"]*("\s*\/>)/, `$1${attr(image)}$2`);
    if (imageAlt)
        html = html.replace(/(<meta property="og:image:alt" content=")[^"]*("\s*\/>)/, `$1${attr(imageAlt)}$2`);
    const ld = jsonLd.map((o) => `<script type="application/ld+json">${jsonForScript(o)}</script>`).join('\n    ');
    return html.replace('</head>', `    ${lit([extra, ld].filter(Boolean).join('\n    '))}\n</head>`);
}

// A page without the front page's nameplate and home view: the body is put
// in #issue-view, like an issue page, and marked so the browser script leaves
// it alone.
export function setBody(html, { page, inner, folioLabel = '' }) {
    let out = html.replace(/<body(\s|>)/, `<body class="issue-open issue-ready" data-page="${page}"$1`);
    if (folioLabel) {
        out = out.replace(
            '<button type="button" class="folio-context" id="folio-context" aria-label="Обратно към началото на броя" hidden></button>',
            `<button type="button" class="folio-context" id="folio-context" aria-label="Обратно към началото на страницата">${lit(escapeHtml(folioLabel))}</button>`,
        );
    }
    out = out
        .replace('<h1 class="masthead-title">', '<p class="masthead-title">')
        .replace(/(<p class="masthead-title">[\s\S]*?)<\/h1>/, '$1</p>');
    return out.replace(
        /(<div id="issue-view">)[\s\S]*?(<\/div>\s*<div class="loading")/,
        `$1${lit(inner)}\n            $2`,
    );
}

const issueLabel = (item) => `Брой ${item.issue}${item.date ? ` · ${formatDateLong(item.date)}` : ''}`;

const breadcrumb = (items) => ({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
});

// ─── Story page ───

// On its own page the story's heading is the h1, so its ### parts become h2:
// headings then step down one level at a time.
export function renderStoryBody(story, meta) {
    const md = renderSourceLines(escapeModelHtml(stripTopicLines(story.body)), meta).replace(
        /^(#{3,6})\s/gm,
        (_m, h) => `${h.slice(1)} `,
    );
    return processRenderedContent(marked.parse(md)).html;
}

export function buildStoryPage(template, { item, story, siblings, meta, image }) {
    const url = SITE_ORIGIN + storyPath(item, story);
    const iso = issueDateToIso(item.date);
    const lead = storyLead(story.body, 400);
    const title = truncate(`${story.heading} — ДВ бр. ${item.issue}`, 110);
    const description = truncate(`Обобщение с AI на ДВ бр. ${item.issue}: ${lead}`, 160);

    const article = {
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: truncate(story.heading, 110),
        description,
        url,
        mainEntityOfPage: url,
        inLanguage: 'bg',
        image: [image || DEFAULT_OG_IMAGE],
        isPartOf: { '@type': 'WebPage', url: SITE_ORIGIN + issuePath(item) },
        publisher: { '@id': `${SITE_ORIGIN}/#org` },
        author: { '@id': `${SITE_ORIGIN}/#org` },
    };
    if (iso) {
        article.datePublished = iso;
        article.dateModified = iso;
    }
    const html = setHead(template, {
        title,
        description,
        url,
        image: image || DEFAULT_OG_IMAGE,
        imageAlt: image ? `${story.heading} — обобщение с AI, gazette.bg` : '',
        jsonLd: [
            article,
            breadcrumb([
                ['Държавен вестник', `${SITE_ORIGIN}/`],
                [issueLabel(item), SITE_ORIGIN + issuePath(item)],
                [truncate(story.heading, 80), url],
            ]),
        ],
        extra: iso ? `<meta property="article:published_time" content="${iso}" />` : '',
    });

    const others = siblings.filter((s) => s.slug !== story.slug);
    const more = others.length
        ? `<nav class="more-stories" aria-label="Още от брой ${escapeHtml(String(item.issue))}">
<p class="contents-label">Още от брой ${escapeHtml(String(item.issue))}</p>
<ol class="contents-list">${others
              .map((s) => `<li><a href="${escapeHtml(storyPath(item, s))}">${escapeHtml(s.heading)}</a></li>`)
              .join('')}</ol>
<p class="more-stories-all"><a href="${escapeHtml(issuePath(item))}">Целият брой ${escapeHtml(String(item.issue))} на една страница →</a></p>
</nav>`
        : '';
    const minutes = readingMinutes(story.body);
    const inner = `
                <div class="back-bar"><a class="back-btn" href="${escapeHtml(issuePath(item))}">← ${escapeHtml(issueLabel(item))}</a></div>
                <div class="issue-header story-header" id="issue-header">
<p class="issue-kicker"><span>Брой ${escapeHtml(String(item.issue))}</span><span class="rule"></span><span>Държавен вестник</span></p>
<h1 class="title story-title">${escapeHtml(story.heading)}</h1>
<div class="issue-meta-bar"><p class="issue-meta" id="issue-meta"><span>Обобщение с AI</span><span>${escapeHtml(formatDateLong(item.date))}</span><span>≈ ${minutes} мин четене</span></p><button type="button" class="issue-share-btn" id="issue-share-btn">Сподели връзка</button></div>
</div>
                <article class="content" id="content">${renderDisclaimer({ ...item, pdfUrl: meta?.pdfUrl || item.pdfUrl })}<div class="issue-body">${renderStoryBody(story, meta)}</div></article>
                ${more}`;
    return setBody(html, { page: 'story', inner, folioLabel: truncate(story.heading, 60) });
}
