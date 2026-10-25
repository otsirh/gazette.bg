import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanMarkdown, EMPTY_MARKER, findMixedScriptWords } from '../scripts/clean-markdown.js';

test('straight quotes become Bulgarian ones, outside code spans only', () => {
    assert.equal(cleanMarkdown('По "Хоризонт" и ("БНТ").'), 'По „Хоризонт“ и („БНТ“).\n');
    assert.equal(cleanMarkdown('Код `"x"` и "текст"'), 'Код `"x"` и „текст“\n');
    assert.equal(cleanMarkdown('Вече „правилни“ и "нови"'), 'Вече „правилни“ и „нови“\n');
});

test('spaced hyphens become em dashes, but list markers stay', () => {
    assert.equal(cleanMarkdown('Глоба - до 100 лева'), 'Глоба — до 100 лева\n');
    assert.equal(cleanMarkdown('- точка - едно'), '- точка - едно\n');
});

test('framing sentences around the summary are dropped', () => {
    const md = 'В този брой има важни промени.\n\n## Тема\n\nТекст.\n\nОстаналата част от броя е техническа.';
    assert.equal(cleanMarkdown(md), '## Тема\n\nТекст.\n');
});

test('an empty issue keeps its one-line marker', () => {
    assert.equal(cleanMarkdown(`${EMPTY_MARKER}\n\n`), `${EMPTY_MARKER}\n`);
    assert.equal(cleanMarkdown(''), '');
});

test('words that mix Cyrillic and Latin letters are caught', () => {
    assert.deepEqual(findMixedScriptWords('obhвата и professionalен, но iBoxx и MWh са наред'), [
        'obhвата',
        'professionalен',
    ]);
    assert.deepEqual(findMixedScriptWords('Само кирилица.'), []);
});
