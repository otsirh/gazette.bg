(function () {
    'use strict';

    const catalogUrl = 'catalog.json';

    const homeView = document.getElementById('home-view');
    const homeContent = document.getElementById('home-content');
    const issueView = document.getElementById('issue-view');
    const backBtn = document.getElementById('back-btn');
    const mainLoading = document.getElementById('loading');
    const issueHeaderEl = document.getElementById('issue-header');
    const mainContent = document.getElementById('content');
    const readProgressBar = document.getElementById('read-progress-bar');
    const readProgressFill = document.getElementById('read-progress-fill');
    const mainEl = document.getElementById('main');
    const scrollToTopBtn = document.getElementById('scroll-to-top');

    let catalog = null;

    const PAGE_TITLE_BASE = 'Държавен вестник — AI обобщения';

    function escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
    function formatDateBulgarian(str) {
        if (!str || typeof str !== 'string') return str;
        const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г\.$/);
        if (!m) return str;
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const year = m[3];
        if (month < 1 || month > 12) return str;
        return day + ' ' + BG_MONTHS[month - 1] + ' ' + year + ' г.';
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
        if (!tocItems.length) return '';
        const firstLevel = tocItems[0].level;
        const offset = firstLevel - 1;
        const normalized = offset > 0
            ? tocItems.map((item) => ({ ...item, level: Math.max(1, item.level - offset) }))
            : tocItems;
        let html = '<nav class="issue-toc" aria-label="Съдържание на броя"><div class="issue-toc-title">Съдържание</div><ul class="issue-toc-list">';
        const stack = [1];
        let first = true;
        for (const item of normalized) {
            if (!first) html += '</li>';
            first = false;
            while (stack.length > 1 && stack[stack.length - 1] > item.level) {
                html += '</ul></li>';
                stack.pop();
            }
            while (stack.length < item.level) {
                html += '<ul class="issue-toc-sublist">';
                stack.push(stack.length + 1);
            }
            html += `<li class="issue-toc-item issue-toc-level-${item.level}"><a href="#${escapeAttr(item.id)}">${escapeHtml(item.text)}</a>`;
        }
        html += '</li>';
        while (stack.length > 1) {
            html += '</ul></li>';
            stack.pop();
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
        return `<button type="button" class="issue-card${currentClass}" data-file="${escapeAttr(item.file)}" data-issue="${item.issue}" data-date="${escapeAttr(item.date)}" data-year="${escapeAttr(item.year)}">
            <span class="num">Брой ${item.issue}</span>
            <span class="date">${escapeHtml(formatDateBulgarian(item.date))}</span>
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
            document.title = `Брой ${issueNum} · ${formattedDate} — Държавен вестник`;
            const readTimePlaceholder = '<span class="issue-read-time" id="issue-read-time"></span>';
            issueHeaderEl.innerHTML = `<div class="meta">Брой ${escapeHtml(issueNum)}${readTimePlaceholder}</div><div class="title">${escapeHtml(formattedDate)}</div>`;
        } else {
            document.title = PAGE_TITLE_BASE;
            issueHeaderEl.innerHTML = '';
        }
        const catalogItem = year && issueNum ? findIssueByYearAndNumber(year, issueNum) : null;
        const readMinutesForHeader = catalogItem?.readMinutes ?? null;
        const contentDisclaimer = '<p class="content-disclaimer">Синтезът по-долу е генериран с AI и може да съдържа грешки. За официалния текст прегледайте PDF-а по-горе.</p>';
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
        backBtn.addEventListener('click', showHome);
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
