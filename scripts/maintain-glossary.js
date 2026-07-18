#!/usr/bin/env node
// Keep the abbreviations glossary current on its own.
//
// Only backtick-wrapped acronyms ever get a tooltip (glossifyHtml touches
// <code> spans and nothing else), so those are exactly the terms worth
// defining. This step scans every issue's markdown for such acronyms, drops
// the ones already defined or vetoed, and asks the model for a definition of
// whatever is left — but only accepts CERTAIN institutional/legal/programme
// terms. A wrong tooltip is worse than no tooltip, so "not sure" means skip.
//
// Two hard rules keep it trustworthy and cheap:
//   1. It never re-adds a term a human removed (glossary-ignore.json → removed).
//   2. Terms the model declines are remembered (→ skipped) so they aren't
//      re-queried every single day. Most days there are no new candidates and
//      the model is never called at all.
//
// It is deliberately non-fatal: the glossary is an enhancement, not the site.
// Any failure (no API key, network, bad JSON) logs a warning and exits 0 so the
// daily pipeline carries on and still ships the new issues.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { appendLog } from './logger.js';
import { findMixedScriptWords } from './clean-markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SCRIPT_NAME = 'maintain-glossary';
const ROOT = path.join(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const GLOSSARY_PATH = path.join(ROOT, 'glossary.json');
const IGNORE_PATH = path.join(ROOT, 'glossary-ignore.json');
const MODEL = 'claude-sonnet-5';
// A safety valve: never fan out an unbounded prompt if a bad issue somehow
// produces a flood of odd tokens. Real runs see 0–2 new candidates.
const MAX_CANDIDATES_PER_RUN = 25;

function log(message, level = 'INFO') {
    appendLog(SCRIPT_NAME, message, level);
    console.log(`[${SCRIPT_NAME}] ${message}`);
}

// Upper-case Cyrillic or Latin, 2–10 chars; the same shape glossifyHtml can
// match. Must hold at least two letters so bare codes like "3" never qualify.
const ACRONYM = /^[A-ZА-Я][A-ZА-Я0-9.\/-]{1,9}$/;
// Road/object codes such as BLG2191 — three letters then a run of digits. These
// are never glossary terms, so filter them before they cost a model call.
const CODE_LIKE = /^[A-ZА-Я]{2,4}\d{2,}$/;

function looksLikeAcronym(t) {
    if (!ACRONYM.test(t)) return false;
    if (CODE_LIKE.test(t)) return false;
    const letters = (t.match(/[A-ZА-Я]/g) || []).length;
    return letters >= 2;
}

function walkMd(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkMd(p, out);
        else if (e.name.endsWith('.md')) out.push(p);
    }
}

// Collect every distinct backticked acronym across the issues, plus one short
// real usage window per term to give the model something to reason from.
function collectCandidates() {
    const files = [];
    if (fs.existsSync(ISSUES_DIR)) walkMd(ISSUES_DIR, files);
    const freq = new Map();
    const context = new Map();
    for (const file of files) {
        const md = fs.readFileSync(file, 'utf8');
        for (const m of md.matchAll(/`([^`]+)`/g)) {
            const t = m[1].trim();
            if (!looksLikeAcronym(t)) continue;
            freq.set(t, (freq.get(t) || 0) + 1);
            if (!context.has(t)) {
                const start = Math.max(0, m.index - 80);
                const end = Math.min(md.length, m.index + m[0].length + 80);
                context.set(t, md.slice(start, end).replace(/\s+/g, ' ').trim());
            }
        }
    }
    return { freq, context };
}

function readJson(p, fallback) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

// Preserve the file's shape: 2-space indent, trailing newline, keys in the
// order they were added (the glossary is human-curated, not alphabetised).
function writeJsonStable(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

const SYSTEM_PROMPT =
    'Ти си редактор на речник за сайт, който обяснява българския „Държавен вестник“ на разбираем език. ' +
    'Дефинираш САМО съкращения на институции, държавни органи и агенции, закони и кодекси, официални програми, ' +
    'публични регистри или официални стандарти — и то само когато пълната форма на български е напълно сигурна и еднозначна. ' +
    'За търговски марки, модели превозни средства, кодове на пътища или обекти, битови технически съкращения и всичко, ' +
    'в което не си сигурен — не давай дефиниция. По-добре нищо, отколкото грешна дефиниция. ' +
    'Пиши пълната форма изцяло на български (кирилица). Латиница използвай само за автентични чужди собствени имена ' +
    '(например официалното име на европейска програма) — никога не транслитерирай български думи на латиница ' +
    '(пиши „Програма“, не „Programa“).';

// The propose pass is confident even when it's wrong — a garbled source acronym
// (ТОЛЕК instead of ТЕЛК) gets a plausible-sounding but invented expansion. So
// every proposal is put to a skeptic whose job is to REFUSE. It rejects unless
// the body is genuinely well known nationally AND the letters actually
// correspond; a term that looks like a typo or variant of another abbreviation
// is treated as a corruption and rejected. Only survivors reach the site.
const VERIFY_SYSTEM_PROMPT =
    'Ти си строг проверяващ на речникови дефиниции. Задачата ти е да ОТХВЪРЛЯШ, освен когато си напълно сигурен. ' +
    'Приемаш двойка „съкращение → пълна форма“ само ако едновременно: (1) става дума за реална, широко позната в България ' +
    'институция, орган, закон, официална програма, регистър или стандарт; и (2) буквите на съкращението действително ' +
    'съответстват на думите в пълната форма. Ако съкращението прилича на печатна грешка или вариант на друго познато ' +
    'съкращение (например изкривена форма), го третираш като грешка и го отхвърляш. ' +
    'Отхвърляш и всяка дефиниция, в която българска дума е изписана на латиница (например „Programa“ вместо „Програма“) — ' +
    'латиница се допуска само за автентични чужди собствени имена. При най-малко съмнение — отхвърляш.';

function buildVerifyPrompt(pairs) {
    const lines = pairs.map(({ term, def }) => `- ${term} → ${def}`);
    return (
        'Провери всяка от следните двойки „съкращение → пълна форма“:\n\n' +
        lines.join('\n') +
        '\n\nВърни само валиден JSON обект, който съпоставя всяко съкращение към true (сигурно вярно) или false ' +
        '(грешно, несигурно или изглежда като печатна грешка). Без коментари — само JSON обектът.'
    );
}

function parseBoolObject(text) {
    const cleaned = String(text).replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < 0) return {};
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k.trim()] = v === true;
    return out;
}

function buildUserPrompt(items) {
    const lines = items.map(
        ({ term, ctx }) => `- ${term} — пример: „…${ctx}…“`
    );
    return (
        'Ето кандидат-съкращения, извлечени от текста на вестника, всяко с пример за реалната му употреба.\n\n' +
        lines.join('\n') +
        '\n\nВърни само валиден JSON обект, който съпоставя съкращение → пълна форма на български, ' +
        'само за онези, които са сигурни институции, държавни органи, закони, официални програми, регистри или стандарти. ' +
        'Пропусни всяко несигурно съкращение (не го включвай в обекта). Без коментари и без обяснения — само JSON обектът.'
    );
}

function parseJsonObject(text) {
    const cleaned = String(text).replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < 0) return {};
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) out[k.trim()] = v.trim();
    }
    return out;
}

async function main() {
    const glossary = readJson(GLOSSARY_PATH, {});
    const ignore = readJson(IGNORE_PATH, { removed: [], skipped: [] });
    const removed = new Set(ignore.removed || []);
    const skipped = new Set(ignore.skipped || []);
    const known = new Set(Object.keys(glossary));

    const { freq, context } = collectCandidates();
    let candidates = [...freq.keys()]
        .filter((t) => !known.has(t) && !removed.has(t) && !skipped.has(t))
        .sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));

    if (candidates.length === 0) {
        log('No new acronyms to define — glossary is up to date.', 'OK');
        return;
    }
    if (candidates.length > MAX_CANDIDATES_PER_RUN) {
        log(`${candidates.length} candidates found; capping at ${MAX_CANDIDATES_PER_RUN} this run.`, 'WARN');
        candidates = candidates.slice(0, MAX_CANDIDATES_PER_RUN);
    }
    log(`Candidates to check: ${candidates.join(', ')}`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        log('No ANTHROPIC_API_KEY — skipping definition step (glossary unchanged).', 'WARN');
        return;
    }

    const client = new Anthropic({ apiKey });
    const items = candidates.map((term) => ({ term, ctx: context.get(term) || '' }));

    async function ask(system, content, parse) {
        const message = await client.messages.create({
            model: MODEL,
            max_tokens: 1500,
            system,
            messages: [{ role: 'user', content }],
            output_config: { effort: 'low' },
        });
        const textBlock = (message.content || []).find((b) => b.type === 'text');
        return parse(textBlock ? textBlock.text : '');
    }

    // Pass 1 — propose expansions for the certain-looking terms.
    let defined = {};
    try {
        defined = await ask(SYSTEM_PROMPT, buildUserPrompt(items), parseJsonObject);
    } catch (e) {
        log('Propose call failed — leaving glossary unchanged: ' + (e && (e.message || String(e))), 'WARN');
        return;
    }

    // Keep only proposals for terms we actually asked about, and drop any whose
    // definition mixes Cyrillic and Latin inside a word — a reliable OCR/typo
    // tell that no prompt fully prevents (caught mechanically, before the model
    // verifier even sees it).
    const asked = new Set(candidates);
    const proposed = [];
    for (const [term, def] of Object.entries(defined)) {
        if (!asked.has(term) || known.has(term)) continue;
        const mixed = findMixedScriptWords(def);
        if (mixed.length) {
            log(`Dropped ${term}: mixed-script word(s) in definition — ${mixed.join(', ')}`, 'WARN');
            continue;
        }
        proposed.push({ term, def });
    }

    // Pass 2 — a skeptic must confirm each proposal before it can ship.
    let verdicts = {};
    if (proposed.length) {
        try {
            verdicts = await ask(VERIFY_SYSTEM_PROMPT, buildVerifyPrompt(proposed), parseBoolObject);
        } catch (e) {
            log('Verify call failed — shipping nothing this run: ' + (e && (e.message || String(e))), 'WARN');
            return;
        }
    }

    const added = [];
    const rejected = [];
    for (const { term, def } of proposed) {
        if (verdicts[term] === true) {
            glossary[term] = def;
            added.push(term);
        } else {
            rejected.push(term);
        }
    }
    if (rejected.length) log(`Verifier rejected: ${rejected.join(', ')}`);
    // Everything the model didn't confidently define, plus everything the
    // verifier threw out, is remembered so it isn't re-queried tomorrow.
    const newlySkipped = candidates.filter((t) => !added.includes(t));

    if (added.length) {
        writeJsonStable(GLOSSARY_PATH, glossary);
        for (const t of added) log(`Added: ${t} → ${glossary[t]}`, 'OK');
    }
    if (newlySkipped.length) {
        ignore.skipped = [...skipped, ...newlySkipped];
        writeJsonStable(IGNORE_PATH, ignore);
        log(`Skipped (not certain institutions): ${newlySkipped.join(', ')}`);
    }
    log(`Done. Added ${added.length}, skipped ${newlySkipped.length}.`, 'OK');
}

main().catch((e) => {
    // Never fail the pipeline over the glossary.
    log('Unhandled (ignored): ' + (e && (e.message || String(e))), 'WARN');
    process.exit(0);
});
