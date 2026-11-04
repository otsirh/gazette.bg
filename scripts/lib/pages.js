// The pages built from stories rather than whole issues: a page per story, a
// page and a feed per topic, the topics index, and the front page's "this
// week". Every story is one ## section of an issue's summary (see splitStories
// in src/js/shared.js).
import { marked } from 'marked';
import {
    escapeHtml,
    escapeModelHtml,
    formatDateLong,
    formatDateShort,
    formatIsoDate,
    issueDateToIso,
    issuePath,
    processRenderedContent,
    readingMinutes,
    renderArchive,
    renderDisclaimer,
    renderSourceLines,
    renderTopicChips,
    storyPath,
    stripMarkdownInline,
    stripTopicLines,
    TOPICS,
    topicPath,
} from '../../src/js/shared.js';

export const SITE_ORIGIN = 'https://gazette.bg';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;
const FEED_ITEM_LIMIT = 50;
// "This week" is every issue within this many days of the newest one.
const WEEK_DAYS = 7;
const WEEK_MIN_ISSUES = 2;

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
    if (story.topics.length) article.articleSection = story.topics.map((t) => t.label);
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
    const chips = story.topics.length ? `<p class="story-topics">${renderTopicChips(story.topics)}</p>` : '';
    const minutes = readingMinutes(story.body);
    const inner = `
                <div class="back-bar"><a class="back-btn" href="${escapeHtml(issuePath(item))}">← ${escapeHtml(issueLabel(item))}</a></div>
                <div class="issue-header story-header" id="issue-header">
<p class="issue-kicker"><span>Брой ${escapeHtml(String(item.issue))}</span><span class="rule"></span><span>Държавен вестник</span></p>
${chips}<h1 class="title story-title">${escapeHtml(story.heading)}</h1>
<div class="issue-meta-bar"><p class="issue-meta" id="issue-meta"><span>Обобщение с AI</span><span class="sep">·</span><span>${escapeHtml(formatDateLong(item.date))}</span>${
        story.effective
            ? `<span class="sep">·</span><span class="meta-effective">В сила от ${escapeHtml(formatIsoDate(story.effective))}</span>`
            : ''
    }<span class="sep">·</span><span>≈ ${minutes} мин четене</span></p><button type="button" class="issue-share-btn" id="issue-share-btn">Сподели връзка</button></div>
</div>
                <article class="content" id="content">${renderDisclaimer({ ...item, pdfUrl: meta?.pdfUrl || item.pdfUrl })}<div class="issue-body">${renderStoryBody(story, meta)}</div></article>
                ${more}`;
    return setBody(html, { page: 'story', inner, folioLabel: truncate(story.heading, 60) });
}

// ─── Topic pages ───

function storyRow({ item, story, lead }, { showTopic = null, kicker: kickerText = null, attrs = '' } = {}) {
    const extra = showTopic ? story.topics.filter((t) => t.slug !== showTopic) : story.topics;
    const kickerLabel = kickerText ?? extra.map((t) => t.label).join(' · ');
    const kicker = kickerLabel ? `<span class="story-card-topics">${escapeHtml(kickerLabel)}</span>` : '';
    const when = story.effective && kickerText === null ? ` · в сила от ${formatIsoDate(story.effective)}` : '';
    return `<li${attrs}><a class="story-card" href="${escapeHtml(storyPath(item, story))}">${kicker}<span class="story-card-title">${escapeHtml(story.heading)}</span><span class="story-card-lead">${escapeHtml(truncate(lead, 160))}</span><span class="story-card-meta">${escapeHtml(issueLabel(item) + when)}</span></a></li>`;
}

export function topicStories(stories, topic) {
    return stories.filter((s) => s.story.topics.some((t) => t.slug === topic.slug));
}

export function buildTopicPage(template, topic, entries) {
    const url = SITE_ORIGIN + topicPath(topic);
    const issues = new Set(entries.map((e) => `${e.item.year}/${e.item.issue}`)).size;
    const title = `${topic.label} — новини от Държавен вестник`;
    const description = truncate(
        `${topic.label}: какво се променя според Държавен вестник — ${topic.scope}. Обобщения с AI, най-новите първи.`,
        160,
    );
    const html = setHead(template, {
        title,
        description,
        url,
        type: 'website',
        jsonLd: [
            {
                '@context': 'https://schema.org',
                '@type': 'CollectionPage',
                name: title,
                url,
                inLanguage: 'bg',
                isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
            },
            breadcrumb([
                ['Държавен вестник', `${SITE_ORIGIN}/`],
                ['Теми', `${SITE_ORIGIN}/tema/`],
                [topic.label, url],
            ]),
        ],
        extra: `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(topic.label)} — gazette.bg" href="${topicPath(topic)}feed.xml" />`,
    });
    const list = entries.length
        ? `<ol class="story-list">${entries.map((e) => storyRow(e, { showTopic: topic.slug })).join('')}</ol>`
        : '<p class="empty">Все още няма новини по тази тема.</p>';
    const inner = `
                <div class="back-bar"><a class="back-btn" href="/tema/">← Всички теми</a></div>
                <div class="issue-header topic-header" id="issue-header">
<p class="issue-kicker"><span>Тема</span><span class="rule"></span><span>Държавен вестник</span></p>
<h1 class="title story-title">${escapeHtml(topic.label)}</h1>
<p class="topic-scope">${escapeHtml(topic.scope[0].toUpperCase() + topic.scope.slice(1))}.</p>
<div class="issue-meta-bar"><p class="issue-meta"><span>${entries.length} ${entries.length === 1 ? 'новина' : 'новини'}</span><span class="sep">·</span><span>${issues} ${issues === 1 ? 'брой' : 'броя'}</span></p><a class="issue-share-btn" href="${topicPath(topic)}feed.xml">Абонамент (RSS)</a></div>
</div>
                <div class="topic-body">${list}</div>`;
    return setBody(html, { page: 'topic', inner, folioLabel: topic.label });
}

export function buildTopicsIndex(template, stories) {
    const url = `${SITE_ORIGIN}/tema/`;
    const title = 'Теми — новини от Държавен вестник по области';
    const description =
        'Новините от Държавен вестник, подредени по теми: данъци, работа, пенсии, здраве, образование, имоти и още. Всяка тема има и RSS емисия.';
    const html = setHead(template, {
        title,
        description,
        url,
        type: 'website',
        jsonLd: [
            breadcrumb([
                ['Държавен вестник', `${SITE_ORIGIN}/`],
                ['Теми', url],
            ]),
        ],
    });
    const inner = `
                <div class="back-bar"><a class="back-btn" href="/">← Начало</a></div>
                <div class="issue-header topic-header" id="issue-header">
<p class="issue-kicker"><span>Теми</span><span class="rule"></span><span>Държавен вестник</span></p>
<h1 class="title story-title">Новините по теми</h1>
<p class="topic-scope">Изберете тема, за да видите само новините по нея. Всяка тема има своя RSS емисия, за да ги получавате в приложението си за новини.</p>
</div>
                <div class="topic-body">${renderTopicGrid(stories)}</div>`;
    return setBody(html, { page: 'topic', inner, folioLabel: 'Теми' });
}

export function renderTopicGrid(stories) {
    const cells = TOPICS.map((topic) => {
        const entries = topicStories(stories, topic);
        const latest = entries[0];
        return `<li><a class="topic-cell" href="${topicPath(topic)}"><span class="topic-cell-label">${escapeHtml(topic.label)}</span><span class="topic-cell-count">${entries.length}</span>${
            latest ? `<span class="topic-cell-latest">${escapeHtml(truncate(latest.story.heading, 90))}</span>` : ''
        }</a></li>`;
    });
    return `<ul class="topic-grid">${cells.join('')}</ul>`;
}

// ─── Upcoming changes ───

const BG_MONTH_NAMES = [
    'Януари',
    'Февруари',
    'Март',
    'Април',
    'Май',
    'Юни',
    'Юли',
    'Август',
    'Септември',
    'Октомври',
    'Ноември',
    'Декември',
];
const RECENT_DAYS = 30;

const isoDaysBefore = (iso, days) =>
    new Date(Date.parse(`${iso}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

// What takes effect from `today` on, soonest first; and what took effect in
// the month before. The page is rebuilt with each issue, and the browser hides
// whatever has passed since (see app.js), so it is right on any day.
export function upcomingStories(stories, today) {
    const dated = stories.filter((s) => s.story.effective);
    const upcoming = dated
        .filter((s) => s.story.effective >= today)
        .sort((a, b) => a.story.effective.localeCompare(b.story.effective));
    const since = isoDaysBefore(today, RECENT_DAYS);
    const recent = dated
        .filter((s) => s.story.effective < today && s.story.effective >= since)
        .sort((a, b) => b.story.effective.localeCompare(a.story.effective));
    return { upcoming, recent };
}

const dayLabel = (iso) => formatIsoDate(iso).replace(/\s\d{4}$/, '');

function upcomingRow(entry) {
    return storyRow(entry, {
        kicker: `От ${dayLabel(entry.story.effective)}`,
        attrs: ` data-until="${escapeHtml(entry.story.effective)}"`,
    });
}

export function buildUpcomingPage(template, stories, today) {
    const url = `${SITE_ORIGIN}/predstoyashti/`;
    const { upcoming, recent } = upcomingStories(stories, today);
    const title = 'Предстоящи промени — какво влиза в сила според Държавен вестник';
    const description =
        'Законите, таксите и правилата от Държавен вестник по датата, от която важат: най-близките първи. Обобщения с AI.';
    const html = setHead(template, {
        title,
        description,
        url,
        type: 'website',
        jsonLd: [
            {
                '@context': 'https://schema.org',
                '@type': 'CollectionPage',
                name: title,
                url,
                inLanguage: 'bg',
                isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
            },
            breadcrumb([
                ['Държавен вестник', `${SITE_ORIGIN}/`],
                ['Предстоящи промени', url],
            ]),
        ],
    });
    const months = new Map();
    for (const e of upcoming) {
        const key = e.story.effective.slice(0, 7);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(e);
    }
    const groups = [...months]
        .map(([key, entries]) => {
            const [y, m] = key.split('-');
            return `<section class="month-group"><h2 class="year-title"><span>${BG_MONTH_NAMES[Number(m) - 1]} ${y}</span></h2><ol class="story-list">${entries.map(upcomingRow).join('')}</ol></section>`;
        })
        .join('');
    const recentHtml = recent.length
        ? `<section class="month-group recent-group"><h2 class="year-title"><span>Влязоха в сила през последния месец</span></h2><ol class="story-list">${recent
              .map((e) =>
                  storyRow(e, {
                      kicker: `От ${dayLabel(e.story.effective)}`,
                      attrs: ` data-since="${escapeHtml(isoDaysBefore(e.story.effective, -RECENT_DAYS))}"`,
                  }),
              )
              .join('')}</ol></section>`
        : '';
    const inner = `
                <div class="back-bar"><a class="back-btn" href="/">← Начало</a></div>
                <div class="issue-header topic-header" id="issue-header">
<p class="issue-kicker"><span>Предстоящи промени</span><span class="rule"></span><span>Държавен вестник</span></p>
<h1 class="title story-title">Какво влиза в сила</h1>
<p class="topic-scope">Промените от Държавен вестник по датата, от която важат — най-близките първи. Датата е взета от обобщението; за точния срок вижте официалния текст на всяка новина.</p>
</div>
                <div class="topic-body upcoming-body">${groups || '<p class="empty">Засега няма обнародвани промени с бъдеща дата.</p>'}${recentHtml}</div>`;
    return setBody(html, { page: 'upcoming', inner, folioLabel: 'Предстоящи промени' });
}

function renderUpcomingTeaser(stories, today) {
    const { upcoming } = upcomingStories(stories, today);
    if (!upcoming.length) return '';
    return `<section class="upcoming-section" aria-labelledby="upcoming-title">
<div class="section-head"><h2 class="section-title" id="upcoming-title">Скоро влизат в сила</h2><a class="section-count" href="/predstoyashti/">Всички предстоящи →</a></div>
<ol class="story-list" data-show="6">${upcoming.slice(0, 24).map(upcomingRow).join('')}</ol>
</section>`;
}

// ─── Topic feeds ───

function rfc822(iso) {
    const d = new Date(`${iso || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
    return d.toUTCString();
}

const AI_NOTICE =
    'Неофициално обобщение, генерирано с AI. Може да съдържа грешки; официалният текст е на dv.parliament.bg.';

export function buildTopicFeed(topic, entries, metaFor) {
    const latest = entries.slice(0, FEED_ITEM_LIMIT);
    const items = latest
        .map(({ item, story, iso, lead }) => {
            const link = SITE_ORIGIN + storyPath(item, story);
            const body = renderStoryBody(story, metaFor(item)).replace(/\]\]>/g, ']]]]><![CDATA[>');
            return `  <item>\n    <title>${escapeHtml(story.heading)}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${rfc822(iso)}</pubDate>\n    <description>${escapeHtml(truncate(`Обобщение с AI, ДВ бр. ${item.issue}: ${lead}`, 500))}</description>\n    <content:encoded><![CDATA[<p><em>${escapeHtml(AI_NOTICE)}</em></p>\n${body}]]></content:encoded>\n  </item>`;
        })
        .join('\n');
    const self = `${SITE_ORIGIN}${topicPath(topic)}feed.xml`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n  <title>${escapeHtml(`${topic.label} — gazette.bg`)}</title>\n  <link>${SITE_ORIGIN}${topicPath(topic)}</link>\n  <atom:link href="${self}" rel="self" type="application/rss+xml" />\n  <description>${escapeHtml(`Новините от Държавен вестник по темата „${topic.label}“ — кратки обобщения с AI.`)}</description>\n  <language>bg</language>\n  <lastBuildDate>${rfc822(latest[0]?.iso)}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`;
}

// ─── Front page ───

// The newest issues as stories: every issue within a week of the newest one,
// and at least two issues.
export function weekStories(all, stories) {
    if (!all.length) return { issues: [], entries: [] };
    const newest = Date.parse(issueDateToIso(all[0].date) || '');
    const issues = all.filter((item, i) => {
        if (i < WEEK_MIN_ISSUES) return true;
        const t = Date.parse(issueDateToIso(item.date) || '');
        return Number.isFinite(newest) && Number.isFinite(t) && newest - t < WEEK_DAYS * 86400000;
    });
    const keys = new Set(issues.map((i) => `${i.year}/${i.issue}`));
    return { issues, entries: stories.filter((s) => keys.has(`${s.item.year}/${s.item.issue}`)) };
}

export function renderHome(all, stories, today = new Date().toISOString().slice(0, 10)) {
    if (!all.length) return '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
    const { issues, entries } = weekStories(all, stories);
    const [lead, ...rest] = entries;
    const oldest = issues[issues.length - 1];
    const span =
        issues.length > 1
            ? `Броеве ${oldest.issue}–${issues[0].issue} · ${formatDateShort(oldest.date)} – ${formatDateLong(issues[0].date)}`
            : issueLabel(issues[0]);
    const leadHtml = lead
        ? `<a class="story-lead" href="${escapeHtml(storyPath(lead.item, lead.story))}">${
              lead.story.topics.length
                  ? `<span class="story-card-topics">${lead.story.topics.map((t) => escapeHtml(t.label)).join(' · ')}</span>`
                  : ''
          }<h3 class="lead-title">${escapeHtml(lead.story.heading)}</h3><p class="lead-standfirst">${escapeHtml(lead.lead)}</p><span class="story-card-meta">${escapeHtml(issueLabel(lead.item))}</span></a>`
        : '';
    const week = `<section class="week-section" aria-labelledby="week-title">
<div class="section-head"><h2 class="section-title" id="week-title">Тази седмица</h2><span class="section-count">${escapeHtml(span)}</span></div>
${leadHtml}
<ol class="story-list story-list-week">${rest.map((e) => storyRow(e)).join('')}</ol>
</section>`;
    const topics = `<section class="topics-section" aria-labelledby="topics-title">
<div class="section-head"><h2 class="section-title" id="topics-title">Теми</h2><a class="section-count" href="/tema/">Всички теми →</a></div>
${renderTopicGrid(stories)}
</section>`;
    return week + renderUpcomingTeaser(stories, today) + topics + renderArchive(all);
}
