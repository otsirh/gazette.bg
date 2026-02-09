/**
 * Shared logger: writes to one file per date in logs/ as yyyy-MM-dd.log.
 * Each line: [ISO timestamp] [scriptName] LEVEL: message
 * So you can see what broke and at what time, and grep by script name.
 *
 * Optional email on failure: one email per failing run to ALERT_EMAIL via Resend.
 * Set RESEND_API_KEY + ALERT_EMAIL. From address defaults to onboarding@resend.dev; set ALERT_FROM for a verified domain.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Resend } = require('resend');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');

let alertEmailSentThisProcess = false;
/** Pending send promise, so callers can await before process.exit. */
let alertSendPromise = null;

function dateStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getLogPath() {
    return path.join(LOG_DIR, `${dateStr()}.log`);
}

function getLastLogLines(maxLines = 30) {
    try {
        const p = getLogPath();
        if (!fs.existsSync(p)) return '';
        const content = fs.readFileSync(p, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        return lines.slice(-maxLines).join('\n');
    } catch (_) {
        return '';
    }
}

function shouldSendAlertEmail() {
    const v = process.env.SEND_ALERT_EMAILS && process.env.SEND_ALERT_EMAILS.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return process.env.NODE_ENV === 'production';
}

/**
 * Send one alert email per process when an ERROR is logged. Requires ALERT_EMAIL + RESEND_API_KEY.
 * Fire-and-forget; errors are swallowed.
 * Sent only when SEND_ALERT_EMAILS=true (or unset and NODE_ENV=production). Set SEND_ALERT_EMAILS=false to disable.
 */
function sendAlertOnce(scriptName, message) {
    if (!shouldSendAlertEmail()) {
        console.log('Alert email skipped (SEND_ALERT_EMAILS is not enabled / NODE_ENV is not "production").');
        return;
    }
    const to = process.env.ALERT_EMAIL && process.env.ALERT_EMAIL.trim();
    const resendKey = process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim();
    if (!to || !resendKey || alertEmailSentThisProcess) return;
    alertEmailSentThisProcess = true;

    const iso = new Date().toISOString();
    const subject = `[gazette.bg] FAILED: ${scriptName}`;
    const logSnippet = getLastLogLines(30);
    const body = [
        `Script: ${scriptName}`,
        `Time: ${iso}`,
        `Error: ${message}`,
        '',
        '--- Last log lines ---',
        logSnippet || '(none)',
    ].join('\n');

    const from = process.env.ALERT_FROM && process.env.ALERT_FROM.trim()
        ? process.env.ALERT_FROM
        : 'Gazette Alerts <onboarding@resend.dev>';
    const resend = new Resend(resendKey);
    alertSendPromise = resend.emails.send({ from, to, subject, text: body }).catch(() => {});
}

/**
 * Wait for the current alert email send to finish. Call this before process.exit(1)
 * so the email is sent before the process exits. Resolves immediately if no send was triggered.
 * @returns {Promise<void>}
 */
function flushAlertEmail() {
    return alertSendPromise ? alertSendPromise : Promise.resolve();
}

/**
 * Append a line to today's log file.
 * If level is ERROR and ALERT_EMAIL + RESEND_API_KEY are set, send one email per process.
 * @param {string} scriptName - e.g. 'download-latest-gazette'
 * @param {string} message - log message
 * @param {string} level - 'INFO' | 'OK' | 'WARN' | 'ERROR'
 */
function appendLog(scriptName, message, level = 'INFO') {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const iso = new Date().toISOString();
        const line = `[${iso}] [${scriptName}] ${level}: ${message}\n`;
        fs.appendFileSync(getLogPath(), line);
        if (level === 'ERROR') sendAlertOnce(scriptName, message);
    } catch (_) {}
}

module.exports = {
    LOG_DIR,
    getLogPath,
    dateStr,
    appendLog,
    shouldSendAlertEmail,
    flushAlertEmail,
};
