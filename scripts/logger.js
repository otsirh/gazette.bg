/**
 * Failure-only alerts: no file logging. Sends one email per failing run to ALERT_EMAIL via Resend
 * when any script logs an ERROR. Set RESEND_API_KEY + ALERT_EMAIL. From address defaults to
 * onboarding@resend.dev; set ALERT_FROM for a verified domain.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MAX_BUFFER_LINES = 30;
const logBuffer = [];

let alertEmailSentThisProcess = false;
let alertSendPromise = null;

function getLastLogLines(maxLines = MAX_BUFFER_LINES) {
    return logBuffer.slice(-maxLines).join('\n') || '(none)';
}

/**
 * Send one alert email per process when an ERROR is logged. Requires ALERT_EMAIL + RESEND_API_KEY.
 * Fire-and-forget; errors are swallowed.
 */
function sendAlertOnce(scriptName, message) {
    const to = process.env.ALERT_EMAIL && process.env.ALERT_EMAIL.trim();
    const resendKey = process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim();
    if (!to || !resendKey || alertEmailSentThisProcess) return;
    alertEmailSentThisProcess = true;

    const iso = new Date().toISOString();
    const subject = `[gazette.bg] FAILED: ${scriptName}`;
    const logSnippet = getLastLogLines(MAX_BUFFER_LINES);
    const body = [
        `Script: ${scriptName}`,
        `Time: ${iso}`,
        `Error: ${message}`,
        '',
        '--- Recent context ---',
        logSnippet,
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
 * Record a message for context; if level is ERROR and ALERT_EMAIL + RESEND_API_KEY are set,
 * send one email per process. No file logging — emails only on failure.
 * @param {string} scriptName - e.g. 'download-latest-gazette'
 * @param {string} message - log message
 * @param {string} level - 'INFO' | 'OK' | 'WARN' | 'ERROR'
 */
function appendLog(scriptName, message, level = 'INFO') {
    const iso = new Date().toISOString();
    const line = `[${iso}] [${scriptName}] ${level}: ${message}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_BUFFER_LINES * 2) logBuffer.splice(0, logBuffer.length - MAX_BUFFER_LINES);
    if (level === 'ERROR') sendAlertOnce(scriptName, message);
}

export { appendLog, flushAlertEmail };
