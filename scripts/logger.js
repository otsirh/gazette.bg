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

function sendAlertOnce(scriptName, message) {
    if (process.env.SEND_ALERT_EMAILS !== 'true') return;
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
    alertSendPromise = resend.emails.send({ from, to, subject, text: body }).catch((e) => {
        console.error('[logger] alert email send failed:', e && (e.message || e));
    });
}

function flushAlertEmail() {
    return alertSendPromise ? alertSendPromise : Promise.resolve();
}

function appendLog(scriptName, message, level = 'INFO') {
    const iso = new Date().toISOString();
    const line = `[${iso}] [${scriptName}] ${level}: ${message}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_BUFFER_LINES * 2) logBuffer.splice(0, logBuffer.length - MAX_BUFFER_LINES);
    if (level === 'ERROR') sendAlertOnce(scriptName, message);
}

export { appendLog, flushAlertEmail };
