#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { EXTRACT_SYSTEM_PROMPT, getRefineUserPrompt, getSummarizeChunkPrompt, SYSTEM_PROMPT } from './ai-prompts.js';
import { cleanMarkdown, findMixedScriptWords } from './clean-markdown.js';
import { createLogger, isMain } from './lib/cli.js';
import { issueDir, ROOT, summaryPath } from './lib/issues.js';

// The API rejects a PDF over 100 pages per request, so a ~170-page issue must
// be split. Keep the parts as large as that limit safely allows: every part is
// one more independent judgment about what to keep, and the fewer of those
// there are — each seeing more of the issue — the less gets silently dropped.
const PAGES_PER_CHUNK = 50;
const DELAY_BETWEEN_CHUNKS_MS = 10 * 1000;
// Intermediate chunk extraction runs at medium effort; the refine call runs at
// high, where prioritization and rule-adherence matter most for the final
// output. Both are explicit because Sonnet 5.5 recalibrated the levels — the
// same name no longer means the same amount of thinking as on Sonnet 5.
const CHUNK_EFFORT = 'medium';
const REFINE_EFFORT = 'high';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODEL = 'claude-sonnet-5-5';
// Hard ceiling on the whole response — adaptive thinking is billed against it
// too, so the budget covers thinking + the summary text. The Sonnet 5 tokenizer
// (Sonnet 5.5 shares it) emits noticeably more tokens for the same Bulgarian
// text than Sonnet 4.6 did, so a 16k ceiling sits close to the edge for a dense issue.
// Requests are streamed, so a high ceiling costs nothing until it's used.
const MAX_TOKENS = 32000;

const log = createLogger('summarize-gazette');

const CACHED_SYSTEM = [
    {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
    },
];

const CACHED_EXTRACT_SYSTEM = [
    {
        type: 'text',
        text: EXTRACT_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
    },
];

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

export async function runClaude(client, content, label, effort, system = CACHED_SYSTEM) {
    // Stream so large-PDF + adaptive-thinking requests don't hit HTTP timeouts;
    // finalMessage() aggregates the full response (usage, stop_reason, content).
    const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort },
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
    if (message.stop_reason !== 'refusal' && message.usage?.iterations?.some((it) => it.type === 'fallback_message')) {
        console.log(`    [${label}] declined by ${MODEL}; written by fallback ${message.model}`);
    }
    return extractText(message);
}

async function splitPdfIntoChunks(pdfBytes) {
    const sourceDoc = await PDFDocument.load(pdfBytes);
    const pageCount = sourceDoc.getPageCount();
    const chunks = [];
    for (let start = 0; start < pageCount; start += PAGES_PER_CHUNK) {
        const end = Math.min(start + PAGES_PER_CHUNK, pageCount);
        const indices = [];
        for (let i = start; i < end; i++) indices.push(i);
        const targetDoc = await PDFDocument.create();
        const copiedPages = await targetDoc.copyPages(sourceDoc, indices);
        for (const p of copiedPages) targetDoc.addPage(p);
        chunks.push(await targetDoc.save());
    }
    return { chunks, pageCount };
}

async function summarizePdfBase64(client, base64, userPrompt, label, effort, system) {
    try {
        return await runClaude(
            client,
            [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: base64,
                    },
                },
                { type: 'text', text: userPrompt },
            ],
            label,
            effort,
            system,
        );
    } catch (e) {
        if (e instanceof Anthropic.BadRequestError && /100 PDF pages/.test(e.message || '')) {
            throw new Error('PDF has more than 100 pages (API limit). Split the PDF or use a shorter document.');
        }
        throw e;
    }
}

// Every issue goes through the same two stages — inventory, then edit — however
// small it is. A short issue used to be summarized in a single pass, which meant
// it silently skipped the recall-first extraction: exactly the issues we had no
// visibility into. The extra call on a 16-page issue costs cents.
export async function summarizePdf(pdfPath, year, issue, { client, delayMs = DELAY_BETWEEN_CHUNKS_MS }) {
    const buf = fs.readFileSync(pdfPath);
    const { chunks, pageCount } = await splitPdfIntoChunks(buf);

    console.log(`  ${pageCount} pages → ${chunks.length} chunk(s) (${PAGES_PER_CHUNK} pages each)`);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await delay(delayMs);
        const start = i * PAGES_PER_CHUNK + 1;
        const end = Math.min((i + 1) * PAGES_PER_CHUNK, pageCount);
        const partLabel = `част ${i + 1} от ${chunks.length}`;
        const prompt = getSummarizeChunkPrompt(partLabel, `${start}–${end}`, year, issue);
        const md = await summarizePdfBase64(
            client,
            Buffer.from(chunks[i]).toString('base64'),
            prompt,
            `chunk ${i + 1}/${chunks.length}`,
            CHUNK_EFFORT,
            CACHED_EXTRACT_SYSTEM,
        );
        parts.push(md.trim());
    }

    const inventory = parts.join('\n');
    console.log(`  Inventory: ${inventory.split('\n').filter(Boolean).length} lines. Writing the summary...`);
    await delay(delayMs);
    const refinePrompt = getRefineUserPrompt(inventory, year, issue);
    const finalMarkdown = cleanMarkdown(
        await runClaude(client, [{ type: 'text', text: refinePrompt }], 'refine', REFINE_EFFORT),
    );

    // Publishing garbled words is worse than publishing nothing: the summary is
    // dropped, the PDF stays, and the next run has another go at it.
    const garbled = findMixedScriptWords(finalMarkdown);
    if (garbled.length) {
        throw new Error(`Summary mixes Cyrillic and Latin inside words: ${garbled.join(', ')}`);
    }

    return finalMarkdown;
}

// The key comes from the environment (the workflow's secret) or, locally, from
// the project's .env.
export function createClient() {
    if (!process.env.ANTHROPIC_API_KEY) {
        try {
            process.loadEnvFile(path.join(ROOT, '.env'));
        } catch {
            // No .env: the environment has to provide the key.
        }
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY (set it in the environment or in .env)');
    return new Anthropic({ apiKey });
}

// Summarizes one issue's PDF into issues/<year>/<NN>/<N>.md. Nothing is
// written unless the whole summary is ready, so an issue is published complete
// or not at all; any failure throws and leaves the PDF for a retry.
export async function summarizeIssue(year, issue, pdfPath, options) {
    const outPath = summaryPath(year, issue);
    if (fs.existsSync(outPath)) {
        log(`Skip ${year}/${issue}: ${path.relative(ROOT, outPath)} already exists`);
        return outPath;
    }
    log(`Processing ДВ ${year}/${issue}...`);
    const markdown = await summarizePdf(pdfPath, year, issue, options);
    fs.mkdirSync(issueDir(year, issue), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
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
