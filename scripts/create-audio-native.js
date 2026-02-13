#!/usr/bin/env node
/**
 * Creates an ElevenLabs Audio Native project from an issue's markdown and saves
 * the embed snippet to issues/{year}/{XX}/{issue}.audio-native.json.
 * Requires ELEVENLABS_API_KEY. Enable Audio Native and whitelist your domain at
 * https://elevenlabs.io (Projects → Audio Native).
 *
 * Usage: node create-audio-native.js <year> <issue>
 *   e.g. node create-audio-native.js 2026 17
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const ELEVENLABS_AUDIO_NATIVE_URL = 'https://api.elevenlabs.io/v1/audio-native';

function issueFolderName(issue) {
    return String(issue).padStart(2, '0');
}

function issueDirPath(year, issue) {
    return path.join(ISSUES_DIR, String(year), issueFolderName(issue));
}

function mdPath(year, issue) {
    return path.join(issueDirPath(year, issue), `${Number(issue)}.md`);
}

function audioNativeMetaPath(year, issue) {
    return path.join(issueDirPath(year, issue), `${Number(issue)}.audio-native.json`);
}

function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Convert markdown to simple HTML for Audio Native: <html><body><div><p>...</p><h2>...</h2>...</div></body></html> */
function markdownToAudioNativeHtml(md) {
    if (!md || typeof md !== 'string') return '';
    const lines = md
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*+|\_+/g, '')
        .replace(/`+/g, '')
        .replace(/~\s*/g, '')
        .split(/\n/);
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
            i++;
            continue;
        }
        if (/^###\s+/.test(trimmed)) {
            blocks.push('<h3>' + escapeHtml(trimmed.replace(/^###\s+/, '')) + '</h3>');
            i++;
            continue;
        }
        if (/^##\s+/.test(trimmed)) {
            blocks.push('<h2>' + escapeHtml(trimmed.replace(/^##\s+/, '')) + '</h2>');
            i++;
            continue;
        }
        if (/^#\s+/.test(trimmed)) {
            blocks.push('<h1>' + escapeHtml(trimmed.replace(/^#\s+/, '')) + '</h1>');
            i++;
            continue;
        }
        const para = [trimmed];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
            para.push(lines[i].trim());
            i++;
        }
        blocks.push('<p>' + escapeHtml(para.join(' ')) + '</p>');
    }
    return '<html><body><div>\n' + blocks.join('\n') + '\n</div></body></html>';
}

/**
 * Create an Audio Native project via ElevenLabs API.
 * @returns {{ project_id: string, converting: boolean, html_snippet: string }}
 */
async function createAudioNativeProject(options) {
    const { apiKey, name, title, author, htmlContent, voiceId, modelId, autoConvert } = options;
    const form = new FormData();
    form.append('name', name);
    if (title) form.append('title', title);
    if (author) form.append('author', author);
    form.append('file', new Blob([htmlContent], { type: 'text/html' }), 'article.html');
    if (voiceId) form.append('voice_id', voiceId);
    if (modelId) form.append('model_id', modelId);
    form.append('auto_convert', autoConvert !== false ? 'true' : 'false');
    form.append('apply_text_normalization', 'off');

    const res = await fetch(ELEVENLABS_AUDIO_NATIVE_URL, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
        },
        body: form,
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`ElevenLabs Audio Native API ${res.status}: ${errText}`);
    }
    return res.json();
}

async function createIssueAudioNative(year, issue) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error('ELEVENLABS_API_KEY is required. Set it in .env');
    }
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

    const mdFilePath = mdPath(year, issue);
    if (!fs.existsSync(mdFilePath)) {
        throw new Error(`Markdown file not found: ${mdFilePath}`);
    }
    const md = fs.readFileSync(mdFilePath, 'utf8');
    const htmlContent = markdownToAudioNativeHtml(md);
    if (!htmlContent || htmlContent.length < 100) {
        throw new Error('No sufficient content to create Audio Native project');
    }

    const issueNum = Number(issue);
    const projectName = `ДВ брой ${issueNum}`;
    const projectTitle = `Обобщение на Държавен вестник, брой ${issueNum}`;

    const result = await createAudioNativeProject({
        apiKey,
        name: projectName,
        title: projectTitle,
        author: 'Държавен вестник',
        htmlContent,
        voiceId,
        modelId,
        autoConvert: true,
    });

    const issueDir = issueDirPath(year, issue);
    fs.mkdirSync(issueDir, { recursive: true });
    const metaPath = audioNativeMetaPath(year, issue);
    const meta = {
        project_id: result.project_id,
        converting: result.converting,
        html_snippet: result.html_snippet,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return { metaPath, ...result };
}

async function main() {
    const yearArg = process.argv[2];
    const issueArg = process.argv[3];
    if (!yearArg || !issueArg || !/^\d{4}$/.test(yearArg) || !/^\d+$/.test(issueArg)) {
        console.log('Usage: node create-audio-native.js <year> <issue>');
        console.log('  e.g. node create-audio-native.js 2026 17');
        console.log('');
        console.log('Enable Audio Native and whitelist your domain at https://elevenlabs.io (Projects → Audio Native).');
        process.exit(1);
    }
    const { metaPath, project_id, converting } = await createIssueAudioNative(yearArg, issueArg);
    console.log('✓ Created Audio Native project:', project_id, converting ? '(converting…)' : '');
    console.log('  Wrote', path.relative(ROOT, metaPath));
}

if (require.main === module) {
    main().catch((e) => {
        console.error('[create-audio-native]', e.message || e);
        process.exit(1);
    });
}

module.exports = {
    createIssueAudioNative,
    createAudioNativeProject,
    audioNativeMetaPath,
    markdownToAudioNativeHtml,
};
