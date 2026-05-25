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
    const mainContent = document.getElementById('content');
    const readProgressBar = document.getElementById('read-progress-bar');
    const readProgressFill = document.getElementById('read-progress-fill');
    const mainEl = document.getElementById('main');
    const scrollToTopBtn = document.getElementById('scroll-to-top');

    let catalog = null;

    const PAGE_TITLE_BASE = 'Обобщения на Държавен вестник';

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
        for (let i = 0; i < BG_MONTHS.length; i++) {
            s = s.replace(BG_MONTHS[i], BG_MONTHS_CAP[i]);
        }
        return s;
    }

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
        let html = '<nav class="issue-toc" aria-label="Съдържание на броя"><div class="issue-toc-title">Съдържание</div><ul class="issue-toc-list">';
        for (const item of mainItems) {
            html += `<li class="issue-toc-item"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
        }
        html += '</ul></nav>';
        return html;
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

    function getIssueFromPath() {
        const m = /\/issue\/(\d+)\/(\d+)\/?$/i.exec(location.pathname);
        return m ? { year: m[1], issueNum: m[2] } : null;
    }

    function setIssuePath(year, issueNum) {
        const path = '/issue/' + year + '/' + issueNum;
        if (location.pathname !== path) history.pushState(null, '', path);
    }

    let currentIssue = null;
    let lastFocusedCard = null;
    let currentTocId = null;

    function formatReadTime(minutes) {
        if (minutes < 1) return 'по-малко от 1 мин';
        if (minutes === 1) return '1 мин четене';
        if (minutes < 60) return minutes + ' мин четене';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (m === 0) return h + ' ч четене';
        return h + ' ч ' + m + ' мин четене';
    }

    const SHARE_ICONS = {
        fb: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.3-1.5 1.6-1.5h1.7V3.6c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1V9.9H7.7V13h2.7v8h3.1z"/></svg>',
        li: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 2h-17C2.7 2 2 2.7 2 3.5v17c0 .8.7 1.5 1.5 1.5h17c.8 0 1.5-.7 1.5-1.5v-17c0-.8-.7-1.5-1.5-1.5zM8 19H5V9h3v10zM6.5 7.7C5.5 7.7 4.7 7 4.7 6S5.5 4.3 6.5 4.3 8.3 5 8.3 6s-.8 1.7-1.8 1.7zM19 19h-3v-5c0-1.2-.4-2-1.5-2-.8 0-1.3.6-1.5 1.1-.1.2-.1.5-.1.7V19h-3V9h3v1.3c.4-.6 1.1-1.5 2.7-1.5 2 0 3.4 1.3 3.4 4V19z"/></svg>',
        x: '<svg class="share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
    };

    function renderShareLinks(url, title) {
        const u = encodeURIComponent(url);
        const t = encodeURIComponent(title);
        return `<span class="issue-share-label">Споделете:</span>`
            + `<a class="share-link share-fb" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener" aria-label="Споделяне във Facebook" title="Споделяне във Facebook">${SHARE_ICONS.fb}</a>`
            + `<a class="share-link share-li" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener" aria-label="Споделяне в LinkedIn" title="Споделяне в LinkedIn">${SHARE_ICONS.li}</a>`
            + `<a class="share-link share-x" href="https://twitter.com/intent/tweet?url=${u}&text=${t}" target="_blank" rel="noopener" aria-label="Споделяне в X" title="Споделяне в X">${SHARE_ICONS.x}</a>`;
    }

    function updateShareLinks(year, issueNum, dateStr) {
        const el = document.getElementById('issue-share');
        if (!el) return;
        if (!year || !issueNum) { el.innerHTML = ''; return; }
        const url = `${location.origin}/issue/${encodeURIComponent(year)}/${encodeURIComponent(issueNum)}`;
        const titleDate = stripDateSuffix(formatDateBulgarian(dateStr || ''));
        const title = `Държавен вестник, брой ${issueNum}${titleDate ? ' · ' + titleDate : ''} — обобщение`;
        el.setAttribute('aria-label', 'Споделяне');
        el.innerHTML = renderShareLinks(url, title);
    }

    function renderIssueCard(item, variant) {
        const readTime = item.readMinutes != null ? `<span class="read-time">${formatReadTime(item.readMinutes)}</span>` : '';
        const variantClass = variant ? ' issue-card-' + variant : '';
        const displayDate = formatDateForHomepage(formatDateBulgarian(item.date));
        const href = `/issue/${encodeURIComponent(item.year)}/${encodeURIComponent(item.issue)}`;
        return `<a class="issue-card${variantClass}" href="${escapeHtml(href)}" data-file="${escapeHtml(item.file)}" data-issue="${item.issue}" data-date="${escapeHtml(item.date)}" data-year="${escapeHtml(item.year)}">
            <span class="num">Брой ${item.issue}</span>
            <span class="date">${escapeHtml(displayDate)}</span>
            ${readTime}
        </a>`;
    }

    function renderHome() {
        if (!catalog || !catalog.years) return;
        const all = getAllIssuesNewestFirst();
        if (all.length === 0) {
            homeContent.innerHTML = '<p class="empty">В момента няма налични броеве. Опитайте отново по-късно.</p>';
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

        let html = '<section class="hero-section">';
        html += '<div class="section-eyebrow">Последен брой</div>';
        html += renderIssueCard(latest, 'hero');
        html += '</section>';

        if (yearKeys.length) {
            html += '<section class="archive-section">';
            html += '<h2 class="section-title">Архив</h2>';
            yearKeys.forEach((year) => {
                html += `<div class="year-group"><h3 class="year-title">${year}</h3><div class="issue-list">`;
                byYear[year].forEach((item) => { html += renderIssueCard(item, 'row'); });
                html += '</div></div>';
            });
            html += '</section>';
        }

        homeContent.innerHTML = html;
    }

    function showHome() {
        currentIssue = null;
        document.title = PAGE_TITLE_BASE;
        document.documentElement.classList.remove('initial-issue-route');
        document.body.classList.remove('issue-open');
        document.body.classList.remove('issue-ready');
        homeView.style.display = 'block';
        issueView.style.display = 'none';
        window.scrollTo(0, 0);
        if (readProgressBar) readProgressBar.style.display = 'none';
        if (scrollToTopBtn) scrollToTopBtn.classList.remove('is-visible');
        currentTocId = null;
        if (location.pathname !== '/') {
            history.pushState(null, '', '/');
        }
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
        if (readProgressBar) {
            readProgressBar.style.display = 'block';
            updateReadProgress();
        }
    }

    function getWindowScrollTop() {
        return window.scrollY ?? document.documentElement.scrollTop ?? 0;
    }

    function updateReadProgress() {
        if (!readProgressFill || !readProgressBar || issueView.style.display !== 'block') return;
        const scrollTop = getWindowScrollTop();
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
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
        scrollToTopBtn.classList.toggle('is-visible', getWindowScrollTop() > SCROLL_TO_TOP_THRESHOLD);
    }

    function scrollToTop() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
    }

    const TOC_ACTIVE_OFFSET = 120;

    function updateCurrentTocItem() {
        if (issueView.style.display !== 'block' || !mainContent) return;
        const headings = mainContent.querySelectorAll('h1[id], h2[id]');
        if (!headings.length) return;
        let activeId = null;
        for (const h of headings) {
            if (h.getBoundingClientRect().top <= TOC_ACTIVE_OFFSET) {
                activeId = h.id;
            } else {
                break;
            }
        }
        if (activeId === currentTocId) return;
        currentTocId = activeId;
        mainContent.querySelectorAll('.issue-toc a[href^="#"]').forEach((a) => {
            const href = a.getAttribute('href');
            const targetId = href ? href.slice(1) : '';
            a.classList.toggle('is-current', activeId !== null && targetId === activeId);
        });
    }

    async function openIssue(file, issueNum, date, year) {
        if (year && issueNum) {
            currentIssue = { year: String(year), issueNum: String(issueNum) };
            setIssuePath(year, issueNum);
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
        const catalogItem = year && issueNum ? findIssueByYearAndNumber(year, issueNum) : null;
        if (issueNum && date) {
            const formattedDate = formatDateBulgarian(date);
            const titleDate = stripDateSuffix(formattedDate);
            document.title = `Брой ${issueNum} · ${titleDate} — Обобщения на Държавен вестник`;
            const readTimePlaceholder = '<span class="issue-read-time" id="issue-read-time"></span>';
            issueHeaderEl.innerHTML = `<div class="meta">Брой ${escapeHtml(issueNum)}${readTimePlaceholder}</div><div class="title">${escapeHtml(stripDateSuffix(formattedDate))}</div>`;
            updateShareLinks(year, issueNum, date);
        } else {
            document.title = PAGE_TITLE_BASE;
            issueHeaderEl.innerHTML = '';
            updateShareLinks(null, null, null);
        }
        const readMinutesForHeader = catalogItem?.readMinutes ?? null;
        const contentDisclaimer = '<p class="content-disclaimer">Текстът по-долу е неофициално обобщение, генерирано с AI, и може да съдържа грешки. За официален текст и правни цели използвайте <a href="https://dv.parliament.bg" target="_blank" rel="noopener">dv.parliament.bg</a>.</p>';
        try {
            const fileUrl = file.startsWith('/') ? file : '/' + file;
            const r = await fetch(fileUrl);
            if (!r.ok) throw new Error(r.statusText);
            const md = await r.text();
            const readMinutes = readMinutesForHeader != null ? readMinutesForHeader : Math.max(1, Math.round((md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*_`~]/g, '').split(/\s+/).filter(Boolean).length) / 200));
            const issueReadTimeEl = document.getElementById('issue-read-time');
            if (issueReadTimeEl) issueReadTimeEl.textContent = ' · ' + formatReadTime(readMinutes);
            const rawHtml = typeof marked !== 'undefined' ? marked.parse(md) : md;
            const { html: processedHtml, tocItems } = processRenderedContent(rawHtml);
            const tocHtml = buildTocHtml(tocItems);
            mainContent.innerHTML = contentDisclaimer + tocHtml + processedHtml;
            currentTocId = null;
            updateCurrentTocItem();
            updateReadProgress();
            if (backBtn) backBtn.focus();
        } catch (e) {
            mainContent.innerHTML = '<p>Този брой не може да бъде зареден в момента. Моля, опитайте отново или изберете друг брой от началната страница.</p><p><a href="/" class="back-btn">← Обратно към началната страница</a></p>';
        }
        renderIssueNav();
        mainLoading.style.display = 'none';
        document.body.classList.add('issue-ready');
        const { prev, next } = getAdjacentIssues();
        if (prev && prev.file) fetch(prev.file.startsWith('/') ? prev.file : '/' + prev.file).catch(() => {});
        if (next && next.file) fetch(next.file.startsWith('/') ? next.file : '/' + next.file).catch(() => {});
    }

    function applyRoute() {
        const fromPath = getIssueFromPath();
        if (fromPath && currentIssue && currentIssue.year === fromPath.year && currentIssue.issueNum === fromPath.issueNum) return;
        if (fromPath) {
            const item = findIssueByYearAndNumber(fromPath.year, fromPath.issueNum);
            if (item) openIssue(item.file, item.issue, item.date, item.year);
            else showHome();
        } else {
            showHome();
        }
    }

    function onMainClick(e) {
        const homeLink = e.target.closest('a[href="/"]');
        if (homeLink) {
            e.preventDefault();
            showHome();
            return;
        }
        const card = e.target.closest('a.issue-card');
        if (card) {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            const file = card.dataset.file;
            const issueNum = card.dataset.issue;
            const date = card.dataset.date;
            const year = card.dataset.year;
            if (!file || !issueNum) return;
            e.preventDefault();
            lastFocusedCard = card;
            openIssue(file, issueNum, date, year);
            return;
        }
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
        window.addEventListener('popstate', applyRoute);
        function onScroll() {
            updateReadProgress();
            updateScrollToTopVisibility();
            updateCurrentTocItem();
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        if (scrollToTopBtn) scrollToTopBtn.addEventListener('click', scrollToTop);
        updateScrollToTopVisibility();

        const initial = getIssueFromPath();
        const isPreRendered = !!(initial && mainContent && mainContent.children.length > 0);

        if (isPreRendered) {
            currentIssue = { year: initial.year, issueNum: initial.issueNum };
            if (readProgressBar) readProgressBar.style.display = 'block';
            currentTocId = null;
            updateCurrentTocItem();
            updateReadProgress();
            updateScrollToTopVisibility();
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
            if (item) {
                openIssue(item.file, item.issue, item.date, item.year);
            } else {
                showHome();
            }
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
