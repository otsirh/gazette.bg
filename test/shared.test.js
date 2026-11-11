import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    escapeHtml,
    formatDateBulgarian,
    formatDateLong,
    formatDateShort,
    issueDateToIso,
    issuesNewestFirst,
    issueTitle,
    latinSlug,
    parseSourceList,
    pluralTopics,
    readingMinutes,
    renderDisclaimer,
    renderHomeContent,
    renderIssueNav,
    renderPublishedMarkdown,
    renderSourceLines,
    searchTermVariants,
    shortActLabel,
    slugify,
    splitStories,
    stemBg,
    stripSourceLines,
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
        2025: [{ issue: 104, date: '30 Декември 2025', file: 'issues/2025/104/104.md', topics: ['Старо'] }],
        2026: [
            { issue: 1, date: '6 Януари 2026', file: 'issues/2026/01/1.md', topics: ['Първа <тема>'] },
            {
                issue: 2,
                date: '9 Януари 2026',
                file: 'issues/2026/02/2.md',
                topics: ['Водеща', 'Втора тема'],
                lead: 'Кратко въведение към водещата тема.',
                minutes: 4,
            },
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
    assert.match(html, /<p class="lead-standfirst">Кратко въведение към водещата тема\.<\/p>/);
    assert.match(html, /href="\/issue\/2026\/2\/#втора-тема"[^>]*>Втора тема<\/a>/);
    assert.match(html, /<span class="section-count">2 броя<\/span>/);
    assert.match(html, /class="issue-card issue-card-row is-lead-row filter-hidden"[^>]*data-issue="2"/);
    assert.ok(html.indexOf('<span>2026</span>') < html.indexOf('<span>2025</span>'));
    assert.match(html, /Първа &lt;тема&gt;/, 'topics are escaped');
    assert.match(renderHomeContent([]), /няма налични броеве/);

    const firstOfNewYear = renderHomeContent(
        issuesNewestFirst({
            years: {
                2026: [{ issue: 104, date: '30 Декември 2026', file: 'issues/2026/104/104.md', topics: ['Старо'] }],
                2027: [{ issue: 1, date: '5 Януари 2027', file: 'issues/2027/01/1.md', topics: ['Ново'] }],
            },
        }),
    );
    assert.match(firstOfNewYear, /class="year-group is-lead-group filter-hidden"><h3 class="year-title"><span>2027/);
});

test('issue navigation links the neighbours that exist', () => {
    const [newest, middle] = issuesNewestFirst(catalog);
    const both = renderIssueNav(middle, newest);
    assert.match(both, /is-prev.*href="\/issue\/2026\/1\/"/s);
    assert.match(both, /is-next.*href="\/issue\/2026\/2\/"/s);
    assert.equal(renderIssueNav(null, null), '');
});

test('Bulgarian stemmer collapses articles, plurals, and -ик/-иц palatalization', () => {
    assert.equal(stemBg('глоба'), stemBg('глобите'));
    assert.equal(stemBg('винетка'), stemBg('винетките'));
    assert.equal(stemBg('пенсия'), stemBg('пенсиите'));
    assert.equal(stemBg('данък'), stemBg('данъците'));
    assert.equal(stemBg('работник'), stemBg('работниците'));
    assert.equal(stemBg('работа'), stemBg('работата'));
    assert.equal(stemBg('град'), stemBg('градовете'));
    assert.equal(stemBg('помощ'), stemBg('помощта'));
    assert.equal(stemBg('месец'), stemBg('месеците'));
    assert.ok(searchTermVariants('данък').includes('данъц'));
});

test('issue titles lead with the primary headline and fall back to the issue number', () => {
    assert.equal(
        issueTitle({ issue: 99, date: '30 Октомври 2026', topics: ['Стажът отново се смята в дни'] }),
        'Стажът отново се смята в дни — ДВ бр. 99 (30 октомври 2026)',
    );
    assert.equal(
        issueTitle({ issue: 5, date: '16 Януари 2026', topics: [] }),
        'Брой 5 · 16 януари 2026 — Обобщения на Държавен вестник',
    );
});

const META = {
    pdfUrl: 'https://dv.parliament.bg/DVWeb/fileUploadShowing.jsp?idFileAtt=1',
    materials: [
        { page: 3, id: 30, issuer: 'Конституционен съд', title: 'Решение № 18 от 27 октомври 2026 г. по к.д. № 11' },
        {
            page: 7,
            id: 70,
            issuer: 'Народно събрание',
            title: 'Закон за изменение и допълнение на Закона за управление на отпадъците',
        },
    ],
};
const ACT = 'https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=';

test('a source line reads acts, pages and ranges, and drops the rest', () => {
    assert.deepEqual(parseSourceList('акт 2, акт 5, стр. 37–38, 40; стр. 9, бла, 8–2'), [
        { act: 2 },
        { act: 5 },
        { from: 37, to: 38 },
        { from: 40, to: 40 },
        { from: 9, to: 9 },
    ]);
    assert.deepEqual(parseSourceList('12, акт 1'), [{ act: 1 }], 'a bare number is a page only after "стр."');
});

test('an act is labelled by its type and number, or a shortened title', () => {
    assert.equal(shortActLabel('Постановление № 224 от 29 октомври 2026 г. за одобряване'), 'Постановление № 224');
    assert.equal(
        shortActLabel('Закон за изменение и допълнение на Закона за управление на отпадъците и други'),
        'Закон за изменение и допълнение на Закона за управление на…',
    );
});

test('the source line of a section becomes links to the official text', () => {
    const md = '## Тема\n\nТекст.\nИзточник: акт 1, акт 2, акт 1, акт 9, стр. 25–26\n\n## Друга';
    const out = renderSourceLines(md, META);
    assert.equal(
        out,
        '## Тема\n\nТекст.\n\n<p class="section-source"><span class="section-source-label">Официален текст:</span> ' +
            `<a href="${ACT}30" target="_blank" rel="noopener" title="Конституционен съд — Решение № 18 от 27 октомври 2026 г. по к.д. № 11">Решение № 18</a> · ` +
            `<a href="${ACT}70" target="_blank" rel="noopener" title="Народно събрание — Закон за изменение и допълнение на Закона за управление на отпадъците">Закон за изменение и допълнение на Закона за управление на…</a> · ` +
            `<a href="${META.pdfUrl}" target="_blank" rel="noopener">стр. 25–26 (PDF)</a></p>\n\n## Друга`,
    );
    assert.match(renderSourceLines('Източник: стр. 4', {}), /<p class="section-source">.*стр\. 4<\/p>/);
    assert.equal(renderSourceLines('Текст.\n\nИзточник: акт 3', {}), 'Текст.\n\n', 'an unknown act renders nothing');
    assert.equal(stripSourceLines('Текст.\n\nИзточник: акт 1'), 'Текст.\n\n');
});

test('the disclaimer links the official PDF when the issue has one', () => {
    assert.match(
        renderDisclaimer({ year: 2026, issue: 100, pdfUrl: META.pdfUrl }),
        /idFileAtt=1.*официалния брой \(PDF\)/,
    );
    assert.match(renderDisclaimer({ year: 2026, issue: 1 }), /href="https:\/\/dv\.parliament\.bg"/);
});

test('story addresses are Latin, short and unique within an issue', () => {
    assert.equal(latinSlug('Минималната заплата става 660 евро'), 'minimalnata-zaplata-stava-660-evro');
    assert.equal(latinSlug('Щатът на „България“ — промени'), 'shtatat-na-balgaria-promeni');
    assert.ok(latinSlug('Дълго заглавие '.repeat(10)).length <= 64);
    const stories = splitStories('## Тема\n\nА.\n\nТеми: Здраве\n\n## Тема\n\nБ.\n');
    assert.deepEqual(
        stories.map((s) => s.slug),
        ['tema', 'tema-2'],
    );
});

test('a published summary shows its sources and never its annotation lines', () => {
    const md =
        '## Тема\n\nТекст <b>x</b>.\n\nИзточник: стр. 4\n\nТеми: Здраве\n\nВ сила: 2027-01-01\n## Друга\n\nОще.\n';
    const out = renderPublishedMarkdown(md, { meta: { pdfUrl: 'https://dv.parliament.bg/x' } });
    assert.doesNotMatch(out, /^(Теми|В сила|Източник):/m);
    assert.match(out, /<p class="section-source">.*стр\. 4 \(PDF\)<\/a><\/p>/);
    assert.match(out, /Текст &lt;b>x&lt;\/b>\./, 'model HTML is shown as text');
    assert.match(out, /^## Друга$/m, 'the next heading survives');
});
