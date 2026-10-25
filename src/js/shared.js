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

export function stripMarkdownInline(s) {
    return String(s)
        .replace(/\*+|_+/g, '')
        .replace(/`+/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
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

export function readingMinutes(markdown) {
    const words = stripMarkdownInline(String(markdown)).split(/\s+/).filter(Boolean).length;
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

function cardAttrs(item) {
    return `href="${escapeHtml(issuePath(item))}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}"`;
}

// The front page. Headline is the issue's first topic; the lead sentence, when
// there is one, runs underneath as the standfirst.
function renderLeadCard(item) {
    const topics = topicsOf(item);
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
    return [`Брой ${item.issue}`, formatDateLong(item.date), item.lead || '', ...topicsOf(item)]
        .join(' ')
        .toLowerCase();
}

function renderRowCard(item) {
    const title = topicsOf(item)[0] || item.lead || `Брой ${item.issue}`;
    return (
        `<a class="issue-card issue-card-row" ${cardAttrs(item)} data-search="${escapeHtml(searchHaystack(item))}">` +
        `<span class="num">${escapeHtml(String(item.issue))}</span>` +
        `<span class="row-body"><span class="row-title">${escapeHtml(title)}</span><span class="date">${escapeHtml(formatDateShort(item.date))}</span></span>` +
        `</a>`
    );
}

function renderNavCard(item) {
    return (
        `<a class="issue-card" ${cardAttrs(item)}>` +
        `<span class="num">Брой ${escapeHtml(String(item.issue))}</span>` +
        `<span class="date">${escapeHtml(formatDateShort(item.date))}</span>` +
        `</a>`
    );
}

function renderArchive(items) {
    if (!items.length) return '';
    const byYear = {};
    for (const item of items) {
        if (!byYear[item.year]) byYear[item.year] = [];
        byYear[item.year].push(item);
    }
    const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
    const total = items.length;

    let html = '<section class="archive-section" id="archive">';
    html += `<div class="section-head"><h2 class="section-title">Архив</h2><span class="section-count">${total} ${total === 1 ? 'брой' : 'броя'}</span></div>`;
    html +=
        '<div class="archive-search"><input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене в текста на броевете…" aria-label="Търсене в текста на броевете" autocomplete="off" spellcheck="false" /></div>';
    for (const year of years) {
        html += `<div class="year-group"><h3 class="year-title"><span>${escapeHtml(year)}</span></h3><div class="issue-list">`;
        for (const item of byYear[year]) html += renderRowCard(item);
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
    return renderLeadCard(all[0]) + renderArchive(all.slice(1));
}

/* ─── Issue page ─── */

export const CONTENT_DISCLAIMER =
    '<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';
export const END_MARK = '<p class="end-mark" aria-hidden="true">◼</p>';

export function issueTitle(item) {
    return `Брой ${item.issue} · ${formatDateLong(item.date)} — Обобщения на Държавен вестник`;
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
        `<p class="issue-meta" id="issue-meta">${metaHtml}</p>`
    );
}

export function buildTocHtml(tocItems) {
    const mainItems = tocItems.filter((item) => item.level <= 2);
    if (!mainItems.length) return '';
    let html =
        '<nav class="issue-toc" aria-label="Съдържание на броя"><p class="issue-toc-title">Съдържание</p><ul class="issue-toc-list">';
    for (const item of mainItems) {
        html += `<li class="issue-toc-item"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
    }
    html += '</ul></nav>';
    return html;
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
