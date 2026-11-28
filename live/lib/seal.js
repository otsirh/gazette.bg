// What a story about a child or a victim must not show (the outlets'
// headlines, pictures and videos) is not thrown away: the published state is
// public, so it is sealed there, and only an update holding the key can open
// it again. A story flagged by mistake can then get everything back, and
// nothing is lost to one wrong answer from the model.
//
// The key is LIVE_SEAL_KEY, or else derived from ANTHROPIC_API_KEY, which
// every update already has. Without either, nothing can be sealed, and the
// hidden fields are dropped as before: hiding wins over keeping.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// The fields of an item a sensitive story hides.
export const HIDDEN = ['title', 'thumb', 'videoId'];

function key() {
    const secret = process.env.LIVE_SEAL_KEY || process.env.ANTHROPIC_API_KEY;
    if (!secret) return null;
    return Buffer.from(hkdfSync('sha256', secret, 'live.gazette.bg', 'sealed items v1', 32));
}

export function seal(value) {
    const k = key();
    if (!k) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', k, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['1', iv, body, cipher.getAuthTag()]
        .map((b) => (typeof b === 'string' ? b : b.toString('base64url')))
        .join('.');
}

// The sealed value, or null if it cannot be opened (another key, or damaged).
export function unseal(text) {
    const k = key();
    const parts = String(text ?? '').split('.');
    if (!k || parts.length !== 4 || parts[0] !== '1') return null;
    try {
        const [iv, body, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
        const decipher = createDecipheriv('aes-256-gcm', k, iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    } catch {
        return null;
    }
}

// An item as the public may see it: for a sensitive story, without its
// headline, picture and video, which travel sealed. An item whose seal could
// not be opened keeps it as it is.
export function publicItem(item, sensitive) {
    if (!sensitive) return item;
    const hidden = {};
    const rest = {};
    for (const [k, v] of Object.entries(item)) {
        if (HIDDEN.includes(k)) {
            if (v) hidden[k] = v;
        } else rest[k] = v;
    }
    const sealed = Object.keys(hidden).length ? seal(hidden) : null;
    if (sealed) rest.sealed = sealed;
    return { ...rest, title: '' };
}

// The state as published: every sensitive story's items sealed.
export function publicState(state) {
    return {
        ...state,
        stories: (state.stories ?? []).map((s) =>
            s.sensitive ? { ...s, items: s.items.map((i) => publicItem(i, true)) } : s,
        ),
    };
}

// After loading a published state: open every seal this update can open.
export function openSeals(state) {
    for (const s of state.stories ?? []) {
        for (const i of s.items ?? []) {
            if (!i.sealed) continue;
            const v = unseal(i.sealed);
            if (!v) continue;
            for (const f of HIDDEN) if (v[f]) i[f] = v[f];
            delete i.sealed;
        }
    }
}
