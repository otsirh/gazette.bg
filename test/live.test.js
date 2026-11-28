import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSite } from '../live/build.js';
import { articleText, isOffTopic, parseFeed, toText } from '../live/lib/feeds.js';
import { HALF_LIFE, heatAt, rankStories, spreadTree, trendOf, trustOf } from '../live/lib/stories.js';
import { sourceIdForName } from '../live/sources.js';
import { applyWrite } from '../live/update.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-28T12:00:00Z');

const item = (id, source, hoursAgo, extra = {}) => ({
    id,
    source,
    kind: source.endsWith('-yt') ? 'video' : 'article',
    title: `t${id}`,
    url: `https://example.bg/${id}`,
    at: NOW - hoursAgo * HOUR,
    ...extra,
});

const story = (items, extra = {}) => ({
    id: 's1',
    title: 'Заглавие',
    summary: '',
    disputed: '',
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW,
    items,
    timeline: [],
    ...extra,
});

test('parseFeed reads RSS items with CDATA and entities', () => {
    const xml = `<rss><channel><title>x</title>
<item><title><![CDATA[Парламентът &quot;прие&quot; бюджета]]></title><link>https://www.bta.bg/a</link>
<pubDate>Sat, 28 Nov 2026 10:00:00 +0200</pubDate><description><![CDATA[<p>Текст &amp; още</p>]]></description><category>Политика</category></item>
<item><title>Без връзка</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
    const [a, ...rest] = parseFeed(xml, NOW);
    assert.equal(rest.length, 0, 'an item without a web link is dropped');
    assert.equal(a.title, 'Парламентът "прие" бюджета');
    assert.equal(a.url, 'https://www.bta.bg/a');
    assert.equal(a.at, Date.parse('2026-11-28T08:00:00Z'));
    assert.equal(a.description, 'Текст & още');
    assert.equal(a.category, 'Политика');
});

test('parseFeed reads YouTube Atom entries', () => {
    const xml = `<feed><entry><yt:videoId>pG-G0z9jG68</yt:videoId><title>По света и у нас</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=pG-G0z9jG68"/><published>2026-11-27T21:31:35+00:00</published>
<media:group><media:thumbnail url="https://i1.ytimg.com/vi/pG-G0z9jG68/hqdefault.jpg" width="480"/><media:description>Емисия</media:description></media:group></entry></feed>`;
    const [v] = parseFeed(xml, NOW);
    assert.equal(v.videoId, 'pG-G0z9jG68');
    assert.equal(v.url, 'https://www.youtube.com/watch?v=pG-G0z9jG68');
    assert.equal(v.description, 'Емисия');
});

test('parseFeed stamps a future date with the time it was read', () => {
    const xml = `<rss><item><title>a</title><link>https://x.bg/a</link><pubDate>Sat, 28 Nov 2026 20:00:00 +0200</pubDate></item></rss>`;
    assert.equal(parseFeed(xml, NOW)[0].at, NOW);
});

test('toText strips markup, including markup hidden in entities', () => {
    assert.equal(toText('<b>a</b> &lt;script&gt;x&lt;/script&gt; b'), 'a x b');
});

test('isOffTopic drops sport by path or category, keeps the rest', () => {
    assert.equal(isOffTopic({ url: 'https://www.24chasa.bg/sport/article/1', category: '' }), true);
    assert.equal(isOffTopic({ url: 'https://x.bg/a/1', category: 'Футбол' }), true);
    assert.equal(isOffTopic({ url: 'https://x.bg/bulgaria/1', category: 'Политика' }), false);
});

test('articleText keeps paragraphs and drops boilerplate', () => {
    const html = `<nav><p>Меню меню меню меню меню меню меню меню меню меню</p></nav>
<p>Премиерът заяви днес, че бюджетът ще бъде внесен до края на седмицата.</p>
<p>Кратко</p><p>Този сайт използва бисквитки, за да работи по-добре за вас.</p>`;
    assert.equal(articleText(html), 'Премиерът заяви днес, че бюджетът ще бъде внесен до края на седмицата.');
});

test('heat halves every HALF_LIFE and a new outlet counts more than a repeat', () => {
    const one = story([item('a', 'mediapool', 0)]);
    const old = story([item('a', 'mediapool', HALF_LIFE / HOUR)]);
    assert.ok(Math.abs(heatAt(one, NOW) - 1) < 1e-9);
    assert.ok(Math.abs(heatAt(old, NOW) - 0.5) < 1e-9);
    const twoOutlets = story([item('a', 'mediapool', 0), item('b', 'sega', 0)]);
    const sameOutlet = story([item('a', 'mediapool', 0), item('b', 'mediapool', 0)]);
    assert.ok(heatAt(twoOutlets, NOW) > heatAt(sameOutlet, NOW));
    // A channel and the site of the same outlet are one outlet.
    const siteAndChannel = story([item('a', 'bnt', 0), item('b', 'bnt-yt', 0)]);
    assert.ok(heatAt(siteAndChannel, NOW) < 2 * 1.2);
});

test('a story nobody writes about leaves the page', () => {
    const fading = story([item('a', 'mediapool', 20)]);
    const busy = story(
        ['mediapool', 'sega', 'bta', 'bnt', 'clubz'].map((s, i) => item(`b${i}`, s, 1)),
        { id: 's2' },
    );
    const ranked = rankStories([fading, busy], NOW);
    assert.deepEqual(
        ranked.map((r) => r.story.id),
        ['s2'],
    );
    assert.equal(ranked[0].level.id, 'warm');
});

test('trend: new, rising, falling', () => {
    assert.equal(trendOf(story([item('a', 'bta', 1)]), NOW), 'new');
    const rising = story([item('a', 'bta', 6), item('b', 'sega', 1), item('c', 'bnt', 0.5), item('d', 'clubz', 0.2)]);
    assert.equal(trendOf(rising, NOW), 'up');
    const falling = story([item('a', 'bta', 8), item('b', 'sega', 7), item('c', 'bnt', 6.5)]);
    assert.equal(trendOf(falling, NOW), 'down');
});

test('trust: first-hand plus another outlet is confirmed; one outlet is not', () => {
    assert.equal(trustOf(story([item('a', 'mediapool', 1)])).id, 'single');
    assert.equal(trustOf(story([item('a', 'mediapool', 1), item('b', 'sega', 1)])).id, 'several');
    const quoted = story([item('a', 'mediapool', 1, { cites: 'МВР', citesKind: 'institution' }), item('b', 'sega', 1)]);
    assert.equal(trustOf(quoted).id, 'confirmed');
    assert.equal(
        trustOf(story([item('a', 'bta', 1), item('b', 'sega', 1), item('c', 'mediapool', 1)])).id,
        'confirmed',
    );
});

test('spreadTree hangs a citing item under the outlet it cites', () => {
    const s = story([
        item('a', 'bta', 5, { cites: 'МВР', citesKind: 'institution' }),
        item('b', 'mediapool', 4, { cites: 'БТА', citesKind: 'media', citesSource: 'bta' }),
        item('c', 'sega', 3, { citesKind: 'own' }),
    ]);
    const roots = spreadTree(s);
    assert.equal(roots.length, 2);
    assert.equal(roots[0].name, 'МВР');
    assert.equal(roots[0].children[0].item.id, 'a');
    assert.equal(roots[0].children[0].children[0].item.id, 'b');
    assert.equal(roots[1].item.id, 'c');
});

test('sourceIdForName finds an outlet by any of its names', () => {
    assert.equal(sourceIdForName('БТА'), 'bta');
    assert.equal(sourceIdForName('„Сега“'), 'sega');
    assert.equal(sourceIdForName('Нова телевизия'), 'nova-yt');
    assert.equal(sourceIdForName('Прокуратурата'), null);
});

test('applyWrite fills in cites and timeline and clears the pending marks', () => {
    const a = item('a', 'mediapool', 2, { pending: true, description: 'x' });
    const b = item('b', 'sega', 1, { pending: true });
    const s = story([a, b]);
    applyWrite(
        s,
        [a, b],
        {
            title: 'Ново заглавие',
            summary: 'Обобщение',
            disputed: '',
            items: [
                { n: 0, cites: 'БТА', citesKind: 'media' },
                { n: 1, cites: '', citesKind: 'own' },
                { n: 7, cites: 'x', citesKind: 'media' },
            ],
            events: [
                { n: [1], who: 'Министър', what: 'заяви нещо' },
                { n: [9], who: 'Никой', what: 'няма такъв материал' },
            ],
        },
        NOW,
    );
    assert.equal(s.title, 'Ново заглавие');
    assert.equal(a.citesSource, 'bta');
    assert.equal(b.cites, null);
    assert.equal(s.timeline.length, 1);
    assert.equal(s.timeline[0].at, b.at);
    assert.ok(!a.pending && !b.pending && !('description' in a));
});

test('buildSite escapes everything from feeds and the model', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    const s = story(
        [
            item('a', 'mediapool', 1, { title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }),
            item('b', 'bnt-yt', 1, { videoId: 'abc"><x', title: 'видео' }),
            item('c', 'sega', 1),
        ],
        {
            title: '<script>alert(1)</script>',
            timeline: [{ at: NOW - HOUR, who: '<b>x</b>', what: 'заяви', items: ['a'] }],
        },
    );
    const state = {
        updatedAt: NOW,
        stories: [s],
        overview: { at: NOW, lines: [{ story: 's1', text: '<i>ред</i>' }] },
        sources: {},
    };
    await buildSite(state, { now: NOW, outDir: out, images: false });
    const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const page = fs.readFileSync(path.join(out, 's', 's1', 'index.html'), 'utf8');
    for (const html of [home, page]) {
        assert.ok(!html.includes('<script>alert'), 'no raw script from a title');
        assert.ok(!html.includes('<img src=x'), 'no raw markup from a feed');
        assert.ok(!html.includes('<i>ред'), 'no raw markup from the model');
        assert.ok(!html.includes('href="javascript:'), 'no script links');
    }
    assert.ok(!page.includes('abc"'), 'a malformed video id is not used');
    assert.ok(fs.existsSync(path.join(out, 'state.json')));
    fs.rmSync(out, { recursive: true, force: true });
});

test("a party's own channel never confirms a story on its own", () => {
    const s = story([item('a', 'gerb-yt', 1), item('b', 'sega', 1)]);
    const t = trustOf(s);
    assert.equal(t.firstHand, false);
    assert.equal(t.id, 'several');
});

test('spreadSvg draws a lane per outlet and links a citing item to its source', async () => {
    const { spreadSvg } = await import('../live/build.js');
    const svg = spreadSvg(
        story([
            item('a', 'bta', 3, { cites: 'МВР', citesKind: 'institution' }),
            item('b', 'mediapool', 2, { citesKind: 'media', citesSource: 'bta' }),
        ]),
        NOW,
    );
    assert.match(svg, /Първоизточник/);
    assert.equal((svg.match(/class="sp-lane"/g) ?? []).length, 3);
    assert.equal((svg.match(/class="sp-link"/g) ?? []).length, 1);
});

test('the track record counts who was first and who cites whom', async () => {
    const { outletContributions, addContributions } = await import('../live/lib/stories.js');
    const s = story([
        item('a', 'bta', 5, { citesKind: 'own' }),
        item('b', 'mediapool', 4, { citesKind: 'media', citesSource: 'bta' }),
        item('c', 'sega', 3, { citesKind: 'media', citesSource: 'bta' }),
    ]);
    const c = outletContributions(s);
    assert.equal(c.get('bta').first, 1);
    assert.equal(c.get('bta').citedBy, 2);
    assert.equal(c.get('mediapool').delayMin, 60);
    assert.equal(c.get('mediapool').attributed, 1);
    const totals = addContributions(addContributions({}, s), s);
    assert.equal(totals.bta.stories, 2);
    assert.equal(outletContributions(story([item('x', 'bta', 1), item('y', 'sega', 1)])).size, 0);
});

test('speaker names from the record lose their capitals', async () => {
    const { nameCase } = await import('../live/lib/depth.js');
    assert.equal(nameCase('НИКОЛАЙ ДЕНКОВ'), 'Николай Денков');
    assert.equal(nameCase('Иван Иванов'), 'Иван Иванов');
});

test('an independent author is its own kind and weighs a little less', () => {
    const one = heatAt(story([item('a', 'karbovski-yt', 0)]), NOW);
    assert.ok(Math.abs(one - 0.8) < 1e-9);
    assert.equal(trustOf(story([item('a', 'karbovski-yt', 1), item('b', 'indzhev', 1)])).firstHand, false);
});

test('tidy fixes what a rule can fix in Bulgarian text', async () => {
    const { tidy } = await import('../live/lib/text.js');
    assert.equal(
        tidy('Той  заяви ,че "всичко е наред" - и си тръгна...'),
        'Той заяви, че „всичко е наред“ – и си тръгна…',
    );
    assert.equal(tidy('тpaнcпopт и iPhone-а'), 'транспорт и iPhone-а');
    assert.equal(tidy('В 14:05 ч. на https://x.bg'), 'В 14:05 ч. на https://x.bg');
});

test('the proofreader may correct, not rewrite', async () => {
    const { isSmallFix } = await import('../live/lib/ai.js');
    assert.equal(isSmallFix('Министъра заяви че ще подаде оставка.', 'Министърът заяви, че ще подаде оставка.'), true);
    assert.equal(isSmallFix('Министърът заяви, че ще подаде оставка.', 'Премиерът подаде оставка.'), false);
});

test('merging two stories keeps both sets of items and the old address', async () => {
    const { mergeInto } = await import('../live/lib/depth.js');
    const a = story([item('a', 'bta', 2)], {
        id: 'aaaa1111',
        timeline: [{ at: NOW, who: 'X', what: 'каза', items: ['a'] }],
    });
    const b = story([item('a', 'bta', 2), item('b', 'sega', 1)], {
        id: 'bbbb2222',
        createdAt: NOW - 20 * HOUR,
        timeline: [{ at: NOW, who: 'X', what: 'каза', items: ['a'] }],
    });
    mergeInto(a, [b]);
    assert.deepEqual(
        a.items.map((i) => i.id),
        ['a', 'b'],
    );
    assert.equal(a.timeline.length, 1);
    assert.deepEqual(a.aliases, ['bbbb2222']);
    assert.equal(a.createdAt, NOW - 20 * HOUR);
});

test('a robots.txt that shuts out Anthropic or says ai-input=no refuses AI', async () => {
    const { aiRefused } = await import('../live/lib/robots.js');
    assert.equal(aiRefused('User-agent: *\nDisallow: /admin\n'), false);
    assert.equal(aiRefused('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n'), true);
    assert.equal(aiRefused('User-agent: ClaudeBot\nDisallow: /private\n'), false);
    assert.equal(aiRefused('User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n'), true);
    assert.equal(aiRefused('User-agent: *\nContent-Signal: ai-train=no, ai-input=yes\nAllow: /\n'), false);
});

test('robots.txt path rules and TDM reservations are respected', async () => {
    const { pathAllowed, aiRefused, tdmReserved } = await import('../live/lib/robots.js');
    const robots = 'User-agent: *\nDisallow: /premium/\nAllow: /premium/free\n\nUser-agent: GPTBot\nDisallow: /\n';
    assert.equal(pathAllowed(robots, '/news/1'), true);
    assert.equal(pathAllowed(robots, '/premium/x'), false);
    assert.equal(pathAllowed(robots, '/premium/free/1'), true);
    assert.equal(aiRefused(robots), false);
    assert.equal(aiRefused('User-agent: *\nDisallow: /\n'), true);
    assert.equal(tdmReserved('[{"location":"/*","tdm-reservation":1}]', '/a'), true);
    assert.equal(tdmReserved('[{"location":"/premium/*","tdm-reservation":1}]', '/news'), false);
});

test('election silence hides polls and party channels, only around election day', async () => {
    const { inElectionSilence, silenceFilter } = await import('../live/lib/policy.js');
    const p = { elections: ['2026-11-29'] };
    assert.equal(inElectionSilence(p, Date.parse('2026-11-28T10:00:00Z')), true);
    assert.equal(inElectionSilence(p, Date.parse('2026-11-29T20:00:00Z')), true);
    assert.equal(inElectionSilence(p, Date.parse('2026-11-26T10:00:00Z')), false);
    const kept = silenceFilter([
        story([item('a', 'bta', 1, { title: 'Проучване: 30% подкрепа за X' })], {
            id: 'p1',
            title: 'Ново социологическо проучване',
        }),
        story([item('b', 'gerb-yt', 1), item('c', 'bta', 1)], { id: 'p2', title: 'Министърът подаде оставка' }),
    ]);
    assert.deepEqual(
        kept.map((s) => s.id),
        ['p2'],
    );
    assert.deepEqual(
        kept[0].items.map((i) => i.id),
        ['c'],
    );
});

test('the blocklist removes stories, outlets and names everywhere', async () => {
    const { applyBlocklist } = await import('../live/lib/policy.js');
    const state = {
        stories: [
            story([item('a', 'bta', 1)], { id: 'keep1', title: 'Иван Петров заяви нещо', summary: 'Иван Петров каза' }),
            story([item('b', 'sega', 1)], { id: 'drop1' }),
        ],
        overview: { lines: [{ story: 'keep1', text: 'Иван Петров е тук' }] },
    };
    applyBlocklist(state, { blocklist: { stories: ['drop1'], items: [], outlets: [], names: ['Иван Петров'] } });
    assert.deepEqual(
        state.stories.map((s) => s.id),
        ['keep1'],
    );
    assert.ok(!JSON.stringify(state).includes('Иван Петров'));
});

test('copying twelve words in a row from a source is caught, quotes are not', async () => {
    const { copiesSource } = await import('../live/lib/policy.js');
    const src =
        'Министърът на финансите заяви днес пред журналисти в парламента че бюджетът ще бъде внесен до края на седмицата';
    assert.equal(
        copiesSource('Той заяви днес пред журналисти в парламента че бюджетът ще бъде внесен до края', [src]),
        true,
    );
    assert.equal(copiesSource('Министърът обеща бюджетът да е готов до петък.', [src]), false);
    assert.equal(
        copiesSource('Той каза: „днес пред журналисти в парламента че бюджетът ще бъде внесен до края“.', [src]),
        false,
    );
});

test('YouTube uploads come from the Data API, never the feed, and the key is not echoed', async () => {
    const { channelUploads, madeForKids } = await import('../live/lib/youtube.js');
    const real = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
        seen.push(String(url));
        if (String(url).includes('/playlistItems')) {
            return new Response(
                JSON.stringify({
                    items: [
                        {
                            snippet: { title: 'Интервю', description: 'д', publishedAt: '2026-11-28T08:00:00Z' },
                            contentDetails: { videoId: 'abcDEF12345' },
                        },
                        { snippet: { title: 'Private video' }, contentDetails: { videoId: 'zzzzzzzzzzz' } },
                    ],
                }),
            );
        }
        if (String(url).includes('/videos'))
            return new Response(JSON.stringify({ items: [{ id: 'abcDEF12345', status: { madeForKids: true } }] }));
        return new Response('', { status: 404 });
    };
    try {
        const list = await channelUploads('UC1234567890123456789012', 'KEY', NOW);
        assert.equal(list.length, 1);
        assert.equal(list[0].url, 'https://www.youtube.com/watch?v=abcDEF12345');
        assert.ok(seen[0].includes('playlistId=UU1234567890123456789012'));
        assert.ok(!seen.some((u) => u.includes('feeds/videos.xml')));
        assert.ok((await madeForKids(['abcDEF12345'], 'KEY')).has('abcDEF12345'));
        globalThis.fetch = async () => new Response('', { status: 403 });
        await assert.rejects(
            channelUploads('UC1234567890123456789012', 'SECRETKEY'),
            (e) => !e.message.includes('SECRETKEY'),
        );
    } finally {
        globalThis.fetch = real;
    }
});
