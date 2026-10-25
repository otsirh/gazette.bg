#!/usr/bin/env node
// Summarizes an issue from a PDF you downloaded by hand — for an issue the
// daily run missed (the gap check names it). Put the PDF in the issue's folder
// as .tmp.pdf, then: node scripts/process-issue-pdf.js <year> <issue>
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalog } from './build-gazette-catalog.js';
import { createLogger } from './lib/cli.js';
import { metadataPath, ROOT, summaryPath, TEMP_PDF_NAME, tempPdfPath } from './lib/issues.js';
import { createClient, summarizeIssue } from './summarize-gazette.js';

const log = createLogger('process-issue-pdf');

async function main() {
    const [year, issueArg] = process.argv.slice(2);
    if (!/^\d{4}$/.test(year || '') || !/^\d+$/.test(issueArg || '')) {
        console.log('Usage: node scripts/process-issue-pdf.js <year> <issue>');
        console.log('  e.g. node scripts/process-issue-pdf.js 2026 15');
        console.log(`  Expects ${TEMP_PDF_NAME} in issues/<year>/<zero-padded-issue>/`);
        process.exit(1);
    }
    const issue = Number(issueArg);
    const pdfPath = tempPdfPath(year, issue);

    if (!fs.existsSync(pdfPath)) {
        console.log(`No PDF found at ${path.relative(ROOT, pdfPath)}. Add ${TEMP_PDF_NAME} and run again.`);
        process.exit(1);
    }
    if (fs.existsSync(summaryPath(year, issue))) {
        console.log(`Skip ${year}/${issue} (already have summary). Delete ${issue}.md to re-summarize.`);
        return;
    }

    try {
        await summarizeIssue(year, issue, pdfPath, { client: createClient() });
    } catch (e) {
        console.error(`[process-issue-pdf] Summarize failed for ${year}/${issue}. PDF left in place.`);
        throw e;
    }

    fs.unlinkSync(pdfPath);
    log(`Removed PDF ${path.relative(ROOT, pdfPath)}`);

    // The daily run stores the scraped date here; by hand there is none to
    // copy, so the issue goes up without one until you add it.
    const jsonPath = metadataPath(year, issue);
    if (!fs.existsSync(jsonPath)) {
        fs.writeFileSync(jsonPath, JSON.stringify({}, null, 4), 'utf8');
        log(`Created minimal ${path.basename(jsonPath)}`);
    }

    try {
        buildCatalog();
    } catch (e) {
        log(`Catalog rebuild failed (${e.message}). Run: npm run build`, 'WARN');
    }
    log(`Issue ${year}/${issue} saved (JSON + MD). Run npm run build to see it on the site.`, 'OK');
}

main().catch((e) => {
    console.error('[process-issue-pdf]', e);
    process.exit(1);
});
