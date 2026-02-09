// Downloads the first issue PDF from DV (https://dv.parliament.bg) to ./official-gazettes.
// For cron/server: runs headless by default. Set HEADLESS=false to show the browser locally.
// Skips download if the file already exists.
// On failure exits with code 1 and prints a clear error (so cron can email you).
// All runs (success and failure) are appended to logs/yyyy-MM-dd.log (one file per date).
//
// Email on failure (pick one or both):
//   - Cron: add MAILTO=your@email.com to crontab; cron emails when the job exits non-zero.
//   - In-app: set ALERT_EMAIL and RESEND_API_KEY in .env; see scripts/logger.js and .env.example.
//
// Server/cron setup:
//   npx playwright install chromium
//   (optional) npx playwright install-deps chromium
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const { appendLog } = require('./logger');

const ROOT = path.join(__dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT, 'official-gazettes');
const ISSUES_DIR = path.join(ROOT, 'issues');
const SCRIPT_NAME = 'download-latest-gazette';
const HEADLESS = process.env.HEADLESS !== 'false';
const STEP_TIMEOUT_MS = 30000;

function log(message, level = 'INFO') {
    appendLog(SCRIPT_NAME, message, level);
}

function fail(message, cause) {
    log(message, 'ERROR');
    if (cause) log(String(cause), 'ERROR');
    console.error('[download-latest-gazette]', message);
    if (cause) console.error(cause);
    process.exit(1);
}

// Parse "12_26.pdf" (issue 12, year 2026) → { issue: 12, year: 2026 }
function parseDvFilename(filename) {
    const match = (filename || '').match(/^(\d+)_(\d{2})\.pdf$/i);
    if (!match) return null;
    const issue = match[1];
    const shortYear = parseInt(match[2], 10);
    const year = shortYear >= 0 && shortYear <= 99 ? 2000 + shortYear : shortYear;
    return { issue, year };
}

// Build path: official-gazettes/YEAR/issue.pdf (e.g. official-gazettes/2026/12.pdf)
function getSavePath(issue, year) {
    const yearDir = path.join(DOWNLOAD_DIR, String(year));
    return path.join(yearDir, `${issue}.pdf`);
}

// Metadata path: official-gazettes/YEAR/issue.json stores { date: "30.1.2026 г." }
function getMetadataPath(issue, year) {
    const yearDir = path.join(DOWNLOAD_DIR, String(year));
    return path.join(yearDir, `${issue}.json`);
}

// True if we already have this issue in issues/YEAR/XX/ (summary or metadata).
function alreadyHaveIssue(issue, year) {
    const pad = String(issue).padStart(2, '0');
    const issueDir = path.join(ISSUES_DIR, String(year), pad);
    return (
        fs.existsSync(path.join(issueDir, `${issue}.md`)) ||
        fs.existsSync(path.join(issueDir, `${issue}.json`))
    );
}

// Parse date from first row .td_tabResult0 text, e.g. "Брой 12, 30.1.2026 г." -> "30.1.2026 г."
function parseDateFromRowText(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/Брой\s*\d+,\s*([\d.]+\s*г\.)/);
    return m ? m[1].trim() : null;
}

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];

// Convert "30.1.2026 г." to "30 януари 2026 г."
function toBulgarianDateFormat(str) {
    if (!str || typeof str !== 'string') return str;
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г\.$/);
    if (!m) return str;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = m[3];
    if (month < 1 || month > 12) return str;
    return `${day} ${BG_MONTHS[month - 1]} ${year} г.`;
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
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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

        const firstRowText = await page.locator('.td_tabResult0').first().textContent().catch(() => null);
        const firstRowDate = parseDateFromRowText(firstRowText || '');

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
        const savePath = getSavePath(issue, year);

        if (alreadyHaveIssue(issue, year)) {
            const msg = `Already have issue ${year}/${issue} in issues/ – skipping download`;
            log(msg, 'OK');
            console.log(msg);
            await browser.close();
            return;
        }
        if (fs.existsSync(savePath)) {
            const metaPath = getMetadataPath(issue, year);
            if (!fs.existsSync(metaPath) && firstRowDate) {
                writeIssueMetadata(issue, year, toBulgarianDateFormat(firstRowDate));
                console.log('Wrote missing metadata:', metaPath);
            }
            const msg = `Already have ${year}/${issue}.pdf – skipping download`;
            log(msg, 'OK');
            console.log(msg);
            await browser.close();
            return;
        }

        fs.mkdirSync(path.join(DOWNLOAD_DIR, String(year)), { recursive: true });

        const [pdfDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
            firstPdfLink.click(),
        ]).catch(async (e) => {
            if (browser) await browser.close().catch(() => {});
            fail('PDF download did not start or timed out – link or server may have changed.', e.message);
        });

        await pdfDownload.saveAs(savePath);
        if (firstRowDate) writeIssueMetadata(issue, year, toBulgarianDateFormat(firstRowDate));
        log('PDF saved to ' + savePath, 'OK');
        console.log('PDF saved to:', savePath);
        await browser.close();
    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        fail('Unexpected error.', e.message || e);
    }
})().catch((e) => {
    log('Unhandled error: ' + (e && (e.message || e)), 'ERROR');
    console.error('[download-latest-gazette] Unhandled error:', e);
    process.exit(1);
});
