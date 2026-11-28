#!/usr/bin/env node
// A blind comparison of how well each setup writes Bulgarian: the same
// stories written by Haiku (as now), Haiku with more thinking, and Sonnet;
// and Haiku's text proofread by Haiku or by Sonnet. A stronger model (Opus),
// not told which text is which, lists every spelling, grammar and
// punctuation error. Prints errors and cost per setup, and a few samples.
//
//   ANTHROPIC_API_KEY=… node live/scripts/eval-writing.js [stories=20]
//
// Input is each story's latest headlines only (article texts are not kept),
// so this measures the language, not how complete a summary is.
import { askJson, BULGARIAN, OVERVIEW_MODEL, proofread, writeStory } from '../lib/ai.js';
import { rankStories } from '../lib/stories.js';
import { tidy } from '../lib/text.js';
import { SOURCE_BY_ID } from '../sources.js';

const N = Number(process.argv[2] ?? 20);
const JUDGE = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const state = await (await fetch(process.env.LIVE_STATE_URL ?? 'https://live.gazette.bg/state.json')).json();
const now = state.updatedAt;
const sourceName = (id) => (SOURCE_BY_ID.get(id)?.name ?? id).replace(/ \(видео\)$/, '');

const picked = rankStories(state.stories, now)
    .map((r) => r.story)
    .filter((s) => !s.sensitive && s.items.filter((i) => i.title?.trim()).length >= 4)
    .slice(0, N);

const SETUPS = [
    { id: 'A', label: 'Haiku, medium (сега)', model: HAIKU, effort: 'medium' },
    { id: 'B', label: 'Haiku, high', model: HAIKU, effort: 'high' },
    { id: 'C', label: 'Sonnet, medium', model: OVERVIEW_MODEL, effort: 'medium' },
];
const meters = Object.fromEntries(
    ['A', 'B', 'C', 'A+proofHaiku', 'A+proofSonnet', 'judge'].map((k) => [k, { usd: 0, calls: 0 }]),
);

const textsOf = (r) => [r.title, r.summary, ...(r.events ?? []).map((e) => e.what)].filter(Boolean).map(tidy);

const results = [];
for (const s of picked) {
    const newItems = s.items
        .filter((i) => i.title?.trim())
        .sort((a, b) => b.at - a.at)
        .slice(0, 12);
    const stub = { id: s.id, title: '', summary: '', timeline: [] };
    const out = {};
    for (const set of SETUPS) {
        try {
            const r = await writeStory({
                story: stub,
                newItems,
                texts: new Map(),
                sourceName,
                meter: meters[set.id],
                model: set.model,
                effort: set.effort,
            });
            out[set.id] = textsOf(r);
        } catch (err) {
            console.log(`${s.id} ${set.id}: ${err.message}`);
        }
    }
    if (!out.A) continue;
    for (const [key, model] of [
        ['A+proofHaiku', HAIKU],
        ['A+proofSonnet', OVERVIEW_MODEL],
    ]) {
        const fixes = await proofread({ texts: out.A, meter: meters[key], model });
        out[key] = out.A.map((t, i) => (fixes.has(i) ? tidy(fixes.get(i)) : t));
    }
    results.push({ story: s, out });
}

// The judge sees each story's versions in a shuffled order, unlabeled.
const JUDGE_SYSTEM = `Ти си строг коректор на български новинарски текстове. Получаваш няколко версии (V1, V2, …) на кратки текстове за една и съща новина. За всяка версия изброй ВСИЧКИ правописни, граматически и пунктуационни грешки според официалния правописен речник на БАН: член, запетаи, кавички („…“), тирета, слято и разделно писане, главни букви, съгласуване, бройна форма, десетична запетая. Не отбелязвай стил, факти или избор на думи, само езикови грешки. Ако версия няма грешки, върни празен списък.

${BULGARIAN}`;
const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        versions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    v: { type: 'string' },
                    errors: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                wrong: { type: 'string' },
                                right: { type: 'string' },
                                kind: { type: 'string' },
                            },
                            required: ['wrong', 'right', 'kind'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['v', 'errors'],
                additionalProperties: false,
            },
        },
    },
    required: ['versions'],
    additionalProperties: false,
};

const tally = {};
const words = {};
const samples = [];
for (const { story, out } of results) {
    const keys = Object.keys(out).sort(() => Math.random() - 0.5);
    const user = keys.map((k, i) => `### V${i + 1}\n${out[k].join('\n')}`).join('\n\n');
    let verdict;
    try {
        verdict = await askJson({
            model: JUDGE,
            system: JUDGE_SYSTEM,
            user,
            schema: JUDGE_SCHEMA,
            effort: 'high',
            meter: meters.judge,
            label: `judge ${story.id}`,
        });
    } catch (err) {
        console.log(`judge ${story.id}: ${err.message}`);
        continue;
    }
    for (const v of verdict.versions) {
        const k = keys[Number(v.v.replace(/\D/g, '')) - 1];
        if (!k) continue;
        tally[k] = (tally[k] ?? 0) + v.errors.length;
        if (samples.length < 40 && v.errors.length)
            samples.push(`${k}: «${v.errors[0].wrong}» → «${v.errors[0].right}» (${v.errors[0].kind})`);
    }
    for (const k of keys) words[k] = (words[k] ?? 0) + out[k].join(' ').split(/\s+/).length;
}

console.log(`\n## ${results.length} истории\n`);
console.log('| Начин | Грешки | на 1000 думи | Цена |');
console.log('|---|---:|---:|---:|');
for (const k of ['A', 'B', 'C', 'A+proofHaiku', 'A+proofSonnet']) {
    const label = SETUPS.find((x) => x.id === k)?.label ?? k;
    console.log(
        `| ${label} | ${tally[k] ?? 0} | ${(((tally[k] ?? 0) / (words[k] || 1)) * 1000).toFixed(1)} | $${meters[k].usd.toFixed(3)} |`,
    );
}
console.log(`\nСъдията: $${meters.judge.usd.toFixed(3)}\n\nПримерни грешки:\n${samples.join('\n')}`);
console.log('\nПримери (A | C):');
for (const { story, out } of results.slice(0, 3)) {
    console.log(`\n— ${story.id}\nA: ${out.A?.slice(0, 2).join(' / ')}\nC: ${out.C?.slice(0, 2).join(' / ')}`);
}
