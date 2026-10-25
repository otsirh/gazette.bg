import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { summarizePdf } from '../scripts/summarize-gazette.js';

// The summarizer against a stand-in for the Claude API: the requests it sends
// and what it makes of the streamed replies. Guards the call path across SDK
// upgrades without spending anything.

function sse(text, stopReason = 'end_turn') {
    const events = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'msg_test',
                    type: 'message',
                    role: 'assistant',
                    model: 'claude-sonnet-5-5',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 1 },
                },
            },
        ],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: 5 },
            },
        ],
        ['message_stop', { type: 'message_stop' }],
    ];
    return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function fakeClaude(replies) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
        const [text, stopReason] = replies[requests.length - 1];
        return new Response(sse(text, stopReason), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    return { client: new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }), requests };
}

const pdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gazette-pdf-')), 'issue.pdf');
const doc = await PDFDocument.create();
for (let i = 0; i < 3; i++) doc.addPage([200, 200]);
fs.writeFileSync(pdfPath, await doc.save());

beforeEach((t) => t.mock.method(console, 'log', () => {}));

test('an issue is read in parts, then written up in one edit pass', async () => {
    const { client, requests } = fakeClaude([['- инвентар'], ['## Тема\n\nТекст с "кавички".']]);
    const markdown = await summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 });

    assert.equal(markdown, '## Тема\n\nТекст с „кавички“.\n');
    assert.equal(requests.length, 2);
    const [chunk, refine] = requests;
    for (const { url, headers, body } of requests) {
        assert.match(url, /\/v1\/messages/);
        assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
        assert.equal(body.model, 'claude-sonnet-5-5');
        assert.equal(body.stream, true);
        assert.deepEqual(body.thinking, { type: 'adaptive' });
        assert.equal(body.fallbacks, 'default');
        assert.equal(body.system[0].cache_control.type, 'ephemeral');
        assert.equal(body.temperature, undefined);
    }
    assert.equal(chunk.body.output_config.effort, 'medium');
    assert.equal(chunk.body.messages[0].content[0].type, 'document');
    assert.equal(chunk.body.messages[0].content[0].source.media_type, 'application/pdf');
    assert.equal(refine.body.output_config.effort, 'high');
    assert.match(refine.body.messages[0].content[0].text, /- инвентар/);
});

test('a refusal fails the issue instead of publishing it', async () => {
    const { client } = fakeClaude([['', 'refusal']]);
    await assert.rejects(summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 }), /declined/);
});

test('a truncated summary fails the issue', async () => {
    const { client } = fakeClaude([['- инвентар'], ['## Тема', 'max_tokens']]);
    await assert.rejects(summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 }), /max_tokens/);
});

test('a summary with garbled words fails the issue', async () => {
    const { client } = fakeClaude([['- инвентар'], ['## Тема\n\nobhвата']]);
    await assert.rejects(summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 }), /mixes Cyrillic and Latin/);
});
