#!/usr/bin/env node
// The test set: writes a new summary of each listed issue with the current
// prompts and pipeline, then has a judge read both the published summary and
// the new one against the PDF, blind to which is which. It shows whether a
// change to the prompts or the pipeline made the summaries better or worse
// before the site sees it. Nothing under issues/ is touched.
//
//   node scripts/compare-summaries.js 2026/98 2026/99 2026/100 [--budget 60] [--out .eval/run]
//
// Issues must still be on the first page of dv.parliament.bg's list (the ten
// newest). PDFs are cached in the output folder, which is git-ignored: they
// carry the names of private people and are never published. Every run spends
// API credit; it stops before starting an issue that would pass --budget (US$).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { stripSourceLines, stripTopicLines } from '../src/js/shared.js';
import { downloadIssuePdf, listIssues, readOfficialContents } from './download-latest-gazette.js';
import { createLogger, isMain } from './lib/cli.js';
import { ROOT, summaryPath } from './lib/issues.js';
import { createClient, newUsage, runClaude, summarizePdf, usageCostUsd } from './summarize-gazette.js';

const log = createLogger('compare-summaries');
const CONCURRENCY = 2;
// What one issue costs end to end (new summary + judge), for the budget check
// before an issue starts. Measured runs replace this as they finish.
const ESTIMATED_ISSUE_USD = 5;

const JUDGE_SYSTEM_PROMPT = `Ти оценяваш две обобщения на един и същ брой на Държавен вестник спрямо самия брой (PDF). Обобщенията са за обикновени хора: какво се променя в техните пари, права и задължения. Не знаеш кое как е написано; съди само по съдържанието.

За всяко обобщение (A и B) намери:

1. **Фактически грешки** — твърдение, което броят опровергава или не потвърждава: грешна сума, дата, срок, засегнати, орган, вид или номер на акт, населено място; или нещо, което изобщо го няма в броя. За всяка: точният откъс от обобщението (\`quote\`), какво пише в броя (\`problem\`), страница (\`page\`). Перифраз, стил, закръгляне на големи държавни суми и превалутиране, когато и двете стойности са в броя, не са грешки.
2. **Важни пропуски** — нещо в броя, което мести пари, права или задължения на много хора или дава срок, който тече, а обобщението го няма. Само наистина важните, не всяко обявление. За всеки: какво е (\`what\`) и страница (\`page\`).

После: на кое обобщение би разчитал читател, който иска да знае какво го засяга и да вярва на всяка цифра — \`better\`: "A", "B" или "equal", и защо, в едно-две изречения на български (\`why\`).

Бъди точен: всяка грешка и всеки пропуск трябва да се проверят на посочената страница. Не пиши имена на частни лица — „жител на Поморие“, „собственик на имот“.`;

const findingsSchema = {
    type: 'object',
    properties: {
        errors: {
            type: 'array',
            items: {
                type: 'object',
                properties: { quote: { type: 'string' }, problem: { type: 'string' }, page: { type: 'integer' } },
                required: ['quote', 'problem', 'page'],
                additionalProperties: false,
            },
        },
        omissions: {
            type: 'array',
            items: {
                type: 'object',
                properties: { what: { type: 'string' }, page: { type: 'integer' } },
                required: ['what', 'page'],
                additionalProperties: false,
            },
        },
    },
    required: ['errors', 'omissions'],
    additionalProperties: false,
};

const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        A: findingsSchema,
        B: findingsSchema,
        better: { type: 'string', enum: ['A', 'B', 'equal'] },
        why: { type: 'string' },
    },
    required: ['A', 'B', 'better', 'why'],
    additionalProperties: false,
};

// Checks that need no model: the house rules a reader would notice.
export function houseRuleCounts(markdown) {
    const md = String(markdown);
    const sections = md.split(/(?=^##\s)/m).filter((s) => /^##\s/.test(s));
    const secondPerson = md.match(
        /(?<![\p{L}])(ти|твоя|твоят|твоите|можеш|имаш|трябва да подадеш|ще плащаш|вие|вашия|вашият)(?![\p{L}])/giu,
    );
    return {
        sections: sections.length,
        sectionsWithSource: sections.filter((s) => /^Източник:\s*\S/m.test(s)).length,
        words: md.split(/\s+/).filter(Boolean).length,
        secondPerson: secondPerson ? secondPerson.length : 0,
    };
}

function parseArgs(argv) {
    const opts = {
        issues: [],
        budget: 60,
        fetchOnly: false,
        out: path.join(ROOT, '.eval', new Date().toISOString().slice(0, 10)),
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--budget') opts.budget = Number(argv[++i]);
        else if (argv[i] === '--fetch-only') opts.fetchOnly = true;
        else if (argv[i] === '--out') opts.out = path.resolve(argv[++i]);
        else {
            const m = argv[i].match(/^(\d{4})\/(\d+)$/);
            if (!m) throw new Error(`Not an issue: ${argv[i]} (expected 2026/98)`);
            opts.issues.push({ year: Number(m[1]), issue: Number(m[2]) });
        }
    }
    if (!opts.issues.length) throw new Error('Name at least one issue, e.g. 2026/98');
    return opts;
}

const key = (t) => `${t.year}-${t.issue}`;

async function fetchSources(targets, dir) {
    const missing = targets.filter((t) => !fs.existsSync(path.join(dir, `${key(t)}.json`)));
    if (!missing.length) return;
    fs.mkdirSync(dir, { recursive: true });
    const browser = await chromium.launch({
        headless: true,
        proxy: process.env.DV_PROXY ? { server: process.env.DV_PROXY } : undefined,
    });
    try {
        const page = await browser.newPage();
        for (const t of missing) {
            const row = (await listIssues(page)).find((r) => r.issue === t.issue && r.year === t.year);
            if (!row)
                throw new Error(`${t.year}/${t.issue} is no longer among the ten newest issues on dv.parliament.bg`);
            const pdfPath = path.join(dir, `${key(t)}.pdf`);
            const pdfUrl = await downloadIssuePdf(page, row, pdfPath);
            const materials = await readOfficialContents(page, t);
            fs.writeFileSync(
                path.join(dir, `${key(t)}.json`),
                JSON.stringify({ date: row.date, pdfUrl, materials }, null, 4),
            );
            log(`Fetched ${t.year}/${t.issue}: ${materials.length} acts listed`);
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

async function judge(client, pdfPath, published, fresh, t, usage) {
    // Which one is A is fixed by the issue number, so a rerun asks the same
    // question, and the order still differs across the set.
    const freshIsA = t.issue % 2 === 0;
    const [a, b] = freshIsA ? [fresh, published] : [published, fresh];
    const data = fs.readFileSync(pdfPath).toString('base64');
    const json = await runClaude(
        client,
        [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
            {
                type: 'text',
                text: `Горе е Държавен вестник бр. ${t.issue} от ${t.year} г.\n\n=== ОБОБЩЕНИЕ A ===\n${a}\n\n=== ОБОБЩЕНИЕ B ===\n${b}`,
            },
        ],
        `judge ${t.year}/${t.issue}`,
        'high',
        {
            system: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT }],
            format: { type: 'json_schema', schema: JUDGE_SCHEMA },
            usage,
        },
    );
    const verdict = JSON.parse(json);
    const unblind = (x) => (x === 'equal' ? 'equal' : (x === 'A') === freshIsA ? 'new' : 'published');
    return {
        published: freshIsA ? verdict.B : verdict.A,
        new: freshIsA ? verdict.A : verdict.B,
        better: unblind(verdict.better),
        why: verdict.why,
        freshWasA: freshIsA,
    };
}

async function runIssue(client, t, opts) {
    const sources = path.join(opts.out, 'sources');
    const pdfPath = path.join(sources, `${key(t)}.pdf`);
    const resultPath = path.join(opts.out, `${key(t)}.result.json`);
    if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    const meta = JSON.parse(fs.readFileSync(path.join(sources, `${key(t)}.json`), 'utf8'));
    const newPath = path.join(opts.out, `${key(t)}.new.md`);
    let run;
    if (fs.existsSync(newPath)) {
        run = JSON.parse(fs.readFileSync(path.join(opts.out, `${key(t)}.new.report.json`), 'utf8'));
    } else {
        const out = await summarizePdf(pdfPath, t.year, t.issue, { client, materials: meta.materials });
        fs.writeFileSync(newPath, out.markdown);
        fs.writeFileSync(path.join(opts.out, `${key(t)}.new.draft.md`), out.draft);
        fs.writeFileSync(path.join(opts.out, `${key(t)}.new.inventory.txt`), out.inventory);
        fs.writeFileSync(path.join(opts.out, `${key(t)}.new.report.json`), JSON.stringify(out.report, null, 4));
        run = out.report;
    }

    const published = fs.readFileSync(summaryPath(t.year, t.issue), 'utf8');
    const fresh = fs.readFileSync(newPath, 'utf8');
    const judgeUsage = newUsage();
    const blind = (md) => stripTopicLines(stripSourceLines(md));
    const verdict = await judge(client, pdfPath, blind(published), blind(fresh), t, judgeUsage);
    const result = {
        issue: `${t.year}/${t.issue}`,
        pageCount: run.pageCount,
        meta: { pdfUrl: meta.pdfUrl, materials: meta.materials },
        corrections: run.corrections,
        notApplied: run.notApplied,
        rules: { published: houseRuleCounts(published), new: houseRuleCounts(fresh) },
        judge: verdict,
        costUsd: { newSummary: run.costUsd, judge: usageCostUsd(judgeUsage) },
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 4));
    return result;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    fs.mkdirSync(opts.out, { recursive: true });
    await fetchSources(opts.issues, path.join(opts.out, 'sources'));
    if (opts.fetchOnly) return;

    // Two issues at a time can meet the rate limit; the SDK waits and retries.
    const client = createClient({ maxRetries: 6 });
    const results = [];
    let spent = 0;
    let inFlight = 0;
    const queue = [...opts.issues];
    const worker = async () => {
        while (queue.length) {
            if (spent + (inFlight + 1) * ESTIMATED_ISSUE_USD > opts.budget) {
                log(`Stopping: $${spent.toFixed(2)} spent, next issue could pass the $${opts.budget} budget.`, 'WARN');
                return;
            }
            const t = queue.shift();
            inFlight++;
            try {
                const r = await runIssue(client, t, opts);
                results.push(r);
                spent += r.costUsd.newSummary + r.costUsd.judge;
                log(
                    `${r.issue}: better=${r.judge.better}; errors ${r.judge.published.errors.length} → ${r.judge.new.errors.length}; omissions ${r.judge.published.omissions.length} → ${r.judge.new.omissions.length}; $${(r.costUsd.newSummary + r.costUsd.judge).toFixed(2)}`,
                    'OK',
                );
            } catch (e) {
                // A failure is still paid for.
                if (e.usage) spent += usageCostUsd(e.usage);
                log(`${t.year}/${t.issue} failed: ${e.message}`, 'ERROR');
            } finally {
                inFlight--;
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    results.sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }));
    const total = (side, field) => results.reduce((n, r) => n + r.judge[side][field].length, 0);
    const summary = {
        issues: results.length,
        better: {
            new: results.filter((r) => r.judge.better === 'new').length,
            published: results.filter((r) => r.judge.better === 'published').length,
            equal: results.filter((r) => r.judge.better === 'equal').length,
        },
        errors: { published: total('published', 'errors'), new: total('new', 'errors') },
        omissions: { published: total('published', 'omissions'), new: total('new', 'omissions') },
        costUsd: Math.round(spent * 100) / 100,
    };
    fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify({ summary, results }, null, 4));
    console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) {
    main().catch((e) => {
        console.error('[compare-summaries]', e);
        process.exit(1);
    });
}
