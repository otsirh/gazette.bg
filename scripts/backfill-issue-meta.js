#!/usr/bin/env node
/*
 * Fills in tags and deadlines for issues summarized before those existed.
 * Reads the published summary — not the PDF — so it costs a few cents an issue.
 *
 *   npm run backfill-meta          # only issues that have none
 *   npm run backfill-meta -- --all # redo every issue
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { extractIssueMeta } from './issue-meta.js';
import { appendLog, flushAlertEmail } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ISSUES_DIR = path.join(ROOT, 'issues');
const SCRIPT_NAME = 'backfill-issue-meta';
const apiKey = process.env.ANTHROPIC_API_KEY;

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];

function issueDateToIso(str) {
    const m = String(str || '').match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})/);
    if (!m) return null;
    const monthIdx = BG_MONTHS.indexOf(m[2].toLowerCase());
    if (monthIdx < 0) return null;
    return `${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function listIssues() {
    const out = [];
    if (!fs.existsSync(ISSUES_DIR)) return out;
    for (const year of fs.readdirSync(ISSUES_DIR).filter((y) => /^\d{4}$/.test(y)).sort()) {
        const yearDir = path.join(ISSUES_DIR, year);
        for (const folder of fs.readdirSync(yearDir).filter((f) => /^\d{2,}$/.test(f)).sort()) {
            const issue = parseInt(folder, 10);
            const md = path.join(yearDir, folder, `${issue}.md`);
            const json = path.join(yearDir, folder, `${issue}.json`);
            if (fs.existsSync(md) && fs.existsSync(json)) out.push({ year, issue, md, json });
        }
    }
    return out;
}

async function main() {
    if (!apiKey) {
        console.error('[backfill-issue-meta] Missing ANTHROPIC_API_KEY');
        process.exit(1);
    }
    const redoAll = process.argv.includes('--all');
    const issues = listIssues();
    let done = 0;
    let skipped = 0;
    const failed = [];

    for (const { year, issue, md, json } of issues) {
        const data = JSON.parse(fs.readFileSync(json, 'utf8'));
        if (!redoAll && Array.isArray(data.audiences)) {
            skipped++;
            continue;
        }
        const issueIso = issueDateToIso(data.date);
        if (!issueIso) {
            console.log(`  ${year}/${issue}: no usable date — skipped`);
            skipped++;
            continue;
        }
        try {
            const meta = await extractIssueMeta({
                apiKey,
                markdown: fs.readFileSync(md, 'utf8'),
                issueIso,
                year,
                issue,
            });
            delete meta.usage;
            fs.writeFileSync(json, JSON.stringify({ ...data, ...meta }, null, 4), 'utf8');
            const live = meta.deadlines.filter((d) => d.expires >= new Date().toISOString().slice(0, 10)).length;
            console.log(`  ${year}/${issue}: ${meta.audiences.length} tags, ${meta.deadlines.length} deadlines (${live} still open), ${meta.places.length} places`);
            done++;
        } catch (e) {
            console.error(`  ${year}/${issue}: FAILED — ${e.message}`);
            failed.push(`${year}/${issue}`);
        }
    }

    const summary = `Tagged ${done} issue(s), skipped ${skipped}, failed ${failed.length}`;
    console.log(`[backfill-issue-meta] ${summary}`);
    appendLog(SCRIPT_NAME, summary, failed.length ? 'WARN' : 'OK');
    if (failed.length) await flushAlertEmail();
}

main().catch(async (e) => {
    appendLog(SCRIPT_NAME, 'Unhandled: ' + (e?.message || e), 'ERROR');
    console.error('[backfill-issue-meta]', e);
    await flushAlertEmail();
    process.exit(1);
});
