#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { formatDateBulgarian } from '../src/js/shared.js';
import { createLogger, isMain } from './lib/cli.js';
import { hasSummary, issueDir, metadataPath, ROOT, tempPdfPath } from './lib/issues.js';
import { createClient, summarizeIssue } from './summarize-gazette.js';

const DIAGNOSTICS_DIR = path.join(ROOT, 'diagnostics');
const HEADLESS = process.env.HEADLESS !== 'false';
const STEP_TIMEOUT_MS = 30000;
const LIST_URL = 'https://dv.parliament.bg/DVWeb/broeveList.faces';
// A dense issue takes ~10 minutes to summarize and the job gets 60. Anything
// beyond this waits for the next run — it stays on the list's first page
// (the ten newest issues) for weeks.
const MAX_ISSUES_PER_RUN = 3;
// From GitHub's runners the list page sometimes hangs while it loads at once
// from elsewhere, and a run that gave up on the first try held an issue back
// a whole day. Waits grow: 30s, then 60s.
const LIST_LOAD_ATTEMPTS = 3;
const LIST_RETRY_DELAY_MS = 30000;

const log = createLogger('download-latest-gazette');

// The PDF's own name, "97_26.pdf": issue 97 of 2026.
export function parseDvFilename(filename) {
    const match = (filename || '').match(/^(\d+)_(\d{2})\.pdf$/i);
    return match ? { issue: Number(match[1]), year: 2000 + Number(match[2]) } : null;
}

function revertIssueDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        log(`Reverted (removed) ${dir}`, 'WARN');
    }
}

// A row of the issue list reads "Брой 90, 30.9.2026 г. (извънреден) …".
export function parseIssueRow(text) {
    const m = (text || '').match(/Брой\s*(\d+),\s*(\d{1,2}\.\d{1,2}\.(\d{4})\s*г\.)/);
    return m ? { issue: Number(m[1]), year: Number(m[3]), date: formatDateBulgarian(m[2]) } : null;
}

// The issue's publication date, as scraped — the only metadata the site
// carries besides the summary itself.
function writeIssueMetadata(year, issue, date) {
    if (!date) return;
    const metaPath = metadataPath(year, issue);
    try {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({ date }, null, 4), 'utf8');
    } catch (e) {
        log(`Failed to write metadata ${metaPath}: ${e.message}`, 'WARN');
    }
}

// When the site's flow changes under us, the page we saw is the only evidence
// the next fix will get. Keep its HTML and a screenshot; the workflow uploads
// diagnostics/ when the run fails.
async function saveDiagnostics(page, label) {
    try {
        fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = path.join(DIAGNOSTICS_DIR, `${label}-${stamp}`);
        fs.writeFileSync(`${base}.html`, await page.content(), 'utf8');
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        log(`Saved ${path.relative(ROOT, base)}.html and .png`, 'WARN');
    } catch (e) {
        log(`Could not save diagnostics: ${e.message}`, 'WARN');
    }
}

export async function gotoWithRetry(page, url, { attempts = LIST_LOAD_ATTEMPTS, delayMs = LIST_RETRY_DELAY_MS } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
        } catch (e) {
            if (attempt >= attempts) throw e;
            const wait = delayMs * attempt;
            // Playwright's message goes on with a call log; the first line says what failed.
            const why = String(e?.message).split('\n')[0];
            log(`${url} did not load (attempt ${attempt}/${attempts}): ${why}. Retrying in ${wait / 1000}s.`, 'WARN');
            await sleep(wait);
        }
    }
}

// Every issue on the list's first page, newest first, each with the link that
// opens its files. Loads the list afresh, so the links are good until the
// page next navigates.
async function listIssues(page) {
    try {
        await gotoWithRetry(page, LIST_URL);
    } catch (e) {
        throw new Error(
            `List page did not load after ${LIST_LOAD_ATTEMPTS} attempts (site down or URL changed?): ${e.message}`,
        );
    }

    const links = page.getByRole('link', { name: 'Изтегли броя' });
    try {
        await links.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    } catch {
        await saveDiagnostics(page, 'list-without-download-links');
        throw new Error("'Изтегли броя' link not found – page layout may have changed.");
    }

    const rows = [];
    const count = await links.count();
    for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const text = await link
            .locator('xpath=../..')
            .locator('.td_tabResult0')
            .first()
            .textContent()
            .catch(() => null);
        const row = parseIssueRow(text);
        if (row) rows.push({ ...row, link });
    }
    if (!rows.length) {
        await saveDiagnostics(page, 'list-rows-unreadable');
        throw new Error('Found download links but could not read any issue number from their rows.');
    }
    return rows;
}

async function downloadIssuePdf(page, target, destPath) {
    // The list is reloaded for every issue: the modal from the previous one is
    // gone, and if a new issue landed meanwhile, matching by number still
    // finds the right row.
    const row = (await listIssues(page)).find((r) => r.issue === target.issue && r.year === target.year);
    if (!row) throw new Error('Issue is no longer on the first page of the list.');

    await row.link.click();

    // Look for the PDF link itself rather than the modal around it: the
    // container's class has changed before, and the link's name ("97_26.pdf")
    // is what identifies the file. The RTF beside it is skipped by that name.
    const pdfLink = page
        .locator('a[href*="fileUploadShowing"]')
        .filter({ hasText: /^\s*\d+_\d{2}\.pdf\s*$/i })
        .first();
    try {
        await pdfLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    } catch {
        await saveDiagnostics(page, `no-pdf-link-${target.year}-${target.issue}`);
        throw new Error("No PDF link appeared after clicking 'Изтегли броя' – site flow may have changed.");
    }

    const filename = ((await pdfLink.textContent()) || '').trim();
    const parsed = parseDvFilename(filename);
    if (!parsed || parsed.issue !== target.issue || parsed.year !== target.year) {
        throw new Error(
            `Expected the PDF of ${target.year}/${target.issue}, the link offers ${JSON.stringify(filename)}.`,
        );
    }

    let download;
    try {
        [download] = await Promise.all([page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }), pdfLink.click()]);
    } catch (e) {
        await saveDiagnostics(page, `download-did-not-start-${target.year}-${target.issue}`);
        throw new Error(`PDF download did not start or timed out – link or server may have changed: ${e?.message}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await download.saveAs(destPath);
}

// Fetch every issue on the list's first page that is not on the site yet,
// oldest first. Taking only the newest would lose an issue for good whenever
// two land between runs, or one fails and a newer one comes out before the
// retry. A failed issue is reverted and retried next run; the others still go
// through.
async function run() {
    log('Run started');

    const failures = [];
    const downloaded = [];
    const browser = await chromium.launch({ headless: HEADLESS });
    try {
        const page = await browser.newPage();
        const missing = (await listIssues(page))
            .filter((r) => !hasSummary(r.year, r.issue))
            .sort((a, b) => a.year - b.year || a.issue - b.issue);

        if (!missing.length) {
            log('Up to date – every issue on the list is already in issues/.', 'OK');
            return;
        }
        const batch = missing.slice(0, MAX_ISSUES_PER_RUN);
        log(
            `Missing: ${missing.map((r) => `${r.year}/${r.issue}`).join(', ')}` +
                (missing.length > batch.length ? ` – taking the oldest ${batch.length} this run` : ''),
        );

        for (const target of batch) {
            const pdfPath = tempPdfPath(target.year, target.issue);
            try {
                await downloadIssuePdf(page, target, pdfPath);
                downloaded.push({ ...target, pdfPath });
                log(`Downloaded ${target.year}/${target.issue}`);
            } catch (e) {
                failures.push(`${target.year}/${target.issue}`);
                log(`Download of ${target.year}/${target.issue} failed: ${e.message}`, 'ERROR');
                revertIssueDir(issueDir(target.year, target.issue));
            }
        }
    } finally {
        // Closed before the long-running summaries, which need no browser.
        await browser.close().catch(() => {});
    }

    let client;
    for (const item of downloaded) {
        try {
            client ??= createClient();
            await summarizeIssue(item.year, item.issue, item.pdfPath, { client });
        } catch (e) {
            failures.push(`${item.year}/${item.issue}`);
            log(
                `Summarize failed for ${item.year}/${item.issue}: ${e.message}. Issue folder reverted; the next run retries it.`,
                'ERROR',
            );
            revertIssueDir(issueDir(item.year, item.issue));
            continue;
        }
        // Written only now, so a folder with metadata is always a finished issue.
        writeIssueMetadata(item.year, item.issue, item.date);
        if (fs.existsSync(item.pdfPath)) fs.unlinkSync(item.pdfPath);
        log(`Issue ${item.year}/${item.issue} saved (JSON + MD)`, 'OK');
    }

    if (failures.length) {
        log(`Finished with ${failures.length} failed issue(s): ${failures.join(', ')}`, 'ERROR');
        process.exitCode = 1;
    }
}

if (isMain(import.meta.url)) {
    run().catch((e) => {
        console.error('[download-latest-gazette]', e.message || e);
        process.exit(1);
    });
}
