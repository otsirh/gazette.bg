import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { appendLog, flushAlertEmail } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const SCRIPT_NAME = 'download-latest-gazette';
const HEADLESS = process.env.HEADLESS !== 'false';
const STEP_TIMEOUT_MS = 30000;
const TEMP_PDF_NAME = '.tmp.pdf';

function log(message, level = 'INFO') {
    appendLog(SCRIPT_NAME, message, level);
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

function alreadyHaveIssue(issue, year) {
    const issueDir = getIssueDir(issue, year);
    return (
        fs.existsSync(path.join(issueDir, `${issue}.md`)) ||
        fs.existsSync(path.join(issueDir, `${issue}.json`))
    );
}

function parseDateFromRowText(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/Брой\s*\d+,\s*([\d.]+\s*г\.)/);
    return m ? m[1].trim() : null;
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

async function run() {
    log('Run started', 'INFO');

    let browser;
    let issueDir;
    let downloaded = false;

    try {
        browser = await chromium.launch({ headless: HEADLESS });
        const page = await browser.newPage();

        try {
            await page.goto('https://dv.parliament.bg/DVWeb/broeveList.faces', {
                waitUntil: 'domcontentloaded',
                timeout: STEP_TIMEOUT_MS,
            });
        } catch (e) {
            throw new Error('List page did not load (site down or URL changed?): ' + e.message);
        }

        const firstDownloadLink = page.getByRole('link', { name: 'Изтегли броя' }).first();
        try {
            await firstDownloadLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        } catch {
            throw new Error("'Изтегли броя' link not found – page layout may have changed.");
        }

        const downloadRowDateCell = firstDownloadLink.locator('xpath=../..').locator('.td_tabResult0').first();
        const downloadRowText = await downloadRowDateCell.textContent().catch(() => null);
        const downloadRowDate = parseDateFromRowText(downloadRowText || '');

        await firstDownloadLink.click();

        const modal = page.locator('.modal_win');
        try {
            await modal.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        } catch {
            throw new Error('Download modal did not appear – site flow may have changed.');
        }
        const firstPdfLink = page.locator('.modal_win a[href*="fileUploadShowing"]').first();

        const linkText = await firstPdfLink.textContent();
        const rawFilename = (linkText || '').trim();
        const parsed = parseDvFilename(rawFilename);

        if (!parsed) {
            throw new Error('Could not parse PDF filename from link text. Got: ' + JSON.stringify(rawFilename));
        }

        const { issue, year } = parsed;

        if (alreadyHaveIssue(issue, year)) {
            const msg = `Already have issue ${year}/${issue} in issues/ – skipping`;
            log(msg, 'OK');
            console.log(msg);
            return;
        }

        issueDir = getIssueDir(issue, year);
        const tempPdfPath = getTempPdfPath(issue, year);
        fs.mkdirSync(issueDir, { recursive: true });

        let pdfDownload;
        try {
            [pdfDownload] = await Promise.all([
                page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
                firstPdfLink.click(),
            ]);
        } catch (e) {
            throw new Error('PDF download did not start or timed out – link or server may have changed: ' + (e && e.message));
        }

        await pdfDownload.saveAs(tempPdfPath);
        downloaded = true;
        log('PDF downloaded to temp', 'INFO');

        // Close the browser before kicking off the long-running summarize step.
        await browser.close().catch(() => {});
        browser = undefined;

        if (downloadRowDate) {
            writeIssueMetadata(issue, year, toBulgarianDateFormat(downloadRowDate));
        }

        const summarizeScript = path.join(__dirname, 'summarize-gazette.js');
        const result = spawnSync('node', [summarizeScript, String(year), String(issue), tempPdfPath], {
            cwd: ROOT,
            stdio: 'inherit',
            shell: false,
        });

        if (result.status !== 0) {
            revertIssueDir(issueDir);
            issueDir = undefined;
            throw new Error('Summarize failed (exit ' + result.status + '). Issue folder reverted.');
        }

        if (fs.existsSync(tempPdfPath)) {
            fs.unlinkSync(tempPdfPath);
            log('Removed temp PDF', 'INFO');
        }
        log('Issue ' + year + '/' + issue + ' saved (JSON + MD only)', 'OK');
        console.log('Issue ' + year + '/' + issue + ' saved to issues/ (JSON + MD only).');
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (downloaded === false && issueDir) {
            // Failed before PDF was saved — nothing to keep.
            revertIssueDir(issueDir);
        }
    }
}

run().catch(async (e) => {
    log(e.message || String(e), 'ERROR');
    console.error('[download-latest-gazette]', e.message || e);
    await flushAlertEmail();
    process.exit(1);
});
