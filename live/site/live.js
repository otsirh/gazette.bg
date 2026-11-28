// What makes the page feel alive and personal, with no account and nothing
// sent anywhere: everything below stays in this browser.
//
// - Times tick ("преди 3 мин").
// - New updates slide in: a bar offers them, a tap swaps the page in place,
//   so the reader keeps their scroll and never sees a reload.
// - A returning reader sees what changed since their last visit, marked on
//   the cards, with a filter for just that.
// - A first-time reader gets three lines on how to read the page, once.
// - Filters, sharing (the phone's own share sheet, or a copied link), and
//   videos that load from YouTube only when asked.

const MINUTE = 60 * 1000;
const store = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Private mode: the page still works, it just forgets.
        }
    },
};

function relTime(ms) {
    const min = Math.max(0, Math.round((Date.now() - ms) / MINUTE));
    if (min < 1) return 'току-що';
    if (min < 60) return `преди ${min} мин`;
    const h = Math.round(min / 60);
    if (h < 24) return `преди ${h} ч`;
    const d = Math.round(h / 24);
    return d === 1 ? 'вчера' : `преди ${d} дни`;
}

function tick() {
    for (const el of document.querySelectorAll('time[data-rel][data-ts]')) {
        el.textContent = relTime(Number(el.dataset.ts));
    }
}

function toast(text) {
    let t = document.querySelector('.toast');
    if (!t) {
        t = document.createElement('div');
        t.className = 'toast';
        t.setAttribute('role', 'status');
        document.body.append(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ─── Since your last visit ──────────────────────────────────────────────

// The visit before this one: kept for the whole session, so moving between
// pages does not wipe the marks. A visit ends after 30 minutes away.
const SESSION_GAP = 30 * MINUTE;
const now = Date.now();
const lastSeen = Number(store.get('live:lastSeen') || 0);
let previousVisit = Number(store.get('live:previousVisit') || 0);
if (!lastSeen) previousVisit = 0;
else if (now - lastSeen > SESSION_GAP) {
    previousVisit = lastSeen;
    store.set('live:previousVisit', String(previousVisit));
}
store.set('live:lastSeen', String(now));
addEventListener('visibilitychange', () => {
    if (document.hidden) store.set('live:lastSeen', String(Date.now()));
});

function markSince() {
    if (!previousVisit) return { fresh: 0, updated: 0 };
    let fresh = 0;
    let updated = 0;
    for (const card of document.querySelectorAll('[data-story][data-first]')) {
        if (card.querySelector('.badge-new')) continue;
        const first = Number(card.dataset.first);
        const last = Number(card.dataset.last);
        let kind = null;
        if (first > previousVisit) kind = 'new';
        else if (last > previousVisit) kind = 'upd';
        if (!kind) continue;
        card.dataset.mine = '1';
        if (card.tagName === 'BODY') continue;
        const badge = document.createElement('span');
        badge.className = `badge-new${kind === 'upd' ? ' upd' : ''}`;
        badge.textContent = kind === 'new' ? 'НОВО' : 'ОБНОВЕНО';
        if (card.classList.contains('row')) card.querySelector('a').append(badge);
        else card.append(badge);
        if (kind === 'new') fresh++;
        else updated++;
    }
    return { fresh, updated };
}

function sinceBar({ fresh, updated }) {
    const box = document.querySelector('[data-since]');
    const mineFilter = document.querySelector('[data-filter="mine"]');
    if (!box || (!fresh && !updated)) return;
    const parts = [];
    if (fresh) parts.push(`<span class="pill">${fresh} ${fresh === 1 ? 'нова история' : 'нови истории'}</span>`);
    if (updated)
        parts.push(
            `<span class="pill" style="background:none;box-shadow:inset 0 0 0 1px var(--line);color:var(--text-2)">${updated} с нови развития</span>`,
        );
    box.innerHTML = `<span>Откакто беше тук <b>${relTime(previousVisit)}</b>:</span>${parts.join('')}<button type="button" data-show-mine>Покажи само тях →</button>`;
    box.hidden = false;
    if (mineFilter) mineFilter.hidden = false;
}

// ─── Filters ────────────────────────────────────────────────────────────

const FILTERS = {
    all: () => true,
    hot: (el) => el.dataset.level === 'hot',
    video: (el) => el.dataset.video === '1',
    confirmed: (el) => el.dataset.trust === 'confirmed',
    mine: (el) => el.dataset.mine === '1',
};

function applyFilter(id) {
    const test = FILTERS[id] ?? FILTERS.all;
    let shown = 0;
    for (const el of document.querySelectorAll('.feed [data-story]')) {
        const ok = test(el);
        el.hidden = !ok;
        if (ok) shown++;
    }
    for (const group of document.querySelectorAll('.feed .group')) {
        // A group without cards (the map) shows only under "all".
        if (group.querySelector('[data-story]')) group.hidden = !group.querySelector('[data-story]:not([hidden])');
        else group.hidden = id !== 'all';
    }
    for (const b of document.querySelectorAll('[data-filter]')) {
        const on = b.dataset.filter === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
    }
    const empty = document.querySelector('[data-filter-empty]');
    if (empty) empty.hidden = shown > 0;
    store.set('live:filter', id === 'mine' ? 'all' : id);
}

// ─── Welcome, once ──────────────────────────────────────────────────────

function welcome() {
    const box = document.querySelector('[data-welcome]');
    if (!box || store.get('live:welcomed')) return;
    box.hidden = false;
    box.querySelector('[data-welcome-close]')?.addEventListener('click', () => {
        store.set('live:welcomed', '1');
        box.hidden = true;
    });
}

// ─── Sharing ────────────────────────────────────────────────────────────

async function share(btn) {
    const url = btn.dataset.shareUrl || location.href;
    const title = btn.dataset.shareTitle || document.title;
    if (navigator.share) {
        try {
            await navigator.share({ title, text: `${title} — live.gazette.bg`, url });
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(url);
        toast('Връзката е копирана');
    } catch {
        prompt('Копирай връзката:', url);
    }
}

// ─── Live updates without a reload ──────────────────────────────────────

const version = () => document.body.dataset.version;

async function swapIn() {
    const scroll = scrollY;
    const res = await fetch(location.pathname, { cache: 'no-store' });
    if (!res.ok) {
        location.reload();
        return;
    }
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const main = doc.querySelector('main');
    if (!main) {
        location.reload();
        return;
    }
    document.querySelector('main').replaceWith(main);
    document.querySelector('.fresh-bar')?.remove();
    // A story page's own data (heat, level) lives on <body>.
    for (const [k, v] of Object.entries(doc.body.dataset)) document.body.dataset[k] = v;
    document.body.className = doc.body.className;
    const status = doc.querySelector('[data-status]');
    if (status) document.querySelector('[data-status]')?.replaceWith(status);
    document.body.dataset.version = doc.body.dataset.version;
    document.title = doc.title;
    decorate();
    scrollTo({ top: scroll });
    toast('Обновено');
}

async function checkForUpdate() {
    if (document.hidden) return;
    try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { updatedAt } = await res.json();
        if (!updatedAt || String(updatedAt) === version()) return;
        // Nothing to lose at the top of the page: just swap it in, unless a
        // video is playing or the reader has opened something.
        const busy = document.querySelector('main iframe, main details[open]');
        if (scrollY < 120 && !busy) {
            await swapIn();
            return;
        }
        if (document.querySelector('.fresh-bar')) return;
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'fresh-bar';
        bar.textContent = '↻ Има нови развития — покажи';
        bar.addEventListener('click', () => {
            bar.remove();
            swapIn().catch(() => location.reload());
        });
        document.body.append(bar);
    } catch {
        // Offline for a moment; the next check will do.
    }
}

// ─── Wiring ─────────────────────────────────────────────────────────────

function decorate() {
    tick();
    const counts = markSince();
    sinceBar(counts);
    welcome();
    const saved = store.get('live:filter');
    if (saved && saved !== 'all' && document.querySelector(`[data-filter="${saved}"]`)) applyFilter(saved);
}

document.addEventListener('click', (e) => {
    const shareBtn = e.target.closest('[data-share]');
    if (shareBtn) {
        e.preventDefault();
        share(shareBtn);
        return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) {
        applyFilter(filter.dataset.filter);
        return;
    }
    if (e.target.closest('[data-show-mine]')) {
        applyFilter('mine');
        document.querySelector('.filters')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const play = e.target.closest('.video-play');
    if (play) {
        const id = play.dataset.video;
        if (!/^[\w-]{6,20}$/.test(id)) return;
        const frame = document.createElement('iframe');
        frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
        frame.title = play.getAttribute('aria-label') ?? 'Видео';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.allowFullscreen = true;
        play.replaceWith(frame);
    }
});

// Sortable tables: a click on a column header sorts by it, again reverses.
document.addEventListener('click', (e) => {
    const th = e.target.closest('table[data-sortable] th[data-sort]');
    if (!th) return;
    const table = th.closest('table');
    const col = [...th.parentNode.children].indexOf(th);
    const desc = th.getAttribute('aria-sort') !== 'descending';
    for (const h of th.parentNode.children) h.removeAttribute('aria-sort');
    th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
    const body = table.tBodies[0];
    const rows = [...body.rows].sort((a, b) => {
        const va = Number(a.cells[col]?.dataset.v ?? 0);
        const vb = Number(b.cells[col]?.dataset.v ?? 0);
        return desc ? vb - va : va - vb;
    });
    body.append(...rows);
});

decorate();
setInterval(tick, MINUTE);
setInterval(checkForUpdate, 2 * MINUTE);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        tick();
        checkForUpdate();
    }
});
