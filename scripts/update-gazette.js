#!/usr/bin/env node
/**
 * Full flow: download latest gazette → summarize new PDFs → rebuild gazette catalog (add new issue to website).
 * Each step runs only if the previous one succeeded (exit code 0).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { appendLog, flushAlertEmail } = require('./logger');

const SCRIPT_NAME = 'update-gazette';
const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

function run(name, script, args = []) {
    appendLog(SCRIPT_NAME, `Starting: ${name}`, 'INFO');
    console.log(`\n--- ${name} ---\n`);
    const result = spawnSync('node', [script, ...args], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
    });
    if (result.status !== 0) {
        appendLog(SCRIPT_NAME, `${name} failed (exit ${result.status})`, 'ERROR');
        console.error(`\n[update-gazette] ${name} failed (exit ${result.status}). Stopping.`);
        return result.status;
    }
    appendLog(SCRIPT_NAME, `Completed: ${name}`, 'OK');
    return 0;
}

async function main() {
    appendLog(SCRIPT_NAME, 'Full update started', 'INFO');
    console.log('[update-gazette] 1. Download latest gazette');
    let code = run('Download latest gazette', path.join(SCRIPTS_DIR, 'download-latest-gazette.js'));
    if (code !== 0) {
        await flushAlertEmail();
        process.exit(code);
    }

    console.log('\n[update-gazette] 2. Summarize any remaining PDFs in official-gazettes/ (optional)');
    code = run('Summarize gazette', path.join(SCRIPTS_DIR, 'summarize-gazette.js'));
    if (code !== 0) {
        await flushAlertEmail();
        process.exit(code);
    }

    console.log('\n[update-gazette] 3. Rebuild catalog (add new issue to website)');
    code = run('Build gazette catalog', path.join(SCRIPTS_DIR, 'build-gazette-catalog.js'));
    if (code !== 0) {
        await flushAlertEmail();
        process.exit(code);
    }

    appendLog(SCRIPT_NAME, 'Full update completed', 'OK');
    console.log('\n[update-gazette] Done. New issue(s) are in issues/ and the website catalog is updated.\n');
}

main().catch((e) => {
    console.error('[update-gazette]', e);
    process.exit(1);
});
