#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const TEMP_PDF_NAME = '.tmp.pdf';
const SCRIPT_NAME = 'process-issue-pdf';

function log(message, level = 'INFO') {
    const line = `[${SCRIPT_NAME}] ${level}: ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

function getIssueDir(year, issue) {
    const pad = String(issue).padStart(2, '0');
    return path.join(ISSUES_DIR, String(year), pad);
}

function getPdfPath(year, issue) {
    return path.join(getIssueDir(year, issue), TEMP_PDF_NAME);
}

function getMdPath(year, issue) {
    return path.join(getIssueDir(year, issue), `${issue}.md`);
}

function getJsonPath(year, issue) {
    return path.join(getIssueDir(year, issue), `${issue}.json`);
}

async function main() {
    const yearArg = process.argv[2];
    const issueArg = process.argv[3];

    if (!yearArg || !issueArg || !/^\d{4}$/.test(yearArg) || !/^\d+$/.test(issueArg)) {
        console.log('Usage: node process-issue-pdf.js <year> <issue>');
        console.log('  e.g. node process-issue-pdf.js 2026 15');
        console.log(`  Expects ${TEMP_PDF_NAME} in issues/<year>/<zero-padded-issue>/`);
        process.exit(1);
    }

    const year = yearArg;
    const issueNum = Number(issueArg);
    const issue = String(issueNum);
    const pdfPath = getPdfPath(year, issueNum);
    const mdPath = getMdPath(year, issueNum);

    if (!fs.existsSync(pdfPath)) {
        console.log(`No PDF found at ${path.relative(ROOT, pdfPath)}. Add ${TEMP_PDF_NAME} and run again.`);
        process.exit(1);
    }

    if (fs.existsSync(mdPath)) {
        console.log(`Skip ${year}/${issue} (already have summary). Delete ${path.basename(mdPath)} to re-summarize.`);
        return;
    }

    log('Run started', 'INFO');
    console.log(`Processing ${year}/${issue} (PDF in issue folder)...`);
    log(`Processing ${year}/${issue} (manual PDF)`, 'INFO');

    const summarizeScript = path.join(__dirname, 'summarize-gazette.js');
    const result = spawnSync('node', [summarizeScript, String(year), issue, pdfPath], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
    });

    if (result.status !== 0) {
        console.error(`[process-issue-pdf] Summarize failed for ${year}/${issue} (exit ${result.status}). PDF left in place.`);
        process.exit(1);
    }

    if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
        log(`Removed PDF ${path.relative(ROOT, pdfPath)}`, 'INFO');
        console.log('Removed PDF (same as download flow).');
    }

    const jsonPath = getJsonPath(year, issueNum);
    if (!fs.existsSync(jsonPath)) {
        fs.writeFileSync(jsonPath, JSON.stringify({}, null, 4), 'utf8');
        log(`Created minimal ${path.basename(jsonPath)}`, 'INFO');
    }

    const buildCatalogScript = path.join(__dirname, 'build-gazette-catalog.js');
    const catalogResult = spawnSync('node', [buildCatalogScript], { cwd: ROOT, stdio: 'inherit', shell: false });
    if (catalogResult.status !== 0) {
        log(`Catalog rebuild failed (exit ${catalogResult.status})`, 'WARN');
        console.warn('[process-issue-pdf] Catalog rebuild failed. Run: node scripts/build-gazette-catalog.js');
    } else {
        log('Catalog updated', 'OK');
        console.log('Catalog updated.');
    }

    log(`Issue ${year}/${issue} saved (JSON + MD)`, 'OK');
    console.log(`Issue ${year}/${issue} saved.`);
}

main().catch((e) => {
    console.error('[process-issue-pdf]', e);
    process.exit(1);
});
