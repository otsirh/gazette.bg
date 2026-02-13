// Reads PDFs from official-gazettes/{year}/{issue}.pdf, sends each to the Claude API for summarization,
// and writes markdown to issues/{year}/{XX}/{issue}.md (XX = zero-padded issue). Deletes the PDF after success.
// Skips PDFs that already have a summary. Requires ANTHROPIC_API_KEY in .env.
// Note: Claude API accepts at most 100 pages per PDF. Longer PDFs are split into
// chunks of 100 pages, each chunk is summarized, then the full combined text is
// sent back to Claude once (no PDF) for a final refinement and structured output
// (issue number, date, summary).
//
// Usage: node summarize-gazette.js [year] [issue] [customPdfPath]
//   No args: process all PDFs in official-gazettes/
//   year only: process all PDFs in official-gazettes/year/
//   year and issue: process only official-gazettes/year/issue.pdf
//   year, issue, customPdfPath: use customPdfPath as PDF (e.g. from download script); do not delete PDF or copy json.
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PDFDocument } = require('pdf-lib');
const {
    SYSTEM_PROMPT,
    getSummarizePrompt,
    getSummarizeChunkPrompt,
    getRefineUserPrompt,
} = require('./ai-prompts');

// API: max 100 pages/PDF, ~200k tokens/request, ~30k input tokens/min. Use small chunks to stay under both.
const PAGES_PER_CHUNK = 12;
// One chunk per minute keeps us under 30k input tokens/min for dense PDFs.
const DELAY_BETWEEN_CHUNKS_MS = 60 * 1000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const { appendLog, flushAlertEmail } = require('./logger');

const ROOT = path.join(__dirname, '..');
const OFFICIAL_GAZETTES_DIR = path.join(ROOT, 'official-gazettes');
const ISSUES_DIR = path.join(ROOT, 'issues');
const SCRIPT_NAME = 'summarize-gazette';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 8192;

const apiKey = process.env.ANTHROPIC_API_KEY;

function log(message, level = 'INFO') {
    appendLog(SCRIPT_NAME, message, level);
}

function fail(message, cause) {
    log(message, 'ERROR');
    if (cause) log(String(cause), 'ERROR');
    console.error('[summarize-gazette]', message);
    if (cause) console.error(cause);
    process.exit(1);
}

// List all official-gazettes/{year}/{issue}.pdf as { year, issue } (issue is the base name, e.g. "12")
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

/** Split a PDF buffer into chunks of at most PAGES_PER_CHUNK pages. Returns array of PDF buffers. */
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

/** Call Claude with text only (no PDF). Used for final refinement of combined chunk summaries. */
async function refineSummaryWithClaude(fullMarkdown, year, issue, retried = false) {
    const userPrompt = getRefineUserPrompt(fullMarkdown, year, issue);
    const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text: userPrompt }],
            },
        ],
    };

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        if (res.status === 429 && !retried) {
            log('Rate limited (429) on final pass, waiting 2 min then retrying...', 'WARN');
            console.log(`  Rate limited (429) on final pass, waiting 2 min then retrying...`);
            await delay(2 * 60 * 1000);
            return refineSummaryWithClaude(fullMarkdown, year, issue, true);
        }
        throw new Error(`API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const textBlock = data.content?.find((c) => c.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error('No text in API response (final pass)');
    return textBlock.text;
}

/** Call Claude with one PDF (base64). Returns markdown. Retries once on 429. */
async function summarizePdfBase64(base64, userPrompt, retried = false) {
    const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: [
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
            },
        ],
    };

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        if (res.status === 429 && !retried) {
            log('Rate limited (429), waiting 2 min then retrying...', 'WARN');
            console.log(`  Rate limited (429), waiting 2 min then retrying...`);
            await delay(2 * 60 * 1000);
            return summarizePdfBase64(base64, userPrompt, true);
        }
        let msg = `API ${res.status}: ${errText}`;
        if (res.status === 400 && errText.includes('100 PDF pages')) {
            msg = 'PDF has more than 100 pages (API limit). Split the PDF or use a shorter document.';
        }
        throw new Error(msg);
    }

    const data = await res.json();
    const textBlock = data.content?.find((c) => c.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error('No text in API response');
    return textBlock.text;
}

async function summarizePdf(pdfPath, year, issue) {
    const buf = fs.readFileSync(pdfPath);
    const { chunks, pageCount } = await splitPdfIntoChunks(buf);

    if (chunks.length === 1) {
        return summarizePdfBase64(
            Buffer.from(chunks[0]).toString('base64'), 
            getSummarizePrompt(year, issue)
        );
    }

    console.log(`  ${pageCount} pages → ${chunks.length} chunks (${PAGES_PER_CHUNK} pages each)`);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            console.log(`  Waiting ${DELAY_BETWEEN_CHUNKS_MS / 60000} min before next chunk (rate limit)...`);
            await delay(DELAY_BETWEEN_CHUNKS_MS);
        } else if (chunks.length > 1) {
            console.log(`  Waiting ${DELAY_BETWEEN_CHUNKS_MS / 60000} min before first chunk (rate limit)...`);
            await delay(DELAY_BETWEEN_CHUNKS_MS);
        }
        const start = i * PAGES_PER_CHUNK + 1;
        const end = Math.min((i + 1) * PAGES_PER_CHUNK, pageCount);
        const partLabel = `част ${i + 1} от ${chunks.length}`;
        const prompt = getSummarizeChunkPrompt(partLabel, `${start}–${end}`, year, issue);
        const md = await summarizePdfBase64(Buffer.from(chunks[i]).toString('base64'), prompt);
        parts.push(md.trim());
    }

    // Combined text from all chunks
    const combined = parts.join('\n\n');
    console.log(`  Sending full summary to Claude for final pass...`);
    if (DELAY_BETWEEN_CHUNKS_MS > 0) {
        await delay(Math.min(DELAY_BETWEEN_CHUNKS_MS, 15 * 1000));
    }
    const finalMarkdown = await refineSummaryWithClaude(combined, year, issue);
    return finalMarkdown.trim();
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
            if (process.env.ELEVENLABS_API_KEY) {
                try {
                    const { createIssueAudioNative } = require('./create-audio-native');
                    const { metaPath } = await createIssueAudioNative(year, issue);
                    log(`Wrote Audio Native ${metaPath}`, 'OK');
                    console.log(`✓ Audio Native ${path.relative(ROOT, metaPath)}`);
                } catch (audioNativeErr) {
                    log(`Audio Native failed: ${audioNativeErr.message}`, 'WARN');
                    console.warn(`  [audio-native] ${audioNativeErr.message}`);
                }
            }
        } catch (e) {
            log(`Failed ${pdf}: ${e.message}`, 'ERROR');
            console.error(`✗ Failed ${year}/${issue}:`, e.message);
            console.error('[summarize-gazette] Anthropic API failed. Stopping (exit 1).');
            await flushAlertEmail();
            process.exit(1);
        }
    }
}

main().catch((e) => {
    log('Unhandled: ' + (e && (e.message || e)), 'ERROR');
    console.error('[summarize-gazette]', e);
    process.exit(1);
});
