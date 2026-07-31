#!/usr/bin/env node
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Each step inherits stdio, so a failing step has already printed why. The
// exit code is the only thing that has to travel back up.
function run(name, script, args = []) {
    console.log(`\n--- ${name} ---\n`);
    const result = spawnSync('node', [script, ...args], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
    });
    if (result.status !== 0) {
        console.error(`\n[update-gazette] ${name} failed (exit ${result.status}). Stopping.`);
    }
    return result.status;
}

const STEPS = [
    ['Download latest gazette', 'download-latest-gazette.js'],
    ['Summarize gazette', 'summarize-gazette.js'],
    ['Build gazette catalog', 'build-gazette-catalog.js'],
    ['Build issue pages', 'build-issue-pages.js'],
];

function main() {
    STEPS.forEach(([name, script], i) => {
        console.log(`${i ? '\n' : ''}[update-gazette] ${i + 1}. ${name}`);
        const code = run(name, path.join(SCRIPTS_DIR, script));
        if (code !== 0) process.exit(code);
    });
    console.log('\n[update-gazette] Done. New issue(s) are in issues/ and the website catalog is updated.\n');
}

try {
    main();
} catch (e) {
    console.error('[update-gazette]', e);
    process.exit(1);
}
