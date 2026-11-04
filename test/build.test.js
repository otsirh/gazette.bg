import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { buildCatalog } from '../scripts/build-gazette-catalog.js';
import { buildSite, lit, minifyCss, processRenderedContent } from '../scripts/build-issue-pages.js';
import { ISSUES_DIR } from '../scripts/lib/issues.js';
import { splitStories } from '../src/js/shared.js';

// Builds the real site from the real issues into a scratch folder, then checks
// the parts a reader, a crawler or a feed app depends on.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'gazette-dist-'));
const read = (rel) => fs.readFileSync(path.join(dist, rel), 'utf8');
const summaries = fs
    .readdirSync(ISSUES_DIR)
    .flatMap((year) => fs.readdirSync(path.join(ISSUES_DIR, year)).map((folder) => ({ year, issue: Number(folder) })))
    .filter(({ year, issue }) =>
        fs.existsSync(path.join(ISSUES_DIR, year, String(issue).padStart(2, '0'), `${issue}.md`)),
    );
let catalog;
const stories = summaries.flatMap(({ year, issue }) =>
    splitStories(
        fs.readFileSync(path.join(ISSUES_DIR, year, String(issue).padStart(2, '0'), `${issue}.md`), 'utf8'),
    ).map((story) => ({ year, issue, story })),
);

before(async () => {
    const log = console.log;
    console.log = () => {};
    try {
        catalog = buildCatalog({ distDir: dist });
        // Share pictures have a test of their own; the full set takes a while.
        await buildSite({ distDir: dist, shareImages: false });
    } finally {
        console.log = log;
    }
});

test('every summary is in the catalog and has its own page', () => {
    const listed = Object.values(catalog.years).flat();
    assert.equal(listed.length, summaries.length);
    for (const { year, issue } of summaries) {
        const page = read(`issue/${year}/${issue}/index.html`);
        assert.match(page, new RegExp(`<link rel="canonical" href="https://gazette.bg/issue/${year}/${issue}/" />`));
        assert.match(page, /<article class="content" id="content"><p class="content-disclaimer">/);
        assert.match(
            page,
            /<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"Article"/,
        );
        assert.ok(fs.existsSync(path.join(dist, 'issues', year)), 'the raw summary is published for client navigation');
    }
});

test('the home page links every issue', () => {
    const home = read('index.html');
    for (const { year, issue } of summaries)
        assert.ok(home.includes(`href="/issue/${year}/${issue}/"`), `${year}/${issue}`);
    assert.match(home, /<style>/, 'the stylesheet is inlined');
    assert.match(home, /<script type="module" src="\/src\/js\/app\.js\?v=[0-9a-f]{8}"/);
    assert.doesNotMatch(home, /cdn\.jsdelivr\.net/, 'no external CDN scripts');
    assert.ok(fs.existsSync(path.join(dist, 'manifest.webmanifest')), 'PWA manifest is published');
    assert.ok(fs.existsSync(path.join(dist, 'src/js/shared.js')), 'the module app.js imports is published');
    assert.ok(fs.existsSync(path.join(dist, 'src/js/marked.js')), 'marked is self-hosted for client navigation');
});

test('sitemap, feed and search index cover the issues', () => {
    const urls = (read('sitemap.xml').match(/<url>/g) || []).length;
    assert.equal(urls, summaries.length + 1 + stories.length, 'home, issues and stories');
    const feed = read('feed.xml');
    const items = feed.match(/<item>/g) || [];
    assert.equal(items.length, Math.min(50, summaries.length));
    assert.match(
        feed,
        /<content:encoded><!\[CDATA\[<p><em>Неофициално обобщение, генерирано с AI\..*?<\/em><\/p>\n<h2>/,
    );
    assert.match(feed, /<description>Обобщение с AI на Държавен вестник/);
    const searchIndex = JSON.parse(read('search-index.json'));
    assert.equal(Object.keys(searchIndex).length, summaries.length);
    assert.match(Object.values(searchIndex)[0], /\t/, 'search index separates section headings with tabs');
});

test('the 404 page stays out of search results', () => {
    const page = read('404.html');
    assert.match(page, /<meta name="robots" content="noindex" \/>/);
    assert.doesNotMatch(page, /rel="canonical"/);
});

test('summary text is spliced into templates literally', () => {
    assert.equal('<x>'.replace('<x>', lit('глоба $1 и $& лв.')), 'глоба $1 и $& лв.');
});

test('headings get unique ids and h1 becomes h2', () => {
    const { html, tocItems } = processRenderedContent('<h1>Тема</h1><h2>Тема</h2><h3>Под &quot;тема&quot;</h3>');
    assert.equal(html, '<h2 id="тема">Тема</h2><h2 id="тема-2">Тема</h2><h3 id="под-тема">Под &quot;тема&quot;</h3>');
    assert.deepEqual(
        tocItems.map((t) => t.level),
        [2, 2, 3],
    );
});

test('CSS minifier strips comments and whitespace while preserving strings, calc(), and selector spaces', () => {
    const out = minifyCss(`
        /* comment */
        .box :focus-visible {
            max-height: calc(100vh - 5.5rem);
            content: "  ✓ копирано ";
        }
    `);
    assert.equal(out, '.box :focus-visible{max-height:calc(100vh - 5.5rem);content:"  ✓ копирано "}');
});

test('every story has its own page', () => {
    assert.ok(stories.length > summaries.length, 'issues have several stories each');
    for (const { year, issue, story } of stories) {
        const page = read(`issue/${year}/${issue}/${story.slug}/index.html`);
        assert.match(page, /<body class="issue-open issue-ready" data-page="story"/);
        assert.match(
            page,
            new RegExp(`<link rel="canonical" href="https://gazette.bg/issue/${year}/${issue}/${story.slug}/" />`),
        );
        assert.match(page, /"@type":"NewsArticle"/);
        assert.match(page, /<meta name="description" content="Обобщение с AI/);
        assert.doesNotMatch(page, /^Теми:|^Източник:/m, 'annotation lines are rendered, not shown');
    }
    const { year, issue } = stories.at(-1);
    assert.doesNotMatch(
        read(`issues/${year}/${String(issue).padStart(2, '0')}/${issue}.md`),
        /class="(section-topics|topic-chip|story-link)"/,
        'issue pages carry no topics or story links',
    );
});

test('the front page leads with the newest issue; topic and upcoming pages are gone', () => {
    const home = read('index.html');
    assert.match(home, /<section class="lead-section">/);
    assert.doesNotMatch(home, /week-section|topic-grid|upcoming-section/);
    assert.ok(!fs.existsSync(path.join(dist, 'topics')) && !fs.existsSync(path.join(dist, 'upcoming')));
    assert.doesNotMatch(home, /href="\/(topics|upcoming)\//);
});

test('a share picture is a 1200×630 PNG with the story on it', async () => {
    const { renderShareImage } = await import('../scripts/lib/share-images.js');
    const png = await renderShareImage({
        headline: 'Минималната заплата става 660 евро',
        kicker: 'ДВ · Брой 100',
        topic: 'Работа и заплати',
    });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
});

test('offline reading and lean assets are published', () => {
    assert.match(read('offline/index.html'), /<meta name="robots" content="noindex" \/>/);
    const sw = read('sw.js');
    assert.doesNotMatch(sw, /__VERSION__/);
    assert.match(sw, /const VERSION = '[0-9a-f]{8}'/);
    const marked = read('src/js/marked.js');
    assert.match(marked, /^\/\*\*[\s\S]*?MIT License/, 'marked keeps its licence notice');
    assert.ok(read('src/js/app.js').split('\n').length < 20, 'scripts are minified');
    assert.ok(!fs.existsSync(path.join(dist, 'fonts', 'og')), 'share-picture fonts stay out of the site');
});

test('a story page steps its headings down from its h1', () => {
    for (const { year, issue, story } of stories.slice(0, 200)) {
        const page = read(`issue/${year}/${issue}/${story.slug}/index.html`);
        const article = page.slice(page.indexOf('<article'), page.indexOf('</article>'));
        assert.doesNotMatch(article, /<h1|<h3/, `${year}/${issue}/${story.slug}`);
    }
});

test('moved story addresses redirect, and nothing else does', () => {
    const redirects = read('_redirects');
    assert.match(redirects, /^# Addresses that moved/);
    assert.match(redirects, /^\/topics\/:topic\/feed\.xml \/feed\.xml 301$/m, 'old topic feeds lead to the site feed');
    assert.ok(
        redirects.indexOf('/topics/:topic/feed.xml') < redirects.indexOf('/topics/* /'),
        'feeds match before pages',
    );
    assert.match(redirects, /^\/upcoming\/ \/ 301$/m);
    for (const line of redirects.split('\n').filter((l) => l.startsWith('/issue/'))) {
        assert.match(line, /^\/issue\/\d{4}\/\d+\/[a-z0-9-]+\/ \/issue\/\d{4}\/\d+\/(?:[a-z0-9-]+\/)? 301$/);
    }
});
