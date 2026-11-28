#!/usr/bin/env node
// The weekly check of the sources we want but cannot read (watchlist.js).
// Prints a report (Markdown) and writes the ones that now let us read them
// to the JSON file given, for the workflow to open an issue for each.
//
//   node live/scripts/recheck-watchlist.js ready.json > report.md
//
// A source refused by its terms of use is checked by hand: the report only
// reminds. A bot challenge is never worked around: it counts as a refusal.
import fs from 'node:fs';
import { fetchText } from '../lib/feeds.js';
import { aiRefused } from '../lib/robots.js';
import { WANTED } from '../watchlist.js';
import { checkChannel, checkSite } from './check-sources.js';

// Only a refusal a machine can see is rechecked here. A source that cannot
// be read for another reason (its terms, no usable feed, a channel not yet
// confirmed) is listed as a reminder, never reported as readable.
const AUTOMATIC = new Set(['robots', 'ai-input', 'tdm', 'outlet', 'bot-wall']);

async function check(w) {
    if (w.check.page) {
        // A bot wall: readable once the page itself answers us.
        await fetchText(w.check.page, { timeoutMs: 15000 });
        return { ok: true, note: 'the page answers now' };
    }
    if (w.check.robotsOf) {
        let robots = '';
        try {
            robots = await fetchText(new URL('/robots.txt', w.check.robotsOf).href, { timeoutMs: 12000 });
        } catch (err) {
            if (!/HTTP 404|HTTP 410/.test(err.message)) return { ok: false, note: `robots.txt: ${err.message}` };
        }
        if (aiRefused(robots)) return { ok: false, note: 'the outlet still refuses AI in robots.txt' };
        if (w.check.channel && process.env.YOUTUBE_API_KEY) return checkChannel({ channel: w.check.channel });
        return { ok: true, note: 'robots.txt no longer refuses AI' };
    }
    return checkSite(w.check);
}

const out = process.argv[2];
const ready = [];
const lines = ['| Източник | Причина | Сега |', '|---|---|---|'];
for (const w of WANTED) {
    let r;
    try {
        r = await check(w);
    } catch (err) {
        r = { ok: false, note: err.message };
    }
    const manual = !AUTOMATIC.has(w.why);
    const now = r.ok
        ? manual
            ? `провери на ръка (${w.why}) — ${r.note}`
            : `✅ вече може — ${r.note}`
        : `❌ ${r.note}`;
    lines.push(`| ${w.name} | ${w.why} | ${now.replace(/\|/g, '/')} |`);
    if (r.ok && !manual) ready.push({ id: w.id, name: w.name, why: w.why, note: r.note, contact: w.contact });
}
console.log(`## Наблюдавани източници\n\n${lines.join('\n')}\n`);
if (out) fs.writeFileSync(out, JSON.stringify(ready, null, 2));
