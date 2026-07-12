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

    const PAGE_TITLE_BASE = 'Държавен вестник — обобщения на броеве, генерирани с AI';
    const THEME_KEY = 'gazette-theme';
    const THEME_COLORS = { light: '#fbf8f2', dark: '#100f0c' };
    const WORDS_PER_MINUTE = 180;
    const COPY_LABEL = 'Копирай връзка';

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

    function toggleTheme() {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        syncThemeColor(next);
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
        return [`Брой ${item.issue}`, formatDateLong(item.date), item.lead || '', ...topics]
            .join(' ')
            .toLowerCase();
    }

    function renderRowCard(item) {
        const topics = Array.isArray(item.topics) ? item.topics : [];
        const title = topics[0] || item.lead || `Брой ${item.issue}`;
        return `<a class="issue-card issue-card-row" ${cardAttrs(item)} data-search="${escapeHtml(searchHaystack(item))}">` +
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

    function renderDeadlineRow(d, item, withIssue = true) {
        const href = `/issue/${item.year}/${item.issue}/`;
        // Inside the issue itself, saying which issue it came from is noise.
        const who = [d.who, withIssue ? `брой ${item.issue}` : ''].filter(Boolean).join(' · ');
        return `<li class="deadline" data-expires="${escapeHtml(d.expires)}">` +
            `<span class="deadline-left">до ${escapeHtml(formatIsoBg(d.expires))}</span>` +
            `<span class="deadline-body">` +
            `<a class="deadline-what" href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${escapeHtml(String(item.issue))}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(String(item.year))}">${escapeHtml(d.what)}</a>` +
            `<span class="deadline-who">${escapeHtml(who)}</span>` +
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
        const restNote = rest > 0
            ? `<p class="deadlines-rest">и още ${rest} ${rest === 1 ? 'срок' : 'срока'} с по-далечни дати — в самите броеве.</p>`
            : '';
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
        scope.querySelectorAll('.deadline').forEach((el) => {
            const expires = el.dataset.expires;
            if (!expires || expires < today) { el.remove(); return; }
            const left = daysUntil(expires);
            const label = el.querySelector('.deadline-left');
            if (label) {
                label.textContent = left === 0 ? 'днес изтича' : left === 1 ? 'утре изтича' : `след ${left} дни`;
                label.title = 'до ' + formatIsoBg(expires);
            }
            el.classList.toggle('is-urgent', left <= 3);
        });
        scope.querySelectorAll('.deadline-list').forEach((list) => {
            const section = list.closest('.deadlines-section, .issue-deadlines');
            if (section && !list.querySelector('.deadline')) section.remove();
        });
        const count = document.getElementById('deadline-count');
        if (count) {
            const n = document.querySelectorAll('.deadlines-section .deadline').length;
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
        html += '<div class="archive-search"><input type="search" id="archive-search" class="archive-search-input" placeholder="Търсене по тема, дата или номер на брой…" aria-label="Търсене в архива" autocomplete="off" spellcheck="false" /></div>';
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

        if (pendingQuery) {
            const searchInput = document.getElementById('archive-search');
            if (searchInput) searchInput.value = pendingQuery;
            applyArchiveFilter(pendingQuery);
        }
    }

    // Live filter over the archive register — and only over it. The lead story
    // and the colophon stay put: a search box that sits inside the archive is
    // expected to narrow the archive, not to rearrange the page around it.
    function applyArchiveFilter(rawQuery) {
        if (!homeContent) return;
        const q = (rawQuery || '').trim().toLowerCase();
        const archiveSection = homeContent.querySelector('.archive-section');
        const existingNote = homeContent.querySelector('.filter-empty');
        if (existingNote) existingNote.remove();

        if (!q) {
            homeContent.querySelectorAll('.filter-hidden').forEach((el) => el.classList.remove('filter-hidden'));
            return;
        }

        let anyVisible = false;
        homeContent.querySelectorAll('.year-group').forEach((group) => {
            let groupVisible = false;
            group.querySelectorAll('.issue-card-row').forEach((row) => {
                const hay = (row.dataset.search || '') + ' ' + row.textContent.toLowerCase();
                const match = hay.includes(q);
                row.classList.toggle('filter-hidden', !match);
                if (match) { groupVisible = true; anyVisible = true; }
            });
            group.classList.toggle('filter-hidden', !groupVisible);
        });

        if (archiveSection && !anyVisible) {
            const note = document.createElement('p');
            note.className = 'empty filter-empty';
            note.textContent = 'Няма намерени броеве за „' + rawQuery.trim() + '“.';
            archiveSection.appendChild(note);
        }
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
            `<h1 class="title">${escapeHtml(formatDateLong(item.date))}</h1>` +
            `<p class="issue-meta" id="issue-meta">${metaHtml}</p>` +
            renderTags(item.audiences);
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
            mainContent.innerHTML = CONTENT_DISCLAIMER + buildTocHtml(tocItems) + processedHtml + END_MARK;
            injectSectionTags(mainContent, item.sections);
            issueHeaderEl.innerHTML = renderIssueHeader(item, readingMinutes(md));
            renderIssueDeadlines(item);
            if (issueShareEl) issueShareEl.innerHTML = renderShare(item);
            currentTocId = null;
            updateCurrentTocItem();
            if (location.hash) requestAnimationFrame(() => scrollToHashTarget('auto'));
            else if (backBtn) backBtn.focus();
        } catch (e) {
            mainContent.innerHTML = '<p>Този брой не може да бъде зареден в момента. Моля, опитайте отново или изберете друг брой от началната страница.</p>';
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
            if (!scrollToHashTarget('smooth')) window.scrollTo({ top: 0, behavior: 'smooth' });
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
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (location.hash !== href) history.pushState(null, '', href);
        }
    }

    async function init() {
        backBtns.forEach((btn) => btn.addEventListener('click', showHome));
        mainEl.addEventListener('click', onMainClick);
        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

        // The head bootstrap already applied a stored theme; the meta tags still
        // need to follow it.
        const storedTheme = document.documentElement.getAttribute('data-theme');
        if (storedTheme) syncThemeColor(storedTheme);
        homeView.addEventListener('input', (e) => {
            if (e.target && e.target.id === 'archive-search') applyArchiveFilter(e.target.value);
        });
        window.addEventListener('popstate', applyRoute);
        window.addEventListener('scroll', () => {
            updateScrollToTopVisibility();
            updateCurrentTocItem();
            updateReadingProgress();
        }, { passive: true });
        if (scrollToTopBtn) {
            scrollToTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
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

        const initial = getIssueFromPath();
        const isPreRendered = !!(initial && mainContent && mainContent.children.length > 0);

        // Pages are built once and read for weeks: whatever the build wrote as
        // "до 24 юли" becomes "след 4 дни" here, and expired deadlines go away.
        refreshDeadlines(document);

        if (isPreRendered) {
            currentIssue = { year: initial.year, issueNum: initial.issueNum };
            currentTocId = null;
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
