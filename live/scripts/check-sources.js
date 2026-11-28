#!/usr/bin/env node
// Checks candidate sources the way update.js reads them, before they are
// added: does the feed (or news list) answer and carry recent dated items,
// does robots.txt let us read it, is there a TDM reservation; for YouTube,
// does the channel exist and upload, read through the YouTube Data API.
//
//   node live/scripts/check-sources.js candidates.json
//
// candidates.json: [{ "id", "feed" } | { "id", "list", "pattern" } |
//                   { "id", "channel": "UC…" } | { "id", "handle": "@…" }]
// YouTube needs YOUTUBE_API_KEY; the key never appears in the output.
import fs from 'node:fs';
import { fetchText, mapLimit, parseFeed, parseList } from '../lib/feeds.js';
import { aiRefused, pathAllowed, tdmReserved } from '../lib/robots.js';

const DAY = 24 * 3600 * 1000;
const now = Date.now();
const ago = (t) => (t ? `${Math.round((now - t) / 3600000)} ч` : '—');

async function yt(path, params) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error('no YOUTUBE_API_KEY');
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`);
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
    return res.json();
}

export async function checkChannel(c) {
    const params = { part: 'snippet,statistics,contentDetails' };
    if (c.channel) params.id = c.channel;
    else params.forHandle = c.handle.replace(/^@?/, '@');
    const ch = (await yt('channels', params)).items?.[0];
    if (!ch) return { ok: false, note: 'no such channel' };
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    const list = await yt('playlistItems', { part: 'snippet,contentDetails', maxResults: '15', playlistId: uploads });
    const dates = (list.items ?? []).map((i) =>
        Date.parse(i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt),
    );
    const week = dates.filter((d) => now - d < 7 * DAY).length;
    return {
        ok: week > 0,
        channel: ch.id,
        title: ch.snippet?.title,
        subs: ch.statistics?.subscriberCount,
        note: `${week}/15 in the last 7 days, newest ${ago(Math.max(...dates))} ago; ${(list.items ?? [])
            .slice(0, c.titles ?? 1)
            .map((i) => `«${i.snippet?.title ?? ''}»`)
            .join(' ')}`,
    };
}

export async function checkSite(c) {
    const url = c.feed ?? c.list;
    const u = new URL(url);
    let robots = '';
    try {
        robots = await fetchText(`${u.origin}/robots.txt`, { timeoutMs: 12000 });
    } catch (err) {
        if (!/HTTP 40[34]|HTTP 410/.test(err.message)) robots = null;
        if (/HTTP 403/.test(err.message)) return { ok: false, note: 'robots.txt refused (403)' };
    }
    if (robots === null) return { ok: false, note: 'robots.txt unreachable' };
    if (aiRefused(robots)) return { ok: false, note: 'robots.txt refuses AI for the whole site' };
    if (!pathAllowed(robots, u.pathname)) return { ok: false, note: `robots.txt disallows ${u.pathname}` };
    let tdm = '';
    try {
        tdm = await fetchText(`${u.origin}/.well-known/tdmrep.json`, { timeoutMs: 8000 });
    } catch {}
    if (tdm && tdmReserved(tdm, '/')) return { ok: false, note: 'TDM reservation' };
    let body;
    try {
        body = await fetchText(url, { timeoutMs: 15000 });
    } catch (err) {
        return { ok: false, note: `feed: ${err.message}` };
    }
    const entries = c.list
        ? parseList(body, url, new RegExp(c.pattern), now).filter((e) => e.dated)
        : parseFeed(body, now);
    const newest = Math.max(0, ...entries.map((e) => e.at));
    return {
        ok: entries.length > 0 && now - newest < 7 * DAY,
        note: `${entries.length} items, newest ${ago(newest)} ago; e.g. «${entries[0]?.title?.slice(0, 80) ?? ''}»`,
    };
}

// Run directly: check the candidates in the file given.
if (import.meta.url === `file://${process.argv[1]}`) {
    const candidates = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const results = await mapLimit(candidates, 6, async (c) => {
        try {
            return { id: c.id, ...(c.channel || c.handle ? await checkChannel(c) : await checkSite(c)) };
        } catch (err) {
            return { id: c.id, ok: false, note: err.message };
        }
    });
    for (const r of results) {
        console.log(
            `${r.ok ? 'OK  ' : 'NO  '} ${r.id}${r.channel ? ` ${r.channel}` : ''}${r.title ? ` «${r.title}»` : ''}${r.subs ? ` ${r.subs} subs` : ''} — ${r.note}`,
        );
    }
}
