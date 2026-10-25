// Where an issue lives on disk. Every issue has a folder named after its
// number, zero-padded to two digits (issues/2026/07/), holding the summary and
// the scraped metadata, each named after the plain number (7.md, 7.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ISSUES_DIR = path.join(ROOT, 'issues');
// The PDF waits here while it is summarized; *.tmp.pdf is gitignored.
export const TEMP_PDF_NAME = '.tmp.pdf';

export function issueDir(year, issue, issuesDir = ISSUES_DIR) {
    return path.join(issuesDir, String(year), String(Number(issue)).padStart(2, '0'));
}

export function summaryPath(year, issue, issuesDir = ISSUES_DIR) {
    return path.join(issueDir(year, issue, issuesDir), `${Number(issue)}.md`);
}

export function metadataPath(year, issue, issuesDir = ISSUES_DIR) {
    return path.join(issueDir(year, issue, issuesDir), `${Number(issue)}.json`);
}

export function tempPdfPath(year, issue, issuesDir = ISSUES_DIR) {
    return path.join(issueDir(year, issue, issuesDir), TEMP_PDF_NAME);
}

// An issue is published once its summary exists. The JSON alone does not
// count: a run killed mid-summary must not mark the issue as done.
export function hasSummary(year, issue, issuesDir = ISSUES_DIR) {
    return fs.existsSync(summaryPath(year, issue, issuesDir));
}
