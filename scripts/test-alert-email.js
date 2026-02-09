// Sends one test alert to ALERT_EMAIL using Resend from .env.
// Run: node scripts/test-alert-email.js   or  npm run test-alert-email
// Logs to logs/ only when alert emails are enabled (SEND_ALERT_EMAILS=true or NODE_ENV=production).
const { appendLog, shouldSendAlertEmail } = require('./logger');

if (shouldSendAlertEmail()) {
    appendLog('test-alert-email', 'This is a test alert. If you received this email, Resend is working.', 'ERROR');
    console.log('Test ERROR logged. Check your inbox at ALERT_EMAIL (and spam folder).');
} else {
    console.log('Alert emails are disabled. No log written, no email sent.');
}
