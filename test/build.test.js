import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { buildCatalog } from '../scripts/build-gazette-catalog.js';
import { buildSite, lit, processRenderedContent } from '../scripts/build-issue-pages.js';
import { ISSUES_DIR } from '../scripts/lib/issues.js';

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

before(() => {
    const log = console.log;
    console.log = () => {};
    try {
        catalog = buildCatalog({ distDir: dist });
        buildSite({ distDir: dist });
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
    assert.match(home, /<script type="module" src="\/src\/js\/app\.js/);
    assert.ok(fs.existsSync(path.join(dist, 'src/js/shared.js')), 'the module app.js imports is published');
});

test('sitemap, feed and search index cover the issues', () => {
    assert.equal((read('sitemap.xml').match(/<url>/g) || []).length, summaries.length + 1);
    const items = read('feed.xml').match(/<item>/g) || [];
    assert.equal(items.length, Math.min(50, summaries.length));
    assert.equal(Object.keys(JSON.parse(read('search-index.json'))).length, summaries.length);
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
