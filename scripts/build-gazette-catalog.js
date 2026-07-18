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

// The issue's JSON carries the publication date and — once the summary has been
// through the tagging pass — who it affects, the deadlines it starts, and the
// places it names. All of it goes into the catalog now: the site surfaces the
// places (per-issue chips, archive search) as well as the audiences and dates.
function readIssueJson(issueDirPath, issueNum) {
    const metaPath = path.join(issueDirPath, `${issueNum}.json`);
    try {
        if (fs.existsSync(metaPath)) return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
    return {};
}
// ─── "Проследи темата" — link sections across issues by topic similarity ───
// TF-IDF cosine over each section's text (title weighted heavily). Only matches
// above a high threshold are kept — a wrong "related" link is worse than none.
const BG_STOPWORDS = new Set('и в на за с се да е че от по при като но или а то той тя те това този тази тези са ще не ако който която което които си ги го я му им вече само още също така там тук как защо между след преди без до над под през около срещу заради чрез спрямо всеки всяка всяко всички някой някоя някои нещо бъде били бил била било беше сме сте би бих ти ви ни ме брой броя закон закона нов нови нова ново промяна промени промяната правило правила наредба наредбата министър държавен вестник може можеш трябва имаш това като лева евро'.split(' '));

function stemBg(w) {
    return w.replace(/(ността|ните|ията|ята|ата|ове|овете|ият|ия|ен|на|но|ни|та|то|те|ът|а|о|и|е|я)$/, '');
}
function tokenize(text, repeat = 1) {
    const out = [];
    for (const m of (String(text).toLowerCase().match(/[а-яёѝ]{3,}/g) || [])) {
        if (BG_STOPWORDS.has(m)) continue;
        const s = stemBg(m);
        if (s.length >= 3) for (let k = 0; k < repeat; k++) out.push(s);
    }
    return out;
}
function readSectionBodies(filePath) {
    const map = new Map();
    try {
        const md = fs.readFileSync(filePath, 'utf8');
        for (const part of md.split(/^##\s+/m).slice(1)) {
            const nl = part.indexOf('\n');
            const title = stripMarkdownInline(nl < 0 ? part : part.slice(0, nl)).trim();
            if (title) map.set(title, nl < 0 ? '' : part.slice(nl));
        }
    } catch (_) {}
    return map;
}

const RELATED_THRESHOLD = 0.14;
const RELATED_MAX = 3;

function attachRelated(catalog) {
    const docs = [];
    for (const year of Object.keys(catalog.years)) {
        for (const entry of catalog.years[year]) {
            const bodies = readSectionBodies(path.join(ROOT, entry.file));
            (entry.sections || []).forEach((section, secIndex) => {
                const title = String(section.title || '').trim();
                if (!title || /^Накратко$/i.test(title)) return;
                const toks = tokenize(title, 3).concat(tokenize(bodies.get(title) || '', 1));
                if (toks.length) docs.push({ year: Number(year), issue: entry.issue, secIndex, section, toks });
            });
        }
    }
    const df = new Map();
    for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
    const N = docs.length;
    const idf = (t) => Math.log(N / ((df.get(t) || 0) + 1));
    for (const d of docs) {
        const tf = new Map();
        for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
        const vec = new Map();
        let norm = 0;
        for (const [t, f] of tf) { const w = (1 + Math.log(f)) * idf(t); vec.set(t, w); norm += w * w; }
        d.vec = vec; d.norm = Math.sqrt(norm) || 1;
    }
    const cos = (a, b) => {
        let dot = 0;
        const [s, l] = a.vec.size < b.vec.size ? [a, b] : [b, a];
        for (const [t, w] of s.vec) { const w2 = l.vec.get(t); if (w2) dot += w * w2; }
        return dot / (a.norm * b.norm);
    };
    for (const d of docs) {
        const matches = [];
        for (const o of docs) {
            if (o === d || o.issue === d.issue) continue;
            const c = cos(d, o);
            if (c >= RELATED_THRESHOLD) matches.push({ o, c });
        }
        matches.sort((a, b) => b.c - a.c);
        // Compact ref [year, issue, sectionIndex]; the renderer resolves the
        // target's title/date/anchor from the catalog, so nothing is duplicated.
        const top = matches.slice(0, RELATED_MAX).map((m) => m.o).sort((a, b) => a.issue - b.issue);
        if (top.length) d.section.related = top.map((o) => [o.year, o.issue, o.secIndex]);
    }
    console.log(`Related topics: ${docs.filter((d) => d.section.related).length}/${docs.length} sections linked (threshold ${RELATED_THRESHOLD})`);
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
                audiences: meta.audiences || [],
                places: meta.places || [],
                sections: meta.sections || [],
                deadlines: meta.deadlines || [],
                // Only carried once the coverage check has run for this issue
                // (new issues going forward); older issues simply omit it.
                ...(meta.coverage ? { coverage: meta.coverage } : {}),
            });
        }
    }

    attachRelated(catalog);

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
