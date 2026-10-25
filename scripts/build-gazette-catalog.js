#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatDateBulgarian } from '../src/js/shared.js';
import { isMain } from './lib/cli.js';
import { ISSUES_DIR, ROOT } from './lib/issues.js';

// The catalog is build output like everything else under dist/ — the page
// builder reads it from here and the client fetches it as /catalog.json.
const DIST_DIR = path.join(ROOT, 'dist');

function stripMarkdownInline(s) {
    return String(s)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Pull the issue's lead sentence (a leading *italic* line, present on only a
// few issues) and its topic headlines (the level-2 headings). These power the
// front-page teaser and the per-row previews on the homepage.
function extractIssueMeta(filePath) {
    try {
        const md = fs.readFileSync(filePath, 'utf8');
        const topics = [];
        let lead = '';
        let sawHeading = false;
        for (const raw of md.split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
            if (h) {
                sawHeading = true;
                if (h[1].length === 2) topics.push(stripMarkdownInline(h[2]));
                continue;
            }
            if (!sawHeading && !lead) {
                const it = /^\*(.+?)\*$/.exec(line);
                lead = stripMarkdownInline(it ? it[1] : line);
            }
        }
        return { lead, topics };
    } catch {
        return { lead: '', topics: [] };
    }
}

// The issue's JSON carries one thing: the publication date, as scraped from
// dv.parliament.bg when the PDF was downloaded.
function readIssueJson(issueDirPath, issueNum) {
    const metaPath = path.join(issueDirPath, `${issueNum}.json`);
    try {
        if (fs.existsSync(metaPath)) return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
        // An unreadable JSON leaves the issue without a date, not off the site.
    }
    return {};
}

export function buildCatalog({ issuesDir = ISSUES_DIR, distDir = DIST_DIR } = {}) {
    const catalog = { years: {} };
    const catalogPath = path.join(distDir, 'catalog.json');
    fs.mkdirSync(distDir, { recursive: true });
    const years = fs.existsSync(issuesDir)
        ? fs
              .readdirSync(issuesDir)
              .filter((name) => /^\d{4}$/.test(name) && fs.statSync(path.join(issuesDir, name)).isDirectory())
              .sort()
        : [];

    for (const year of years) {
        const yearDir = path.join(issuesDir, year);
        const issueDirs = fs
            .readdirSync(yearDir)
            // Folders are zero-padded to at least two digits; ДВ runs past
            // 100 issues a year, so a hard \d{2} would drop 100+ silently.
            .filter((name) => /^\d{2,}$/.test(name) && fs.statSync(path.join(yearDir, name)).isDirectory())
            .map((name) => ({ name, num: parseInt(name, 10) }))
            .sort((a, b) => a.num - b.num);

        catalog.years[year] = [];
        for (const { name: folderName, num: issueNum } of issueDirs) {
            const issueDirPath = path.join(yearDir, folderName);
            const mdName = `${issueNum}.md`;
            const filePath = path.join(issueDirPath, mdName);
            if (!fs.existsSync(filePath)) continue;
            const { lead, topics } = extractIssueMeta(filePath);
            const meta = readIssueJson(issueDirPath, issueNum);
            catalog.years[year].push({
                issue: issueNum,
                date: meta.date ? formatDateBulgarian(String(meta.date).trim()) : '',
                file: `issues/${year}/${folderName}/${mdName}`,
                lead,
                topics,
            });
        }
    }

    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 4), 'utf8');
    console.log('Catalog written to', catalogPath);
    return catalog;
}

export { extractIssueMeta };

if (isMain(import.meta.url)) {
    try {
        buildCatalog();
    } catch (e) {
        console.error('[build-gazette-catalog]', e.message || e);
        process.exit(1);
    }
}
