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

function fail(message, cause) {
    log(message, 'ERROR');
    if (cause) log(String(cause), 'ERROR');
    console.error('[download-latest-gazette]', message);
    if (cause) console.error(cause);
    flushAlertEmail().then(() => process.exit(1));
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
    return path.join(getIssueDir(issue, year), `${issue}.json`);
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

(async () => {
    let browser;
    log('Run started', 'INFO');

    try {
        browser = await chromium.launch({ headless: HEADLESS });
        const page = await browser.newPage();

        await page.goto('https://dv.parliament.bg/DVWeb/broeveList.faces', {
            waitUntil: 'domcontentloaded',
            timeout: STEP_TIMEOUT_MS,
        }).catch(async (e) => {
            if (browser) await browser.close().catch(() => {});
            fail('List page did not load (site down or URL changed?).', e.message);
        });

        const firstDownloadLink = page.getByRole('link', { name: 'Изтегли броя' }).first();
        await firstDownloadLink.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(async () => {
            if (browser) await browser.close().catch(() => {});
            fail("'Изтегли броя' link not found – page layout may have changed.");
        });

        const downloadRowDateCell = firstDownloadLink.locator('xpath=../..').locator('.td_tabResult0').first();
        const downloadRowText = await downloadRowDateCell.textContent().catch(() => null);
        const downloadRowDate = parseDateFromRowText(downloadRowText || '');

        await firstDownloadLink.click();

        const modal = page.locator('.modal_win');
        await modal.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(async () => {
            if (browser) await browser.close().catch(() => {});
            fail('Download modal did not appear – site flow may have changed.');
        });
        const firstPdfLink = page.locator('.modal_win a[href*="fileUploadShowing"]').first();

        const linkText = await firstPdfLink.textContent();
        const rawFilename = (linkText || '').trim();
        const parsed = parseDvFilename(rawFilename);

        if (!parsed) {
            await browser.close().catch(() => {});
            fail('Could not parse PDF filename from link text. Got: ' + JSON.stringify(rawFilename));
        }

        const { issue, year } = parsed;

        if (alreadyHaveIssue(issue, year)) {
            const msg = `Already have issue ${year}/${issue} in issues/ – skipping`;
            log(msg, 'OK');
            console.log(msg);
            await browser.close();
            return;
        }

        const issueDir = getIssueDir(issue, year);
        const tempPdfPath = getTempPdfPath(issue, year);
        fs.mkdirSync(issueDir, { recursive: true });

        try {
            const [pdfDownload] = await Promise.all([
                page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
                firstPdfLink.click(),
            ]).catch(async (e) => {
                if (browser) await browser.close().catch(() => {});
                throw new Error('PDF download did not start or timed out – link or server may have changed. ' + (e && e.message));
            });

            await pdfDownload.saveAs(tempPdfPath);
            await browser.close();
            log('PDF downloaded to temp', 'INFO');

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
                fail('Summarize failed (exit ' + result.status + '). Issue folder reverted.');
            }

            if (fs.existsSync(tempPdfPath)) {
                fs.unlinkSync(tempPdfPath);
                log('Removed temp PDF', 'INFO');
            }
            log('Issue ' + year + '/' + issue + ' saved (JSON + MD only)', 'OK');
            console.log('Issue ' + year + '/' + issue + ' saved to issues/ (JSON + MD only).');
        } catch (e) {
            await browser.close().catch(() => {});
            revertIssueDir(issueDir);
            fail(e.message || 'Unexpected error.', e);
        }
    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        fail('Unexpected error.', e.message || e);
    }
})().catch((e) => {
    log('Unhandled error: ' + (e && (e.message || e)), 'ERROR');
    console.error('[download-latest-gazette] Unhandled error:', e);
    flushAlertEmail().then(() => process.exit(1));
});
