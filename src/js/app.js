(function () {
    'use strict';

    const catalogUrl = '/catalog.json';

    const homeView = document.getElementById('home-view');
    const homeContent = document.getElementById('home-content');
    const issueView = document.getElementById('issue-view');
    const backBtns = document.querySelectorAll('.back-btn');
    const backBtn = document.getElementById('back-btn');
    const mainLoading = document.getElementById('loading');
    const issueHeaderEl = document.getElementById('issue-header');
    const issueShareEl = document.getElementById('issue-share');
    const mainContent = document.getElementById('content');
    const mainEl = document.getElementById('main');
    const scrollToTopBtn = document.getElementById('scroll-to-top');
    const progressEl = document.getElementById('reading-progress');
    const themeToggle = document.getElementById('theme-toggle');

    let catalog = null;

    // Must match the server-rendered home <title> in index.html, so returning
    // to the home view via the SPA doesn't rewrite it to a different string.
    const PAGE_TITLE_BASE = 'Държавен вестник — кратки обобщения на всеки брой с AI';
    const THEME_KEY = 'gazette-theme';
    const THEME_COLORS = { light: '#fbf8f2', dark: '#100f0c' };
    const WORDS_PER_MINUTE = 180;
    const COPY_LABEL = 'Копирай връзка';

    // The closed audience vocabulary (mirrors scripts/issue-meta.js). Powers the
    // "За мен" filter: the reader picks who they are and the archive narrows to
    // the issues that touch them. The choice persists locally.
    const AUDIENCES = [
        'шофьор', 'собственик на имот', 'пенсионер', 'родител', 'ученик или студент',
        'пациент', 'земеделец', 'фирма или самонает', 'работещ', 'потребител', 'жител на конкретно място',
    ];
    const AUDIENCE_KEY = 'gazette-audiences';

    function loadSelectedAudiences() {
        try {
            const raw = JSON.parse(localStorage.getItem(AUDIENCE_KEY) || '[]');
            return new Set(Array.isArray(raw) ? raw.filter((a) => AUDIENCES.includes(a)) : []);
        } catch (e) { return new Set(); }
    }
    function saveSelectedAudiences() {
        try { localStorage.setItem(AUDIENCE_KEY, JSON.stringify([...selectedAudiences])); } catch (e) { /* storage blocked */ }
    }
    const selectedAudiences = loadSelectedAudiences();

    // Honour prefers-reduced-motion for JS-driven scrolling: an explicit
    // behavior:'smooth' argument is not governed by CSS scroll-behavior, so the
    // stylesheet's reduced-motion block can't neutralise it — we must here.
    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }
    function scrollBehavior() {
        return prefersReducedMotion() ? 'auto' : 'smooth';
    }

    // A single polite live region announces state changes (issue loaded, load
    // failed, empty search) to screen readers. Guard against re-announcing an
    // unchanged message.
    const statusRegion = document.getElementById('a11y-status');
    function announce(message) {
        if (statusRegion && statusRegion.textContent !== message) statusRegion.textContent = message;
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
    const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

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

    // Long form ("10 юли 2026") for datelines; short form drops the year for
    // the archive register, where the year is already the running head.
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

    /* ─── Theme ─────────────────────────────────────── */

    function currentTheme() {
        const set = document.documentElement.getAttribute('data-theme');
        if (set === 'dark' || set === 'light') return set;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // The two <meta name="theme-color"> tags are keyed to prefers-color-scheme,
    // so an explicitly chosen theme would leave the browser chrome the opposite
    // colour of the page. Once the reader has chosen, the OS preference no
    // longer decides: drop the media gate and pin both tags to the live colour.
    function syncThemeColor(theme) {
        const color = THEME_COLORS[theme];
        if (!color) return;
        document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
            meta.removeAttribute('media');
            meta.setAttribute('content', color);
        });
    }

    function syncThemeToggleState(theme) {
        if (themeToggle) themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
    }

    function toggleTheme() {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        syncThemeColor(next);
        syncThemeToggleState(next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage blocked — theme is per-page then */ }
    }

    /* ─── Article rendering ─────────────────────────── */

    function processRenderedContent(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        div.querySelectorAll('h1').forEach((h1) => {
            const h2 = document.createElement('h2');
            for (const attr of Array.from(h1.attributes)) h2.setAttribute(attr.name, attr.value);
            h2.innerHTML = h1.innerHTML;
            h1.replaceWith(h2);
        });
        const used = new Set();
        const tocItems = [];
        div.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
            const text = h.textContent.trim();
            let id = slugify(text);
            if (used.has(id)) {
                let n = 2;
                while (used.has(id + '-' + n)) n++;
                id = id + '-' + n;
            }
            used.add(id);
            h.id = id;
            tocItems.push({ level: parseInt(h.tagName.slice(1), 10), text, id });
        });
        return { html: div.innerHTML, tocItems };
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

    /* ─── Catalog ───────────────────────────────────── */

    function getAllIssuesNewestFirst() {
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

    function findIssueByYearAndNumber(year, issueNum) {
        if (!catalog || !catalog.years || !catalog.years[year]) return null;
        const issue = catalog.years[year].find((item) => String(item.issue) === String(issueNum));
        return issue ? { ...issue, year } : null;
    }

    function getIssueFromPath() {
        const m = /\/issue\/(\d+)\/(\d+)\/?$/i.exec(location.pathname);
        return m ? { year: m[1], issueNum: m[2] } : null;
    }

    function setIssuePath(year, issueNum) {
        // Trailing slash matches the URL the host actually serves (Cloudflare
        // Pages 308-redirects the non-slash form), so canonical == current URL.
        const path = '/issue/' + year + '/' + issueNum + '/';
        if (location.pathname !== path) history.pushState(null, '', path);
    }

    let currentIssue = null;
    let lastFocusedCard = null;
    let currentTocId = null;

    const LEAD_TOPIC_LIMIT = 5;

    function cardAttrs(item) {
        const href = `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}/`;
        return `href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}"`;
    }

    // The front page. Headline is the issue's first topic; the lead sentence,
    // when there is one, runs underneath as the standfirst.
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

        const standfirstHtml = standfirst
            ? `<p class="lead-standfirst">${escapeHtml(standfirst)}</p>`
            : '';
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

    /* ─── Tags and deadlines (mirrors scripts/build-issue-pages.js) ─── */

    function renderTags(audiences) {
        if (!Array.isArray(audiences) || !audiences.length) return '';
        return `<p class="tags">${audiences.map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join('')}</p>`;
    }

    // The places a brief names; each links to the archive pre-filtered to it.
    function renderPlaces(places) {
        if (!Array.isArray(places) || !places.length) return '';
        const chips = places
            .map((pl) => `<a class="place-chip" href="/?q=${encodeURIComponent(pl)}#archive">${escapeHtml(pl)}</a>`)
            .join('');
        return `<p class="issue-places"><span class="issue-places-label">Места в броя</span>${chips}</p>`;
    }

    // "Проследи темите" — mirrors scripts/build-issue-pages.js. Resolves the
    // compact [year, issue, sectionIndex] refs against the loaded catalog.
    function resolveRelated(ref) {
        if (!Array.isArray(ref) || !catalog || !catalog.years) return null;
        const [year, issue, secIndex] = ref;
        const entry = (catalog.years[String(year)] || []).find((e) => String(e.issue) === String(issue));
        const sec = entry && (entry.sections || [])[secIndex];
        if (!sec || !sec.title) return null;
        return { year, issue, title: sec.title, date: entry.date, slug: slugify(sec.title) };
    }

    function renderTopicThreads(item) {
        const sections = Array.isArray(item.sections) ? item.sections : [];
        const rows = [];
        for (const s of sections) {
            if (!Array.isArray(s.related) || !s.related.length) continue;
            const links = s.related.map((ref) => {
                const t = resolveRelated(ref);
                if (!t) return '';
                return `<a class="thread-link" href="/issue/${t.year}/${t.issue}/#${encodeURIComponent(t.slug)}" title="${escapeHtml(t.title)}">брой ${escapeHtml(String(t.issue))} · ${escapeHtml(formatDateShort(t.date))}</a>`;
            }).filter(Boolean).join('');
            if (links) rows.push(`<li class="thread"><span class="thread-topic">${escapeHtml(s.title)}</span><span class="thread-links">${links}</span></li>`);
        }
        if (!rows.length) return '';
        return `<aside class="topic-threads" aria-label="Свързано отразяване"><p class="topic-threads-title">Проследи темите</p><ul class="topic-threads-list">${rows.join('')}</ul></aside>`;
    }

    function isoToday() {
        const d = new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }

    function daysUntil(iso) {
        const then = new Date(iso + 'T00:00:00');
        const now = new Date(isoToday() + 'T00:00:00');
        return Math.round((then - now) / 86400000);
    }

    function formatIsoBg(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        return m ? `${parseInt(m[3], 10)} ${BG_MONTHS[parseInt(m[2], 10) - 1]}` : iso;
    }

    // A deadline as a downloadable all-day .ics event, encoded as a data: URI so
    // the link works with no server (mirrors scripts/build-issue-pages.js).
    function icsEscape(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    }
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
    function utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function deadlineIcs(d, item) {
        const start = String(d.expires || '').replace(/-/g, '');
        const end = icsAddDay(d.expires).replace(/-/g, '');
        const url = location.origin + `/issue/${item.year}/${item.issue}/`;
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
        const href = 'data:text/calendar;charset=utf-8;base64,' + utf8ToBase64(deadlineIcs(d, item));
        return `<a class="deadline-cal" download="gazette-deadline-${escapeHtml(String(item.issue))}.ics" href="${href}" aria-label="Добави срока в календара">＋ Календар</a>`;
    }

    function renderDeadlineRow(d, item, withIssue = true) {
        const href = `/issue/${item.year}/${item.issue}/`;
        // Inside the issue itself, saying which issue it came from is noise.
        const who = [d.who, withIssue ? `брой ${item.issue}` : ''].filter(Boolean).join(' · ');
        return `<li class="deadline" data-expires="${escapeHtml(d.expires)}">` +
            `<span class="deadline-left">до ${escapeHtml(formatIsoBg(d.expires))}</span>` +
            `<span class="deadline-body">` +
            `<a class="deadline-what" href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}">${escapeHtml(d.what)}</a>` +
            `<span class="deadline-who">${escapeHtml(who)}</span>` +
            renderDeadlineCal(d, item) +
            `</span></li>`;
    }

    // Only the soonest few are actionable; the rest would be a wall.
    const DEADLINES_SHOWN = 8;

    function renderDeadlinesSection(all) {
        const today = isoToday();
        const rows = [];
        all.forEach((item) => {
            (item.deadlines || []).forEach((d) => {
                if (d.expires >= today) rows.push({ d, item });
            });
        });
        if (!rows.length) return '';
        rows.sort((a, b) => a.d.expires.localeCompare(b.d.expires));
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
            `<ul class="deadline-list">${shown.map((r) => renderDeadlineRow(r.d, r.item)).join('')}</ul>` +
            restNote +
            '</section>';
    }

    // The pages are built once and read for weeks, so "до 24 юли" is what the
    // server can honestly say. Only the browser knows what day it is — it turns
    // that into "след 4 дни" and drops whatever has run out.
    function refreshDeadlines(root) {
        const scope = root || document;
        const today = isoToday();
        // The header count is the true number of open deadlines, but the list
        // only ever renders the soonest few (the rest are folded into a note).
        // So it can't be recounted from the DOM — instead track what actually
        // expired here and subtract that from the total the count already shows.
        let expiredFromMain = 0;
        scope.querySelectorAll('.deadline').forEach((el) => {
            const expires = el.dataset.expires;
            if (!expires || expires < today) {
                if (el.closest('.deadlines-section')) expiredFromMain++;
                el.remove();
                return;
            }
            const left = daysUntil(expires);
            const label = el.querySelector('.deadline-left');
            if (label) {
                label.textContent = left === 0 ? 'днес изтича' : left === 1 ? 'утре изтича' : `след ${left} дни`;
                label.title = 'до ' + formatIsoBg(expires);
            }
            el.classList.toggle('is-urgent', left <= 3);
        });
        scope.querySelectorAll('.deadline-list').forEach((list) => {
            const section = list.closest('.deadlines-section, .issue-deadlines, .month-group');
            if (section && !list.querySelector('.deadline')) section.remove();
        });
        const count = document.getElementById('deadline-count');
        if (count && expiredFromMain > 0) {
            const shown = parseInt(count.textContent, 10);
            const n = Math.max(0, (Number.isNaN(shown) ? 0 : shown) - expiredFromMain);
            count.textContent = n + ' ' + (n === 1 ? 'срок' : 'срока');
        }
    }

    function renderArchive(items) {
        if (!items.length) return '';
        const byYear = {};
        items.forEach((item) => {
            if (!byYear[item.year]) byYear[item.year] = [];
            byYear[item.year].push(item);
        });
        const years = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
        const total = items.length;

        let html = '<section class="archive-section" id="archive">';
        html += `<div class="section-head"><h2 class="section-title">Архив</h2><span class="section-count">${total} ${total === 1 ? 'брой' : 'броя'}</span></div>`;
        html += '<div class="archive-search"><input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене в текста на броевете…" aria-label="Търсене в текста на броевете" autocomplete="off" spellcheck="false" /></div>';
        html += renderAudienceFilter();
        years.forEach((year) => {
            html += `<div class="year-group"><h3 class="year-title"><span>${escapeHtml(year)}</span></h3><div class="issue-list">`;
            byYear[year].forEach((item) => { html += renderRowCard(item); });
            html += '</div></div>';
        });
        html += '</section>';
        return html;
    }

    function renderHome() {
        if (!catalog || !catalog.years) return;
        const all = getAllIssuesNewestFirst();
        if (!all.length) {
            homeContent.innerHTML = '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
            return;
        }

        // The pre-rendered register is searchable before catalog.json lands, so
        // a query may already be in flight. Carry it over to the fresh input —
        // reading the value after the re-render would always find it empty.
        const previous = document.getElementById('archive-search');
        const pendingQuery = previous ? previous.value : '';

        homeContent.innerHTML = renderLeadCard(all[0]) + renderDeadlinesSection(all) + renderArchive(all.slice(1));
        refreshDeadlines(homeContent);
        syncAudienceChips();

        if (pendingQuery) {
            const searchInput = document.getElementById('archive-search');
            if (searchInput) searchInput.value = pendingQuery;
        }
        if (pendingQuery || selectedAudiences.size) applyArchiveFilter();
    }

    // The "За мен" filter: a row of the audience vocabulary the reader can
    // toggle. Sits inside the archive because that is what it narrows.
    function renderAudienceFilter() {
        const chips = AUDIENCES.map((a) =>
            `<button type="button" class="aud-chip" data-aud="${escapeHtml(a)}" aria-pressed="false">${escapeHtml(a)}</button>`
        ).join('');
        return '<div class="audience-filter" role="group" aria-label="Покажи само това, което ме засяга">' +
            '<span class="audience-filter-label">За мен</span>' +
            chips +
            '<button type="button" class="aud-clear" hidden>× изчисти</button>' +
            '</div>';
    }

    // Reflect the saved selection on the freshly rendered chips.
    function syncAudienceChips() {
        if (!homeContent) return;
        homeContent.querySelectorAll('.aud-chip').forEach((chip) => {
            const on = selectedAudiences.has(chip.dataset.aud);
            chip.classList.toggle('is-active', on);
            chip.setAttribute('aria-pressed', String(on));
        });
        const clear = homeContent.querySelector('.aud-clear');
        if (clear) clear.hidden = selectedAudiences.size === 0;
    }

    function onAudienceClick(e) {
        if (e.target.closest('.aud-clear')) {
            selectedAudiences.clear();
            saveSelectedAudiences();
            syncAudienceChips();
            applyArchiveFilter();
            return;
        }
        const chip = e.target.closest('.aud-chip');
        if (!chip || !chip.dataset.aud) return;
        const aud = chip.dataset.aud;
        if (selectedAudiences.has(aud)) selectedAudiences.delete(aud);
        else selectedAudiences.add(aud);
        saveSelectedAudiences();
        syncAudienceChips();
        applyArchiveFilter();
    }

    // The full text of every summary, keyed "year/issue". Fetched once, lazily,
    // the first time the reader searches — so it never weighs on a normal visit.
    let searchIndex = null;
    let searchIndexLower = null;
    let searchIndexLoading = false;
    function ensureSearchIndex() {
        if (searchIndex || searchIndexLoading) return;
        searchIndexLoading = true;
        fetch('/search-index.json')
            .then((r) => (r.ok ? r.json() : null))
            .then((idx) => {
                if (!idx) return;
                searchIndex = idx;
                searchIndexLower = {};
                for (const k in idx) searchIndexLower[k] = String(idx[k]).toLowerCase();
                applyArchiveFilter(); // re-run with the current query now that the text is here
            })
            .catch(() => { /* full text just stays unavailable; metadata search still works */ });
    }

    // A ~140-char window around the first hit, with the match highlighted. Built
    // from escaped parts so the <mark> is the only markup.
    function buildSnippet(original, qLower) {
        const lower = original.toLowerCase();
        const i = lower.indexOf(qLower);
        if (i < 0) return '';
        const start = Math.max(0, i - 45);
        const end = Math.min(original.length, i + qLower.length + 95);
        const pre = (start > 0 ? '…' : '') + original.slice(start, i);
        const mid = original.slice(i, i + qLower.length);
        const post = original.slice(i + qLower.length, end) + (end < original.length ? '…' : '');
        return escapeHtml(pre) + '<mark>' + escapeHtml(mid) + '</mark>' + escapeHtml(post);
    }
    function injectSnippet(row, qLower) {
        const original = searchIndex && searchIndex[(row.dataset.year || '') + '/' + (row.dataset.issue || '')];
        const body = row.querySelector('.row-body');
        if (!original || !body) return;
        const html = buildSnippet(original, qLower);
        if (!html) return;
        const el = document.createElement('span');
        el.className = 'row-snippet';
        el.innerHTML = html;
        body.appendChild(el);
    }

    // Live filter over the archive register — and only over it. The lead story
    // and the colophon stay put: controls that sit inside the archive are
    // expected to narrow the archive, not to rearrange the page around them.
    // Criteria combine (AND): the text query (metadata + full text) and the
    // "За мен" audiences.
    function applyArchiveFilter(rawQuery) {
        if (!homeContent) return;
        const input = document.getElementById('archive-search');
        const displayQ = (rawQuery != null ? rawQuery : (input ? input.value : '')).trim();
        const q = displayQ.toLowerCase();
        const auds = selectedAudiences;
        const hasAud = auds.size > 0;
        const archiveSection = homeContent.querySelector('.archive-section');
        const existingNote = homeContent.querySelector('.filter-empty');
        if (existingNote) existingNote.remove();
        homeContent.querySelectorAll('.row-snippet').forEach((el) => el.remove());

        if (!q && !hasAud) {
            homeContent.querySelectorAll('.filter-hidden').forEach((el) => el.classList.remove('filter-hidden'));
            announce('');
            return;
        }

        let anyVisible = false;
        homeContent.querySelectorAll('.year-group').forEach((group) => {
            let groupVisible = false;
            group.querySelectorAll('.issue-card-row').forEach((row) => {
                // Metadata (instant) OR the full summary text (once the index has
                // loaded). A body-only match also gets a highlighted snippet.
                const metaMatch = !q || ((row.dataset.search || '') + ' ' + row.textContent.toLowerCase()).includes(q);
                let bodyMatch = false;
                if (q && searchIndexLower) {
                    const body = searchIndexLower[(row.dataset.year || '') + '/' + (row.dataset.issue || '')];
                    bodyMatch = !!(body && body.includes(q));
                }
                const audMatch = !hasAud || (row.dataset.audiences || '').split('|').some((a) => auds.has(a));
                const match = (metaMatch || bodyMatch) && audMatch;
                row.classList.toggle('filter-hidden', !match);
                if (match) {
                    groupVisible = true; anyVisible = true;
                    if (bodyMatch && q) injectSnippet(row, q);
                }
            });
            group.classList.toggle('filter-hidden', !groupVisible);
        });

        if (archiveSection && !anyVisible) {
            const note = document.createElement('p');
            note.className = 'empty filter-empty';
            note.textContent = displayQ
                ? 'Няма намерени броеве за „' + displayQ + '“.'
                : 'Няма броеве за избраните профили.';
            archiveSection.appendChild(note);
            announce('Няма намерени броеве.');
        } else {
            announce('');
        }
    }

    // A place chip on an issue page lands here as /?q=<place>#archive. Carry the
    // query into the archive search, filter, and drop the reader at the register.
    function applyPendingArchiveQuery() {
        if (location.pathname !== '/') return;
        let q = '';
        try { q = new URLSearchParams(location.search).get('q') || ''; } catch (_) { return; }
        if (!q) return;
        ensureSearchIndex();
        const input = document.getElementById('archive-search');
        if (input) { input.value = q; applyArchiveFilter(q); }
        const archive = document.getElementById('archive');
        if (archive) requestAnimationFrame(() => archive.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }));
    }

    /* ─── Views ─────────────────────────────────────── */

    function showHome() {
        currentIssue = null;
        document.title = PAGE_TITLE_BASE;
        document.documentElement.classList.remove('initial-issue-route');
        document.body.classList.remove('issue-open', 'issue-ready');
        homeView.style.display = 'block';
        issueView.style.display = 'none';
        window.scrollTo(0, 0);
        if (scrollToTopBtn) scrollToTopBtn.classList.remove('is-visible');
        if (progressEl) progressEl.style.width = '0';
        currentTocId = null;
        if (location.pathname !== '/') history.pushState(null, '', '/');
        if (lastFocusedCard && typeof lastFocusedCard.focus === 'function') {
            lastFocusedCard.focus();
            lastFocusedCard = null;
        } else {
            // Direct-load path (no originating card): move focus to the top of
            // the home view instead of letting it fall to <body>.
            const home = document.querySelector('.masthead-title a');
            if (home && typeof home.focus === 'function') home.focus();
        }
    }

    function showIssue() {
        document.body.classList.remove('issue-ready');
        document.body.classList.add('issue-open');
        homeView.style.display = 'none';
        issueView.style.display = 'block';
    }

    function getWindowScrollTop() {
        return window.scrollY ?? document.documentElement.scrollTop ?? 0;
    }

    // Server-rendered issue pages are shown by CSS (body.issue-open), never by
    // an inline style — so the body class is the only reliable signal here.
    function isIssueOpen() {
        return document.body.classList.contains('issue-open');
    }

    const SCROLL_TO_TOP_THRESHOLD = 400;

    function updateScrollToTopVisibility() {
        if (!scrollToTopBtn) return;
        if (!isIssueOpen()) {
            scrollToTopBtn.classList.remove('is-visible');
            return;
        }
        scrollToTopBtn.classList.toggle('is-visible', getWindowScrollTop() > SCROLL_TO_TOP_THRESHOLD);
    }

    function updateReadingProgress() {
        if (!progressEl) return;
        if (!isIssueOpen()) {
            progressEl.style.width = '0';
            return;
        }
        const doc = document.documentElement;
        const scrollable = doc.scrollHeight - window.innerHeight;
        const ratio = scrollable > 0 ? Math.min(1, Math.max(0, getWindowScrollTop() / scrollable)) : 0;
        progressEl.style.width = (ratio * 100).toFixed(1) + '%';
    }

    /* ─── Issue page ────────────────────────────────── */

    function getAdjacentIssues() {
        if (!currentIssue || !catalog) return { prev: null, next: null };
        const all = getAllIssuesNewestFirst();
        const idx = all.findIndex((item) => String(item.year) === currentIssue.year && String(item.issue) === currentIssue.issueNum);
        return {
            prev: idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null,
            next: idx > 0 ? all[idx - 1] : null
        };
    }

    // Drops a row of "who this is for" tags under every heading it has tags for,
    // so the reader can skip a section without reading it.
    function injectSectionTags(container, sections) {
        if (!container || !Array.isArray(sections) || !sections.length) return;
        const byTitle = new Map(sections.map((s) => [s.title.trim(), s.audiences || []]));
        container.querySelectorAll('h2').forEach((h2) => {
            const audiences = byTitle.get(h2.textContent.trim());
            if (!audiences || !audiences.length) return;
            const p = document.createElement('p');
            p.className = 'tags';
            p.innerHTML = audiences.map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join('');
            h2.insertAdjacentElement('afterend', p);
        });
    }

    // Abbreviation glossary. Pre-rendered issue pages get the tooltips from the
    // build; client-rendered ones fetch the map once and apply it here. A
    // multi-word term falls back to its first word ("БНТ 4" → БНТ).
    let glossary = null;
    let glossaryLoading = false;
    function glossifyContent(container) {
        if (!container || !glossary) return;
        container.querySelectorAll('code:not(.gloss)').forEach((code) => {
            const term = code.textContent.trim();
            const def = glossary[term] || glossary[term.split(/\s+/)[0]];
            if (def) { code.classList.add('gloss'); code.title = def; }
        });
    }
    function ensureGlossary() {
        if (glossary) { glossifyContent(mainContent); return; }
        if (glossaryLoading) return;
        glossaryLoading = true;
        fetch('/glossary.json')
            .then((r) => (r.ok ? r.json() : null))
            .then((g) => { if (g) { glossary = g; glossifyContent(mainContent); } })
            .catch(() => { /* terms just render without tooltips */ });
    }

    // Once the reader has picked a profile in "За мен", light up what touches
    // them inside a brief: the matching audience tags, and a marker on every
    // section that has one. Purely a reading aid — no profile, nothing shows.
    function highlightRelevantSections(root) {
        if (!root) return;
        root.querySelectorAll('.tag.is-for-you').forEach((t) => t.classList.remove('is-for-you'));
        root.querySelectorAll('h2.section-for-you').forEach((h) => h.classList.remove('section-for-you'));
        if (!selectedAudiences.size) return;
        root.querySelectorAll('.tag').forEach((tag) => {
            if (selectedAudiences.has(tag.textContent.trim())) tag.classList.add('is-for-you');
        });
        root.querySelectorAll('.content .tags').forEach((tagsRow) => {
            const match = [...tagsRow.querySelectorAll('.tag')].some((t) => selectedAudiences.has(t.textContent.trim()));
            const h2 = tagsRow.previousElementSibling;
            if (match && h2 && h2.tagName === 'H2') h2.classList.add('section-for-you');
        });
    }

    function renderIssueDeadlines(item) {
        const el = document.getElementById('issue-deadlines');
        if (!el) return;
        const today = isoToday();
        const open = (item.deadlines || []).filter((d) => d.expires >= today);
        el.innerHTML = open.length
            ? '<section class="issue-deadlines"><p class="issue-deadlines-title">Срокове от този брой</p>' +
              `<ul class="deadline-list">${open.map((d) => renderDeadlineRow(d, item, false)).join('')}</ul></section>`
            : '';
        refreshDeadlines(el);
    }

    function renderIssueHeader(item, minutes) {
        const topics = Array.isArray(item.topics) ? item.topics : [];
        const meta = ['Обобщение с AI'];
        if (topics.length) meta.push(pluralTopics(topics.length));
        if (minutes) meta.push('≈ ' + minutes + ' мин четене');
        const metaHtml = meta
            .map((m) => `<span>${escapeHtml(m)}</span>`)
            .join('<span class="sep">·</span>');

        return `<p class="issue-kicker"><span>Брой ${escapeHtml(String(item.issue))}</span><span class="rule"></span><span>Държавен вестник</span></p>` +
            `<h1 class="title"><span class="visually-hidden">Държавен вестник, брой ${escapeHtml(String(item.issue))} — </span>${escapeHtml(formatDateLong(item.date))}</h1>` +
            `<p class="issue-meta" id="issue-meta">${metaHtml}</p>` +
            renderTags(item.audiences) +
            renderPlaces(item.places);
    }

    function renderShare(item) {
        const url = location.origin + `/issue/${item.year}/${item.issue}/`;
        const text = `Държавен вестник, брой ${item.issue} — обобщение`;
        const u = encodeURIComponent(url);
        const t = encodeURIComponent(text);
        return '<span class="share-label">Сподели</span>' +
            `<button type="button" class="share-btn" id="share-copy" data-url="${escapeHtml(url)}">${COPY_LABEL}</button>` +
            `<a class="share-btn" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">Facebook</a>` +
            `<a class="share-btn" href="https://twitter.com/intent/tweet?url=${u}&text=${t}" target="_blank" rel="noopener">X</a>` +
            `<a class="share-btn" href="mailto:?subject=${t}&body=${u}">Имейл</a>`;
    }

    function renderIssueNav(prev, next) {
        const navEl = document.getElementById('issue-nav');
        if (!navEl) return;
        if (!prev && !next) { navEl.innerHTML = ''; return; }
        let html = '';
        if (prev) {
            html += `<div class="issue-nav-group is-prev"><span class="nav-label">← Предишен брой</span>${renderNavCard(prev)}</div>`;
        }
        if (next) {
            html += `<div class="issue-nav-group is-next"><span class="nav-label">Следващ брой →</span>${renderNavCard(next)}</div>`;
        }
        navEl.innerHTML = html;
    }

    const TOC_ACTIVE_OFFSET = 140;

    function updateCurrentTocItem() {
        if (!isIssueOpen() || !mainContent) return;
        const headings = mainContent.querySelectorAll('h1[id], h2[id]');
        if (!headings.length) return;
        let activeId = null;
        for (const h of headings) {
            if (h.getBoundingClientRect().top <= TOC_ACTIVE_OFFSET) activeId = h.id;
            else break;
        }
        if (activeId === currentTocId) return;
        currentTocId = activeId;
        mainContent.querySelectorAll('.issue-toc a[href^="#"]').forEach((a) => {
            const href = a.getAttribute('href');
            const targetId = href ? href.slice(1) : '';
            a.classList.toggle('is-current', activeId !== null && targetId === activeId);
        });
    }

    function scrollToHashTarget(behavior) {
        if (!location.hash || location.hash.length < 2) return false;
        let id = location.hash.slice(1);
        try { id = decodeURIComponent(id); } catch (_) { /* keep raw */ }
        const el = document.getElementById(id);
        if (!el) return false;
        el.scrollIntoView({ behavior: behavior || 'auto', block: 'start' });
        return true;
    }

    const CONTENT_DISCLAIMER = '<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';
    const END_MARK = '<p class="end-mark" aria-hidden="true">◼</p>';

    async function openIssue(item) {
        currentIssue = { year: String(item.year), issueNum: String(item.issue) };
        setIssuePath(item.year, item.issue);
        showIssue();
        mainLoading.hidden = false;
        mainContent.innerHTML = '';
        if (issueShareEl) issueShareEl.innerHTML = '';
        const deadlinesEl = document.getElementById('issue-deadlines');
        if (deadlinesEl) deadlinesEl.innerHTML = '';
        const navEl = document.getElementById('issue-nav');
        if (navEl) navEl.innerHTML = '';

        const titleDate = formatDateLong(item.date);
        document.title = `Брой ${item.issue} · ${titleDate} — Обобщения на Държавен вестник`;
        issueHeaderEl.innerHTML = renderIssueHeader(item, 0);

        try {
            const fileUrl = item.file.startsWith('/') ? item.file : '/' + item.file;
            const r = await fetch(fileUrl);
            if (!r.ok) throw new Error(r.statusText);
            const md = await r.text();
            const rawHtml = typeof marked !== 'undefined' ? marked.parse(md) : md;
            const { html: processedHtml, tocItems } = processRenderedContent(rawHtml);
            mainContent.innerHTML = CONTENT_DISCLAIMER + buildTocHtml(tocItems) + processedHtml + renderTopicThreads(item) + END_MARK;
            injectSectionTags(mainContent, item.sections);
            ensureGlossary();
            issueHeaderEl.innerHTML = renderIssueHeader(item, readingMinutes(md));
            highlightRelevantSections(issueView);
            renderIssueDeadlines(item);
            if (issueShareEl) issueShareEl.innerHTML = renderShare(item);
            announce(`Заредено: Държавен вестник, брой ${item.issue}.`);
            currentTocId = null;
            updateCurrentTocItem();
            if (location.hash) requestAnimationFrame(() => scrollToHashTarget('auto'));
            else if (backBtn) backBtn.focus();
        } catch (e) {
            mainContent.innerHTML = '<p>Този брой не може да бъде зареден в момента. Моля, опитайте отново или изберете друг брой от началната страница.</p>';
            announce('Броят не можа да бъде зареден.');
        }

        const { prev, next } = getAdjacentIssues();
        renderIssueNav(prev, next);
        mainLoading.hidden = true;
        document.body.classList.add('issue-ready');
        updateReadingProgress();

        // Warm the neighbours — most readers step through issues in order.
        if (prev && prev.file) fetch(prev.file.startsWith('/') ? prev.file : '/' + prev.file).catch(() => {});
        if (next && next.file) fetch(next.file.startsWith('/') ? next.file : '/' + next.file).catch(() => {});
    }

    function applyRoute() {
        const fromPath = getIssueFromPath();
        if (fromPath && currentIssue && currentIssue.year === fromPath.year && currentIssue.issueNum === fromPath.issueNum) {
            if (!scrollToHashTarget(scrollBehavior())) window.scrollTo({ top: 0, behavior: scrollBehavior() });
            return;
        }
        if (fromPath) {
            const item = findIssueByYearAndNumber(fromPath.year, fromPath.issueNum);
            if (item) openIssue(item);
            else showHome();
        } else {
            showHome();
        }
    }

    /* ─── Events ────────────────────────────────────── */

    let copyResetTimer = null;

    async function copyLink(btn) {
        const url = btn.dataset.url || location.href;
        try {
            await navigator.clipboard.writeText(url);
        } catch (e) {
            const input = document.createElement('input');
            input.value = url;
            document.body.appendChild(input);
            input.select();
            try { document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
            input.remove();
        }
        // Restore from the constant, not from the button's current label: a
        // second click within the timeout would otherwise capture "Копирано ✓"
        // as the label to restore and the button would keep it for good.
        if (copyResetTimer) clearTimeout(copyResetTimer);
        btn.textContent = 'Копирано ✓';
        btn.classList.add('is-copied');
        copyResetTimer = setTimeout(() => {
            btn.textContent = COPY_LABEL;
            btn.classList.remove('is-copied');
            copyResetTimer = null;
        }, 2000);
    }

    function onMainClick(e) {
        const copyBtn = e.target.closest('#share-copy');
        if (copyBtn) {
            copyLink(copyBtn);
            return;
        }

        const card = e.target.closest('a.issue-card');
        if (card) {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            const file = card.dataset.file;
            const issueNum = card.dataset.issue;
            const year = card.dataset.year;
            if (!file || !issueNum || !year) return;
            const item = findIssueByYearAndNumber(year, issueNum) || {
                file, issue: issueNum, year, date: card.dataset.date, topics: []
            };
            e.preventDefault();
            lastFocusedCard = card;
            openIssue(item);
            return;
        }

        const link = e.target.closest('.issue-toc a[href^="#"]');
        if (!link) return;
        const href = link.getAttribute('href');
        const id = href.slice(1);
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
            e.preventDefault();
            el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
            if (location.hash !== href) history.pushState(null, '', href);
        }
    }

    // "Архив" used to just jump the page down and leave you there, which reads as
    // nothing happening. Someone who clicks it wants to find an issue — so land
    // on the register with the cursor already in the search box. Not on a touch
    // screen, where that would throw the keyboard in the reader's face.
    function onFolioClick(e) {
        const link = e.target.closest('.folio-link[href^="/#"]');
        if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (document.body.classList.contains('issue-open')) return; // let it navigate home

        const id = link.getAttribute('href').slice(2);
        const target = document.getElementById(id);
        if (!target) return;

        e.preventDefault();
        target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        if (location.hash !== '#' + id) history.pushState(null, '', '/#' + id);

        const search = id === 'archive' ? document.getElementById('archive-search') : null;
        if (search && window.matchMedia('(hover: hover)').matches) {
            setTimeout(() => search.focus({ preventScroll: true }), 400);
        }
    }

    // The /map choropleth: hover/focus a province for a tooltip, click/enter to
    // open the archive filtered to it. The ranked list below the map is the
    // keyboard/screen-reader-friendly equivalent.
    function initMap() {
        const figure = document.querySelector('.map-figure');
        const svg = document.querySelector('.bg-map');
        const tip = document.getElementById('map-tooltip');
        if (!figure || !svg || !tip) return;
        const showTip = (el) => {
            const name = el.getAttribute('data-name');
            const count = el.getAttribute('data-count');
            tip.textContent = `${name} · ${count} ${count === '1' ? 'брой' : 'броя'}`;
            tip.hidden = false;
        };
        const go = (el) => {
            const name = el.getAttribute('data-name');
            if (name) location.href = `/?q=${encodeURIComponent(name)}#archive`;
        };
        svg.querySelectorAll('.province').forEach((el) => {
            el.addEventListener('mouseenter', () => showTip(el));
            el.addEventListener('focus', () => showTip(el));
            el.addEventListener('blur', () => { tip.hidden = true; });
            el.addEventListener('click', () => go(el));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(el); }
            });
        });
        svg.addEventListener('mousemove', (e) => {
            const r = figure.getBoundingClientRect();
            tip.style.left = (e.clientX - r.left) + 'px';
            tip.style.top = (e.clientY - r.top) + 'px';
        });
        svg.addEventListener('mouseleave', () => { tip.hidden = true; });
    }

    async function init() {
        backBtns.forEach((btn) => btn.addEventListener('click', showHome));
        mainEl.addEventListener('click', onMainClick);
        const folio = document.querySelector('.folio');
        if (folio) folio.addEventListener('click', onFolioClick);
        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

        // The head bootstrap already applied a stored theme; the meta tags still
        // need to follow it.
        const storedTheme = document.documentElement.getAttribute('data-theme');
        if (storedTheme) syncThemeColor(storedTheme);
        syncThemeToggleState(currentTheme());
        homeView.addEventListener('input', (e) => {
            if (e.target && e.target.id === 'archive-search') { ensureSearchIndex(); applyArchiveFilter(e.target.value); }
        });
        // Start fetching the full-text index as soon as the reader means to search.
        homeView.addEventListener('focusin', (e) => {
            if (e.target && e.target.id === 'archive-search') ensureSearchIndex();
        });
        if (homeContent) homeContent.addEventListener('click', onAudienceClick);
        window.addEventListener('popstate', applyRoute);
        window.addEventListener('scroll', () => {
            updateScrollToTopVisibility();
            updateCurrentTocItem();
            updateReadingProgress();
        }, { passive: true });
        if (scrollToTopBtn) {
            scrollToTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: scrollBehavior() }));
        }
        updateScrollToTopVisibility();

        // The 404 page is served under the URL the visitor actually asked for.
        // Leave its content alone — rendering the home view over it would
        // swallow the error and rewrite the address bar. The one thing that
        // must go is initial-issue-route: the head bootstrap sets it for any
        // /issue/<year>/<num>/ path, and its CSS hides the very block the
        // not-found message lives in, which would paint a blank page.
        if (document.querySelector('.not-found-section')) {
            document.documentElement.classList.remove('initial-issue-route');
            return;
        }

        // The /deadlines page is fully pre-rendered and static. Just live-update
        // its deadline labels (and drop any that expired since the build); do
        // not fetch the catalog or render the home view over it.
        if (document.body.classList.contains('deadlines-route')) {
            refreshDeadlines(document);
            return;
        }

        // The /places index is fully static; leave its pre-rendered content be.
        if (document.body.classList.contains('places-route')) {
            return;
        }

        // The /map choropleth is pre-rendered; wire its hover/tap tooltip.
        if (document.body.classList.contains('map-route')) {
            initMap();
            return;
        }

        // The /stats dashboard is fully static (values are labelled, native
        // <title> tooltips); leave its pre-rendered content be.
        if (document.body.classList.contains('stats-route')) {
            return;
        }

        // The /glossary reference is fully static.
        if (document.body.classList.contains('glossary-route')) {
            return;
        }

        const initial = getIssueFromPath();
        const isPreRendered = !!(initial && mainContent && mainContent.children.length > 0);

        // Pages are built once and read for weeks: whatever the build wrote as
        // "до 24 юли" becomes "след 4 дни" here, and expired deadlines go away.
        refreshDeadlines(document);

        if (isPreRendered) {
            currentIssue = { year: initial.year, issueNum: initial.issueNum };
            currentTocId = null;
            highlightRelevantSections(issueView);
            updateCurrentTocItem();
            updateScrollToTopVisibility();
            updateReadingProgress();
            if (location.hash) requestAnimationFrame(() => scrollToHashTarget('auto'));
        }

        try {
            const r = await fetch(catalogUrl);
            if (!r.ok) throw new Error(r.statusText);
            catalog = await r.json();
        } catch (e) {
            if (!isPreRendered) {
                homeContent.innerHTML = '<p class="empty">Каталогът временно не е наличен. Моля, опитайте да презаредите страницата или да се върнете по-късно.</p>';
            }
            return;
        }

        renderHome();
        applyPendingArchiveQuery();

        if (isPreRendered) {
            const { prev, next } = getAdjacentIssues();
            if (prev && prev.file) fetch(prev.file.startsWith('/') ? prev.file : '/' + prev.file).catch(() => {});
            if (next && next.file) fetch(next.file.startsWith('/') ? next.file : '/' + next.file).catch(() => {});
            return;
        }

        if (initial) {
            const item = findIssueByYearAndNumber(initial.year, initial.issueNum);
            if (item) openIssue(item);
            else showHome();
        } else if (location.pathname !== '/') {
            showHome();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
