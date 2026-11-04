#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import {
    CHECK_SCHEMA,
    CHECK_SYSTEM_PROMPT,
    EXTRACT_SYSTEM_PROMPT,
    getCheckUserPrompt,
    getRefindUserPrompt,
    getRefineUserPrompt,
    getSummarizeChunkPrompt,
    SYSTEM_PROMPT,
} from './ai-prompts.js';
import { cleanMarkdown, findMixedScriptWords } from './clean-markdown.js';
import { createLogger, isMain } from './lib/cli.js';
import { checkReportPath, issueDir, ROOT, summaryPath } from './lib/issues.js';

// Parts of the issue are read separately: every part is one more independent
// judgment about what to keep, and the fewer of those there are — each seeing
// more of the issue — the less gets silently dropped. 50 pages has held up.
const PAGES_PER_CHUNK = 50;
// The check reads the whole issue at once where it can (600 pages per request
// on a 1M-context model), so a claim is found wherever it sits. Some accounts
// and models still cap a PDF at 100 pages; on that refusal it goes in parts.
const CHECK_PAGES_PER_PART = 500;
const CHECK_FALLBACK_PAGES_PER_PART = 100;
const DELAY_BETWEEN_CHUNKS_MS = 10 * 1000;
// Every stage thinks hard: reading the pages at high, so less is missed, and
// writing and checking at xhigh, where judgment decides what readers see.
// Thinking is billed as output, a small part of an issue's cost next to the
// PDF itself. Opus 5.5 defaults to medium, so each is set explicitly.
const CHUNK_EFFORT = 'high';
const REFINE_EFFORT = 'xhigh';
const CHECK_EFFORT = 'xhigh';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODEL = 'claude-opus-5-5';
// Hard ceiling on one response, thinking included. Requests are streamed, so
// a high ceiling costs nothing until it is used.
const MAX_TOKENS = 64000;
// Claude API list prices for MODEL, US$ per million tokens. Used only to log
// what an issue cost; the bill itself is the Console's.
const PRICE_PER_MTOK = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

const log = createLogger('summarize-gazette');

const cached = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
const CACHED_SYSTEM = cached(SYSTEM_PROMPT);
const CACHED_EXTRACT_SYSTEM = cached(EXTRACT_SYSTEM_PROMPT);
const CACHED_CHECK_SYSTEM = cached(CHECK_SYSTEM_PROMPT);

// Adds one response's usage to a running total for the issue.
function addUsage(total, usage) {
    if (!total || !usage) return;
    total.input += usage.input_tokens ?? 0;
    total.output += usage.output_tokens ?? 0;
    total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    total.cacheRead += usage.cache_read_input_tokens ?? 0;
}

export function newUsage() {
    return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

export function usageCostUsd(u) {
    const p = PRICE_PER_MTOK;
    const cost =
        (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
    return Math.round(cost * 100) / 100;
}

function logUsage(label, usage) {
    if (!usage) return;
    const parts = [`in=${usage.input_tokens ?? 0}`, `out=${usage.output_tokens ?? 0}`];
    if (usage.cache_creation_input_tokens) parts.push(`cache_write=${usage.cache_creation_input_tokens}`);
    if (usage.cache_read_input_tokens) parts.push(`cache_read=${usage.cache_read_input_tokens}`);
    console.log(`    [${label}] ${parts.join(' ')}`);
}

function extractText(message) {
    if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new Error(
            `Claude declined the request (stop_reason: refusal${category ? `, category: ${category}` : ''})`,
        );
    }

    // Check truncation before the missing-text check: thinking tokens count
    // against max_tokens, so a cut-off response can carry no text block at all —
    // and "No text in API response" would be a misleading diagnosis of it.
    if (message.stop_reason === 'max_tokens') {
        throw new Error(`Output hit max_tokens (${MAX_TOKENS}) — the summary would be truncated`);
    }

    // Join every text block: when a fallback takes over mid-answer, the text
    // before the switch and the fallback model's continuation are separate
    // blocks, and the summary is both of them together.
    const text = (message.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
    if (!text) throw new Error('No text in API response');
    return text;
}

export async function runClaude(
    client,
    content,
    label,
    effort,
    { system = CACHED_SYSTEM, format = null, usage = null } = {},
) {
    // Stream so large-PDF + adaptive-thinking requests don't hit HTTP timeouts;
    // finalMessage() aggregates the full response (usage, stop_reason, content).
    const outputConfig = { effort };
    if (format) outputConfig.format = format;
    const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: outputConfig,
        system,
        messages: [{ role: 'user', content }],
        // If a safety classifier declines an issue, the API re-runs it on the
        // model Anthropic recommends for that refusal category instead of
        // failing it. Only some categories have a fallback; the rest still come
        // back as a refusal.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
    });
    const message = await stream.finalMessage();
    logUsage(label, message.usage);
    addUsage(usage, message.usage);
    if (message.stop_reason !== 'refusal' && message.usage?.iterations?.some((it) => it.type === 'fallback_message')) {
        console.log(`    [${label}] declined by ${MODEL}; written by fallback ${message.model}`);
    }
    return extractText(message);
}

// Copies pages [start, end) of the issue into a PDF of their own.
async function slicePdf(sourceDoc, start, end) {
    const targetDoc = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);
    for (const p of await targetDoc.copyPages(sourceDoc, indices)) targetDoc.addPage(p);
    return targetDoc.save();
}

async function splitPdf(sourceDoc, pagesPerPart) {
    const pageCount = sourceDoc.getPageCount();
    const parts = [];
    for (let start = 0; start < pageCount; start += pagesPerPart) {
        const end = Math.min(start + pagesPerPart, pageCount);
        parts.push({ first: start + 1, last: end, bytes: await slicePdf(sourceDoc, start, end) });
    }
    return parts;
}

function pdfBlock(bytes) {
    return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') },
    };
}

// The check's corrections, applied by code: each `find` must occur exactly
// once. Models copying a passage tend to drop the ** and ` around it, so a
// second pass matches with those markers optional and whitespace loose.
export function applyEdits(markdown, edits) {
    let text = markdown;
    const applied = [];
    const skipped = [];
    for (const edit of edits) {
        const find = String(edit.find ?? '');
        if (!find.trim()) {
            skipped.push({ ...edit, why: 'empty find' });
            continue;
        }
        const span = locateOnce(text, find);
        if (!span) {
            skipped.push({ ...edit, why: 'not found exactly once' });
            continue;
        }
        const next = text.slice(0, span.start) + edit.replace + text.slice(span.end);
        // Bold comes in pairs; a correction that leaves one open would bold the
        // rest of the page.
        if (boldCount(next) % 2 !== boldCount(text) % 2) {
            skipped.push({ ...edit, why: 'would break bold formatting' });
            continue;
        }
        text = next;
        applied.push(edit);
    }
    // A removed sentence can leave a doubled space or an empty paragraph.
    // Indentation at the start of a line (nested lists) is left alone.
    text = text
        .replace(/(\S)[ \t]{2,}/g, '$1 ')
        .replace(/(\S) +([.,;:])/g, '$1$2')
        .replace(/\n{3,}/g, '\n\n');
    return { markdown: text, applied, skipped };
}

function locateOnce(text, find) {
    const first = text.indexOf(find);
    if (first !== -1) {
        return text.indexOf(find, first + 1) === -1 ? { start: first, end: first + find.length } : null;
    }
    const plain = find
        .replace(/\*\*|`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return null;
    // Emphasis markers may sit between any two characters of the passage, and
    // at either end of it.
    const marks = '(?:\\*\\*|`)*';
    const tokens = [...plain].map((ch) => (ch === ' ' ? '\\s+' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const re = new RegExp(`${marks}${tokens.join(marks)}${marks}`, 'g');
    const matches = [...text.matchAll(re)];
    if (matches.length !== 1) return null;
    return { start: matches[0].index, end: matches[0].index + matches[0][0].length };
}

const boldCount = (s) => (s.match(/\*\*/g) || []).length;

// What the check found missing. A paragraph goes after the line that holds its
// anchor sentence; a whole new section (## …) goes at the end, where the less
// important news sits.
export function applyAdditions(markdown, additions) {
    let text = markdown;
    const applied = [];
    const skipped = [];
    for (const add of additions) {
        const body = String(add.text ?? '').trim();
        if (!body || boldCount(body) % 2) {
            skipped.push({ ...add, why: body ? 'unbalanced bold' : 'empty text' });
            continue;
        }
        if (/^##\s/.test(body)) {
            text = `${text.trimEnd()}\n\n${body}\n`;
            applied.push(add);
            continue;
        }
        const span = locateOnce(text, String(add.after ?? ''));
        if (!span) {
            skipped.push({ ...add, why: 'anchor not found exactly once' });
            continue;
        }
        const lineEnd = text.indexOf('\n', span.end);
        const at = lineEnd === -1 ? text.length : lineEnd;
        text = `${text.slice(0, at)}\n\n${body}${text.slice(at)}`;
        applied.push(add);
    }
    return { markdown: text.replace(/\n{3,}/g, '\n\n'), applied, skipped };
}

const REPAIR_SCHEMA = {
    type: 'object',
    properties: {
        words: {
            type: 'array',
            items: {
                type: 'object',
                properties: { wrong: { type: 'string' }, right: { type: 'string' } },
                required: ['wrong', 'right'],
                additionalProperties: false,
            },
        },
    },
    required: ['words'],
    additionalProperties: false,
};

// A word typed with both alphabets ("obhвата") is replaced by the word meant,
// asked of the model with only the sentences around it; a fix that is itself
// mixed is not taken.
export async function repairMixedScript(client, markdown, usage) {
    const garbled = findMixedScriptWords(markdown);
    if (!garbled.length) return markdown;
    const context = garbled
        .map((w) => {
            const at = markdown.indexOf(w);
            return `${w} — „…${markdown.slice(Math.max(0, at - 120), at + w.length + 120).replace(/\s+/g, ' ')}…“`;
        })
        .join('\n');
    const json = await runClaude(
        client,
        [
            {
                type: 'text',
                text: `В текст на български тези думи са написани със смесени кирилски и латински букви. За всяка дай думата, която е имало предвид (\`right\`), изцяло на кирилица — или на латиница, ако е чуждо име или съкращение.\n\n${context}`,
            },
        ],
        'mixed-script repair',
        'low',
        {
            system: [{ type: 'text', text: 'Поправяш правописни грешки. Отговаряш само с поисканото.' }],
            format: { type: 'json_schema', schema: REPAIR_SCHEMA },
            usage,
        },
    );
    let text = markdown;
    for (const { wrong, right } of JSON.parse(json).words) {
        if (!garbled.includes(wrong) || !right || findMixedScriptWords(right).length) continue;
        text = text.split(wrong).join(right);
    }
    return text;
}

// Sections that the site cannot link: every ## section should end with
// "Източник: …".
export function sectionsWithoutSource(markdown) {
    return String(markdown)
        .split(/(?=^##\s)/m)
        .filter((s) => /^##\s/.test(s))
        .filter((s) => !/^Източник:\s*\S/m.test(s))
        .map((s) => s.split('\n')[0].replace(/^##\s+/, ''));
}

async function checkSummary(client, sourceDoc, draft, { year, issue, materials, usage, delayMs }) {
    const pageCount = sourceDoc.getPageCount();
    const run = async (pagesPerPart) => {
        const parts = await splitPdf(sourceDoc, pagesPerPart);
        const edits = [];
        const additions = [];
        for (const [i, part] of parts.entries()) {
            if (i > 0) await delay(delayMs);
            const range = parts.length > 1 ? `${part.first}–${part.last}` : null;
            const json = await runClaude(
                client,
                [
                    pdfBlock(part.bytes),
                    { type: 'text', text: getCheckUserPrompt(draft, year, issue, materials, range) },
                ],
                parts.length > 1 ? `check ${i + 1}/${parts.length}` : 'check',
                CHECK_EFFORT,
                { system: CACHED_CHECK_SYSTEM, format: { type: 'json_schema', schema: CHECK_SCHEMA }, usage },
            );
            const result = JSON.parse(json);
            edits.push(...result.edits);
            additions.push(...(result.additions || []));
        }
        return { edits, additions };
    };
    try {
        return await run(Math.min(CHECK_PAGES_PER_PART, pageCount));
    } catch (e) {
        if (e instanceof Anthropic.BadRequestError && /100 PDF pages/.test(e.message || '')) {
            log('The API takes at most 100 PDF pages here; checking in parts.', 'WARN');
            return run(CHECK_FALLBACK_PAGES_PER_PART);
        }
        throw e;
    }
}

// Every issue goes through the same stages, however small it is:
// 1. inventory — each part of the PDF is read for everything that could
//    matter, every line tagged with its page;
// 2. edit — the whole inventory is written up as the summary, each section
//    ending with the acts and pages it came from;
// 3. check — the summary is read against the PDF itself, and the corrections
//    are applied and kept on record.
export async function summarizePdf(pdfPath, year, issue, options) {
    const usage = newUsage();
    try {
        return await summarizeWithUsage(pdfPath, year, issue, options, usage);
    } catch (e) {
        // What the failed attempt cost goes with the error, for budgets.
        e.usage = usage;
        throw e;
    }
}

async function summarizeWithUsage(
    pdfPath,
    year,
    issue,
    { client, materials = [], delayMs = DELAY_BETWEEN_CHUNKS_MS },
    usage,
) {
    const sourceDoc = await PDFDocument.load(fs.readFileSync(pdfPath));
    const pageCount = sourceDoc.getPageCount();
    const chunks = await splitPdf(sourceDoc, PAGES_PER_CHUNK);

    console.log(`  ${pageCount} pages → ${chunks.length} chunk(s) (${PAGES_PER_CHUNK} pages each)`);
    const parts = [];
    for (const [i, chunk] of chunks.entries()) {
        if (i > 0) await delay(delayMs);
        const partLabel = `част ${i + 1} от ${chunks.length}`;
        const prompt = getSummarizeChunkPrompt(partLabel, `${chunk.first}–${chunk.last}`, year, issue);
        const md = await runClaude(
            client,
            [pdfBlock(chunk.bytes), { type: 'text', text: prompt }],
            `chunk ${i + 1}/${chunks.length}`,
            CHUNK_EFFORT,
            { system: CACHED_EXTRACT_SYSTEM, usage },
        ).catch((e) => {
            if (e instanceof Anthropic.BadRequestError && /100 PDF pages/.test(e.message || '')) {
                throw new Error('PDF part has more than 100 pages (API limit).');
            }
            throw e;
        });
        parts.push(md.trim());
    }

    const inventory = parts.join('\n');
    console.log(`  Inventory: ${inventory.split('\n').filter(Boolean).length} lines. Writing the summary...`);
    await delay(delayMs);
    const draft = cleanMarkdown(
        await runClaude(
            client,
            [{ type: 'text', text: getRefineUserPrompt(inventory, year, issue, materials) }],
            'refine',
            REFINE_EFFORT,
            {
                usage,
            },
        ),
    );

    console.log('  Checking the summary against the PDF...');
    await delay(delayMs);
    const { edits, additions } = await checkSummary(client, sourceDoc, draft, {
        year,
        issue,
        materials,
        usage,
        delayMs,
    });
    const checked = applyEdits(draft, edits);
    if (checked.skipped.length) {
        const json = await runClaude(
            client,
            [{ type: 'text', text: getRefindUserPrompt(checked.markdown, checked.skipped) }],
            'check retry',
            'medium',
            { system: CACHED_CHECK_SYSTEM, format: { type: 'json_schema', schema: CHECK_SCHEMA }, usage },
        );
        const retry = applyEdits(checked.markdown, JSON.parse(json).edits);
        checked.markdown = retry.markdown;
        checked.applied.push(...retry.applied);
        checked.skipped = retry.skipped;
    }
    const added = applyAdditions(checked.markdown, additions);
    let finalMarkdown = cleanMarkdown(added.markdown);
    console.log(
        `  Check: ${checked.applied.length} correction(s) and ${added.applied.length} addition(s) applied, ${checked.skipped.length + added.skipped.length} not applied`,
    );
    for (const s of checked.skipped) log(`Correction not applied (${s.why}): ${JSON.stringify(s.find)}`, 'WARN');
    for (const s of added.skipped)
        log(`Addition not applied (${s.why}): ${JSON.stringify(s.text.slice(0, 80))}`, 'WARN');

    // Publishing garbled words is worse than publishing nothing. A few are
    // mended by one cheap request; if any remain, the summary is dropped, the
    // PDF stays, and the next run has another go at it.
    finalMarkdown = await repairMixedScript(client, finalMarkdown, usage);
    const garbled = findMixedScriptWords(finalMarkdown);
    if (garbled.length) {
        throw new Error(`Summary mixes Cyrillic and Latin inside words: ${garbled.join(', ')}`);
    }

    const report = {
        model: MODEL,
        pageCount,
        corrections: checked.applied,
        additions: added.applied,
        notApplied: [...checked.skipped, ...added.skipped],
        sectionsWithoutSource: sectionsWithoutSource(finalMarkdown),
        usage,
        costUsd: usageCostUsd(usage),
    };
    console.log(`  Cost: ~$${report.costUsd.toFixed(2)}`);
    return { markdown: finalMarkdown, draft, inventory, report };
}

// The key comes from the environment (the workflow's secret) or, locally, from
// the project's .env.
export function createClient(options = {}) {
    if (!process.env.ANTHROPIC_API_KEY) {
        try {
            process.loadEnvFile(path.join(ROOT, '.env'));
        } catch {
            // No .env: the environment has to provide the key.
        }
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY (set it in the environment or in .env)');
    return new Anthropic({ apiKey, ...options });
}

// Summarizes one issue's PDF into issues/<year>/<NN>/<N>.md, with the check's
// record beside it in <N>.check.json. Nothing is written unless the whole
// summary is ready, so an issue is published complete or not at all; any
// failure throws and leaves the PDF for a retry.
export async function summarizeIssue(year, issue, pdfPath, options) {
    const outPath = summaryPath(year, issue);
    if (fs.existsSync(outPath)) {
        log(`Skip ${year}/${issue}: ${path.relative(ROOT, outPath)} already exists`);
        return outPath;
    }
    log(`Processing ДВ ${year}/${issue}...`);
    const { markdown, report } = await summarizePdf(pdfPath, year, issue, options);
    fs.mkdirSync(issueDir(year, issue), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
    fs.writeFileSync(checkReportPath(year, issue), `${JSON.stringify(report, null, 4)}\n`, 'utf8');
    log(`Wrote ${path.relative(ROOT, outPath)}`, 'OK');
    return outPath;
}

async function main() {
    const [year, issue, pdfArg] = process.argv.slice(2);
    if (!/^\d{4}$/.test(year || '') || !/^\d+$/.test(issue || '') || !pdfArg) {
        console.error('Usage: node scripts/summarize-gazette.js <year> <issue> <path/to/issue.pdf>');
        process.exit(1);
    }
    const pdfPath = path.resolve(pdfArg);
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    await summarizeIssue(year, issue, pdfPath, { client: createClient() });
}

if (isMain(import.meta.url)) {
    main().catch((e) => {
        console.error('[summarize-gazette]', e);
        process.exit(1);
    });
}
