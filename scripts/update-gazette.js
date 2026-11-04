#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './lib/issues.js';

const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Each step inherits stdio, so a failing step has already printed why. The
// exit code is the only thing that has to travel back up.
//
// A step killed by a signal (out of memory, a job timeout) and a step that
// never started at all both leave status null — and process.exit(null) exits
// zero, which would report the run as green and let the workflow commit a
// half-updated site. Anything that is not a clean zero becomes a real failure.
function run(name, script, args = []) {
    console.log(`\n--- ${name} ---\n`);
    const result = spawnSync('node', [script, ...args], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
    });
    if (result.status === 0) return 0;
    const why = result.error
        ? result.error.message
        : result.signal
          ? `killed by ${result.signal}`
          : `exit ${result.status}`;
    console.error(`\n[update-gazette] ${name} failed (${why}).`);
    return result.status || 1;
}

// The download step also summarizes each issue it fetches. A step marked
// keepGoing fails the run without stopping it. A failed issue reverts its own
// folder, so whatever is on disk afterwards is complete and still worth
// building and committing; the gap check only reports.
const STEPS = [
    ['Download and summarize new issues', 'download-latest-gazette.js', { keepGoing: true }],
    ['Build gazette catalog', 'build-gazette-catalog.js'],
    ['Build issue pages', 'build-issue-pages.js'],
    ['Check for missing issues', 'check-issue-gaps.js', { keepGoing: true }],
];

function main() {
    let failed = 0;
    STEPS.forEach(([name, script, { keepGoing = false } = {}], i) => {
        console.log(`${i ? '\n' : ''}[update-gazette] ${i + 1}. ${name}`);
        const code = run(name, path.join(SCRIPTS_DIR, script));
        if (code === 0) return;
        if (!keepGoing) process.exit(code);
        failed = failed || code;
    });
    if (failed) {
        console.error('\n[update-gazette] Finished with failures (see above). Complete issues were still built.\n');
        process.exit(failed);
    }
    console.log('\n[update-gazette] Done. New issue(s) are in issues/ and the site is built in dist/.\n');
}

try {
    main();
} catch (e) {
    console.error('[update-gazette]', e);
    process.exit(1);
}
