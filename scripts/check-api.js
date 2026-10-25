#!/usr/bin/env node
// Sends one tiny request down the summarizer's own call path (same model,
// thinking, fallback beta and streaming) to confirm the Claude API and the SDK
// still agree. Run it after upgrading @anthropic-ai/sdk; it costs about a cent.
// On GitHub: Actions → API check → Run workflow.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createClient, runClaude } from './summarize-gazette.js';

try {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 120]).drawText('gazette.bg API check', { x: 20, y: 60, size: 14, font });
    const data = Buffer.from(await doc.save()).toString('base64');

    const text = await runClaude(
        createClient(),
        [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
            { type: 'text', text: 'What text is on this page? Reply with the text only.' },
        ],
        'api-check',
        'low',
        [{ type: 'text', text: 'Answer in one short line.' }],
    );
    console.log(`[check-api] OK: Claude read the test page as "${text.trim()}"`);
} catch (e) {
    console.error('[check-api] FAILED:', e);
    process.exit(1);
}
