(function () {
    'use strict';

    const catalogUrl = 'catalog.json';

    const homeView = document.getElementById('home-view');
    const homeContent = document.getElementById('home-content');
    const issueView = document.getElementById('issue-view');
    const backBtns = document.querySelectorAll('.back-btn');
    const backBtn = document.getElementById('back-btn');
    const mainLoading = document.getElementById('loading');
    const issueHeaderEl = document.getElementById('issue-header');
    const mainContent = document.getElementById('content');
    const readProgressBar = document.getElementById('read-progress-bar');
    const readProgressFill = document.getElementById('read-progress-fill');
    const mainEl = document.getElementById('main');
    const scrollToTopBtn = document.getElementById('scroll-to-top');

    let catalog = null;

    const PAGE_TITLE_BASE = 'Държавен вестник — AI анализ';

    function escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
    const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

    /** Remove trailing " г." from date string. */
    function stripDateSuffix(str) {
        if (!str || typeof str !== 'string') return str;
        return str.replace(/\s*г\.\s*$/, '').trim();
    }

    /** Capitalize month name in a Bulgarian date string (e.g. "6 януари 2026" → "6 Януари 2026"). */
    function capitalizeMonthInDate(str) {
        if (!str || typeof str !== 'string') return str;
        let s = str;
        for (let i = 0; i < BG_MONTHS.length; i++) {
            s = s.replace(BG_MONTHS[i], BG_MONTHS_CAP[i]);
        }
        return s;
    }

    /** Lowercase month name in a Bulgarian date string (e.g. "6 Януари 2026" → "6 януари 2026"). */
    function lowercaseMonthInDate(str) {
        if (!str || typeof str !== 'string') return str;
        let s = str;
        for (let i = 0; i < BG_MONTHS_CAP.length; i++) {
            s = s.replace(BG_MONTHS_CAP[i], BG_MONTHS[i]);
        }
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

    /** Date for homepage cards: day + month only (no year), lowercase month. */
    function formatDateForHomepage(str) {
        if (!str || typeof str !== 'string') return str;
        const s = stripDateSuffix(str);
        return lowercaseMonthInDate(s.replace(/\s+\d{4}\s*$/, '').trim());
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

    function extractHeadings(md) {
        const headings = [];
        const lines = md.split('\n');
        for (const line of lines) {
            const m = /^(#{1,6})\s+(.+)$/.exec(line);
            if (m) headings.push({ level: m[1].length, text: m[2].trim() });
        }
        return headings;
    }

    function tocItemsWithIds(headings) {
        const used = new Set();
        return headings.map((h) => {
            let id = slugify(h.text);
            if (used.has(id)) {
                let n = 2;
                while (used.has(id + '-' + n)) n++;
                id = id + '-' + n;
            }
            used.add(id);
            return { level: h.level, text: stripMarkdownInline(h.text), id };
        });
    }

    function buildTocHtml(tocItems) {
        const mainItems = tocItems.filter((item) => item.level <= 2);
        if (!mainItems.length) return '';
        let html = '<nav class="issue-toc" aria-label="Съдържание на броя"><div class="issue-toc-title">Съдържание</div><ul class="issue-toc-list">';
        for (const item of mainItems) {
            html += `<li class="issue-toc-item"><a href="#${escapeAttr(item.id)}">${escapeHtml(item.text)}</a></li>`;
        }
        html += '</ul></nav>';
        return html;
    }

    function addHeadingIds(html, tocItems) {
        const div = document.createElement('div');
        div.innerHTML = html;
        const headings = div.querySelectorAll('h1, h2, h3, h4, h5, h6');
        tocItems.forEach((item, i) => {
            if (headings[i]) headings[i].id = item.id;
        });
        return div.innerHTML;
    }

    function getAllIssuesNewestFirst() {
        if (!catalog || !catalog.years) return [];
        const years = Object.keys(catalog.years).sort((a, b) => Number(b) - Number(a));
        const list = [];
        years.forEach((year) => {
            const issues = catalog.years[year]
                .slice()
                .sort((a, b) => Number(b.issue) - Number(a.issue));
            issues.forEach((item) => list.push({ ...item, year }));
        });
        return list;
    }

    function findIssueByYearAndNumber(year, issueNum) {
        if (!catalog || !catalog.years || !catalog.years[year]) return null;
        const issue = catalog.years[year].find((item) => String(item.issue) === String(issueNum));
        return issue ? { ...issue, year } : null;
    }

    function getIssueFromHash() {
        const m = /^#?issue\/(\d+)\/(\d+)$/i.exec(location.hash || '');
        return m ? { year: m[1], issueNum: m[2] } : null;
    }

    function setIssueHash(year, issueNum) {
        const hash = 'issue/' + year + '/' + issueNum;
        if (location.hash !== '#' + hash) location.hash = hash;
    }

    let currentIssue = null; // { year, issueNum } when viewing an issue
    let lastFocusedCard = null; // element to focus when going back from issue
    let tocObserver = null; // IntersectionObserver for TOC current section

    function formatReadTime(minutes) {
        if (minutes < 1) return 'по-малко от 1 мин';
        if (minutes === 1) return '1 мин четене';
        if (minutes < 60) return minutes + ' мин четене';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (m === 0) return h + ' ч четене';
        return h + ' ч ' + m + ' мин четене';
    }

    function renderIssueCard(item, isCurrent) {
        const readTime = item.readMinutes != null ? `<span class="read-time">${formatReadTime(item.readMinutes)}</span>` : '';
        const currentClass = isCurrent ? ' issue-card-current' : '';
        const displayDate = formatDateForHomepage(formatDateBulgarian(item.date));
        return `<button type="button" class="issue-card${currentClass}" data-file="${escapeAttr(item.file)}" data-issue="${item.issue}" data-date="${escapeAttr(item.date)}" data-year="${escapeAttr(item.year)}">
            <span class="num">Брой ${item.issue}</span>
            <span class="date">${escapeHtml(displayDate)}</span>
            ${readTime}
        </button>`;
    }

    function renderHome() {
        if (!catalog || !catalog.years) return;
        const all = getAllIssuesNewestFirst();
        if (all.length === 0) {
            homeContent.innerHTML = '<p class="empty">Няма намерени броеве.</p>';
            return;
        }
        const latest = all[0];
        const older = all.slice(1);
        const byYear = {};
        older.forEach((item) => {
            if (!byYear[item.year]) byYear[item.year] = [];
            byYear[item.year].push(item);
        });
        const yearKeys = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));

        let html = '<div class="year-group"><div class="year-title">Последен брой</div><div class="issue-cards">';
        html += renderIssueCard(latest, true);
        html += '</div></div>';

        yearKeys.forEach((year) => {
            html += `<div class="year-group"><div class="year-title">${year}</div><div class="issue-cards">`;
            byYear[year].forEach((item) => { html += renderIssueCard(item); });
            html += '</div></div>';
        });

        homeContent.innerHTML = html;
        homeContent.querySelectorAll('.issue-card').forEach((btn) => {
            btn.addEventListener('click', () => {
                lastFocusedCard = btn;
                openIssue(btn.dataset.file, btn.dataset.issue, btn.dataset.date, btn.dataset.year);
            });
        });
    }

    function showHome() {
        currentIssue = null;
        document.title = PAGE_TITLE_BASE;
        document.body.classList.remove('issue-open');
        homeView.style.display = 'block';
        issueView.style.display = 'none';
        if (readProgressBar) readProgressBar.style.display = 'none';
        if (scrollToTopBtn) scrollToTopBtn.classList.remove('is-visible');
        if (tocObserver) {
            tocObserver.disconnect();
            tocObserver = null;
        }
        if (location.hash) {
            history.replaceState(null, '', location.pathname + location.search);
        }
        if (lastFocusedCard && typeof lastFocusedCard.focus === 'function') {
            lastFocusedCard.focus();
            lastFocusedCard = null;
        }
    }

    function showIssue() {
        document.body.classList.add('issue-open');
        homeView.style.display = 'none';
        issueView.style.display = 'block';
        if (readProgressBar) {
            readProgressBar.style.display = 'block';
            updateReadProgress();
        }
    }

    function getScrollContainer() {
        if (issueView.style.display !== 'block' || !mainEl) return null;
        return mainEl.scrollHeight > mainEl.clientHeight ? mainEl : null;
    }

    function updateReadProgress() {
        if (!readProgressFill || !readProgressBar || issueView.style.display !== 'block') return;
        const el = getScrollContainer();
        const scrollTop = el ? el.scrollTop : (window.scrollY ?? document.documentElement.scrollTop);
        const scrollHeight = el ? el.scrollHeight : document.documentElement.scrollHeight;
        const clientHeight = el ? el.clientHeight : window.innerHeight;
        const maxScroll = scrollHeight - clientHeight;
        const pct = maxScroll <= 0 ? 100 : Math.min(100, (scrollTop / maxScroll) * 100);
        readProgressFill.style.width = pct + '%';
        readProgressBar.setAttribute('aria-valuenow', Math.round(pct));
    }

    const SCROLL_TO_TOP_THRESHOLD = 300;

    function updateScrollToTopVisibility() {
        if (!scrollToTopBtn) return;
        if (issueView.style.display !== 'block') {
            scrollToTopBtn.classList.remove('is-visible');
            return;
        }
        const el = getScrollContainer();
        const scrollTop = el ? el.scrollTop : (window.scrollY ?? document.documentElement.scrollTop ?? 0);
        if (scrollTop > SCROLL_TO_TOP_THRESHOLD) {
            scrollToTopBtn.classList.add('is-visible');
        } else {
            scrollToTopBtn.classList.remove('is-visible');
        }
    }

    function scrollToTop() {
        const el = getScrollContainer();
        if (el) {
            el.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function getAdjacentIssues() {
        if (!currentIssue || !catalog) return { prev: null, next: null };
        const all = getAllIssuesNewestFirst();
        const idx = all.findIndex((item) => String(item.year) === currentIssue.year && String(item.issue) === currentIssue.issueNum);
        return {
            prev: idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null,
            next: idx > 0 ? all[idx - 1] : null
        };
    }

    function renderIssueNav() {
        const navEl = document.getElementById('issue-nav');
        if (!navEl || !catalog) return;
        const all = getAllIssuesNewestFirst();
        if (!currentIssue) {
            navEl.innerHTML = '';
            navEl.style.display = 'none';
            return;
        }
        const idx = all.findIndex((item) => String(item.year) === currentIssue.year && String(item.issue) === currentIssue.issueNum);
        const prevOne = idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null;
        const nextOne = idx > 0 ? all[idx - 1] : null;
        if (!prevOne && !nextOne) {
            navEl.innerHTML = '';
            navEl.style.display = 'none';
            return;
        }
        navEl.style.display = '';
        let html = '';
        if (prevOne) {
            html += '<div class="issue-nav-group"><div class="issue-nav-title">← Предишен брой</div><div class="issue-cards">';
            html += renderIssueCard(prevOne);
            html += '</div></div>';
        }
        if (nextOne) {
            html += '<div class="issue-nav-group"><div class="issue-nav-title">Следващ брой →</div><div class="issue-cards">';
            html += renderIssueCard(nextOne);
            html += '</div></div>';
        }
        navEl.innerHTML = html;
        navEl.querySelectorAll('.issue-card').forEach((btn) => {
            btn.addEventListener('click', () => {
                lastFocusedCard = null;
                openIssue(btn.dataset.file, btn.dataset.issue, btn.dataset.date, btn.dataset.year);
            });
        });
    }

    function setupTocCurrentSection() {
        if (tocObserver) {
            tocObserver.disconnect();
            tocObserver = null;
        }
        const scrollRoot = getScrollContainer();
        if (!scrollRoot || !mainContent) return;
        const headings = mainContent.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
        if (!headings.length) return;
        let currentId = null;
        function setCurrent(id) {
            if (id === currentId) return;
            currentId = id;
            mainContent.querySelectorAll('.issue-toc a[href^="#"]').forEach((a) => {
                const href = a.getAttribute('href');
                const targetId = href ? href.slice(1) : '';
                a.classList.toggle('is-current', targetId === id);
            });
        }
        tocObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const id = entry.target.id;
                    if (id) setCurrent(id);
                });
            },
            { root: scrollRoot, rootMargin: '-20% 0px -70% 0px', threshold: 0 }
        );
        headings.forEach((h) => tocObserver.observe(h));
        const first = headings[0];
        if (first && first.id) setCurrent(first.id);
    }

    async function openIssue(file, issueNum, date, year) {
        if (year && issueNum) {
            currentIssue = { year: String(year), issueNum: String(issueNum) };
            setIssueHash(year, issueNum);
        } else {
            currentIssue = null;
        }
        showIssue();
        mainLoading.style.display = 'block';
        mainContent.innerHTML = '';
        const issueNavEl = document.getElementById('issue-nav');
        if (issueNavEl) {
            issueNavEl.innerHTML = '';
            issueNavEl.style.display = 'none';
        }
        if (issueNum && date) {
            const formattedDate = formatDateBulgarian(date);
            const titleDate = stripDateSuffix(formattedDate);
            document.title = `Брой ${issueNum} · ${titleDate} — AI анализ на Български Държавен вестник`;
            const readTimePlaceholder = '<span class="issue-read-time" id="issue-read-time"></span>';
            issueHeaderEl.innerHTML = `<div class="meta">Брой ${escapeHtml(issueNum)}${readTimePlaceholder}</div><div class="title">${escapeHtml(stripDateSuffix(formattedDate))}</div>`;
        } else {
            document.title = PAGE_TITLE_BASE;
            issueHeaderEl.innerHTML = '';
        }
        const catalogItem = year && issueNum ? findIssueByYearAndNumber(year, issueNum) : null;
        const readMinutesForHeader = catalogItem?.readMinutes ?? null;
        const contentDisclaimer = '<p class="content-disclaimer"><strong>Важно:</strong> Целият текст по-долу е генериран с изкуствен интелект (AI) и не е официален — може да съдържа грешки или неточности. Ако не сте сигурни в нещо, винаги преглеждайте официалния брой на Държавен вестник на <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';
        try {
            const r = await fetch(file);
            if (!r.ok) throw new Error(r.statusText);
            const md = await r.text();
            const readMinutes = readMinutesForHeader != null ? readMinutesForHeader : Math.max(1, Math.round((md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*_`~]/g, '').split(/\s+/).filter(Boolean).length) / 200));
            const issueReadTimeEl = document.getElementById('issue-read-time');
            if (issueReadTimeEl) issueReadTimeEl.textContent = ' · ' + formatReadTime(readMinutes);
            const headings = extractHeadings(md);
            const tocItems = tocItemsWithIds(headings);
            const rawHtml = typeof marked !== 'undefined' ? marked.parse(md) : md;
            const htmlWithIds = addHeadingIds(rawHtml, tocItems);
            const tocHtml = buildTocHtml(tocItems);
            mainContent.innerHTML = contentDisclaimer + tocHtml + htmlWithIds;
            setupTocCurrentSection();
            updateReadProgress();
            if (backBtn) backBtn.focus();
        } catch (e) {
            mainContent.innerHTML = `<p>Неуспешно зареждане на броя: ${escapeHtml(e.message)}.</p><p>Стартирайте от локален сървър (напр. <code>npm run gazette</code>), за да се заредят файловете.</p>`;
        }
        renderIssueNav();
        mainLoading.style.display = 'none';
        const { prev, next } = getAdjacentIssues();
        if (prev && prev.file) fetch(prev.file).catch(() => {});
        if (next && next.file) fetch(next.file).catch(() => {});
    }

    function applyRoute() {
        const fromHash = getIssueFromHash();
        if (fromHash && currentIssue && currentIssue.year === fromHash.year && currentIssue.issueNum === fromHash.issueNum) return;
        if (fromHash) {
            const item = findIssueByYearAndNumber(fromHash.year, fromHash.issueNum);
            if (item) openIssue(item.file, item.issue, item.date, item.year);
            else showHome();
        } else {
            showHome();
        }
    }

    function onMainClick(e) {
        const link = e.target.closest('.issue-toc a[href^="#"]');
        if (!link) return;
        const id = link.getAttribute('href').slice(1);
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
            e.preventDefault();
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    async function init() {
        backBtns.forEach(function (btn) { btn.addEventListener('click', showHome); });
        mainEl.addEventListener('click', onMainClick);
        window.addEventListener('hashchange', applyRoute);
        function onScroll() {
            updateReadProgress();
            updateScrollToTopVisibility();
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        mainEl.addEventListener('scroll', onScroll, { passive: true });
        if (scrollToTopBtn) scrollToTopBtn.addEventListener('click', scrollToTop);
        updateScrollToTopVisibility();
        try {
            const r = await fetch(catalogUrl);
            if (!r.ok) throw new Error(r.statusText);
            catalog = await r.json();
        } catch (e) {
            homeContent.innerHTML = `<p class="empty">Каталогът не може да се зареди. Стартирайте <code>node build-gazette-catalog.js</code> и обслужвайте тази папка.</p>`;
            return;
        }
        renderHome();
        const initial = getIssueFromHash();
        if (initial) {
            const item = findIssueByYearAndNumber(initial.year, initial.issueNum);
            if (item) openIssue(item.file, item.issue, item.date, item.year);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
