#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendLog, flushAlertEmail } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = 'build-gazette-catalog';
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');

const issueHeadingRe = /# State Gazette[^\n]*Issue (\d+),\s*([^\n#]+?)(?:\s*$|\s*#)/m;

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

function getIssueDateFromJson(issueDirPath, issueNum) {
    const metaPath = path.join(issueDirPath, `${issueNum}.json`);
    try {
        if (fs.existsSync(metaPath)) {
            const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const raw = data.date && String(data.date).trim() ? data.date.trim() : null;
            return raw ? normalizeDate(raw) : null;
        }
    } catch (_) {}
    return null;
}
const WORDS_PER_MINUTE = 200;

function countWords(text) {
    const stripped = text.replace(/^#+ .+$/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*_`~]/g, '');
    const words = stripped.split(/\s+/).filter(Boolean);
    return words.length;
}

function extractIssueInfo(content) {
    const m = content.match(issueHeadingRe);
    if (!m) return null;
    return { issue: parseInt(m[1], 10), date: m[2].trim() };
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
                return fs.statSync(p).isDirectory() && /^\d{2}$/.test(name);
            })
            .map((name) => ({ name, num: parseInt(name, 10) }))
            .sort((a, b) => a.num - b.num);

        catalog.years[year] = [];
        for (const { name: folderName, num: issueNum } of issueDirs) {
            const issueDirPath = path.join(yearDir, folderName);
            const mdName = `${issueNum}.md`;
            const filePath = path.join(issueDirPath, mdName);
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const info = extractIssueInfo(content);
            const readMinutes = Math.max(1, Math.round(countWords(content) / WORDS_PER_MINUTE));
            const effectiveIssue = info ? info.issue : issueNum;
            const dateFromJson = getIssueDateFromJson(issueDirPath, issueNum);
            const dateFromMarkdown = info ? normalizeDate(info.date) : '';
            const entry = {
                issue: effectiveIssue,
                date: dateFromJson || dateFromMarkdown || '',
                file: `issues/${year}/${folderName}/${mdName}`,
                readMinutes,
            };
            catalog.years[year].push(entry);
        }
    }

    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4), 'utf8');
    console.log('Catalog written to', CATALOG_PATH);
    return catalog;
}

(async () => {
    try {
        appendLog(SCRIPT_NAME, 'Starting catalog build', 'INFO');
        buildCatalog();
        appendLog(SCRIPT_NAME, 'Catalog written to ' + CATALOG_PATH, 'OK');
    } catch (e) {
        appendLog(SCRIPT_NAME, 'Failed: ' + (e && (e.message || String(e))), 'ERROR');
        console.error('[build-gazette-catalog]', e.message || e);
        await flushAlertEmail();
        process.exit(1);
    }
})();
