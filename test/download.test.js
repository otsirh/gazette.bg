import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gotoWithRetry, parseDvFilename, parseIssueRow } from '../scripts/download-latest-gazette.js';
import { issueDir, metadataPath, summaryPath } from '../scripts/lib/issues.js';

test('a row of the dv.parliament.bg list gives the issue, year and date', () => {
    assert.deepEqual(parseIssueRow('Брой 90, 30.9.2026 г. (извънреден)'), {
        issue: 90,
        year: 2026,
        date: '30 Септември 2026',
    });
    assert.deepEqual(parseIssueRow('Брой 7,  6.1.2027 г.'), { issue: 7, year: 2027, date: '6 Януари 2027' });
    assert.equal(parseIssueRow('Изтегли броя'), null);
    assert.equal(parseIssueRow(null), null);
});

test('the PDF link name identifies the issue', () => {
    assert.deepEqual(parseDvFilename('97_26.pdf'), { issue: 97, year: 2026 });
    assert.deepEqual(parseDvFilename('5_27.PDF'), { issue: 5, year: 2027 });
    assert.equal(parseDvFilename('97_26.rtf'), null);
});

test('issue folders are zero-padded, files are not', () => {
    assert.match(issueDir(2026, 7), /issues\/2026\/07$/);
    assert.match(issueDir(2026, '07'), /issues\/2026\/07$/);
    assert.match(issueDir(2026, 104), /issues\/2026\/104$/);
    assert.match(summaryPath(2026, '07'), /issues\/2026\/07\/7\.md$/);
    assert.match(metadataPath(2026, 7), /issues\/2026\/07\/7\.json$/);
});

// A page whose goto times out the first `failures` times, then loads.
function flakyPage(failures) {
    const page = { calls: 0 };
    page.goto = async () => {
        page.calls++;
        if (page.calls <= failures) throw new Error('page.goto: Timeout 30000ms exceeded.\nCall log: …');
        return 'loaded';
    };
    return page;
}

test('a list page that hangs is tried again', async () => {
    const page = flakyPage(2);
    assert.equal(await gotoWithRetry(page, 'https://example.test', { attempts: 3, delayMs: 0 }), 'loaded');
    assert.equal(page.calls, 3);
});

test('a list page that never loads fails with the last error', async () => {
    const page = flakyPage(Infinity);
    await assert.rejects(gotoWithRetry(page, 'https://example.test', { attempts: 3, delayMs: 0 }), /Timeout 30000ms/);
    assert.equal(page.calls, 3);
});
