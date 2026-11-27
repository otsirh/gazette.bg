// Keeps an open page current: relative times tick, the front page reloads
// itself when a new update is published, a story page offers to, and a video
// plays in place only when asked (nothing from YouTube loads before that).

const MINUTE = 60 * 1000;

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

const current = document.body.dataset.version;

async function checkForUpdate() {
    if (document.hidden) return;
    try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { updatedAt } = await res.json();
        if (!updatedAt || String(updatedAt) === current) return;
        if (document.body.classList.contains('home') && window.scrollY < 200) {
            location.reload();
            return;
        }
        if (!document.querySelector('.fresh-banner')) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'fresh-banner';
            b.textContent = 'Има нова информация — обнови';
            b.addEventListener('click', () => location.reload());
            document.body.append(b);
        }
    } catch {
        // Offline for a moment; the next check will do.
    }
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.video-play');
    if (!btn) return;
    const id = btn.dataset.video;
    if (!/^[\w-]{6,20}$/.test(id)) return;
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    frame.title = btn.getAttribute('aria-label') ?? 'Видео';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    btn.replaceWith(frame);
});

tick();
setInterval(tick, MINUTE);
setInterval(checkForUpdate, 2 * MINUTE);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        tick();
        checkForUpdate();
    }
});
