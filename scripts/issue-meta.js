/*
 * Turns a finished summary into the two things a reader actually asks:
 * "does this touch me?" and "how long do I have?".
 *
 * Both are already in the text — who is affected, and "30 дни от обнародването".
 * They are just dissolved in prose, where a person has to find and compute them.
 * This pulls them out as data. The dates are arithmetic done in code (issue date
 * + N days); the model only reads the sentence.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getIssueMetaPrompt } from './ai-prompts.js';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 8000;
const EFFORT = 'low';

// A closed vocabulary, so the same reader is labelled the same way in every
// issue. An open list would drift into dozens of near-synonyms and the tags
// would stop being scannable.
const AUDIENCES = [
    'шофьор',
    'собственик на имот',
    'пенсионер',
    'родител',
    'ученик или студент',
    'пациент',
    'земеделец',
    'фирма или самонает',
    'работещ',
    'потребител',
    'жител на конкретно място',
];

const SCHEMA = {
    type: 'object',
    properties: {
        audiences: {
            type: 'array',
            description: 'Кого засяга броят като цяло. Само от изброените стойности.',
            items: { type: 'string', enum: AUDIENCES },
        },
        places: {
            type: 'array',
            description: 'Населени места, общини и области, назовани в броя.',
            items: { type: 'string' },
        },
        sections: {
            type: 'array',
            description: 'По един запис за всяко ## заглавие в обобщението, в същия ред.',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Заглавието дословно, както е в текста.' },
                    audiences: { type: 'array', items: { type: 'string', enum: AUDIENCES } },
                },
                required: ['title', 'audiences'],
                additionalProperties: false,
            },
        },
        deadlines: {
            type: 'array',
            description: 'Срокове, в които човек може да направи нещо (възражение, обжалване, заявление). Не събития без действие.',
            items: {
                type: 'object',
                properties: {
                    what: { type: 'string', description: 'Какво може да направи човекът, кратко.' },
                    who: { type: 'string', description: 'Кого засяга — място или група, кратко.' },
                    days: { type: 'integer', description: 'Брой дни от обнародването. 0, ако срокът е изрична дата.' },
                    date: { type: 'string', description: 'Изрична крайна дата ГГГГ-ММ-ДД, ако е дадена. Иначе празно.' },
                    quote: { type: 'string', description: 'Изречението от обобщението, от което идва срокът.' },
                },
                required: ['what', 'who', 'days', 'date', 'quote'],
                additionalProperties: false,
            },
        },
    },
    required: ['audiences', 'places', 'sections', 'deadlines'],
    additionalProperties: false,
};

function addDays(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The model reads the sentence; the calendar is ours.
function resolveDeadline(raw, issueIso) {
    const explicit = ISO_DATE.test(raw.date || '') ? raw.date : null;
    const derived = raw.days > 0 && issueIso ? addDays(issueIso, raw.days) : null;
    const expires = explicit || derived;
    if (!expires) return null;
    return {
        what: raw.what.trim(),
        who: (raw.who || '').trim(),
        expires,
        source: explicit ? 'изрична дата в броя' : `${raw.days} дни от обнародването`,
        quote: (raw.quote || '').trim(),
    };
}

async function extractIssueMeta({ apiKey, markdown, issueIso, year, issue }) {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: {
            effort: EFFORT,
            format: { type: 'json_schema', schema: SCHEMA },
        },
        messages: [{ role: 'user', content: getIssueMetaPrompt(markdown, issueIso, year, issue) }],
    });

    if (message.stop_reason === 'refusal') throw new Error('Claude declined the metadata request');
    if (message.stop_reason === 'max_tokens') throw new Error('Metadata response hit max_tokens');

    const textBlock = message.content?.find((c) => c.type === 'text');
    if (!textBlock?.text) throw new Error('No text in metadata response');

    const raw = JSON.parse(textBlock.text);

    return {
        audiences: [...new Set(raw.audiences || [])],
        places: [...new Set((raw.places || []).map((p) => p.trim()).filter(Boolean))],
        sections: (raw.sections || []).map((s) => ({
            title: s.title.trim(),
            audiences: [...new Set(s.audiences || [])],
        })),
        deadlines: (raw.deadlines || [])
            .map((d) => resolveDeadline(d, issueIso))
            .filter(Boolean)
            .sort((a, b) => a.expires.localeCompare(b.expires)),
        usage: message.usage,
    };
}

export { extractIssueMeta, AUDIENCES };
