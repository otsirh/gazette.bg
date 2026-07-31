#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');

const BG_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const BG_MONTHS_CAP = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

function normalizeDate(str) {
    if (!str || typeof str !== 'string') return str;
    let s = str.replace(/\s*г\.\s*$/, '').trim();
    for (let i = 0; i < BG_MONTHS.length; i++) {
        s = s.replace(BG_MONTHS[i], BG_MONTHS_CAP[i]);
    }
    return s;
}

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
    } catch (_) {
        return { lead: '', topics: [] };
    }
}

// The issue's JSON carries one thing: the publication date, as scraped from
// dv.parliament.bg when the PDF was downloaded.
function readIssueJson(issueDirPath, issueNum) {
    const metaPath = path.join(issueDirPath, `${issueNum}.json`);
    try {
        if (fs.existsSync(metaPath)) return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
    return {};
}
function buildCatalog() {
    const catalog = { years: {} };
    if (!fs.existsSync(ISSUES_DIR)) {
        fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4), 'utf8');
        console.log('Catalog written to', CATALOG_PATH);
        return catalog;
    }
    const years = fs.readdirSync(ISSUES_DIR).filter((name) => {
        const p = path.join(ISSUES_DIR, name);
        return fs.statSync(p).isDirectory() && /^\d{4}$/.test(name);
    }).sort();

    for (const year of years) {
        const yearDir = path.join(ISSUES_DIR, year);
        const issueDirs = fs.readdirSync(yearDir)
            .filter((name) => {
                const p = path.join(yearDir, name);
                // Folders are zero-padded to at least two digits; ДВ runs past
                // 100 issues a year, so a hard \d{2} would drop 100+ silently.
                return fs.statSync(p).isDirectory() && /^\d{2,}$/.test(name);
            })
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
                date: meta.date ? normalizeDate(String(meta.date).trim()) : '',
                file: `issues/${year}/${folderName}/${mdName}`,
                lead,
                topics,
            });
        }
    }

    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4), 'utf8');
    console.log('Catalog written to', CATALOG_PATH);
    return catalog;
}

try {
    buildCatalog();
} catch (e) {
    console.error('[build-gazette-catalog]', e.message || e);
    process.exit(1);
}
