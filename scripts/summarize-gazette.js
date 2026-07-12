import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { PDFDocument } from 'pdf-lib';
import Anthropic from '@anthropic-ai/sdk';
import {
    SYSTEM_PROMPT,
    EXTRACT_SYSTEM_PROMPT,
    getSummarizeChunkPrompt,
    getRefineUserPrompt,
    getCoverageCheckPrompt,
} from './ai-prompts.js';
import { cleanMarkdown, findMixedScriptWords } from './clean-markdown.js';
import { appendLog, flushAlertEmail } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// The API rejects a PDF over 100 pages per request, so a ~170-page issue must
// be split. Keep the parts as large as that limit safely allows: every part is
// one more independent judgment about what to keep, and the fewer of those
// there are — each seeing more of the issue — the less gets silently dropped.
const PAGES_PER_CHUNK = 50;
const DELAY_BETWEEN_CHUNKS_MS = 10 * 1000;
// Intermediate chunk extraction runs at medium effort (≈ Sonnet 4.6 at high, the
// previous baseline); the single-pass and refine calls keep the default (high),
// where prioritization and rule-adherence matter most for the final output.
const CHUNK_EFFORT = 'medium';
// The coverage check just compares two lists — it needs no deliberation.
const COVERAGE_EFFORT = 'low';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const ROOT = path.join(__dirname, '..');
const OFFICIAL_GAZETTES_DIR = path.join(ROOT, 'official-gazettes');
const ISSUES_DIR = path.join(ROOT, 'issues');
const SCRIPT_NAME = 'summarize-gazette';
const MODEL = 'claude-sonnet-5';
// Hard ceiling on the whole response — adaptive thinking is billed against it
// too, so the budget covers thinking + the summary text. Sonnet 5's tokenizer
// also emits noticeably more tokens for the same Bulgarian text than Sonnet 4.6
// did, so the old 16k ceiling now sits close to the edge for a dense issue.
// Requests are streamed, so a high ceiling costs nothing until it's used.
const MAX_TOKENS = 32000;

const apiKey = process.env.ANTHROPIC_API_KEY;

const client = apiKey ? new Anthropic({ apiKey }) : null;

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
    const parts = [
        `in=${usage.input_tokens ?? 0}`,
        `out=${usage.output_tokens ?? 0}`,
    ];
    if (usage.cache_creation_input_tokens) parts.push(`cache_write=${usage.cache_creation_input_tokens}`);
    if (usage.cache_read_input_tokens) parts.push(`cache_read=${usage.cache_read_input_tokens}`);
    console.log(`    [${label}] ${parts.join(' ')}`);
}

function extractText(message) {
    if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new Error('Claude declined the request (stop_reason: refusal' + (category ? `, category: ${category}` : '') + ')');
    }

    // Check truncation before the missing-text check: thinking tokens count
    // against max_tokens, so a cut-off response can carry no text block at all —
    // and "No text in API response" would be a misleading diagnosis of it.
    if (message.stop_reason === 'max_tokens') {
        throw new Error(`Output hit max_tokens (${MAX_TOKENS}) — the summary would be truncated`);
    }

    const textBlock = message.content?.find((c) => c.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error('No text in API response');
    return textBlock.text;
}

async function runClaude(content, label, effort, system = CACHED_SYSTEM) {
    // Stream so large-PDF + adaptive-thinking requests don't hit HTTP timeouts;
    // finalMessage() aggregates the full response (usage, stop_reason, content).
    const params = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system,
        messages: [{ role: 'user', content }],
    };
    if (effort) params.output_config = { effort };
    const stream = client.messages.stream(params);
    const message = await stream.finalMessage();
    logUsage(label, message.usage);
    return extractText(message);
}

function log(message, level = 'INFO') {
    appendLog(SCRIPT_NAME, message, level);
}

function fail(message, cause) {
    log(message, 'ERROR');
    if (cause) log(String(cause), 'ERROR');
    console.error('[summarize-gazette]', message);
    if (cause) console.error(cause);
    flushAlertEmail().then(() => process.exit(1));
}

// Two kinds of failure need opposite handling. An unreachable or unauthorized
// API means every remaining issue will fail the same way — stop and keep the
// quota. A failure tied to one issue's content (a refusal, a response that
// would be truncated, an unreadable PDF) says nothing about the next issue, so
// skip that issue and carry on: its PDF stays on disk and the next run retries
// it, while newer issues still reach the site.
function isInfrastructureError(e) {
    return e instanceof Anthropic.AuthenticationError
        || e instanceof Anthropic.PermissionDeniedError
        || e instanceof Anthropic.RateLimitError
        || e instanceof Anthropic.InternalServerError
        || e instanceof Anthropic.APIConnectionError;
}

function listOfficialPdfs() {
    if (!fs.existsSync(OFFICIAL_GAZETTES_DIR)) return [];
    const entries = [];
    const years = fs.readdirSync(OFFICIAL_GAZETTES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const y of years) {
        const yearDir = path.join(OFFICIAL_GAZETTES_DIR, y.name);
        const files = fs.readdirSync(yearDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
        for (const f of files) {
            const issue = path.basename(f, '.pdf');
            if (/^\d+$/.test(issue)) entries.push({ year: y.name, issue });
        }
    }
    return entries.sort((a, b) => a.year.localeCompare(b.year) || Number(a.issue) - Number(b.issue));
}

function pdfPath(year, issue) {
    return path.join(OFFICIAL_GAZETTES_DIR, String(year), `${issue}.pdf`);
}

function issueFolderName(issue) {
    return String(issue).padStart(2, '0');
}

function summaryPath(year, issue) {
    return path.join(ISSUES_DIR, String(year), issueFolderName(issue), `${Number(issue)}.md`);
}

function issueDirPath(year, issue) {
    return path.join(ISSUES_DIR, String(year), issueFolderName(issue));
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
        copiedPages.forEach((p) => targetDoc.addPage(p));
        chunks.push(await targetDoc.save());
    }
    return { chunks, pageCount };
}

async function refineSummaryWithClaude(fullMarkdown, year, issue) {
    const userPrompt = getRefineUserPrompt(fullMarkdown, year, issue);
    return runClaude([{ type: 'text', text: userPrompt }], 'refine');
}

async function summarizePdfBase64(base64, userPrompt, label = 'chunk', effort, system) {
    try {
        return await runClaude(
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
            system
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
// it silently skipped both the recall-first extraction and the coverage check:
// exactly the issues we had no visibility into. The extra call on a 16-page
// issue costs cents.
async function summarizePdf(pdfPath, year, issue) {
    const buf = fs.readFileSync(pdfPath);
    const { chunks, pageCount } = await splitPdfIntoChunks(buf);

    console.log(`  ${pageCount} pages → ${chunks.length} chunk(s) (${PAGES_PER_CHUNK} pages each)`);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await delay(DELAY_BETWEEN_CHUNKS_MS);
        const start = i * PAGES_PER_CHUNK + 1;
        const end = Math.min((i + 1) * PAGES_PER_CHUNK, pageCount);
        const partLabel = `част ${i + 1} от ${chunks.length}`;
        const prompt = getSummarizeChunkPrompt(partLabel, `${start}–${end}`, year, issue);
        const md = await summarizePdfBase64(
            Buffer.from(chunks[i]).toString('base64'),
            prompt,
            `chunk ${i + 1}/${chunks.length}`,
            CHUNK_EFFORT,
            CACHED_EXTRACT_SYSTEM
        );
        parts.push(md.trim());
    }

    const inventory = parts.join('\n');
    console.log(`  Inventory: ${inventory.split('\n').filter(Boolean).length} lines. Writing the summary...`);
    await delay(DELAY_BETWEEN_CHUNKS_MS);
    const finalMarkdown = cleanMarkdown(await refineSummaryWithClaude(inventory, year, issue));

    // Publishing garbled words is worse than publishing nothing: the summary is
    // dropped, the PDF stays, and the next run has another go at it.
    const garbled = findMixedScriptWords(finalMarkdown);
    if (garbled.length) {
        throw new Error(`Summary mixes Cyrillic and Latin inside words: ${garbled.join(', ')}`);
    }

    await reportCoverage(inventory, finalMarkdown, year, issue);

    return finalMarkdown;
}

// The editor only ever sees the inventory, so anything it leaves out is invisible
// to us as well. Read both back and say what fell out — a run that quietly covers
// four of six issues looks identical to one that covers all six.
async function reportCoverage(inventory, summary, year, issue) {
    try {
        const verdict = (await runClaude(
            [{ type: 'text', text: getCoverageCheckPrompt(inventory, summary) }],
            'coverage',
            COVERAGE_EFFORT,
            CACHED_EXTRACT_SYSTEM
        )).trim();

        if (/^НЯМА ПРОПУСКИ/i.test(verdict)) {
            log(`Coverage check ${year}/${issue}: nothing dropped`, 'OK');
            console.log('  Coverage: nothing dropped.');
            return;
        }
        log(`Coverage check ${year}/${issue} — dropped from the summary:\n${verdict}`, 'WARN');
        console.log('  Coverage — left out of the summary:\n' + verdict.split('\n').map((l) => '    ' + l).join('\n'));
    } catch (e) {
        // A failed check must not cost us a good summary.
        log(`Coverage check failed for ${year}/${issue}: ${e.message}`, 'WARN');
    }
}

async function main() {
    log('Run started', 'INFO');
    if (!apiKey) fail('Missing ANTHROPIC_API_KEY in .env');

    const yearArg = process.argv[2];
    const issueArg = process.argv[3];
    const customPdfPath = process.argv[4] ? path.resolve(process.cwd(), process.argv[4]) : null;

    let entries;
    if (customPdfPath && yearArg && issueArg) {
        entries = [{ year: yearArg, issue: issueArg }];
    } else {
        entries = listOfficialPdfs();
        if (yearArg) {
            entries = entries.filter((e) => e.year === yearArg);
            if (issueArg) entries = entries.filter((e) => e.issue === issueArg);
        }
    }

    if (entries.length === 0) {
        console.log('No PDFs to process.');
        return;
    }

    const failures = [];

    for (const { year, issue } of entries) {
        const pdf = customPdfPath || pdfPath(year, issue);
        const outPath = summaryPath(year, issue);
        if (!fs.existsSync(pdf)) {
            log(`PDF missing: ${pdf}`, 'WARN');
            if (customPdfPath) {
                fail('Custom PDF path not found: ' + pdf);
            }
            continue;
        }
        if (fs.existsSync(outPath)) {
            console.log(`Skip ${year}/${issue}.pdf (already have ${year}/${issue}.md)`);
            continue;
        }

        try {
            log(`Processing ДВ ${year}/${issue}...`, 'INFO');
            console.log(`Processing ДВ ${year}/${issue}...`);
            const issueDir = issueDirPath(year, issue);
            fs.mkdirSync(issueDir, { recursive: true });
            const markdown = await summarizePdf(pdf, year, issue);
            fs.writeFileSync(outPath, markdown, 'utf8');
            if (!customPdfPath) {
                const metaPath = path.join(OFFICIAL_GAZETTES_DIR, String(year), `${issue}.json`);
                const metaDest = path.join(issueDir, `${Number(issue)}.json`);
                if (fs.existsSync(metaPath)) {
                    fs.copyFileSync(metaPath, metaDest);
                    fs.unlinkSync(metaPath);
                }
                if (fs.existsSync(pdf)) {
                    fs.unlinkSync(pdf);
                    log(`Deleted PDF ${pdf}`, 'INFO');
                }
            }
            log(`Wrote ${outPath}`, 'OK');
            console.log(`✓ Wrote ${path.relative(ROOT, outPath)}`);
        } catch (e) {
            // Nothing was written and the PDF is still on disk, so the issue is
            // simply not published — never a half-written summary.
            failures.push(`${year}/${issue}`);
            log(`Failed ${pdf}: ${e.message}`, 'ERROR');
            console.error(`✗ Failed ${year}/${issue}:`, e.message);

            if (isInfrastructureError(e)) {
                console.error('[summarize-gazette] The API is unavailable. Stopping the run; the remaining issues will be retried next time.');
                break;
            }
            console.error('[summarize-gazette] Skipping this issue. Its PDF is kept, so the next run retries it.');
        }
    }

    if (failures.length) {
        log(`Run finished with ${failures.length} failed issue(s): ${failures.join(', ')}`, 'ERROR');
        await flushAlertEmail();
        process.exit(1);
    }
}

main().catch(async (e) => {
    log('Unhandled: ' + (e && (e.message || e)), 'ERROR');
    console.error('[summarize-gazette]', e);
    await flushAlertEmail();
    process.exit(1);
});
