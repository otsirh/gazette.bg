#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { formatDateBulgarian } from '../src/js/shared.js';
import { createLogger, isMain } from './lib/cli.js';
import { ATTEMPTS_PATH, hasSummary, issueDir, metadataPath, ROOT, tempPdfPath } from './lib/issues.js';
import { createClient, summarizeIssue } from './summarize-gazette.js';

const DIAGNOSTICS_DIR = path.join(ROOT, 'diagnostics');
const HEADLESS = process.env.HEADLESS !== 'false';
const STEP_TIMEOUT_MS = 30000;
const LIST_URL = 'https://dv.parliament.bg/DVWeb/broeveList.faces';
// dv.parliament.bg answers only Bulgarian addresses, and GitHub's runners are
// not, so in CI the browser goes out through a SOCKS proxy that ends at a
// Mac mini in Bulgaria (see update-gazette.yml). Run from Bulgaria, leave it unset.
const PROXY = process.env.DV_PROXY;
// A dense issue takes up to ~25 minutes to read, write up and check, and the
// job gets 90. Anything beyond this waits for the next run — it stays on the
// list's first page (the ten newest issues) for weeks.
const MAX_ISSUES_PER_RUN = 2;
// Every failed summary is paid for (a few dollars on Opus), and a failure that
// repeats would be paid for twice a day. After this many, the issue waits for
// a person: the run stays red until its line in the attempts file is removed.
const MAX_SUMMARY_ATTEMPTS = 3;
// The job is killed at 90 minutes. No issue is started after this, so the one
// in hand can finish and the run can still commit; the rest wait a few hours.
const START_NO_SUMMARY_AFTER_MS = 45 * 60 * 1000;
// One request to the API may take long on a dense issue, but not forever.
const API_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
// A slow moment on dv.parliament.bg, or on the home connection the proxy goes
// out through, must not hold an issue back a whole day. Waits grow: 30s, then 60s.
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

// Failed summaries per issue, "2026/101": 2. Kept in the repo, so every run
// sees the count the last one left.
export function readAttempts(file = ATTEMPTS_PATH) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function writeAttempts(attempts, file = ATTEMPTS_PATH) {
    if (Object.keys(attempts).length) fs.writeFileSync(file, `${JSON.stringify(attempts, null, 4)}\n`, 'utf8');
    else if (fs.existsSync(file)) fs.rmSync(file);
}

// One act of the official contents: who issued it, its title, the page it
// starts on ("стр. 7  Преглед на материала") and the link to its own page
// (showMaterialDV.jsp?idMat=247203).
export function parseMaterialRow({ issuer, title, pageText, href }) {
    const page = (pageText || '').match(/стр\.\s*(\d+)/);
    const id = (href || '').match(/idMat=(\d+)/);
    if (!page || !id) return null;
    const clean = (s) =>
        String(s || '')
            .replace(/\s+/g, ' ')
            .trim();
    return { page: Number(page[1]), id: Number(id[1]), issuer: clean(issuer), title: clean(title) };
}

// What the site knows about an issue besides its summary: the publication
// date, the official PDF, and the acts of the official section, each with its
// own page on dv.parliament.bg for the links under the summary's sections.
function writeIssueMetadata(year, issue, meta) {
    if (!meta.date) return;
    const metaPath = metadataPath(year, issue);
    const out = { date: meta.date };
    if (meta.pdfUrl) out.pdfUrl = meta.pdfUrl;
    if (meta.materials?.length) out.materials = meta.materials;
    try {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        fs.writeFileSync(metaPath, `${JSON.stringify(out, null, 4)}\n`, 'utf8');
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
// opens its files and its table row. Loads the list afresh, so the links are
// good until the page next navigates.
export async function listIssues(page) {
    try {
        await gotoWithRetry(page, LIST_URL);
    } catch (e) {
        throw new Error(
            `List page did not load after ${LIST_LOAD_ATTEMPTS} attempts (site down, URL changed, or not reached from a Bulgarian address?): ${e.message}`,
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
        const tr = link.locator('xpath=../..');
        const text = await tr
            .locator('.td_tabResult0')
            .first()
            .textContent()
            .catch(() => null);
        const row = parseIssueRow(text);
        if (row) rows.push({ ...row, link, tr });
    }
    if (!rows.length) {
        await saveDiagnostics(page, 'list-rows-unreadable');
        throw new Error('Found download links but could not read any issue number from their rows.');
    }
    return rows;
}

// Saves the issue's PDF to destPath and returns the official link to it,
// which opens without a session.
export async function downloadIssuePdf(page, target, destPath) {
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
    const href = await pdfLink.getAttribute('href').catch(() => null);
    return href ? new URL(href, page.url()).href : null;
}

// The official section's contents: each act with the page it starts on and
// the id of its page on dv.parliament.bg. An issue without an official section
// (only announcements) has none, so an empty list is an answer, not an error.
export async function readOfficialContents(page, target) {
    const row = (await listIssues(page)).find((r) => r.issue === target.issue && r.year === target.year);
    if (!row) throw new Error('Issue is no longer on the first page of the list.');
    const contentsLink = row.tr.getByRole('link', { name: 'Съдържание на официалния раздел' });
    if (!(await contentsLink.count())) return [];
    await contentsLink.first().click();
    const materialLinks = page.locator('a[href*="showMaterialDV"]');
    try {
        await materialLinks.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        // The list can still be arriving when its first link shows.
        await page.waitForLoadState('load', { timeout: STEP_TIMEOUT_MS });
    } catch {
        log(`No acts listed for ${target.year}/${target.issue}; summary sections will point at the PDF.`, 'WARN');
        return [];
    }
    // Each act is one cell: <strong>issuer</strong><br>title<br><table>стр. N
    // and the link</table>. The title is the text between the two.
    const rows = await materialLinks.evaluateAll((as) =>
        as.map((a) => {
            const inner = a.closest('table');
            const cell = inner?.closest('td');
            let title = '';
            for (const node of cell ? cell.childNodes : []) {
                if (node === inner) break;
                if (node.nodeType === Node.TEXT_NODE) title += node.textContent;
            }
            return {
                issuer: cell?.querySelector('strong')?.textContent || '',
                title,
                pageText: a.closest('td')?.textContent || '',
                href: a.getAttribute('href') || '',
            };
        }),
    );
    // In the site's order, which is the order of the pages; the summary refers
    // to the acts by their place in this list.
    return rows.map(parseMaterialRow).filter(Boolean);
}

// Fetch every issue on the list's first page that is not on the site yet,
// oldest first. Taking only the newest would lose an issue for good whenever
// two land between runs, or one fails and a newer one comes out before the
// retry. A failed issue is reverted and retried next run; the others still go
// through.
async function run() {
    const startedAt = Date.now();
    log('Run started');

    const failures = [];
    const downloaded = [];
    const browser = await chromium.launch({ headless: HEADLESS, proxy: PROXY ? { server: PROXY } : undefined });
    try {
        const page = await browser.newPage();
        const attempts = readAttempts();
        const missing = (await listIssues(page))
            .filter((r) => !hasSummary(r.year, r.issue))
            .filter((r) => {
                const tries = attempts[`${r.year}/${r.issue}`] ?? 0;
                if (tries < MAX_SUMMARY_ATTEMPTS) return true;
                failures.push(`${r.year}/${r.issue}`);
                log(
                    `${r.year}/${r.issue} failed ${tries} times and is not retried. Remove its line from ${path.relative(ROOT, ATTEMPTS_PATH)} to try again.`,
                    'ERROR',
                );
                return false;
            })
            .sort((a, b) => a.year - b.year || a.issue - b.issue);

        if (!missing.length) {
            // An issue that is not retried still has to turn the run red.
            if (failures.length) process.exitCode = 1;
            else log('Up to date – every issue on the list is already in issues/.', 'OK');
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
                const pdfUrl = await downloadIssuePdf(page, target, pdfPath);
                // The contents only add links; an issue is not lost over them.
                const materials = await readOfficialContents(page, target).catch((e) => {
                    log(`Contents of ${target.year}/${target.issue} not read: ${e.message}`, 'WARN');
                    return [];
                });
                downloaded.push({ ...target, pdfPath, pdfUrl, materials });
                log(`Downloaded ${target.year}/${target.issue} (${materials.length} acts listed)`);
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
        const key = `${item.year}/${item.issue}`;
        if (Date.now() - startedAt > START_NO_SUMMARY_AFTER_MS) {
            log(`${key} waits for the next run: this one is close to its time limit.`, 'WARN');
            revertIssueDir(issueDir(item.year, item.issue));
            continue;
        }
        // Counted before the paid work starts, so a run killed halfway through
        // still counts it (the workflow commits even after a timeout).
        const attempts = readAttempts();
        attempts[key] = (attempts[key] ?? 0) + 1;
        writeAttempts(attempts);
        try {
            client ??= createClient({ timeout: API_REQUEST_TIMEOUT_MS });
            await summarizeIssue(item.year, item.issue, item.pdfPath, { client, materials: item.materials });
        } catch (e) {
            failures.push(key);
            log(
                `Summarize failed for ${item.year}/${item.issue}: ${e.message}. Issue folder reverted; the next run retries it.`,
                'ERROR',
            );
            revertIssueDir(issueDir(item.year, item.issue));
            continue;
        }
        // Written only now, so a folder with metadata is always a finished issue.
        writeIssueMetadata(item.year, item.issue, {
            date: item.date,
            pdfUrl: item.pdfUrl,
            materials: item.materials,
        });
        if (fs.existsSync(item.pdfPath)) fs.unlinkSync(item.pdfPath);
        const after = readAttempts();
        if (key in after) {
            delete after[key];
            writeAttempts(after);
        }
        log(`Issue ${key} saved (JSON + MD)`, 'OK');
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
