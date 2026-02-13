#!/usr/bin/env node
/**
 * Generates an MP3 audio file from an issue's markdown using ElevenLabs text-to-speech.
 * Writes to issues/{year}/{XX}/{issue}.mp3. Uses eleven_multilingual_v2 and mp3_44100_128 by default (best quality). Override via .env to save credits.
 *
 * Usage: node generate-issue-audio.js <year> <issue>
 *   Or call require('./generate-issue-audio').generateIssueAudio(year, issue) from summarize-gazette.js
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const LANGUAGE_CODE = 'bg';
// Default: Multilingual v2 — best quality, natural long-form. Override with ELEVENLABS_MODEL_ID for cheaper (e.g. eleven_flash_v2_5).
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const CHUNK_LIMITS = { eleven_multilingual_v2: 9000, eleven_flash_v2_5: 39000, eleven_turbo_v2_5: 39000 };

function issueFolderName(issue) {
    return String(issue).padStart(2, '0');
}

function issueDirPath(year, issue) {
    return path.join(ISSUES_DIR, String(year), issueFolderName(issue));
}

function mdPath(year, issue) {
    return path.join(issueDirPath(year, issue), `${Number(issue)}.md`);
}

function audioPath(year, issue) {
    return path.join(issueDirPath(year, issue), `${Number(issue)}.mp3`);
}

/** Strip markdown to plain text suitable for TTS (remove links, emphasis, headings syntax). */
function markdownToPlainText(md) {
    if (!md || typeof md !== 'string') return '';
    return md
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^#+\s+/gm, '')
        .replace(/\*+|\_+/g, '')
        .replace(/`+/g, '')
        .replace(/~\s*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Split text into chunks of at most maxChars, breaking at word boundaries. */
function chunkText(text, maxChars) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxChars) {
            chunks.push(remaining);
            break;
        }
        const slice = remaining.slice(0, maxChars);
        const lastSpace = slice.lastIndexOf(' ');
        const breakAt = lastSpace > 0 ? lastSpace + 1 : maxChars;
        chunks.push(remaining.slice(0, breakAt).trim());
        remaining = remaining.slice(breakAt).trim();
    }
    return chunks;
}

/**
 * Call ElevenLabs TTS and return audio buffer.
 */
async function textToSpeech(text, apiKey, voiceId, modelId, outputFormat) {
    const url = `${ELEVENLABS_API_URL}/${voiceId}?output_format=${outputFormat}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
        },
        body: JSON.stringify({
            text,
            model_id: modelId,
            language_code: LANGUAGE_CODE,
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`ElevenLabs API ${res.status}: ${errText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
}

/**
 * Concatenate MP3 files. Tries ffmpeg first; if not installed, falls back to appending raw MP3 bytes (works for same-format streams).
 */
function concatMp3Files(inputPaths, outputPath) {
    const listPath = outputPath + '.list.txt';
    const listContent = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');
    try {
        execSync(
            `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`,
            { cwd: ROOT, stdio: 'pipe' }
        );
    } catch (e) {
        if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        try {
            const buffers = inputPaths.map((p) => fs.readFileSync(p));
            fs.writeFileSync(outputPath, Buffer.concat(buffers));
            console.warn('  [audio] ffmpeg not found; concatenated MP3 chunks without it. Install ffmpeg for best results.');
        } catch (fallbackErr) {
            throw new Error(
                'ffmpeg is required to concatenate long audio. Install it (e.g. apt install ffmpeg) or use shorter summaries. ' +
                    (e.message || '')
            );
        }
        return;
    }
    if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
}

/**
 * Generate MP3 for the given issue. Uses ELEVENLABS_API_KEY and optional ELEVENLABS_VOICE_ID.
 * @param {string} year
 * @param {string} issue
 * @param {{ maxChars?: number }} [opts] - optional maxChars to cap text (saves credits; CLI overrides env)
 * @returns {Promise<string>} Path to the generated MP3 file.
 */
function isElevenLabsEnabled() {
    if (!process.env.ELEVENLABS_API_KEY) return false;
    const v = (process.env.ELEVENLABS_ENABLED || 'true').toLowerCase();
    return v !== 'false' && v !== '0' && v !== 'off';
}

async function generateIssueAudio(year, issue, opts = {}) {
    if (!isElevenLabsEnabled()) {
        throw new Error(
            'ElevenLabs audio is disabled. Set ELEVENLABS_ENABLED=true and ELEVENLABS_API_KEY in .env to enable.'
        );
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;
    const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT;
    const maxCharsPerChunk = CHUNK_LIMITS[modelId] ?? 39000;

    const mdFilePath = mdPath(year, issue);
    if (!fs.existsSync(mdFilePath)) {
        throw new Error(`Markdown file not found: ${mdFilePath}`);
    }

    const md = fs.readFileSync(mdFilePath, 'utf8');
    let plainText = markdownToPlainText(md);
    if (!plainText) {
        throw new Error('No text content to speak');
    }
    const maxChars = opts.maxChars ?? (process.env.ELEVENLABS_MAX_CHARS ? parseInt(process.env.ELEVENLABS_MAX_CHARS, 10) : null);
    if (Number.isInteger(maxChars) && maxChars > 0 && plainText.length > maxChars) {
        plainText = plainText.slice(0, maxChars).trim();
        console.warn(`  [audio] Text capped to ${maxChars} chars to fit quota.`);
    }

    const chunks = chunkText(plainText, maxCharsPerChunk);
    const issueDir = issueDirPath(year, issue);
    fs.mkdirSync(issueDir, { recursive: true });

    const outPath = audioPath(year, issue);
    const tempDir = path.join(issueDir, '.audio_chunks');
    fs.mkdirSync(tempDir, { recursive: true });
    const chunkPaths = [];

    try {
        for (let i = 0; i < chunks.length; i++) {
            const chunkPath = path.join(tempDir, `chunk_${i}.mp3`);
            const audioBuf = await textToSpeech(chunks[i], apiKey, voiceId, modelId, outputFormat);
            fs.writeFileSync(chunkPath, audioBuf);
            chunkPaths.push(chunkPath);
        }

        if (chunkPaths.length === 1) {
            fs.copyFileSync(chunkPaths[0], outPath);
        } else {
            concatMp3Files(chunkPaths, outPath);
        }
        return outPath;
    } finally {
        for (const p of chunkPaths) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
}

async function main() {
    const yearArg = process.argv[2];
    const issueArg = process.argv[3];
    const maxCharsArg = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;
    if (!yearArg || !issueArg || !/^\d{4}$/.test(yearArg) || !/^\d+$/.test(issueArg)) {
        console.log('Usage: node generate-issue-audio.js <year> <issue> [max-chars]');
        console.log('  e.g. node generate-issue-audio.js 2026 17');
        console.log('  e.g. node generate-issue-audio.js 2026 17 2000   # cap length to fit quota');
        process.exit(1);
    }
    const outPath = await generateIssueAudio(yearArg, issueArg, { maxChars: maxCharsArg });
    console.log('✓ Wrote', path.relative(ROOT, outPath));
}

if (require.main === module) {
    main().catch((e) => {
        console.error('[generate-issue-audio]', e.message || e);
        process.exit(1);
    });
}

module.exports = { generateIssueAudio, audioPath, mdPath, isElevenLabsEnabled };
