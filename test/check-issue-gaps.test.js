import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findGaps } from '../scripts/check-issue-gaps.js';

function issuesTree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gazette-gaps-'));
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), '');
    }
    return dir;
}

test('a hole in the numbering is reported', () => {
    const dir = issuesTree(['2026/01/1.md', '2026/02/2.md', '2026/04/4.md', '2027/01/1.md']);
    assert.deepEqual(findGaps(dir), ['2026/3']);
});

test('metadata without a summary is still a gap', () => {
    const dir = issuesTree(['2026/01/1.md', '2026/02/2.json', '2026/03/3.md']);
    assert.deepEqual(findGaps(dir), ['2026/2']);
});

test('a complete run, or no issues at all, has no gaps', () => {
    assert.deepEqual(findGaps(issuesTree(['2026/01/1.md', '2026/02/2.md'])), []);
    assert.deepEqual(findGaps(path.join(os.tmpdir(), 'gazette-no-such-dir')), []);
});
