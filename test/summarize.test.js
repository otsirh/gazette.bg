import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import {
    applyAdditions,
    applyEdits,
    sectionsWithoutSource,
    summarizePdf,
    usageCostUsd,
} from '../scripts/summarize-gazette.js';

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
                    model: 'claude-opus-5-5',
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

const NO_EDITS = '{"edits":[]}';

test('an issue is read in parts, written up, then checked against the PDF', async () => {
    const check = JSON.stringify({
        edits: [{ find: 'от **1 март**', replace: 'от **1 април**', reason: 'В броя е 1 април.', page: 2 }],
    });
    const { client, requests } = fakeClaude([
        ['[стр. 2] инвентар'],
        ['## Тема\n\nВажи от **1 март** с "кавички".\n\nИзточник: акт 1'],
        [check],
    ]);
    const materials = [{ page: 2, id: 9, issuer: 'Министерски съвет', title: 'Постановление № 1' }];
    const { markdown, report } = await summarizePdf(pdfPath, '2026', '97', { client, materials, delayMs: 0 });

    assert.equal(markdown, '## Тема\n\nВажи от **1 април** с „кавички“.\n\nИзточник: акт 1\n');
    assert.equal(report.corrections.length, 1);
    assert.deepEqual(report.sectionsWithoutSource, []);
    assert.equal(requests.length, 3);
    const [chunk, refine, checkReq] = requests;
    for (const { url, headers, body } of requests) {
        assert.match(url, /\/v1\/messages/);
        assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
        assert.equal(body.model, 'claude-opus-5-5');
        assert.equal(body.stream, true);
        assert.deepEqual(body.thinking, { type: 'adaptive' });
        assert.equal(body.fallbacks, 'default');
        assert.equal(body.system[0].cache_control.type, 'ephemeral');
        assert.equal(body.temperature, undefined);
    }
    assert.equal(chunk.body.output_config.effort, 'high');
    assert.equal(chunk.body.messages[0].content[0].type, 'document');
    assert.equal(chunk.body.messages[0].content[0].source.media_type, 'application/pdf');
    assert.equal(refine.body.output_config.effort, 'xhigh');
    assert.match(refine.body.messages[0].content[0].text, /\[стр\. 2\] инвентар/);
    assert.match(refine.body.messages[0].content[0].text, /акт 1 · стр\. 2 · Министерски съвет — Постановление № 1/);
    assert.equal(checkReq.body.output_config.effort, 'xhigh');
    assert.equal(checkReq.body.output_config.format.type, 'json_schema');
    assert.equal(checkReq.body.messages[0].content[0].type, 'document', 'the check sees the PDF');
    assert.match(checkReq.body.messages[0].content[1].text, /Важи от \*\*1 март\*\*/);
    assert.match(checkReq.body.messages[0].content[1].text, /акт 1 · стр\. 2/, 'the check sees the acts list');
});

test('a correction that does not match is tried once more without the PDF', async () => {
    const miss = JSON.stringify({
        edits: [{ find: 'от 5 март', replace: 'от 1 април', reason: 'Е 1 април.', page: 2 }],
    });
    const hit = JSON.stringify({
        edits: [{ find: 'от 1 март', replace: 'от 1 април', reason: 'Е 1 април.', page: 2 }],
    });
    const { client, requests } = fakeClaude([
        ['- инвентар'],
        ['## Тема\n\nВажи от 1 март.\n\nИзточник: акт 1'],
        [miss],
        [hit],
    ]);
    const { markdown, report } = await summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 });
    assert.match(markdown, /Важи от 1 април\./);
    assert.equal(report.notApplied.length, 0);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].body.messages[0].content[0].type, 'text', 'the retry sends no PDF');
});

test('a refusal fails the issue instead of publishing it', async () => {
    const { client } = fakeClaude([['', 'refusal']]);
    await assert.rejects(summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 }), /declined/);
});

test('a truncated summary fails the issue', async () => {
    const { client } = fakeClaude([['- инвентар'], ['## Тема', 'max_tokens']]);
    await assert.rejects(summarizePdf(pdfPath, '2026', '97', { client, delayMs: 0 }), /max_tokens/);
});

test('a garbled word is mended once, and fails the issue if it stays', async () => {
    const mended = fakeClaude([
        ['- инвентар'],
        ['## Тема\n\nВ обхвата е obhвата.'],
        [NO_EDITS],
        ['{"words":[{"wrong":"obhвата","right":"обхвата"}]}'],
    ]);
    const { markdown } = await summarizePdf(pdfPath, '2026', '97', { client: mended.client, delayMs: 0 });
    assert.equal(markdown, '## Тема\n\nВ обхвата е обхвата.\n');
    assert.equal(mended.requests[3].body.messages[0].content[0].type, 'text', 'the repair sends no PDF');

    const stuck = fakeClaude([
        ['- инвентар'],
        ['## Тема\n\nobhвата'],
        [NO_EDITS],
        ['{"words":[{"wrong":"obhвата","right":"obhвата"}]}'],
    ]);
    const failure = await summarizePdf(pdfPath, '2026', '97', { client: stuck.client, delayMs: 0 }).catch((e) => e);
    assert.match(failure.message, /mixes Cyrillic and Latin/);
    assert.ok(failure.usage.input > 0, 'a failure says what it cost');
});

test('corrections apply once, tolerate dropped emphasis, and skip what is ambiguous', () => {
    const md = 'Таксата е **12,50 евро** от **1 март**.\n\nДа. Да.\n\n  - вложен ред';
    const { markdown, applied, skipped } = applyEdits(md, [
        { find: 'Таксата е 12,50 евро', replace: 'Таксата е **13,50 евро**', reason: '', page: 1 },
        { find: 'Да.', replace: 'Не.', reason: '', page: 1 },
        { find: ' от **1 март**', replace: '', reason: '', page: 1 },
    ]);
    assert.equal(markdown, 'Таксата е **13,50 евро**.\n\nДа. Да.\n\n  - вложен ред');
    assert.equal(applied.length, 2);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].why, /exactly once/);
});

test('sections without a source line are reported', () => {
    assert.deepEqual(sectionsWithoutSource('## А\n\nТекст.\n\nИзточник: акт 1\n\n## Б\n\nТекст.'), ['Б']);
});

test('usage is priced at Opus 5.5 list prices', () => {
    assert.equal(usageCostUsd({ input: 1_000_000, output: 100_000, cacheWrite: 0, cacheRead: 0 }), 6);
});

test('missed items are added after their anchor, or as a section at the end', () => {
    const md = '## А\n\nПърво изречение. Последно изречение.\n\nИзточник: акт 1\n';
    const { markdown, applied, skipped } = applyAdditions(md, [
        { after: 'Последно изречение.', text: 'Нов абзац с **срок**.', reason: '', page: 2 },
        { after: '', text: '## Б\n\nОще.\n\nИзточник: стр. 9', reason: '', page: 9 },
        { after: 'Няма такова.', text: 'Абзац.', reason: '', page: 3 },
        { after: 'Първо изречение.', text: 'Счупен **болд.', reason: '', page: 3 },
    ]);
    assert.equal(
        markdown,
        '## А\n\nПърво изречение. Последно изречение.\n\nНов абзац с **срок**.\n\nИзточник: акт 1\n\n## Б\n\nОще.\n\nИзточник: стр. 9\n',
    );
    assert.equal(applied.length, 2);
    assert.deepEqual(
        skipped.map((s) => s.why),
        ['anchor not found exactly once', 'unbalanced bold'],
    );
});
