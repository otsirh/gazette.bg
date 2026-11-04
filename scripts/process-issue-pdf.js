#!/usr/bin/env node
// Summarizes an issue from a PDF you downloaded by hand — for an issue the
// daily run missed (the gap check names it). Put the PDF in the issue's folder
// as .tmp.pdf, then: node scripts/process-issue-pdf.js <year> <issue>
import fs from 'node:fs';
import path from 'node:path';
import { formatDateBulgarian } from '../src/js/shared.js';
import { buildCatalog } from './build-gazette-catalog.js';
import { buildSite } from './build-issue-pages.js';
import { createLogger } from './lib/cli.js';
import { metadataPath, ROOT, summaryPath, TEMP_PDF_NAME, tempPdfPath } from './lib/issues.js';
import { createClient, summarizeIssue } from './summarize-gazette.js';

const log = createLogger('process-issue-pdf');

async function main() {
    const [year, issueArg, dateArg] = process.argv.slice(2);
    if (!/^\d{4}$/.test(year || '') || !/^\d+$/.test(issueArg || '')) {
        console.log('Usage: node scripts/process-issue-pdf.js <year> <issue> [date]');
        console.log('  e.g. node scripts/process-issue-pdf.js 2026 15 "20.2.2026 г."');
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

    // The daily run stores the scraped date here; by hand you can pass it on
    // the command line, or fill it in later.
    const jsonPath = metadataPath(year, issue);
    if (dateArg || !fs.existsSync(jsonPath)) {
        const meta = dateArg ? { date: formatDateBulgarian(dateArg.trim()) } : {};
        fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 4), 'utf8');
        log(`Wrote ${path.basename(jsonPath)}`);
    }

    try {
        buildCatalog();
        await buildSite();
    } catch (e) {
        log(`Site rebuild failed (${e.message}). Run: npm run build`, 'WARN');
    }
    log(`Issue ${year}/${issue} saved (JSON + MD) and built into dist/.`, 'OK');
}

main().catch((e) => {
    console.error('[process-issue-pdf]', e);
    process.exit(1);
});
