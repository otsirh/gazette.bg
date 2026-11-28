// What makes the page feel alive and personal, with no account and nothing
// sent anywhere: everything below stays in this browser.
//
// - Times tick ("преди 3 мин").
// - New updates slide in: a bar offers them, a tap swaps the page in place,
//   so the reader keeps their scroll and never sees a reload.
// - A returning reader sees what changed since their last visit, marked on
//   the cards.
// - A first-time reader gets three lines on how to read the page, once.
// - Videos load from YouTube only when asked.

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
        // A new step in its timeline, not just one more article retelling it.
        const step = Number(card.dataset.step ?? card.dataset.last);
        let kind = null;
        if (first > previousVisit) kind = 'new';
        else if (step > previousVisit) kind = 'upd';
        if (!kind) continue;
        card.dataset.mine = '1';
        if (card.tagName === 'BODY') continue;
        const badge = document.createElement('span');
        badge.className = `badge-new${kind === 'upd' ? ' upd' : ''}`;
        badge.textContent = kind === 'new' ? 'НОВО' : 'НОВО РАЗВИТИЕ';
        if (card.classList.contains('row')) card.querySelector('a').append(badge);
        else (card.querySelector('.ago') ?? card).before(badge);
        if (kind === 'new') fresh++;
        else updated++;
    }
    return { fresh, updated };
}

function sinceBar({ fresh, updated }) {
    const box = document.querySelector('[data-since]');
    if (!box || (!fresh && !updated)) return;
    const parts = [];
    if (fresh) parts.push(`<span class="pill">${fresh === 1 ? '1 е нова' : `${fresh} са нови`}</span>`);
    if (updated)
        parts.push(
            `<span class="pill" style="background:none;box-shadow:inset 0 0 0 1px var(--line);color:var(--text-2)">${updated} с нови развития</span>`,
        );
    box.innerHTML = `<span>Откакто беше тук <b>${relTime(previousVisit)}</b>:</span>${parts.join('')}`;
    box.hidden = false;
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

// ─── Live updates without a reload ──────────────────────────────────────

const version = () => document.body.dataset.version;

async function swapIn() {
    const scroll = scrollY;
    const res = await fetch(location.pathname, { cache: 'no-store' });
    // The page is gone or the network failed: keep what the reader is
    // reading rather than throw them onto an error page.
    if (!res.ok) return;
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
    toast('Ето най-новото');
}

async function checkForUpdate() {
    // A page that never changes (a remembered story) is not refreshed.
    if (document.hidden || document.body.dataset.static !== undefined) return;
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

// ─── What is new in a story for you ──────────────────────────────────────

// ─── Keyboard: J and K move between stories, Enter opens ────────────────

document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (key !== 'j' && key !== 'k') return;
    const links = [...document.querySelectorAll('.feed [data-story]:not([hidden]) a[href^="/s/"]')].filter(
        (a, i, all) => all.findIndex((b) => b.closest('[data-story]') === a.closest('[data-story]')) === i,
    );
    if (!links.length) return;
    const at = links.indexOf(document.activeElement);
    if (at < 0) return;
    const next = key === 'j' ? Math.min(links.length - 1, at + 1) : Math.max(0, at - 1);
    links[next].focus();
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    links[next].scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    e.preventDefault();
});

// ─── Wiring ─────────────────────────────────────────────────────────────

// ─── The river of the day ───────────────────────────────────────────────

function decorate() {
    tick();
    const counts = markSince();
    sinceBar(counts);
    welcome();
}

document.addEventListener('click', (e) => {
    if (e.target.closest('[data-forget]')) {
        try {
            for (const k of Object.keys(localStorage)) if (k.startsWith('live:')) localStorage.removeItem(k);
        } catch {}
        toast('Изтрито. Браузърът вече не помни нищо за сайта.');
        return;
    }
    const more = e.target.closest('[data-brief-more]');
    if (more) {
        document.querySelector('[data-brief]')?.classList.add('open');
        more.remove();
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

decorate();
setInterval(tick, MINUTE);

// Read without a connection: pages you opened stay readable offline.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(checkForUpdate, 2 * MINUTE);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        tick();
        checkForUpdate();
    }
});
