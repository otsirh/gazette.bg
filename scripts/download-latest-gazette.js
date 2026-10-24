import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const DIAGNOSTICS_DIR = path.join(ROOT, 'diagnostics');
const SCRIPT_NAME = 'download-latest-gazette';
const HEADLESS = process.env.HEADLESS !== 'false';
const STEP_TIMEOUT_MS = 30000;
const TEMP_PDF_NAME = '.tmp.pdf';
const LIST_URL = 'https://dv.parliament.bg/DVWeb/broeveList.faces';
// A dense issue takes ~10 minutes to summarize and the job gets 60. Anything
// beyond this waits for the next run — it stays on the list's first page
// (the ten newest issues) for weeks.
const MAX_ISSUES_PER_RUN = 3;

function log(message, level = 'INFO') {
    const line = `[${SCRIPT_NAME}] ${level}: ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function parseDvFilename(filename) {
    const match = (filename || '').match(/^(\d+)_(\d{2})\.pdf$/i);
    if (!match) return null;
    const issue = match[1];
    const shortYear = parseInt(match[2], 10);
    const year = shortYear >= 0 && shortYear <= 99 ? 2000 + shortYear : shortYear;
    return { issue, year };
}

function getIssueDir(issue, year) {
    const pad = String(issue).padStart(2, '0');
    return path.join(ISSUES_DIR, String(year), pad);
}

function getTempPdfPath(issue, year) {
    return path.join(getIssueDir(issue, year), TEMP_PDF_NAME);
}

function getMetadataPath(issue, year) {
    // Match the summarizer's convention (`${Number(issue)}.json`) so the two
    // never write to two different files for the same issue.
    return path.join(getIssueDir(issue, year), `${Number(issue)}.json`);
}

function revertIssueDir(issueDir) {
    if (fs.existsSync(issueDir)) {
        fs.rmSync(issueDir, { recursive: true });
        log('Reverted (removed) ' + issueDir, 'WARN');
    }
}

// An issue is published once its summary exists. Every file on disk is named
// after the plain number, so ask about `7.md`, not `07.md`. The JSON alone
// does not count: a run killed mid-summary must not mark the issue as done.
function alreadyHaveIssue(issue, year) {
    return fs.existsSync(path.join(getIssueDir(issue, year), `${Number(issue)}.md`));
}

// A row of the issue list reads "Брой 90, 30.9.2026 г. (извънреден) …".
function parseIssueRow(text) {
    const m = (text || '').match(/Брой\s*(\d+),\s*(\d{1,2}\.\d{1,2}\.(\d{4})\s*г\.)/);
    return m ? { issue: Number(m[1]), year: Number(m[3]), date: toBulgarianDateFormat(m[2]) } : null;
}

const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

function toBulgarianDateFormat(str) {
    if (!str || typeof str !== 'string') return str;
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г\.?$/);
    if (!m) return str;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = m[3];
    if (month < 1 || month > 12) return str;
    return `${day} ${BG_MONTHS_CAP[month - 1]} ${year}`;
}

function writeIssueMetadata(issue, year, date) {
    if (!date) return;
    const metaPath = getMetadataPath(issue, year);
    try {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify({ date }, null, 4), 'utf8');
    } catch (e) {
        log('Failed to write metadata ' + metaPath + ': ' + e.message, 'WARN');
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
        log('Could not save diagnostics: ' + e.message, 'WARN');
    }
}

// Every issue on the list's first page, newest first, each with the link that
// opens its files. Loads the list afresh, so the links are good until the
// page next navigates.
async function listIssues(page) {
    try {
        await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
    } catch (e) {
        throw new Error('List page did not load (site down or URL changed?): ' + e.message);
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
        const text = await link.locator('xpath=../..').locator('.td_tabResult0').first().textContent().catch(() => null);
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
    const pdfLink = page.locator('a[href*="fileUploadShowing"]').filter({ hasText: /^\s*\d+_\d{2}\.pdf\s*$/i }).first();
    try {
        await pdfLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    } catch {
        await saveDiagnostics(page, `no-pdf-link-${target.year}-${target.issue}`);
        throw new Error("No PDF link appeared after clicking 'Изтегли броя' – site flow may have changed.");
    }

    const filename = ((await pdfLink.textContent()) || '').trim();
    const parsed = parseDvFilename(filename);
    if (!parsed || Number(parsed.issue) !== target.issue || parsed.year !== target.year) {
        throw new Error(`Expected the PDF of ${target.year}/${target.issue}, the link offers ${JSON.stringify(filename)}.`);
    }

    let download;
    try {
        [download] = await Promise.all([
            page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
            pdfLink.click(),
        ]);
    } catch (e) {
        await saveDiagnostics(page, `download-did-not-start-${target.year}-${target.issue}`);
        throw new Error('PDF download did not start or timed out – link or server may have changed: ' + (e && e.message));
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
    log('Run started', 'INFO');

    const failures = [];
    const downloaded = [];
    const browser = await chromium.launch({ headless: HEADLESS });
    try {
        const page = await browser.newPage();
        const missing = (await listIssues(page))
            .filter((r) => !alreadyHaveIssue(r.issue, r.year))
            .sort((a, b) => a.year - b.year || a.issue - b.issue);

        if (!missing.length) {
            log('Up to date – every issue on the list is already in issues/.', 'OK');
            return;
        }
        const batch = missing.slice(0, MAX_ISSUES_PER_RUN);
        log(`Missing: ${missing.map((r) => `${r.year}/${r.issue}`).join(', ')}` +
            (missing.length > batch.length ? ` – taking the oldest ${batch.length} this run` : ''), 'INFO');

        for (const target of batch) {
            const issueDir = getIssueDir(target.issue, target.year);
            const pdfPath = getTempPdfPath(target.issue, target.year);
            try {
                await downloadIssuePdf(page, target, pdfPath);
                downloaded.push({ ...target, issueDir, pdfPath });
                log(`Downloaded ${target.year}/${target.issue}`, 'INFO');
            } catch (e) {
                failures.push(`${target.year}/${target.issue}`);
                log(`Download of ${target.year}/${target.issue} failed: ${e.message}`, 'ERROR');
                revertIssueDir(issueDir);
            }
        }
    } finally {
        // Closed before the long-running summaries, which need no browser.
        await browser.close().catch(() => {});
    }

    for (const item of downloaded) {
        const result = spawnSync('node', [path.join(__dirname, 'summarize-gazette.js'), String(item.year), String(item.issue), item.pdfPath], {
            cwd: ROOT,
            stdio: 'inherit',
            shell: false,
        });
        if (result.status !== 0) {
            failures.push(`${item.year}/${item.issue}`);
            log(`Summarize failed for ${item.year}/${item.issue} (exit ${result.status ?? result.signal}). Issue folder reverted; the next run retries it.`, 'ERROR');
            revertIssueDir(item.issueDir);
            continue;
        }
        // Written only now, so a folder with metadata is always a finished issue.
        writeIssueMetadata(item.issue, item.year, item.date);
        if (fs.existsSync(item.pdfPath)) fs.unlinkSync(item.pdfPath);
        log(`Issue ${item.year}/${item.issue} saved (JSON + MD)`, 'OK');
    }

    if (failures.length) {
        log(`Finished with ${failures.length} failed issue(s): ${failures.join(', ')}`, 'ERROR');
        process.exitCode = 1;
    }
}

run().catch((e) => {
    console.error('[download-latest-gazette]', e.message || e);
    process.exit(1);
});
