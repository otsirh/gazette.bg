#!/usr/bin/env node
// Gives every story (## section) of a summary one or two topics from the fixed
// list in src/js/shared.js, as a "Теми: …" line at the end of the section. The
// topic pages and their feeds are built from these lines.
//
// The summarizer tags each new issue itself. This command tags the ones that
// have no topics yet, for example summaries written before topics existed:
//
//   node scripts/tag-topics.js            every issue without topics
//   node scripts/tag-topics.js 2026/98    just these
//
// It reads only the summary, never the PDF, and costs about 3 cents an issue.
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS } from '../src/js/shared.js';
import { createLogger, isMain } from './lib/cli.js';
import { ISSUES_DIR, summaryPath } from './lib/issues.js';
import { createClient, newUsage, runClaude, usageCostUsd } from './summarize-gazette.js';

const log = createLogger('tag-topics');
const CONCURRENCY = 4;
const MAX_TOPICS = 2;

const TAG_SYSTEM_PROMPT = `Подреждаш новините от Държавен вестник по теми, за да може човек да следи само това, което го засяга. Получаваш кратко обобщение на един брой, разделено на номерирани новини.

За всяка новина избери 1 или 2 теми от списъка — тези, под които читател би я потърсил. Първата е основната. Втора тема добавяй само когато новината наистина засяга и нея. Само теми от списъка, изписани точно както са.

${TOPICS.map((t) => `- ${t.label} — ${t.scope}`).join('\n')}`;

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
                },
                required: ['n', 'topics'],
                additionalProperties: false,
            },
        },
    },
    required: ['stories'],
    additionalProperties: false,
};

const SECTION_SPLIT = /(?=^##\s)/m;
const TOPIC_LINE = /^Теми:.*$/m;

export function hasTopics(markdown) {
    const sections = String(markdown)
        .split(SECTION_SPLIT)
        .filter((s) => /^##\s/.test(s));
    return sections.length > 0 && sections.every((s) => TOPIC_LINE.test(s));
}

// Puts each story's topics on the last line of its section, replacing any
// topics line it had.
export function applyTopics(markdown, topicsByStory) {
    let n = 0;
    return String(markdown)
        .split(SECTION_SPLIT)
        .map((section) => {
            if (!/^##\s/.test(section)) return section;
            n++;
            const labels = (topicsByStory.get(n) || []).slice(0, MAX_TOPICS);
            const trailing = section.match(/\n*$/)[0];
            const body = section.replace(/\n*$/, '').replace(/\n+Теми:.*$/m, '');
            return labels.length ? `${body}\n\nТеми: ${labels.join(', ')}${trailing || '\n'}` : `${body}${trailing}`;
        })
        .join('');
}

export async function tagTopics(client, markdown, { usage = null } = {}) {
    const sections = String(markdown)
        .split(SECTION_SPLIT)
        .filter((s) => /^##\s/.test(s));
    if (!sections.length) return markdown;
    const numbered = sections.map((s, i) => `=== ${i + 1} ===\n${s.replace(/\n+Теми:.*$/m, '').trim()}`).join('\n\n');
    const json = await runClaude(client, [{ type: 'text', text: numbered }], 'topics', 'low', {
        system: [{ type: 'text', text: TAG_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        format: { type: 'json_schema', schema: TAG_SCHEMA },
        usage,
    });
    const byStory = new Map(JSON.parse(json).stories.map((s) => [s.n, s.topics]));
    return applyTopics(markdown, byStory);
}

function issuesWithoutTopics() {
    const out = [];
    for (const year of fs.readdirSync(ISSUES_DIR).filter((y) => /^\d{4}$/.test(y))) {
        for (const folder of fs.readdirSync(path.join(ISSUES_DIR, year)).filter((f) => /^\d{2,}$/.test(f))) {
            const file = summaryPath(year, folder);
            if (fs.existsSync(file) && !hasTopics(fs.readFileSync(file, 'utf8')))
                out.push({ year, issue: Number(folder) });
        }
    }
    return out;
}

async function main() {
    const named = process.argv.slice(2).map((a) => {
        const m = a.match(/^(\d{4})\/(\d+)$/);
        if (!m) throw new Error(`Not an issue: ${a} (expected 2026/98)`);
        return { year: m[1], issue: Number(m[2]) };
    });
    const queue = named.length ? named : issuesWithoutTopics();
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
                const tagged = await tagTopics(client, fs.readFileSync(file, 'utf8'), { usage });
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
