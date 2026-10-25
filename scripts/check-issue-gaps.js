#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/cli.js';
import { ISSUES_DIR } from './lib/issues.js';

// ДВ numbers its issues 1, 2, 3… within a year, extraordinary issues
// included, so a hole in the run is an issue the site never published. The
// downloader only sees the ten newest issues; once a failed one slips past
// them, nothing else would ever notice. Fail the run and name it — summarize
// it by hand with process-issue-pdf.js.
export function findGaps(issuesDir = ISSUES_DIR) {
    const gaps = [];
    if (!fs.existsSync(issuesDir)) return gaps;
    const years = fs
        .readdirSync(issuesDir)
        .filter((name) => /^\d{4}$/.test(name))
        .sort();
    for (const year of years) {
        const have = new Set();
        for (const folder of fs.readdirSync(path.join(issuesDir, year))) {
            if (!/^\d+$/.test(folder)) continue;
            const num = parseInt(folder, 10);
            if (fs.existsSync(path.join(issuesDir, year, folder, `${num}.md`))) have.add(num);
        }
        const last = Math.max(0, ...have);
        for (let num = 1; num < last; num++) {
            if (!have.has(num)) gaps.push(`${year}/${num}`);
        }
    }
    return gaps;
}

if (isMain(import.meta.url)) {
    const gaps = findGaps();
    if (gaps.length) {
        console.error(
            `[check-issue-gaps] Missing issue(s): ${gaps.join(', ')}. The downloader retries them while they are among the ten newest on dv.parliament.bg; past that, run process-issue-pdf.js for each.`,
        );
        process.exit(1);
    }
    console.log('[check-issue-gaps] No gaps in the issue numbering.');
}
