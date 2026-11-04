#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatDateBulgarian, readingMinutes, stripMarkdownInline } from '../src/js/shared.js';
import { isMain } from './lib/cli.js';
import { ISSUES_DIR, ROOT } from './lib/issues.js';

// The catalog is build output like everything else under dist/ — the page
// builder reads it from here and the client fetches it as /catalog.json.
const DIST_DIR = path.join(ROOT, 'dist');

function summarizeStandfirst(paragraph, maxChars = 320) {
    const clean = stripMarkdownInline(paragraph);
    if (!clean || clean.length <= maxChars) return clean;
    const within = clean.slice(0, maxChars);
    let lastSentenceEnd = -1;
    for (const m of within.matchAll(/[.!?](?=\s|$)/g)) {
        // Avoid splitting after common Bulgarian abbreviations like "чл.", "ал.", "бр.", "г.", "т.", "лв."
        const before = within.slice(0, m.index);
        if (/(?:^|\s)(?:чл|ал|бр|г|т|лв|евро|млн|млрд|хил|стр|параграф|дв|к\.д|реш|зап|пмс|р\.д)$/i.test(before)) {
            continue;
        }
        lastSentenceEnd = m.index + 1;
    }
    if (lastSentenceEnd >= 80) return within.slice(0, lastSentenceEnd).trim();
    return `${within
        .slice(0, maxChars - 1)
        .replace(/\s+\S*$/, '')
        .replace(/[\s.,;:–—-]+$/, '')}…`;
}

// Pull the issue's topic headlines (the level-2 headings), opening standfirst,
// and reading-time estimate. These power the front-page lead spread and the
// per-row previews on the homepage.
function extractIssueMeta(filePath) {
    try {
        const md = fs.readFileSync(filePath, 'utf8');
        const topics = [];
        for (const raw of md.split('\n')) {
            const m = /^##\s+(.+?)\s*$/.exec(raw.trim());
            if (m) topics.push(stripMarkdownInline(m[1]));
        }

        // First prose paragraph of the lead section.
        const firstSection = md.split(/^##\s+[^\n]+\n+/m)[1] ?? md;
        const blocks = firstSection
            .split(/\n{2,}/)
            .map((b) => b.trim())
            .filter(Boolean);
        const firstProse = blocks.find((b) => !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|---|Източник:)/.test(b)) || '';
        const lead = summarizeStandfirst(firstProse);

        return { topics, lead, minutes: readingMinutes(md) };
    } catch {
        return { topics: [], lead: '', minutes: 1 };
    }
}

// The issue's JSON, as scraped from dv.parliament.bg when the PDF was
// downloaded: the publication date and, for newer issues, the official PDF and
// where each act starts.
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
            const { topics, lead, minutes } = extractIssueMeta(filePath);
            const meta = readIssueJson(issueDirPath, issueNum);
            const entry = {
                issue: issueNum,
                date: meta.date ? formatDateBulgarian(String(meta.date).trim()) : '',
                file: `issues/${year}/${folderName}/${mdName}`,
                topics,
                minutes,
            };
            if (lead) entry.lead = lead;
            // The official PDF, for the link above every summary. Where each
            // act starts stays in the JSON: only the build needs it.
            if (meta.pdfUrl) entry.pdfUrl = meta.pdfUrl;
            catalog.years[year].push(entry);
        }
    }

    fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
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
