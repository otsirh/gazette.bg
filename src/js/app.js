import {
    escapeHtml,
    formatDateLong,
    issuesNewestFirst,
    issueTitle,
    processRenderedContent,
    readingMinutes,
    renderHomeContent,
    renderIssueArticleHtml,
    renderIssueHeader,
    renderIssueNav,
    searchTermVariants,
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
const folioContextBtn = document.getElementById('folio-context');

let catalog = null;
let catalogPromise = null;
let markedPromise = null;
const markdownCache = new Map();

function ensureCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (!catalogPromise) {
        catalogPromise = fetch(catalogUrl)
            .then((r) => {
                if (!r.ok) throw new Error(r.statusText);
                return r.json();
            })
            .then((data) => {
                catalog = data;
                return data;
            })
            .catch(() => {
                catalogPromise = null;
                return null;
            });
    }
    return catalogPromise;
}

function ensureMarked() {
    if (!markedPromise) {
        markedPromise = import('./marked.js').catch((err) => {
            markedPromise = null;
            throw err;
        });
    }
    return markedPromise;
}

function fetchMarkdown(file) {
    const fileUrl = file.startsWith('/') ? file : `/${file}`;
    let pending = markdownCache.get(fileUrl);
    if (!pending) {
        pending = fetch(fileUrl)
            .then((r) => {
                if (!r.ok) throw new Error(r.statusText);
                return r.text();
            })
            .catch((err) => {
                markdownCache.delete(fileUrl);
                throw err;
            });
        markdownCache.set(fileUrl, pending);
    }
    return pending;
}

function warmIssue(file) {
    if (!file) return;
    fetchMarkdown(file).catch(() => {});
    ensureMarked().catch(() => {});
    ensureCatalog();
}

// Must match the server-rendered home <title> in index.html, so returning
// to the home view via the SPA doesn't rewrite it to a different string.
const PAGE_TITLE_BASE = 'Държавен вестник — кратки обобщения на всеки брой с AI';
const THEME_KEY = 'gazette-theme';
const THEME_COLORS = { light: '#fbf8f2', dark: '#100f0c' };
const DESKTOP_TOC_MQ = window.matchMedia?.('(min-width: 1000px)');

function prefersReducedMotion() {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function scrollBehavior() {
    return prefersReducedMotion() ? 'auto' : 'smooth';
}

function withViewTransition(mutate) {
    if (!document.startViewTransition || prefersReducedMotion()) {
        mutate();
        return Promise.resolve();
    }
    try {
        const vt = document.startViewTransition(() => mutate());
        return vt.updateCallbackDone.catch(() => {});
    } catch {
        mutate();
        return Promise.resolve();
    }
}

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
    withViewTransition(() => {
        document.documentElement.setAttribute('data-theme', next);
        syncThemeColor(next);
        syncThemeToggleState(next);
    });
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        /* storage blocked — theme is per-page then */
    }
}

/* ─── Catalog & Routing ─────────────────────────── */

function syncCanonicalUrl(path) {
    const url = `https://gazette.bg${path}`;
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', url);
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', url);
}

function findIssueByYearAndNumber(year, issueNum) {
    if (!catalog?.years?.[year]) return null;
    const issue = catalog.years[year].find((item) => String(item.issue) === String(issueNum));
    return issue ? { ...issue, year } : null;
}

function getIssueFromPath() {
    const m = /\/issue\/(\d+)\/(\d+)\/?$/i.exec(location.pathname);
    return m ? { year: m[1], issueNum: m[2] } : null;
}

function setIssuePath(year, issueNum, hash = '') {
    const path = `/issue/${year}/${issueNum}/`;
    const full = `${path}${hash}`;
    if (`${location.pathname}${location.hash}` !== full) history.pushState(null, '', full);
    syncCanonicalUrl(path);
}

let currentIssue = null;
let lastFocusedCard = null;
let currentTocId = null;

// The front page is built ahead of time with this week's stories. Where it is
// not on the page (an issue opened first), going home loads it.
function renderHome() {
    if (!homeContent?.children.length) {
        location.assign('/');
        return;
    }
    if (!catalog?.years) return;
    const all = issuesNewestFirst(catalog);
    if (!all.length) {
        homeContent.innerHTML = renderHomeContent(all);
        return;
    }

    const previous = document.getElementById('archive-search');
    const pendingQuery = previous ? previous.value : '';

    homeContent.innerHTML = renderHomeContent(all);

    if (pendingQuery) {
        const searchInput = document.getElementById('archive-search');
        if (searchInput) searchInput.value = pendingQuery;
        applyArchiveFilter();
    }
}

/* ─── Full-Text Morphological Search ────────────── */

let searchIndex = null;
let searchIndexLower = null;
let searchIndexLoading = false;
let searchUrlTimer = null;

function ensureSearchIndex() {
    if (searchIndex || searchIndexLoading) return;
    searchIndexLoading = true;
    fetch('/search-index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((idx) => {
            searchIndexLoading = false;
            if (!idx) return;
            searchIndex = idx;
            searchIndexLower = {};
            for (const k in idx) searchIndexLower[k] = String(idx[k]).toLowerCase();
            applyArchiveFilter();
        })
        .catch(() => {
            searchIndexLoading = false;
        });
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseQueryGroups(rawQuery) {
    return String(rawQuery || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => searchTermVariants(word))
        .filter((g) => g.length > 0);
}

function matchesAllGroups(haystackLower, groups) {
    if (!haystackLower) return false;
    for (const variants of groups) {
        let hit = false;
        for (const v of variants) {
            if (haystackLower.includes(v)) {
                hit = true;
                break;
            }
        }
        if (!hit) return false;
    }
    return true;
}

// A ~150-char window snapped to word boundaries around the first match, with
// whole inflected words wrapped in <mark>.
function buildSnippet(original, groups) {
    if (!original || !groups.length) return '';
    const text = original.replace(/\t/g, ' — ');
    const lower = text.toLowerCase();
    const allVariants = [...new Set(groups.flat())].sort((a, b) => b.length - a.length);
    if (!allVariants.length) return '';

    let firstIdx = -1;
    let firstLen = 0;
    for (const v of allVariants) {
        const idx = lower.indexOf(v);
        if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) {
            firstIdx = idx;
            firstLen = v.length;
        }
    }
    if (firstIdx < 0) return '';

    let start = Math.max(0, firstIdx - 48);
    if (start > 0) {
        const ws = text.indexOf(' ', start);
        if (ws >= 0 && ws < firstIdx) start = ws + 1;
    }
    let end = Math.min(text.length, firstIdx + firstLen + 102);
    if (end < text.length) {
        const ws = text.lastIndexOf(' ', end);
        if (ws > firstIdx + firstLen) end = ws;
    }

    const slice = text.slice(start, end).trim();
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';

    const pattern = new RegExp(`([\\p{L}\\p{N}]*(?:${allVariants.map(escapeRegExp).join('|')})[\\p{L}\\p{N}]*)`, 'giu');
    const parts = slice.split(pattern);
    const highlighted = parts
        .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
        .join('');
    return `${escapeHtml(prefix)}${highlighted}${escapeHtml(suffix)}`;
}

// Each line in searchIndex[key] is one level-2 section ("heading\tbody").
// Pick the section matching the most query groups and derive its exact #anchor.
function findBestMatchingSection(rawIssueText, groups) {
    if (!rawIssueText || !groups.length) return null;
    const lines = rawIssueText.split('\n');
    const used = new Set();
    let best = null;
    let bestCount = 0;

    for (const line of lines) {
        const tabIdx = line.indexOf('\t');
        const heading = tabIdx >= 0 ? line.slice(0, tabIdx) : '';
        const body = tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
        let id = '';
        if (heading) {
            id = slugify(heading);
            if (used.has(id)) {
                let n = 2;
                while (used.has(`${id}-${n}`)) n++;
                id = `${id}-${n}`;
            }
            used.add(id);
        }
        const lower = line.toLowerCase();
        let count = 0;
        for (const variants of groups) {
            if (variants.some((v) => lower.includes(v))) count++;
        }
        if (count > bestCount) {
            bestCount = count;
            best = { id, text: heading && body ? `${heading} — ${body}` : body || heading };
            if (count === groups.length) break;
        }
    }
    return best;
}

function injectSnippet(row, groups) {
    const raw = searchIndex?.[`${row.dataset.year || ''}/${row.dataset.issue || ''}`];
    const body = row.querySelector('.row-body');
    if (!raw || !body) return;
    const section = findBestMatchingSection(raw, groups);
    const baseHref = `/issue/${row.dataset.year}/${row.dataset.issue}/`;
    row.setAttribute('href', section?.id ? `${baseHref}#${section.id}` : baseHref);
    const html = buildSnippet(section ? section.text : raw, groups);
    if (!html) return;
    const el = document.createElement('span');
    el.className = 'row-snippet';
    el.innerHTML = html;
    body.appendChild(el);
}

function syncSearchChrome(rawValue) {
    const clearBtn = document.getElementById('archive-search-clear');
    const kbdEl = document.getElementById('archive-search-kbd');
    const hasText = Boolean(rawValue?.trim());
    if (clearBtn) clearBtn.hidden = !hasText;
    if (kbdEl) kbdEl.hidden = hasText;
}

function syncSearchUrl(displayQ) {
    if (isIssueOpen() || location.pathname !== '/') return;
    clearTimeout(searchUrlTimer);
    searchUrlTimer = setTimeout(() => {
        if (isIssueOpen() || location.pathname !== '/') return;
        const target = displayQ
            ? `/?q=${encodeURIComponent(displayQ)}#archive`
            : location.hash === '#archive'
              ? '/#archive'
              : '/';
        const current = `${location.pathname}${location.search}${location.hash}`;
        if (current !== target) history.replaceState(null, '', target);
    }, 180);
}

function applyArchiveFilter(rawQuery, { syncUrl = false } = {}) {
    if (!homeContent) return;
    const input = document.getElementById('archive-search');
    const raw = rawQuery !== undefined ? rawQuery : input ? input.value : '';
    const displayQ = raw.trim();
    const groups = parseQueryGroups(displayQ);

    syncSearchChrome(displayQ);
    if (syncUrl) syncSearchUrl(displayQ);

    const archiveSection = homeContent.querySelector('.archive-section');
    const countEl = archiveSection?.querySelector('.section-count');
    if (countEl && !countEl.dataset.defaultText) {
        countEl.dataset.defaultText = countEl.textContent || '';
    }

    const existingNote = archiveSection?.querySelector('.filter-empty');
    if (existingNote) existingNote.remove();
    for (const el of homeContent.querySelectorAll('.row-snippet')) el.remove();

    if (!groups.length) {
        for (const row of homeContent.querySelectorAll('.issue-card-row')) {
            if (row.dataset.year && row.dataset.issue) {
                row.setAttribute('href', `/issue/${row.dataset.year}/${row.dataset.issue}/`);
            }
        }
        for (const el of homeContent.querySelectorAll('.filter-hidden')) {
            if (!el.classList.contains('is-lead-row') && !el.classList.contains('is-lead-group')) {
                el.classList.remove('filter-hidden');
            }
        }
        for (const el of homeContent.querySelectorAll('.is-lead-row, .is-lead-group')) {
            el.classList.add('filter-hidden');
        }
        if (countEl?.dataset.defaultText) countEl.textContent = countEl.dataset.defaultText;
        announce('');
        return;
    }

    let visibleCount = 0;
    let totalCount = 0;
    homeContent.querySelectorAll('.year-group').forEach((group) => {
        let groupVisible = false;
        group.querySelectorAll('.issue-card-row').forEach((row) => {
            totalCount++;
            const metaHaystack = `${row.dataset.search || ''} ${row.textContent.toLowerCase()}`;
            const metaMatch = matchesAllGroups(metaHaystack, groups);
            let bodyMatch = false;
            if (searchIndexLower) {
                const body = searchIndexLower[`${row.dataset.year || ''}/${row.dataset.issue || ''}`];
                bodyMatch = matchesAllGroups(body, groups);
            }
            const match = metaMatch || bodyMatch;
            row.classList.toggle('filter-hidden', !match);
            if (match) {
                groupVisible = true;
                visibleCount++;
                if (bodyMatch || searchIndex) injectSnippet(row, groups);
            }
        });
        group.classList.toggle('filter-hidden', !groupVisible);
    });

    if (countEl) {
        const suffix = !searchIndex && searchIndexLoading ? ' · търсене…' : '';
        countEl.textContent = `${visibleCount} от ${totalCount} ${totalCount === 1 ? 'брой' : 'броя'}${suffix}`;
    }

    if (archiveSection && visibleCount === 0) {
        const note = document.createElement('p');
        note.className = 'empty filter-empty';
        note.textContent = `Няма намерени броеве за „${displayQ}“.`;
        archiveSection.appendChild(note);
        announce('Няма намерени броеве.');
    } else {
        announce(`Намерени броеве: ${visibleCount}.`);
    }
}

function applyPendingArchiveQuery() {
    if (location.pathname !== '/') return;
    let q = '';
    try {
        q = (new URLSearchParams(location.search).get('q') || '').trim();
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

/* ─── Views & Running Folio ─────────────────────── */

function updateFolioContext(item) {
    if (!folioContextBtn) return;
    if (!item) {
        folioContextBtn.hidden = true;
        folioContextBtn.classList.remove('is-visible');
        folioContextBtn.textContent = '';
        return;
    }
    const dateStr = formatDateLong(item.date);
    folioContextBtn.textContent = `Брой ${item.issue}${dateStr ? ` · ${dateStr}` : ''}`;
    folioContextBtn.hidden = false;
    updateFolioVisibility();
}

function updateFolioVisibility() {
    if (!folioContextBtn || folioContextBtn.hidden) return;
    if (!isIssueOpen()) {
        folioContextBtn.classList.remove('is-visible');
        return;
    }
    const headerBottom = issueHeaderEl ? issueHeaderEl.getBoundingClientRect().bottom : 0;
    folioContextBtn.classList.toggle('is-visible', headerBottom < 48);
}

function showHome() {
    const commit = () => {
        currentIssue = null;
        document.title = PAGE_TITLE_BASE;
        document.documentElement.classList.remove('initial-issue-route');
        document.body.classList.remove('issue-open', 'issue-ready');
        homeView.style.display = 'block';
        issueView.style.display = 'none';
        window.scrollTo(0, 0);
        if (scrollToTopBtn) scrollToTopBtn.classList.remove('is-visible');
        if (progressEl) progressEl.style.width = '0';
        updateFolioContext(null);
        currentTocId = null;
        if (location.pathname !== '/') history.pushState(null, '', '/');
        syncCanonicalUrl('/');
        if (homeContent && !homeContent.children.length) {
            location.assign('/');
            return;
        }
        if (lastFocusedCard && typeof lastFocusedCard.focus === 'function') {
            lastFocusedCard.focus();
            lastFocusedCard = null;
        } else {
            const home = document.querySelector('.masthead-title a');
            if (home && typeof home.focus === 'function') home.focus();
        }
    };
    withViewTransition(commit);
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

/* ─── Issue Page & TOC ──────────────────────────── */

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

function syncTocDisclosureForViewport(isInitialOpen = false) {
    if (!mainContent) return;
    const details = mainContent.querySelector('.issue-toc-details');
    if (!details) return;
    if (DESKTOP_TOC_MQ?.matches) {
        details.open = true;
    } else if (isInitialOpen) {
        const count = details.querySelectorAll('.issue-toc-item').length;
        details.open = count <= 4;
    }
}

const TOC_ACTIVE_OFFSET = 140;

function updateCurrentTocItem() {
    if (!isIssueOpen() || !mainContent) return;
    const headings = mainContent.querySelectorAll('h1[id], h2[id]');
    if (!headings.length) return;
    let activeId = null;
    if (window.innerHeight + getWindowScrollTop() >= document.documentElement.scrollHeight - 8) {
        activeId = headings[headings.length - 1].id;
    } else {
        for (const h of headings) {
            if (h.getBoundingClientRect().top <= TOC_ACTIVE_OFFSET) activeId = h.id;
            else break;
        }
    }
    if (activeId === currentTocId) return;
    currentTocId = activeId;

    let activeLink = null;
    mainContent.querySelectorAll('.issue-toc a[href^="#"]').forEach((a) => {
        const href = a.getAttribute('href');
        const targetId = href ? href.slice(1) : '';
        const isCurrent = activeId !== null && targetId === activeId;
        a.classList.toggle('is-current', isCurrent);
        if (isCurrent) activeLink = a;
    });

    // Keep the active TOC entry visible inside the sticky desktop TOC scrollport.
    if (activeLink && DESKTOP_TOC_MQ?.matches) {
        const toc = mainContent.querySelector('.issue-toc');
        if (toc && toc.scrollHeight > toc.clientHeight) {
            const tocRect = toc.getBoundingClientRect();
            const linkRect = activeLink.getBoundingClientRect();
            const relTop = linkRect.top - tocRect.top;
            const relBottom = linkRect.bottom - tocRect.top;
            if (relTop < 24 || relBottom > toc.clientHeight - 24) {
                const targetTop = Math.max(0, toc.scrollTop + relTop - toc.clientHeight / 2 + linkRect.height / 2);
                toc.scrollTo({ top: targetTop, behavior: scrollBehavior() });
            }
        }
    }
}

function flashTargetHeading(el) {
    if (!el || !mainContent) return;
    for (const prev of mainContent.querySelectorAll('.is-targeted')) prev.classList.remove('is-targeted');
    el.classList.add('is-targeted');
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
    flashTargetHeading(el);
    return true;
}

async function openIssue(item, hash = '') {
    const targetYear = String(item.year);
    const targetIssue = String(item.issue);
    currentIssue = { year: targetYear, issueNum: targetIssue };
    setIssuePath(item.year, item.issue, hash);

    const navEl = document.getElementById('issue-nav');

    // Only paint a loading placeholder if network/parse takes over 100ms —
    // prefetched issues swap directly into the rendered article in one transition.
    let showedSkeleton = false;
    const skeletonTimer = setTimeout(() => {
        if (!currentIssue || currentIssue.year !== targetYear || currentIssue.issueNum !== targetIssue) return;
        showedSkeleton = true;
        showIssue();
        window.scrollTo(0, 0);
        mainLoading.hidden = false;
        mainContent.innerHTML = '';
        if (navEl) navEl.innerHTML = '';
        document.title = issueTitle(item);
        issueHeaderEl.innerHTML = renderIssueHeader(item, 0);
        updateFolioContext(item);
    }, 100);

    try {
        const [{ marked }, md] = await Promise.all([ensureMarked(), fetchMarkdown(item.file), ensureCatalog()]);
        clearTimeout(skeletonTimer);
        if (!currentIssue || currentIssue.year !== targetYear || currentIssue.issueNum !== targetIssue) return;

        const resolved = findIssueByYearAndNumber(targetYear, targetIssue) || item;
        const { html: processedHtml, tocItems } = processRenderedContent(marked.parse(md));
        const articleHtml = renderIssueArticleHtml(resolved, processedHtml, tocItems);
        const headerHtml = renderIssueHeader(resolved, readingMinutes(md));
        const { prev, next } = getAdjacentIssues();
        const navHtml = renderIssueNav(prev, next);

        const renderReady = () => {
            showIssue();
            mainLoading.hidden = true;
            document.title = issueTitle(resolved);
            issueHeaderEl.innerHTML = headerHtml;
            mainContent.innerHTML = articleHtml;
            if (navEl) navEl.innerHTML = navHtml;
            document.body.classList.add('issue-ready');
            syncTocDisclosureForViewport(true);
            updateFolioContext(resolved);
            currentTocId = null;
            if (location.hash) {
                if (!scrollToHashTarget('auto')) window.scrollTo(0, 0);
            } else {
                window.scrollTo(0, 0);
            }
            updateCurrentTocItem();
            updateReadingProgress();
            updateScrollToTopVisibility();
        };

        if (showedSkeleton) renderReady();
        else await withViewTransition(renderReady);

        announce(`Заредено: Държавен вестник, брой ${resolved.issue}.`);
        if (!location.hash && backBtn) backBtn.focus({ preventScroll: true });

        if (prev?.file) fetchMarkdown(prev.file).catch(() => {});
        if (next?.file) fetchMarkdown(next.file).catch(() => {});
    } catch {
        clearTimeout(skeletonTimer);
        if (!currentIssue || currentIssue.year !== targetYear || currentIssue.issueNum !== targetIssue) return;
        showIssue();
        mainLoading.hidden = true;
        document.title = issueTitle(item);
        issueHeaderEl.innerHTML = renderIssueHeader(item, 0);
        mainContent.innerHTML =
            '<p>Този брой не може да бъде зареден в момента. Моля, опитайте отново или изберете друг брой от началната страница.</p>';
        document.body.classList.add('issue-ready');
        announce('Броят не можа да бъде зареден.');
    }
}

async function applyRoute() {
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
        await ensureCatalog();
        const item = findIssueByYearAndNumber(fromPath.year, fromPath.issueNum);
        if (item) openIssue(item, location.hash);
        else showHome();
    } else {
        showHome();
    }
}

/* ─── Events ────────────────────────────────────── */

let hoverWarmTimer = null;

function onMainPointerOver(e) {
    const card = e.target.closest('a.issue-card[data-file]');
    if (!card) return;
    clearTimeout(hoverWarmTimer);
    hoverWarmTimer = setTimeout(() => warmIssue(card.dataset.file), 60);
}

function onMainTouchStart(e) {
    const card = e.target.closest('a.issue-card[data-file]');
    if (card) warmIssue(card.dataset.file);
}

async function shareCurrentIssue(btn) {
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || location.href;
    if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
        try {
            await navigator.share({ title: document.title, url: canonical });
            return;
        } catch {
            /* user cancelled or share unavailable — fall back to clipboard */
        }
    }
    try {
        await navigator.clipboard?.writeText(canonical);
    } catch {
        /* ignore clipboard restrictions */
    }
    btn.dataset.copied = 'true';
    btn.textContent = 'Копирано ✓';
    announce('Връзката към броя е копирана.');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
        delete btn.dataset.copied;
        btn.textContent = 'Сподели връзка';
    }, 1800);
}

function onMainClick(e) {
    const clearBtn = e.target.closest('#archive-search-clear');
    if (clearBtn) {
        const input = document.getElementById('archive-search');
        if (input) {
            input.value = '';
            applyArchiveFilter('', { syncUrl: true });
            input.focus();
        }
        return;
    }

    const shareBtn = e.target.closest('#issue-share-btn');
    if (shareBtn) {
        shareCurrentIssue(shareBtn);
        return;
    }

    const card = e.target.closest('a.issue-card');
    if (card) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const file = card.dataset.file;
        const issueNum = card.dataset.issue;
        const year = card.dataset.year;
        if (!file || !issueNum || !year) return;
        const href = card.getAttribute('href') || '';
        const hashIdx = href.indexOf('#');
        const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
        const item = findIssueByYearAndNumber(year, issueNum) || {
            file,
            issue: issueNum,
            year,
            date: card.dataset.date,
            topics: [],
        };
        e.preventDefault();
        lastFocusedCard = card;
        openIssue(item, hash);
        return;
    }

    const heading = e.target.closest('.content h2[id], .content h3[id]');
    if (heading && !window.getSelection?.().toString()) {
        const hash = `#${heading.id}`;
        if (location.hash !== hash) history.pushState(null, '', hash);
        heading.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        flashTargetHeading(heading);
        navigator.clipboard?.writeText(location.href).catch(() => {});
        heading.dataset.copied = 'true';
        clearTimeout(heading._copyTimer);
        heading._copyTimer = setTimeout(() => {
            delete heading.dataset.copied;
        }, 1800);
        announce('Връзката към темата е копирана.');
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
        if (!DESKTOP_TOC_MQ?.matches) {
            const details = link.closest('.issue-toc-details');
            if (details) details.open = false;
        }
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        flashTargetHeading(el);
        if (location.hash !== href) history.pushState(null, '', href);
    }
}

function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    if (isInput) {
        if (e.key === 'Escape' && target.id === 'archive-search') {
            if (target.value) {
                e.preventDefault();
                target.value = '';
                applyArchiveFilter('', { syncUrl: true });
            } else {
                target.blur();
            }
        }
        return;
    }

    if (e.key === '/') {
        if (isIssueOpen()) showHome();
        const search = document.getElementById('archive-search');
        if (!search) return;
        e.preventDefault();
        const archive = document.getElementById('archive');
        if (archive) archive.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        search.focus({ preventScroll: true });
        return;
    }

    if (!isIssueOpen()) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        showHome();
        return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const selector =
            e.key === 'ArrowLeft' ? '.issue-nav .is-prev a.issue-card' : '.issue-nav .is-next a.issue-card';
        const navCard = document.querySelector(selector);
        if (navCard) {
            e.preventDefault();
            navCard.click();
        }
    }
}

function onFolioClick(e) {
    const ctxBtn = e.target.closest('#folio-context');
    if (ctxBtn) {
        window.scrollTo({ top: 0, behavior: scrollBehavior() });
        return;
    }

    const link = e.target.closest('.folio-link[href^="/#"]');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (document.body.classList.contains('issue-open')) return;

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

// Story and topic pages are plain pages: links between them load the next
// page, so only the shared chrome (theme, share, scroll) runs on them.
const STATIC_PAGE = document.body.dataset.page || '';

async function init() {
    if (!STATIC_PAGE) for (const btn of backBtns) btn.addEventListener('click', showHome);
    mainEl.addEventListener('click', onMainClick);
    mainEl.addEventListener('pointerover', onMainPointerOver);
    mainEl.addEventListener('touchstart', onMainTouchStart, { passive: true });
    const folio = document.querySelector('.folio');
    if (folio) folio.addEventListener('click', onFolioClick);
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    DESKTOP_TOC_MQ?.addEventListener?.('change', () => syncTocDisclosureForViewport(false));

    const storedTheme = document.documentElement.getAttribute('data-theme');
    if (storedTheme) syncThemeColor(storedTheme);
    syncThemeToggleState(currentTheme());

    homeView.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'archive-search') {
            ensureSearchIndex();
            applyArchiveFilter(e.target.value, { syncUrl: true });
        }
    });
    homeView.addEventListener('focusin', (e) => {
        if (e.target && e.target.id === 'archive-search') ensureSearchIndex();
    });
    if (!STATIC_PAGE) window.addEventListener('popstate', applyRoute);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(
        'scroll',
        () => {
            updateScrollToTopVisibility();
            updateCurrentTocItem();
            updateReadingProgress();
            updateFolioVisibility();
        },
        { passive: true },
    );
    if (scrollToTopBtn) {
        scrollToTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: scrollBehavior() }));
    }
    updateScrollToTopVisibility();

    if (STATIC_PAGE || document.querySelector('.not-found-section')) {
        updateReadingProgress();
        updateFolioVisibility();
        document.documentElement.classList.remove('initial-issue-route');
        return;
    }

    const initial = getIssueFromPath();
    const isPreRendered = !!(initial && mainContent && mainContent.children.length > 0);
    const isHomePreRendered = !initial && !!(homeContent && homeContent.children.length > 0);

    if (isPreRendered) {
        currentIssue = { year: initial.year, issueNum: initial.issueNum };
        currentTocId = null;
        syncTocDisclosureForViewport(!location.hash);
        updateCurrentTocItem();
        updateScrollToTopVisibility();
        updateReadingProgress();
        updateFolioVisibility();
        if (location.hash) requestAnimationFrame(() => scrollToHashTarget('auto'));
        for (const card of document.querySelectorAll('#issue-nav a.issue-card[data-file]')) {
            if (card.dataset.file) fetchMarkdown(card.dataset.file).catch(() => {});
        }
        return;
    }

    if (isHomePreRendered) {
        applyPendingArchiveQuery();
        if (location.pathname !== '/') showHome();
        return;
    }

    const cat = await ensureCatalog();
    if (!cat) {
        homeContent.innerHTML =
            '<p class="empty">Каталогът временно не е наличен. Моля, опитайте да презаредите страницата или да се върнете по-късно.</p>';
        return;
    }

    renderHome();
    applyPendingArchiveQuery();

    if (initial) {
        const item = findIssueByYearAndNumber(initial.year, initial.issueNum);
        if (item) openIssue(item, location.hash);
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
