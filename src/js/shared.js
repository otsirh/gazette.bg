// Formatting and markup shared by the build (scripts/build-issue-pages.js) and
// the browser (src/js/app.js). The build pre-renders every page; the browser
// renders the same pieces again when the reader navigates without a reload.
// Both import them from here, so the two can never drift apart.

const BG_MONTHS = [
    'януари',
    'февруари',
    'март',
    'април',
    'май',
    'юни',
    'юли',
    'август',
    'септември',
    'октомври',
    'ноември',
    'декември',
];
const BG_MONTHS_CAP = [
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

const WORDS_PER_MINUTE = 180;
const LEAD_TOPIC_LIMIT = 5;

export function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ─── Dates ─── */

function stripDateSuffix(str) {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/\s*г\.\s*$/, '').trim();
}

export function capitalizeMonthInDate(str) {
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

// "30.9.2026 г." as dv.parliament.bg prints it, or a date already in words,
// becomes "30 Септември 2026" — the form the issue's JSON stores.
export function formatDateBulgarian(str) {
    if (!str || typeof str !== 'string') return str;
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г\.?$/);
    if (!m) return capitalizeMonthInDate(stripDateSuffix(str));
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = m[3];
    if (month < 1 || month > 12) return capitalizeMonthInDate(stripDateSuffix(str));
    return `${day} ${BG_MONTHS_CAP[month - 1]} ${year}`;
}

// Long form ("10 юли 2026") for datelines; short form drops the year for the
// archive register, where the year is already the running head.
export function formatDateLong(str) {
    return lowercaseMonthInDate(stripDateSuffix(formatDateBulgarian(str)));
}

export function formatDateShort(str) {
    return formatDateLong(str)
        .replace(/\s+\d{4}\s*$/, '')
        .trim();
}

export function issueDateToIso(str) {
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

/* ─── Text ─── */

// marked emits HTML entities (&quot;, &amp;, …) inside heading markup. Decode
// them back to text before deriving slugs/TOC labels, otherwise escapeHtml
// double-encodes (&amp;quot;) and slugify leaks "quot" into anchor ids.
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

export function stripMarkdownInline(s) {
    return String(s)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*+|_+|`+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function slugify(text) {
    return (
        stripMarkdownInline(text)
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\p{L}\p{N}-]/gu, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'section'
    );
}

// Lightweight, deterministic Bulgarian inflection stemmer for search.
// Strips definite articles and plural/gender endings while preserving a >=3-char
// Cyrillic root, and normalizes -иц/-ъц <-> -ик/-ък palatalization ("данъци" <-> "данък").
export function stemBg(word) {
    const w = String(word).toLowerCase().trim();
    if (w.length < 4 || !/^[\u0400-\u04ff]+$/.test(w)) return w;

    let s = w;
    const artMatch = /^(.*?)(овете|евете|ищата|ият|ата|ята|ото|ето|ите|ът|ят)$/.exec(s);
    if (artMatch && artMatch[1].length >= 3) {
        s = artMatch[1];
    } else if (/^(.*(?:ост|ест|ъст|щ))та$/.test(s) && s.length - 2 >= 3) {
        s = s.slice(0, -2);
    }

    const endMatch = /^(.*?)(ове|еве|ища|ия|ии|[аяоеий])$/.exec(s);
    if (endMatch && endMatch[1].length >= 3) {
        s = endMatch[1];
    }

    if (/(?:и|ъ)ц$/.test(s)) {
        s = `${s.slice(0, -1)}к`;
    }
    return s;
}

export function searchTermVariants(term) {
    const raw = String(term).toLowerCase().trim();
    if (!raw) return [];
    const stem = stemBg(raw);
    const out = new Set([raw, stem]);
    if (/(?:и|ъ)к$/.test(stem)) {
        out.add(`${stem.slice(0, -1)}ц`);
    }
    return [...out];
}

function uniqueSlugs(headings) {
    const used = new Set();
    return headings.map((h) => {
        let id = slugify(h);
        if (used.has(id)) {
            let n = 2;
            while (used.has(`${id}-${n}`)) n++;
            id = `${id}-${n}`;
        }
        used.add(id);
        return id;
    });
}

// Promote any h1 to h2, assign unique heading IDs, and collect TOC items.
// Shared by the static build and client-side navigation so anchor IDs are
// always identical.
export function processRenderedContent(html) {
    let out = String(html).replace(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
    const used = new Set();
    const tocItems = [];
    out = out.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_m, level, attrs, inner) => {
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
    return { html: out, tocItems };
}

export function readingMinutes(markdown) {
    const text = String(markdown).replace(/<[^>]+>/g, ' ');
    const words = stripMarkdownInline(text).split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function pluralTopics(n) {
    return n === 1 ? '1 тема' : `${n} теми`;
}

/* ─── Catalog ─── */

export function issuesNewestFirst(catalog) {
    if (!catalog?.years) return [];
    const years = Object.keys(catalog.years).sort((a, b) => Number(b) - Number(a));
    const list = [];
    for (const year of years) {
        catalog.years[year]
            .slice()
            .sort((a, b) => Number(b.issue) - Number(a.issue))
            .forEach((item) => {
                list.push({ ...item, year });
            });
    }
    return list;
}

export function issuePath(item) {
    return `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
}

/* ─── Cards ─── */

function topicsOf(item) {
    return Array.isArray(item.topics) ? item.topics : [];
}

function cardAttrs(item, hash = '') {
    const href = `${issuePath(item)}${hash ? `#${hash}` : ''}`;
    return `href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}"`;
}

// The front page: a two-column editorial spread on wide screens. The left
// column carries the lead story and its opening standfirst; the right column
// lists the remaining topics as direct section deep-links.
function renderLeadCard(item) {
    const topics = topicsOf(item);
    const slugs = uniqueSlugs(topics);
    const headline = topics[0] || `Брой ${item.issue}`;
    const rest = topics.slice(1);
    const standfirst = item.lead ? `<p class="lead-standfirst">${escapeHtml(item.lead)}</p>` : '';

    const metaParts = [];
    if (topics.length) metaParts.push(pluralTopics(topics.length));
    if (item.minutes) metaParts.push(`≈ ${item.minutes} мин четене`);
    const metaHtml = metaParts.length ? `<span class="lead-meta">${escapeHtml(metaParts.join(' · '))}</span>` : '';

    let contents = '';
    if (rest.length) {
        const shown = rest.slice(0, LEAD_TOPIC_LIMIT);
        const hidden = rest.length - shown.length;
        let items = shown
            .map(
                (t, idx) =>
                    `<li><a class="issue-card lead-topic-link" ${cardAttrs(item, slugs[idx + 1])}>${escapeHtml(t)}</a></li>`,
            )
            .join('');
        if (hidden > 0) {
            items += `<li class="more"><a class="issue-card lead-topic-link" ${cardAttrs(item)}>още ${pluralTopics(hidden)} →</a></li>`;
        }
        contents = `<div class="lead-contents"><p class="contents-label">Още в броя</p><ol class="contents-list">${items}</ol></div>`;
    }

    const spreadCls = contents ? 'lead-spread' : 'lead-spread is-single';

    return `<section class="lead-section">
<p class="lead-dateline"><span>Последен брой</span><span class="rule"></span><span>Брой ${escapeHtml(String(item.issue))} · ${escapeHtml(formatDateLong(item.date))}</span></p>
<div class="${spreadCls}">
<div class="lead-main">
<a class="issue-card issue-card-lead" ${cardAttrs(item)}>
<h2 class="lead-title">${escapeHtml(headline)}</h2>
${standfirst}
<span class="lead-footer"><span class="lead-read">Прочети обобщението →</span>${metaHtml}</span>
</a>
</div>
${contents}
</div>
</section>`;
}

// The register shows a bare number and one headline, but readers search for
// things it does not print — "брой 63", the year, a topic further down the
// issue. Carry all of it in a hidden haystack.
function searchHaystack(item) {
    return [`Брой ${item.issue}`, formatDateLong(item.date), ...topicsOf(item)].join(' ').toLowerCase();
}

function renderRowCard(item, extraClass = '') {
    const topics = topicsOf(item);
    const title = topics[0] || `Брой ${item.issue}`;
    const cls = extraClass ? `issue-card issue-card-row ${extraClass}` : 'issue-card issue-card-row';
    const meta = [formatDateShort(item.date), topics.length > 1 ? pluralTopics(topics.length) : '']
        .filter(Boolean)
        .join(' · ');
    return (
        `<a class="${cls}" ${cardAttrs(item)} data-search="${escapeHtml(searchHaystack(item))}">` +
        `<span class="num">${escapeHtml(String(item.issue))}</span>` +
        `<span class="row-body"><span class="row-title">${escapeHtml(title)}</span><span class="date">${escapeHtml(meta)}</span></span>` +
        `</a>`
    );
}

function renderNavCard(item) {
    const headline = topicsOf(item)[0] || formatDateLong(item.date);
    const sub = [`Брой ${item.issue}`, item.date ? formatDateShort(item.date) : ''].filter(Boolean).join(' · ');
    return (
        `<a class="issue-card" ${cardAttrs(item)}>` +
        `<span class="num">${escapeHtml(sub)}</span>` +
        `<span class="nav-headline">${escapeHtml(headline)}</span>` +
        `</a>`
    );
}

// The newest issue is already shown above as the lead story, so its row in the
// archive stays hidden while browsing and only appears when the reader filters
// the register by search query.
function renderArchive(items, leadItem) {
    if (!items.length) return '';
    const byYear = {};
    if (leadItem) byYear[leadItem.year] = [{ item: leadItem, isLead: true }];
    for (const item of items) {
        if (!byYear[item.year]) byYear[item.year] = [];
        byYear[item.year].push({ item, isLead: false });
    }
    const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
    const total = items.length;

    let html = '<section class="archive-section" id="archive">';
    html += `<div class="section-head"><h2 class="section-title">Архив</h2><span class="section-count">${total} ${total === 1 ? 'брой' : 'броя'}</span></div>`;
    html +=
        '<div class="archive-search">' +
        '<input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене по тема, закон, град или ключова дума…" aria-label="Търсене в текста на броевете" autocomplete="off" spellcheck="false" />' +
        '<kbd class="archive-search-kbd" id="archive-search-kbd" aria-hidden="true" title="Натиснете / за търсене">/</kbd>' +
        '<button type="button" class="archive-search-clear" id="archive-search-clear" aria-label="Изчисти търсенето" hidden>×</button>' +
        '</div>';
    for (const year of years) {
        const entries = byYear[year];
        const groupCls = entries.every((e) => e.isLead) ? 'year-group is-lead-group filter-hidden' : 'year-group';
        html += `<div class="${groupCls}"><h3 class="year-title"><span>${escapeHtml(year)}</span></h3><div class="issue-list">`;
        for (const { item, isLead } of entries) {
            html += renderRowCard(item, isLead ? 'is-lead-row filter-hidden' : '');
        }
        html += '</div></div>';
    }
    html += '</section>';
    return html;
}

// The home page below the masthead: the newest issue as the lead story, every
// older one in the archive register.
export function renderHomeContent(all) {
    if (!all.length) {
        return '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
    }
    return renderLeadCard(all[0]) + renderArchive(all.slice(1), all[0]);
}

/* ─── Sources ─── */

const DV_MATERIAL_URL = 'https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=';
const SOURCE_LINE_RE = /^Източник:[ \t]*(.+?)[ \t]*$/gm;

// "акт 2, акт 5, стр. 37–38" → [{ act: 2 }, { act: 5 }, { from: 37, to: 38 }].
// A bare number after "стр." is a page too ("стр. 37, 39"); anything else is
// dropped rather than guessed at.
export function parseSourceList(text) {
    const refs = [];
    let inPages = false;
    for (const raw of String(text).split(/[,;]/)) {
        const part = raw.trim();
        const act = part.match(/^акт\s*(\d{1,3})$/i);
        if (act) {
            refs.push({ act: Number(act[1]) });
            inPages = false;
            continue;
        }
        const pages = part.match(/^(?:(стр\.?)\s*)?(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?$/i);
        if (!pages || !(pages[1] || inPages)) continue;
        inPages = true;
        const from = Number(pages[2]);
        const to = pages[3] ? Number(pages[3]) : from;
        if (from >= 1 && to >= from) refs.push({ from, to });
    }
    return refs;
}

// "Постановление № 224 от 29 октомври 2026 г. за ..." → "Постановление № 224".
// A title without a number (a law) is cut to a readable length instead.
export function shortActLabel(title) {
    const t = String(title || '').trim();
    const numbered = t.match(/^(.{1,60}?№\s*[^\s,]+)/);
    if (numbered) return numbered[1];
    if (t.length <= 60) return t;
    return `${t.slice(0, 59).replace(/\s+\S*$/, '')}…`;
}

const pageLabel = ({ from, to }) => (from === to ? String(from) : `${from}–${to}`);

// Each act of the official section has a page of its own on dv.parliament.bg;
// anything outside those acts is shown on its page of the issue's PDF.
export function renderSourceHtml(text, meta) {
    const materials = Array.isArray(meta?.materials) ? meta.materials : [];
    const refs = parseSourceList(text);
    const links = [];
    const seen = new Set();
    const pages = [];
    for (const ref of refs) {
        if (ref.act) {
            const m = materials[ref.act - 1];
            if (!m || seen.has(m.id)) continue;
            seen.add(m.id);
            const full = [m.issuer, m.title].filter(Boolean).join(' — ');
            links.push(
                `<a href="${DV_MATERIAL_URL}${encodeURIComponent(m.id)}" target="_blank" rel="noopener" title="${escapeHtml(full)}">${escapeHtml(shortActLabel(m.title))}</a>`,
            );
        } else {
            pages.push(ref);
        }
    }
    if (pages.length) {
        const label = `стр. ${pages.map(pageLabel).join(', ')}`;
        links.push(
            meta?.pdfUrl
                ? `<a href="${escapeHtml(meta.pdfUrl)}" target="_blank" rel="noopener">${escapeHtml(label)} (PDF)</a>`
                : escapeHtml(label),
        );
    }
    if (!links.length) return '';
    return `<p class="section-source"><span class="section-source-label">Официален текст:</span> ${links.join(' · ')}</p>`;
}

// Turns each section's closing "Източник: акт 2, стр. 37" line into links to
// the official text. Runs on the markdown before it is parsed, in the build;
// the browser fetches the markdown already turned.
export function renderSourceLines(markdown, meta) {
    return String(markdown)
        .replace(SOURCE_LINE_RE, (_m, list) => {
            const html = renderSourceHtml(list, meta);
            return html ? `\n\n${html}\n\n` : '';
        })
        .replace(/\n{3,}/g, '\n\n');
}

export function stripSourceLines(markdown) {
    return String(markdown).replace(SOURCE_LINE_RE, '');
}

/* ─── Issue page ─── */

const REPORT_URL_BASE = 'https://github.com/otsirh/gazette.bg/issues/new?template=mistake.yml';

export function renderDisclaimer(item) {
    const issueUrl = item?.year && item?.issue ? `https://gazette.bg${issuePath(item)}` : '';
    const reportHref = issueUrl ? `${REPORT_URL_BASE}&issue=${encodeURIComponent(issueUrl)}` : REPORT_URL_BASE;
    const official = item?.pdfUrl
        ? `<a href="${escapeHtml(item.pdfUrl)}" target="_blank" rel="noopener">официалния брой (PDF)</a> на dv.parliament.bg`
        : '<a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>';
    return `<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте ${official}. Забелязахте неточност? <a href="${escapeHtml(reportHref)}" target="_blank" rel="noopener">Съобщете за нея</a>.</p>`;
}

export const CONTENT_DISCLAIMER = renderDisclaimer();
export const END_MARK = '<p class="end-mark" aria-hidden="true">◼</p>';

export function issueTitle(item) {
    const topics = topicsOf(item);
    const dateStr = formatDateLong(item.date);
    if (topics[0]) {
        const suffix = ` — ДВ бр. ${item.issue}${dateStr ? ` (${dateStr})` : ''}`;
        const maxLead = Math.max(40, 105 - suffix.length);
        const lead =
            topics[0].length > maxLead ? `${topics[0].slice(0, maxLead - 1).replace(/[\s.,;:–—-]+$/, '')}…` : topics[0];
        return `${lead}${suffix}`;
    }
    return `Брой ${item.issue}${dateStr ? ` · ${dateStr}` : ''} — Обобщения на Държавен вестник`;
}

// minutes is 0 while the summary is still loading; the estimate joins the
// meta line once the text is in.
export function renderIssueHeader(item, minutes) {
    const topics = topicsOf(item);
    const meta = ['Обобщение с AI'];
    if (topics.length) meta.push(pluralTopics(topics.length));
    if (minutes) meta.push(`≈ ${minutes} мин четене`);
    const metaHtml = meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('<span class="sep">·</span>');

    return (
        `<p class="issue-kicker"><span>Брой ${escapeHtml(String(item.issue))}</span><span class="rule"></span><span>Държавен вестник</span></p>` +
        `<h1 class="title"><span class="visually-hidden">Държавен вестник, брой ${escapeHtml(String(item.issue))} — </span>${escapeHtml(formatDateLong(item.date))}</h1>` +
        `<div class="issue-meta-bar"><p class="issue-meta" id="issue-meta">${metaHtml}</p><button type="button" class="issue-share-btn" id="issue-share-btn" aria-label="Сподели или копирай връзка към този брой">Сподели връзка</button></div>`
    );
}

export function buildTocHtml(tocItems) {
    const mainItems = tocItems.filter((item) => item.level <= 2);
    if (!mainItems.length) return '';
    let html =
        '<nav class="issue-toc" aria-label="Съдържание на броя">' +
        '<details class="issue-toc-details" open>' +
        `<summary class="issue-toc-title"><span>Съдържание</span><span class="issue-toc-count">${escapeHtml(pluralTopics(mainItems.length))}</span></summary>` +
        '<ul class="issue-toc-list">';
    for (const item of mainItems) {
        html += `<li class="issue-toc-item"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
    }
    html += '</ul></details></nav>';
    return html;
}

export function renderIssueArticleHtml(item, processedHtml, tocItems) {
    return `${renderDisclaimer(item)}${buildTocHtml(tocItems)}<div class="issue-body">${processedHtml}${END_MARK}</div>`;
}

export function renderIssueNav(prev, next) {
    let html = '';
    if (prev) {
        html += `<div class="issue-nav-group is-prev"><span class="nav-label">← Предишен брой</span>${renderNavCard(prev)}</div>`;
    }
    if (next) {
        html += `<div class="issue-nav-group is-next"><span class="nav-label">Следващ брой →</span>${renderNavCard(next)}</div>`;
    }
    return html;
}
