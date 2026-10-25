import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    escapeHtml,
    formatDateBulgarian,
    formatDateLong,
    formatDateShort,
    issueDateToIso,
    issuesNewestFirst,
    pluralTopics,
    readingMinutes,
    renderHomeContent,
    renderIssueNav,
    slugify,
} from '../src/js/shared.js';

test('dates read the way the site prints them', () => {
    assert.equal(formatDateBulgarian('30.9.2026 г.'), '30 Септември 2026');
    assert.equal(formatDateBulgarian('23 октомври 2026 г.'), '23 Октомври 2026');
    assert.equal(formatDateLong('23 Октомври 2026'), '23 октомври 2026');
    assert.equal(formatDateLong('5.1.2026 г.'), '5 януари 2026');
    assert.equal(formatDateShort('23 Октомври 2026'), '23 октомври');
    assert.equal(formatDateLong(''), '');
});

test('issue dates convert to ISO for feeds and structured data', () => {
    assert.equal(issueDateToIso('23 Октомври 2026'), '2026-10-23');
    assert.equal(issueDateToIso('5.1.2026'), '2026-01-05');
    assert.equal(issueDateToIso('someday'), null);
    assert.equal(issueDateToIso(undefined), null);
});

test('slugs keep Cyrillic and drop punctuation', () => {
    assert.equal(slugify('Такси за „патентно“ ведомство'), 'такси-за-патентно-ведомство');
    assert.equal(slugify('**Нови** правила — от 1 юли'), 'нови-правила-от-1-юли');
    assert.equal(slugify('***'), 'section');
});

test('text helpers', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.equal(pluralTopics(1), '1 тема');
    assert.equal(pluralTopics(4), '4 теми');
    assert.equal(readingMinutes(''), 1);
    assert.equal(readingMinutes('дума '.repeat(360)), 2);
});

const catalog = {
    years: {
        2025: [{ issue: 104, date: '30 Декември 2025', file: 'issues/2025/104/104.md', lead: '', topics: ['Старо'] }],
        2026: [
            { issue: 1, date: '6 Януари 2026', file: 'issues/2026/01/1.md', lead: '', topics: ['Първа <тема>'] },
            { issue: 2, date: '9 Януари 2026', file: 'issues/2026/02/2.md', lead: '', topics: ['Водеща', 'Втора'] },
        ],
    },
};

test('issues are listed newest first across years', () => {
    assert.deepEqual(
        issuesNewestFirst(catalog).map((i) => `${i.year}/${i.issue}`),
        ['2026/2', '2026/1', '2025/104'],
    );
    assert.deepEqual(issuesNewestFirst(null), []);
});

test('the home page leads with the newest issue and files the rest by year', () => {
    const html = renderHomeContent(issuesNewestFirst(catalog));
    assert.match(html, /^<section class="lead-section">/);
    assert.match(html, /<h2 class="lead-title">Водеща<\/h2>/);
    assert.match(html, /<span class="section-count">2 броя<\/span>/);
    assert.ok(html.indexOf('<span>2026</span>') < html.indexOf('<span>2025</span>'));
    assert.match(html, /Първа &lt;тема&gt;/, 'topics are escaped');
    assert.match(renderHomeContent([]), /няма налични броеве/);
});

test('issue navigation links the neighbours that exist', () => {
    const [newest, middle] = issuesNewestFirst(catalog);
    const both = renderIssueNav(middle, newest);
    assert.match(both, /is-prev.*href="\/issue\/2026\/1\/"/s);
    assert.match(both, /is-next.*href="\/issue\/2026\/2\/"/s);
    assert.equal(renderIssueNav(null, null), '');
});
