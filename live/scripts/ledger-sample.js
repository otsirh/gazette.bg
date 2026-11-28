#!/usr/bin/env node
// The weekly check of „Казано – направено“ before anything is shown: a
// random sample of the deadlines collected in the last days, each with its
// words and link, to mark by hand as right or wrong. The goal is 9 in 10
// right (owner, date and kind as the article says).
//
//   node live/scripts/ledger-sample.js [count=20] [days=7]
//
// Reads the published state (LIVE_STATE_URL, or live.gazette.bg); costs
// nothing.
const N = Number(process.argv[2] ?? 20);
const DAYS = Number(process.argv[3] ?? 7);
const url = process.env.LIVE_STATE_URL ?? 'https://live.gazette.bg/state.json';
const state = await (await fetch(url)).json();
const since = Date.now() - DAYS * 24 * 3600 * 1000;
const ledger = (state.ledger ?? []).filter((e) => e.addedAt >= since);
const KIND = { deadline: 'срок', promise: 'обещание', scheduled: 'насрочено' };
const WHEN = { on: 'на', by: 'до', from: 'от' };

const sample = [...ledger].sort(() => Math.random() - 0.5).slice(0, N);
console.log(`${ledger.length} записа за последните ${DAYS} дни; ${sample.length} на случаен принцип:\n`);
sample.forEach((e, i) => {
    console.log(`${i + 1}. ${e.owner} · ${KIND[e.kind] ?? e.kind} ${WHEN[e.dueKind] ?? ''} ${e.due}`);
    console.log(`   „${e.quote}“`);
    console.log(`   ${e.sources[0]?.url ?? ''}${e.sources.length > 1 ? ` (+${e.sources.length - 1})` : ''}`);
    console.log('   [ ] вярно   [ ] грешен срок   [ ] грешен отговорник   [ ] не е срок\n');
});
