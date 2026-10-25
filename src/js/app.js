import {
    buildTocHtml,
    CONTENT_DISCLAIMER,
    END_MARK,
    escapeHtml,
    issuesNewestFirst,
    issueTitle,
    readingMinutes,
    renderHomeContent,
    renderIssueHeader,
    renderIssueNav,
    slugify,
} from './shared.js';

const catalogUrl = '/catalog.json';

const homeView = document.getElementById('home-view');
const homeContent = document.getElementById('home-content');
const issueView = document.getElementById('issue-view');
const backBtns = document.querySelectorAll('.back-btn');
const backBtn = document.getElementById('back-btn');
const mainLoading = document.getElementById('loading');
const issueHeaderEl = document.getElementById('issue-header');
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

// Honour prefers-reduced-motion for JS-driven scrolling: an explicit
// behavior:'smooth' argument is not governed by CSS scroll-behavior, so the
// stylesheet's reduced-motion block can't neutralise it — we must here.
function prefersReducedMotion() {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        /* storage blocked — theme is per-page then */
    }
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
            while (used.has(`${id}-${n}`)) n++;
            id = `${id}-${n}`;
        }
        used.add(id);
        h.id = id;
        tocItems.push({ level: parseInt(h.tagName.slice(1), 10), text, id });
    });
    return { html: div.innerHTML, tocItems };
}

/* ─── Catalog ───────────────────────────────────── */

function findIssueByYearAndNumber(year, issueNum) {
    if (!catalog?.years?.[year]) return null;
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
    const path = `/issue/${year}/${issueNum}/`;
    if (location.pathname !== path) history.pushState(null, '', path);
}

let currentIssue = null;
let lastFocusedCard = null;
let currentTocId = null;

function renderHome() {
    if (!catalog?.years) return;
    const all = issuesNewestFirst(catalog);
    if (!all.length) {
        homeContent.innerHTML = renderHomeContent(all);
        return;
    }

    // The pre-rendered register is searchable before catalog.json lands, so
    // a query may already be in flight. Carry it over to the fresh input —
    // reading the value after the re-render would always find it empty.
    const previous = document.getElementById('archive-search');
    const pendingQuery = previous ? previous.value : '';

    homeContent.innerHTML = renderHomeContent(all);

    if (pendingQuery) {
        const searchInput = document.getElementById('archive-search');
        if (searchInput) searchInput.value = pendingQuery;
        applyArchiveFilter();
    }
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
        .catch(() => {
            /* full text just stays unavailable; metadata search still works */
        });
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
    return `${escapeHtml(pre)}<mark>${escapeHtml(mid)}</mark>${escapeHtml(post)}`;
}
function injectSnippet(row, qLower) {
    const original = searchIndex?.[`${row.dataset.year || ''}/${row.dataset.issue || ''}`];
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
// and the colophon stay put: a control that sits inside the archive is
// expected to narrow the archive, not to rearrange the page around it.
// The criterion is the text query, matched on metadata and on full text.
function applyArchiveFilter(rawQuery) {
    if (!homeContent) return;
    const input = document.getElementById('archive-search');
    const displayQ = (rawQuery != null ? rawQuery : input ? input.value : '').trim();
    const q = displayQ.toLowerCase();
    const archiveSection = homeContent.querySelector('.archive-section');
    const existingNote = homeContent.querySelector('.filter-empty');
    if (existingNote) existingNote.remove();
    for (const el of homeContent.querySelectorAll('.row-snippet')) el.remove();

    if (!q) {
        for (const el of homeContent.querySelectorAll('.filter-hidden')) el.classList.remove('filter-hidden');
        announce('');
        return;
    }

    let anyVisible = false;
    homeContent.querySelectorAll('.year-group').forEach((group) => {
        let groupVisible = false;
        group.querySelectorAll('.issue-card-row').forEach((row) => {
            // Metadata (instant) OR the full summary text (once the index has
            // loaded). A body-only match also gets a highlighted snippet.
            const metaMatch = `${row.dataset.search || ''} ${row.textContent.toLowerCase()}`.includes(q);
            let bodyMatch = false;
            if (searchIndexLower) {
                const body = searchIndexLower[`${row.dataset.year || ''}/${row.dataset.issue || ''}`];
                bodyMatch = !!body?.includes(q);
            }
            const match = metaMatch || bodyMatch;
            row.classList.toggle('filter-hidden', !match);
            if (match) {
                groupVisible = true;
                anyVisible = true;
                if (bodyMatch) injectSnippet(row, q);
            }
        });
        group.classList.toggle('filter-hidden', !groupVisible);
    });

    if (archiveSection && !anyVisible) {
        const note = document.createElement('p');
        note.className = 'empty filter-empty';
        note.textContent = `Няма намерени броеве за „${displayQ}“.`;
        archiveSection.appendChild(note);
        announce('Няма намерени броеве.');
    } else {
        announce('');
    }
}

// A shared link of the form /?q=<term>#archive. Carry the query into the
// archive search, filter, and drop the reader at the register.
function applyPendingArchiveQuery() {
    if (location.pathname !== '/') return;
    let q = '';
    try {
        q = new URLSearchParams(location.search).get('q') || '';
    } catch {
        return;
    }
    if (!q) return;
    ensureSearchIndex();
    const input = document.getElementById('archive-search');
    if (input) {
        input.value = q;
        applyArchiveFilter(q);
    }
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
    progressEl.style.width = `${(ratio * 100).toFixed(1)}%`;
}

/* ─── Issue page ────────────────────────────────── */

function getAdjacentIssues() {
    if (!currentIssue || !catalog) return { prev: null, next: null };
    const all = issuesNewestFirst(catalog);
    const idx = all.findIndex(
        (item) => String(item.year) === currentIssue.year && String(item.issue) === currentIssue.issueNum,
    );
    return {
        prev: idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null,
        next: idx > 0 ? all[idx - 1] : null,
    };
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
    try {
        id = decodeURIComponent(id);
    } catch {
        /* keep raw */
    }
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: behavior || 'auto', block: 'start' });
    return true;
}

async function openIssue(item) {
    currentIssue = { year: String(item.year), issueNum: String(item.issue) };
    setIssuePath(item.year, item.issue);
    showIssue();
    mainLoading.hidden = false;
    mainContent.innerHTML = '';
    const navEl = document.getElementById('issue-nav');
    if (navEl) navEl.innerHTML = '';

    document.title = issueTitle(item);
    issueHeaderEl.innerHTML = renderIssueHeader(item, 0);

    try {
        const fileUrl = item.file.startsWith('/') ? item.file : `/${item.file}`;
        const r = await fetch(fileUrl);
        if (!r.ok) throw new Error(r.statusText);
        const md = await r.text();
        const rawHtml = typeof marked !== 'undefined' ? marked.parse(md) : md;
        const { html: processedHtml, tocItems } = processRenderedContent(rawHtml);
        mainContent.innerHTML = CONTENT_DISCLAIMER + buildTocHtml(tocItems) + processedHtml + END_MARK;
        issueHeaderEl.innerHTML = renderIssueHeader(item, readingMinutes(md));
        announce(`Заредено: Държавен вестник, брой ${item.issue}.`);
        currentTocId = null;
        updateCurrentTocItem();
        if (location.hash) requestAnimationFrame(() => scrollToHashTarget('auto'));
        else if (backBtn) backBtn.focus();
    } catch {
        mainContent.innerHTML =
            '<p>Този брой не може да бъде зареден в момента. Моля, опитайте отново или изберете друг брой от началната страница.</p>';
        announce('Броят не можа да бъде зареден.');
    }

    const { prev, next } = getAdjacentIssues();
    if (navEl) navEl.innerHTML = renderIssueNav(prev, next);
    mainLoading.hidden = true;
    document.body.classList.add('issue-ready');
    updateReadingProgress();

    // Warm the neighbours — most readers step through issues in order.
    if (prev?.file) fetch(prev.file.startsWith('/') ? prev.file : `/${prev.file}`).catch(() => {});
    if (next?.file) fetch(next.file.startsWith('/') ? next.file : `/${next.file}`).catch(() => {});
}

function applyRoute() {
    const fromPath = getIssueFromPath();
    if (
        fromPath &&
        currentIssue &&
        currentIssue.year === fromPath.year &&
        currentIssue.issueNum === fromPath.issueNum
    ) {
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

function onMainClick(e) {
    const card = e.target.closest('a.issue-card');
    if (card) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const file = card.dataset.file;
        const issueNum = card.dataset.issue;
        const year = card.dataset.year;
        if (!file || !issueNum || !year) return;
        const item = findIssueByYearAndNumber(year, issueNum) || {
            file,
            issue: issueNum,
            year,
            date: card.dataset.date,
            topics: [],
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
    if (location.hash !== `#${id}`) history.pushState(null, '', `/#${id}`);

    const search = id === 'archive' ? document.getElementById('archive-search') : null;
    if (search && window.matchMedia('(hover: hover)').matches) {
        setTimeout(() => search.focus({ preventScroll: true }), 400);
    }
}

async function init() {
    for (const btn of backBtns) btn.addEventListener('click', showHome);
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
        if (e.target && e.target.id === 'archive-search') {
            ensureSearchIndex();
            applyArchiveFilter(e.target.value);
        }
    });
    // Start fetching the full-text index as soon as the reader means to search.
    homeView.addEventListener('focusin', (e) => {
        if (e.target && e.target.id === 'archive-search') ensureSearchIndex();
    });
    window.addEventListener('popstate', applyRoute);
    window.addEventListener(
        'scroll',
        () => {
            updateScrollToTopVisibility();
            updateCurrentTocItem();
            updateReadingProgress();
        },
        { passive: true },
    );
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

    const initial = getIssueFromPath();
    const isPreRendered = !!(initial && mainContent && mainContent.children.length > 0);

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
    } catch {
        if (!isPreRendered) {
            homeContent.innerHTML =
                '<p class="empty">Каталогът временно не е наличен. Моля, опитайте да презаредите страницата или да се върнете по-късно.</p>';
        }
        return;
    }

    renderHome();
    applyPendingArchiveQuery();

    if (isPreRendered) {
        const { prev, next } = getAdjacentIssues();
        if (prev?.file) fetch(prev.file.startsWith('/') ? prev.file : `/${prev.file}`).catch(() => {});
        if (next?.file) fetch(next.file.startsWith('/') ? next.file : `/${next.file}`).catch(() => {});
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
