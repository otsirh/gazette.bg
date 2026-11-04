#!/usr/bin/env node
// Gives every story (## section) of a summary one or two topics from the fixed
// list in src/js/shared.js, as a "Теми: …" line at the end of the section, and
// the date its main change takes effect, as "В сила: 2027-01-01" under it. The
// topic pages, their feeds and the upcoming-changes page are built from these.
//
// The update run calls it after the downloads, for every issue not tagged yet
// (a new one, or one whose tagging failed). By hand:
//
//   node scripts/tag-topics.js            every issue without topics
//   node scripts/tag-topics.js 2026/98    just these
//   node scripts/tag-topics.js --all      every issue, again
//
// It reads only the summary, never the PDF, and costs about 3 cents an issue.
import fs from 'node:fs';
import path from 'node:path';
import { issueDateToIso, TOPICS } from '../src/js/shared.js';
import { createLogger, isMain } from './lib/cli.js';
import { ISSUES_DIR, metadataPath, summaryPath } from './lib/issues.js';
import { createClient, newUsage, runClaude, usageCostUsd } from './summarize-gazette.js';

const log = createLogger('tag-topics');
const CONCURRENCY = 4;
const MAX_TOPICS = 2;

const TAG_SYSTEM_PROMPT = `Подреждаш новините от Държавен вестник по теми, за да може човек да следи само това, което го засяга. Получаваш кратко обобщение на един брой, разделено на номерирани новини.

За всяка новина избери 1 или 2 теми от списъка — тези, под които читател би я потърсил. Първата е основната. Втора тема добавяй само когато новината наистина засяга и нея. Само теми от списъка, изписани точно както са.

${TOPICS.map((t) => `- ${t.label} — ${t.scope}`).join('\n')}

За всяка новина дай и датата, от която важи основната ѝ промяна (\`effective\`, във вид ГГГГ-ММ-ДД), само ако обобщението я казва. „От обнародването“ или „от деня на обнародването“ е датата на броя, дадена горе. Ако датите са няколко, дай тази на главната промяна. Ако дата няма, не е ясна, или новината е срок за възражение, търг или конкурс, а не промяна, която влиза в сила — празен низ.`;

const TAG_SCHEMA = {
    type: 'object',
    properties: {
        stories: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    n: { type: 'integer' },
                    topics: { type: 'array', items: { type: 'string', enum: TOPICS.map((t) => t.label) } },
                    effective: { type: 'string' },
                },
                required: ['n', 'topics', 'effective'],
                additionalProperties: false,
            },
        },
    },
    required: ['stories'],
    additionalProperties: false,
};

const SECTION_SPLIT = /(?=^##\s)/m;
const TOPIC_LINE = /^Теми:.*$/m;
const ANNOTATION_LINES = /\n+(?:Теми|В сила):.*$/gm;

// "2027-01-01" when it is a real date, else nothing.
export function validDate(text) {
    const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const d = new Date(`${m[0]}T12:00:00Z`);
    const year = Number(m[1]);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[0] && year >= 1990 && year <= 2100
        ? m[0]
        : '';
}

// An issue is tagged once any of its stories has topics. A story the model
// left without any stays so: retrying would reshuffle the others' topics and
// dates on every run.
export function hasTopics(markdown) {
    return TOPIC_LINE.test(String(markdown));
}

// Puts each story's topics, and the date it takes effect, on the last lines of
// its section, replacing any it had. A story's entry is its topic labels, or
// { topics, effective }.
export function applyTopics(markdown, byStory) {
    let n = 0;
    return String(markdown)
        .split(SECTION_SPLIT)
        .map((section) => {
            if (!/^##\s/.test(section)) return section;
            n++;
            const entry = byStory.get(n) || [];
            const { topics = [], effective = '' } = Array.isArray(entry) ? { topics: entry } : entry;
            const labels = topics.slice(0, MAX_TOPICS);
            const date = validDate(effective);
            const trailing = section.match(/\n*$/)[0] || '\n';
            const body = section.replace(/\n*$/, '').replace(ANNOTATION_LINES, '');
            const lines = [labels.length ? `Теми: ${labels.join(', ')}` : '', date ? `В сила: ${date}` : ''].filter(
                Boolean,
            );
            return lines.length ? `${body}\n\n${lines.join('\n\n')}${trailing}` : `${body}${trailing}`;
        })
        .join('');
}

export async function tagTopics(client, markdown, { usage = null, issueDate = '' } = {}) {
    const sections = String(markdown)
        .split(SECTION_SPLIT)
        .filter((s) => /^##\s/.test(s));
    if (!sections.length) return markdown;
    const numbered = sections.map((s, i) => `=== ${i + 1} ===\n${s.replace(ANNOTATION_LINES, '').trim()}`).join('\n\n');
    const head = issueDate ? `Броят е обнародван на ${issueDate}.\n\n` : '';
    const json = await runClaude(client, [{ type: 'text', text: head + numbered }], 'topics', 'low', {
        system: [{ type: 'text', text: TAG_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        format: { type: 'json_schema', schema: TAG_SCHEMA },
        usage,
    });
    const byStory = new Map(JSON.parse(json).stories.map((s) => [s.n, { topics: s.topics, effective: s.effective }]));
    return applyTopics(markdown, byStory);
}

function issueDate(year, issue) {
    try {
        return issueDateToIso(JSON.parse(fs.readFileSync(metadataPath(year, issue), 'utf8')).date) || '';
    } catch {
        return '';
    }
}

function listIssues({ all = false } = {}) {
    const out = [];
    for (const year of fs.readdirSync(ISSUES_DIR).filter((y) => /^\d{4}$/.test(y))) {
        for (const folder of fs.readdirSync(path.join(ISSUES_DIR, year)).filter((f) => /^\d{2,}$/.test(f))) {
            const file = summaryPath(year, folder);
            if (fs.existsSync(file) && (all || !hasTopics(fs.readFileSync(file, 'utf8'))))
                out.push({ year, issue: Number(folder) });
        }
    }
    return out;
}

async function main() {
    const args = process.argv.slice(2);
    const all = args.includes('--all');
    const named = args
        .filter((a) => a !== '--all')
        .map((a) => {
            const m = a.match(/^(\d{4})\/(\d+)$/);
            if (!m) throw new Error(`Not an issue: ${a} (expected 2026/98)`);
            return { year: m[1], issue: Number(m[2]) };
        });
    const queue = named.length ? named : listIssues({ all });
    if (!queue.length) {
        log('Every issue already has topics.', 'OK');
        return;
    }
    log(`Tagging ${queue.length} issue(s)`);
    const client = createClient({ maxRetries: 6 });
    const usage = newUsage();
    let failed = 0;
    const worker = async () => {
        while (queue.length) {
            const { year, issue } = queue.shift();
            const file = summaryPath(year, issue);
            try {
                const tagged = await tagTopics(client, fs.readFileSync(file, 'utf8'), {
                    usage,
                    issueDate: issueDate(year, issue),
                });
                fs.writeFileSync(file, tagged, 'utf8');
            } catch (e) {
                failed++;
                log(`${year}/${issue}: ${e.message}`, 'ERROR');
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    log(`Done. Cost: ~$${usageCostUsd(usage).toFixed(2)}`, failed ? 'WARN' : 'OK');
    if (failed) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
    main().catch((e) => {
        console.error('[tag-topics]', e);
        process.exit(1);
    });
}
