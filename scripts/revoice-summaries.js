#!/usr/bin/env node
/*
 * One-off: re-voice the published summaries out of second person.
 *
 * The summaries were written to address the reader ("Ако си шофьор, ще
 * плащаш…"), which read as instruction rather than reporting. The prompts no
 * longer produce that, but 57 issues already on the site do. This rewrites the
 * voice only — same facts, same numbers, same sections, same order.
 *
 * The risk in rewriting published legal summaries is silent factual drift, so
 * every rewrite is checked mechanically before it is accepted: the numbers,
 * dates, currency amounts, `code` terms and section headings must all survive.
 * A file that fails any check is left exactly as it was and reported.
 *
 *   node scripts/revoice-summaries.js                # every issue that needs it
 *   node scripts/revoice-summaries.js 69 60          # just these issues
 *   node scripts/revoice-summaries.js --dry 69       # print the rewrite, write nothing
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { findMixedScriptWords } from './clean-markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ISSUES_DIR = path.join(ROOT, 'issues');
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const apiKey = process.env.ANTHROPIC_API_KEY;

// What second person looks like in Bulgarian. Also the acceptance test: a
// rewrite that still matches any of these has not done its job.
//
// Deliberately NOT flagged, because Bulgarian makes them ambiguous:
//   „те"  — third person plural just as often as the 2sg clitic („те плащат"
//           vs „засяга те"), so only the clitic collocations below are caught;
//   „си"  — the reflexive possessive works in any person („получават пенсиите
//           си"), so a bare „си" says nothing about the voice.
const SECOND_PERSON = [
    // „ти" needs a non-letter AND non-digit/hyphen before it, else the ordinal
    // suffix in „10-ти клас" reads as the pronoun.
    /(?<![\p{L}\d-])(ти|теб|тебе|твой|твоя|твоят|твоите|твои|твое|твоята|ваш\p{L}*|вие)(?![\p{L}])/iu,
    /(?<![\p{L}])(можеш|имаш|нямаш|трябва\s+да\s+\p{L}+(еш|иш)|ще\s+\p{L}+(еш|иш)|получаваш|плащаш|дължиш|губиш|подадеш|заявиш|провериш|знаеш|видиш)(?![\p{L}])/iu,
    /(?<![\p{L}])Ако\s+(си|имаш|нямаш|караш|живееш|работиш|учиш|получаваш|плащаш)(?![\p{L}])/iu,
    // The 2sg clitic „те"/„ти" only next to a verb that takes a person as its
    // object, in either order („засяга те", „ако те хванат"). „Ако те създават
    // висок риск" stays out: „създават" is not on the list, so „те" reads as
    // the third person plural subject it is.
    /(?<![\p{L}])(засяга|касае|интересува|хванат|хване|спре|спира|глоби|уведоми|задължава|върнат|лишава|защитава|признава)\s+(те|ти)(?![\p{L}])/iu,
    /(?<![\p{L}])(те|ти)\s+(засяга|касае|интересува|хванат|хване|спрат|спре|глобят|глоби|уведомят|задължава|върнат|лишат|признават)(?![\p{L}])/iu,
    /(?<![\p{L}])(Засяга\s+те|за\s+теб|при\s+теб)/iu,
    // Imperatives only where they open a sentence; „службата трябва да провери
    // дали…" is an obligation on an institution, not an instruction to a reader.
    /(^|[.!?…]\s+|\n)(Провери|Провери\s+дали|Не\s+забравяй|Внимавай|Подай|Заяви|Обжалвай)(?![\p{L}])/u,
];

const PROMPT = `По-долу е обобщение на брой на Държавен вестник. То е написано в грешен глас: обръща се към читателя („Ако си шофьор…", „ще плащаш", „имаш 30 дни"). Това го прави инструктаж, а сайтът съобщава новини.

Пренапиши САМО гласа. Това не е нова редакция — това е същият текст, изчистен от обръщението.

# ЗАДЪЛЖИТЕЛНО ЗАПАЗИ

- **Толкова ## заглавия, колкото има сега, в същия ред и за същите теми.** Не сливай, не разделяй, не добавяй и не махай секция.
- Всяко число, сума, процент, дата и срок — точно както са, включително удебеляването (**5,30 евро** остава **5,30 евро**).
- Всички \`обратни кавички\` около термини (\`НЗОК\`, \`ЕООД\`).
- Броя на параграфите и структурата (### подзаглавия, списъци).
- Всички факти. Не добавяй нищо, което го няма. Не махай факт, за да ти е по-лесно изречението.

# ПРОМЕНИ САМО ТОВА

- **Никакво второ лице — включително в ## заглавията.** Нито „ти", „твой", „теб", „можеш", „имаш", „ще плащаш", „трябва да подадеш". Нито „вие"/„Вашият".
- **Заглавие във второ лице се пренаписва в трето, но остава за същото нещо** и запазва ключовите си думи:
  „## Кои билки можеш да береш и кои са забранени" → „## Кои билки могат да се берат и кои са забранени"
  „## Техническият преглед на колата ти не може да се блокира заради стари глоби" → „## Техническият преглед не може да се блокира заради стари глоби"
  „## Ако имаш имот в някоя от тези общини" → „## Собствениците на имоти в тези общини имат срок за възражение"
  „## Две съдебни дела, за които трябва да знаеш" → „## Две съдебни дела с значение за потребителите"
- **Никакви условни обръщения:** „Ако си шофьор…", „Ако имаш имот…", „Ако живееш в…", „Засяга те, ако…", „Провери дали…".
- **Засегнатите се назовават като група, в трето лице** и стават подлог на изречението.
- **Никакви подзаглавия-обръщения** („Какво означава за теб" → „За наемателите" или махни ###, ако групата е ясна).

Примери:

„Ако караш кола по републиканската мрежа, ще плащаш повече от **1 август**." → „Винетките за републиканската пътна мрежа поскъпват от **1 август**."
„Ако имаш имот в тези места, имаш **30 дни** да възразиш." → „Собствениците на имоти в тези места имат **30 дни** за възражение."
„Ако си пенсионер, ще получаваш пенсията си в евро." → „Пенсиите се изплащат в евро."
„Трябва да подадеш заявление до **14 юни**." → „Заявленията се подават до **14 юни**."

Български: само кирилица, дълго тире с интервали ( — ) за пояснения, „български кавички", десетична запетая. Пълен член за подлог („Законът влиза в сила"), непълен след предлог.

Отговори САМО с пренаписания markdown — от първото \`##\` до края. Без коментар, без обяснение, без ограждащи блокове.

---
${''}`;

function listIssues(filter) {
    const out = [];
    for (const year of fs.readdirSync(ISSUES_DIR)) {
        const yearDir = path.join(ISSUES_DIR, year);
        if (!fs.statSync(yearDir).isDirectory()) continue;
        for (const folder of fs.readdirSync(yearDir).sort((a, b) => +a - +b)) {
            const dir = path.join(yearDir, folder);
            if (!fs.statSync(dir).isDirectory()) continue;
            const issue = parseInt(folder, 10);
            const md = path.join(dir, `${issue}.md`);
            if (!fs.existsSync(md)) continue;
            if (filter.length && !filter.includes(String(issue))) continue;
            out.push({ year, issue, md });
        }
    }
    return out;
}

function needsRevoice(text) {
    return SECOND_PERSON.some((re) => re.test(text));
}

/* ─── Acceptance checks ─── */

const headings = (md) => (md.match(/^##\s+.+$/gm) || []).map((h) => h.replace(/^##\s+/, '').trim());
// Every digit run, so 5,30 / 46,50 / 2026 / 30 are all compared as written.
const numbers = (md) => (md.match(/\d+(?:[.,]\d+)?/g) || []).sort();
const codeTerms = (md) => (md.match(/`[^`]+`/g) || []).sort();

function checkRewrite(before, after) {
    const problems = [];
    if (!after.startsWith('## ')) problems.push('does not start with "## "');
    if (/```/.test(after)) problems.push('contains a code fence');

    // A heading in second person has to be rewritten, so it cannot be compared
    // verbatim. Instead: same count, same order, and each one still recognisably
    // about the same thing — at least one content word survives, compared on a
    // 4-character prefix so inflection ("имот" / "имоти") still matches. Four,
    // not five: "имот", "кола", "срок", "дете" are the subject of a heading as
    // often as any longer word.
    const hb = headings(before), ha = headings(after);
    if (hb.length !== ha.length) {
        problems.push(`headings ${hb.length} → ${ha.length}`);
    } else {
        const stem = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 4);
        hb.forEach((h, i) => {
            const keys = h.split(/\s+/).map(stem).filter((w) => w.length >= 4);
            if (!keys.length) return;
            const target = ha[i].split(/\s+/).map(stem);
            if (!keys.some((k) => target.includes(k))) {
                problems.push(`heading ${i + 1} drifted: ${JSON.stringify(h)} → ${JSON.stringify(ha[i])}`);
            }
        });
    }

    const nb = numbers(before), na = numbers(after);
    const missing = nb.filter((n) => { const i = na.indexOf(n); if (i < 0) return true; na.splice(i, 1); return false; });
    if (missing.length) problems.push(`numbers dropped: ${[...new Set(missing)].join(', ')}`);
    if (na.length) problems.push(`numbers invented: ${[...new Set(na)].join(', ')}`);

    const cb = codeTerms(before), ca = codeTerms(after);
    const lostTerms = cb.filter((t) => !ca.includes(t));
    if (lostTerms.length) problems.push(`code terms dropped: ${[...new Set(lostTerms)].join(', ')}`);

    // Report the hit with its surroundings — a bare match is not diagnosable.
    for (const re of SECOND_PERSON) {
        const m = re.exec(after);
        if (!m) continue;
        const from = Math.max(0, m.index - 40);
        const context = after.slice(from, m.index + m[0].length + 40).replace(/\s+/g, ' ');
        problems.push(`still second person (${JSON.stringify(m[0])}): …${context}…`);
    }

    const garbled = findMixedScriptWords(after);
    if (garbled.length) problems.push(`mixed script: ${garbled.join(', ')}`);

    // A rewrite that loses a fifth of the text has cut content, not voice.
    const ratio = after.length / before.length;
    if (ratio < 0.8 || ratio > 1.25) problems.push(`length ${Math.round(ratio * 100)}% of original`);

    return problems;
}

async function revoice(client, markdown) {
    const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT + markdown }] }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('model declined');
    if (message.stop_reason === 'max_tokens') throw new Error('hit max_tokens');
    const block = message.content?.find((c) => c.type === 'text');
    if (!block?.text) throw new Error('no text in response');
    return { text: block.text.trim().replace(/^```(?:markdown)?\n?|\n?```$/g, '').trim(), usage: message.usage };
}

async function main() {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    const filter = args.filter((a) => /^\d+$/.test(a));
    if (!apiKey) {
        console.error('[revoice] Missing ANTHROPIC_API_KEY');
        process.exit(1);
    }
    const client = new Anthropic({ apiKey });

    const all = listIssues(filter);
    const todo = all.filter(({ md }) => needsRevoice(fs.readFileSync(md, 'utf8')));
    console.log(`[revoice] ${todo.length} of ${all.length} issue(s) need re-voicing${dry ? ' (dry run)' : ''}\n`);

    const done = [], failed = [];
    for (const { year, issue, md } of todo) {
        const before = fs.readFileSync(md, 'utf8');
        process.stdout.write(`  ${year}/${issue}… `);
        try {
            const { text: after, usage } = await revoice(client, before);
            const problems = checkRewrite(before, after);
            if (problems.length) {
                console.log(`REJECTED — left untouched`);
                problems.forEach((p) => console.log(`      · ${p}`));
                failed.push(`${year}/${issue}`);
                continue;
            }
            if (dry) {
                console.log('ok (not written)\n');
                console.log(after + '\n');
            } else {
                fs.writeFileSync(md, after.endsWith('\n') ? after : after + '\n', 'utf8');
                console.log(`ok (in=${usage?.input_tokens ?? '?'} out=${usage?.output_tokens ?? '?'})`);
            }
            done.push(`${year}/${issue}`);
        } catch (e) {
            console.log(`FAILED — ${e.message}`);
            failed.push(`${year}/${issue}`);
        }
    }

    console.log(`\n[revoice] Re-voiced ${done.length}, left untouched ${failed.length}${failed.length ? ' (' + failed.join(', ') + ')' : ''}`);
    if (!dry && done.length) console.log('[revoice] Run `npm run build` to re-render.');
}

main().catch((e) => {
    console.error('[revoice]', e);
    process.exit(1);
});
