import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSite, wideCards } from '../live/build.js';
import { articleText, isOffTopic, parseFeed, toText } from '../live/lib/feeds.js';
import { HALF_LIFE, heatAt, rankStories, spreadTree, trendOf, trustOf } from '../live/lib/stories.js';
import { sourceIdForName } from '../live/sources.js';
import { applyWrite, checkQuotes, isTransient, proofQueue, toItem } from '../live/update.js';

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
    assert.equal(sourceIdForName('Сметната палата'), 'smetna');
    assert.equal(sourceIdForName('Министерството на финансите'), null);
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
    const s = story([item('a', 'dps-yt', 1), item('b', 'sega', 1)]);
    const t = trustOf(s);
    assert.equal(t.firstHand, false);
    assert.equal(t.id, 'several');
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
        story([item('b', 'dps-yt', 1), item('c', 'bta', 1)], { id: 'p2', title: 'Министърът подаде оставка' }),
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

test('one refusing Anthropic group is enough, even if another allows', async () => {
    const { aiRefused } = await import('../live/lib/robots.js');
    assert.equal(aiRefused('User-agent: Claude-User\nAllow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n'), true);
});

test('a news list page gives dated items with clean headlines', async () => {
    const { parseList, parseBgDate } = await import('../live/lib/feeds.js');
    const html = `<ul>
<li><span class="date">27.11.2026</span><a href="/bg/news/101-statement">Прокуратурата повдигна обвинение на кмета на общината</a></li>
<li><a href="/bg/news/102-old" title="Министърът откри новата сграда на агенцията">Министърът откри</a><time datetime="2026-11-20T10:00">20 ноември</time></li>
<li><a href="/bg/about">За нас и нашата история от години насам</a></li>
<li><a href="/bg/news/103-undated">Съобщение без дата никъде около него в страницата</a></li></ul>`;
    const items = parseList(html, 'https://example.bg/bg/news', '^/bg/news/\\d+', NOW);
    assert.deepEqual(
        items.map((i) => [i.url.split('/').pop(), i.dated]),
        [
            ['101-statement', true],
            ['102-old', true],
            ['103-undated', true],
        ].slice(0, 3),
    );
    assert.equal(items[1].title, 'Министърът откри новата сграда на агенцията');
    assert.equal(parseBgDate('23 Ное 2026'), Date.parse('2026-11-23T12:00:00+02:00'));
    assert.equal(parseBgDate('ноември 17, 2026'), Date.parse('2026-11-17T12:00:00+02:00'));
});

test('hot cards: video cards and lone text cards take the whole row, text cards pair up', () => {
    assert.deepEqual(wideCards([false, false, false]), [true, false, false]);
    assert.deepEqual(wideCards([false, true, false, true, false]), [true, true, true, true, true]);
    assert.deepEqual(wideCards([true, false, false, false, true]), [true, false, false, true, true]);
    assert.deepEqual(wideCards([]), []);
});

test('video ids come back from watch links only', async () => {
    const { videoIdOf } = await import('../live/lib/youtube.js');
    assert.equal(videoIdOf('https://www.youtube.com/watch?v=KijPv5Z9N9M'), 'KijPv5Z9N9M');
    assert.equal(videoIdOf('https://www.youtube.com/watch?v=<script>'), null);
    assert.equal(videoIdOf('https://btvnovinite.bg/a/b'), null);
    assert.equal(videoIdOf('not a url'), null);
});

test('the sensitive rule names children, sexual and domestic violence, not every victim', async () => {
    const { SENSITIVE_RULE } = await import('../live/lib/ai.js');
    assert.match(SENSITIVE_RULE, /под 18/);
    assert.match(SENSITIVE_RULE, /сексуално насилие/);
    assert.match(SENSITIVE_RULE, /домашно насилие/);
    assert.match(SENSITIVE_RULE, /не е основание/);
});

// Every count on every page agrees with its noun: "1 видео", "2 видеа",
// "1 медия", "2 медии", "1 материал", "2 материала".
test('built pages: counts agree with their nouns', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-plurals-'));
    const vid = (n, h) =>
        item(`v${n}`, 'bnt-yt', h, { videoId: `vid${n}abcdef`, url: `https://www.youtube.com/watch?v=vid${n}abcdef` });
    // Seven videos (four shown, "Още 3 видеа"), and a story with one of each.
    const many = story(
        [item('a', 'mediapool', 1), item('b', 'sega', 1), ...[1, 2, 3, 4, 5, 6, 7].map((n) => vid(n, n / 10))],
        {
            id: 'many',
            summary: 'Обобщение',
        },
    );
    const one = story([item('c', 'mediapool', 2), vid(8, 2)], { id: 'one', summary: 'Обобщение' });
    await buildSite({ updatedAt: NOW, stories: [many, one], sources: {} }, { now: NOW, outDir: out, images: false });
    const bad = [];
    const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) walk(p);
            else if (f.name.endsWith('.html')) {
                const text = fs.readFileSync(p, 'utf8').replace(/<[^>]+>/g, ' ');
                for (const m of text.matchAll(
                    /(?<![\d,])(\d+)\s+(видео|видеа|медия|медии|материал|материала|история|истории)(?![а-я])/g,
                )) {
                    const n = Number(m[1]);
                    const one = ['видео', 'медия', 'материал', 'история'].includes(m[2]);
                    if ((n === 1) !== one) bad.push(`${path.relative(out, p)}: ${m[0]}`);
                }
            }
        }
    };
    walk(out);
    assert.deepEqual(bad, []);
    assert.match(fs.readFileSync(path.join(out, 's', 'many', 'index.html'), 'utf8'), /Още 3 видеа/);
    fs.rmSync(out, { recursive: true, force: true });
});

test('tidy: decimal comma before a unit, en dash in ranges, dates and times untouched', async () => {
    const { tidy } = await import('../live/lib/text.js');
    assert.equal(tidy('дължина 9.5 км и 2.18 промила'), 'дължина 9,5 км и 2,18 промила');
    assert.equal(tidy('с 5-10 млрд. евро'), 'с 5–10 млрд. евро');
    assert.equal(tidy('на 28.11 в 9.30 ч.'), 'на 28.11 в 9.30 ч.');
    assert.equal(tidy('„Симеоново - Алеко“'), '„Симеоново – Алеко“');
    assert.equal(tidy('22-рия пакет, АМ-1'), '22-рия пакет, АМ-1');
});

test('clip cuts at a word, never mid-word', async () => {
    const { clip } = await import('../live/lib/text.js');
    assert.equal(clip('кратко', 60), 'кратко');
    const long = 'Българска федерация по волейбол, Българска федерация по лека атлетика';
    const c = clip(long, 40);
    assert.ok(c.length <= 40 && c.endsWith('…'));
    assert.ok(long.startsWith(c.slice(0, -1)));
    assert.match(c, /\p{L}…$/u);
});

test('tidyState reaches every text the model wrote, not outlet headlines', async () => {
    const { tidyState } = await import('../live/lib/text.js');
    const state = {
        stories: [
            {
                title: 'Лифт 9.5 км',
                summary: '"Стандарт"',
                disputed: '',
                items: [{ title: 'Очкават сняг 9.5 км', cites: 'БТА' }],
                timeline: [{ actor: 'СО', who: 'кмет', what: 'А - Б' }],
            },
        ],
        overview: { lines: [{ text: 'до 5-10 см' }] },
    };
    tidyState(state);
    const s = state.stories[0];
    assert.equal(s.title, 'Лифт 9,5 км');
    assert.equal(s.summary, '„Стандарт“');
    assert.equal(s.timeline[0].what, 'А – Б');
    assert.equal(state.overview.lines[0].text, 'до 5–10 см');
    assert.equal(s.items[0].title, 'Очкават сняг 9.5 км', 'an outlet headline is theirs');
});

test('originOf: an institution broke the news, a quoted person did not', async () => {
    const { originOf } = await import('../live/lib/stories.js');
    const byInst = originOf(
        story([item('a', 'bta', 2, { cites: 'МВР', citesKind: 'institution' }), item('b', 'sega', 1)]),
    );
    assert.equal(byInst.name, 'МВР');
    const byPerson = originOf(
        story([item('a', 'mediapool', 2, { cites: 'Бойко Борисов', citesKind: 'person' }), item('b', 'sega', 1)]),
    );
    assert.equal(byPerson.name, 'Медиапул');
    assert.equal(byPerson.words, 'Бойко Борисов');
});

test("one outlet's channels count as one outlet", async () => {
    const { outletOf } = await import('../live/sources.js');
    assert.equal(outletOf('nova-yt'), 'nova');
    assert.equal(outletOf('zdravei-yt'), 'nova');
    assert.equal(outletOf('tvoyatden-yt'), 'nova');
    const s = story([item('a', 'nova-yt', 2), item('b', 'tvoyatden-yt', 1), item('c', 'zdravei-yt', 1)]);
    assert.equal(trustOf(s).outlets, 1);
});

test("robots: a group with only Crawl-delay does not take the next group's rules", async () => {
    const { aiRefused } = await import('../live/lib/robots.js');
    const robots =
        'User-agent: *\nDisallow: /old/\n\nUser-agent: ClaudeBot\nCrawl-Delay: 10\n\nUser-agent: BadBot\nDisallow: /\n';
    assert.equal(aiRefused(robots), false);
    assert.equal(
        aiRefused('User-agent: ClaudeBot\nUser-agent: GPTBot\nDisallow: /\n'),
        true,
        'consecutive agents share a group',
    );
});

test('parseFeed: a link in <url> and a zone-less date in Sofia time', () => {
    const xml =
        '<rss><channel><item><title>Заглавие на новината тук</title><url>https://varnautre.bg/2026/11/28/1-a</url><pubDate>2026-11-28 12:28:10</pubDate></item></channel></rss>';
    const [e] = parseFeed(xml, Date.UTC(2026, 10, 29));
    assert.equal(e.url, 'https://varnautre.bg/2026/11/28/1-a');
    assert.equal(new Date(e.at).toISOString(), '2026-11-28T10:28:10.000Z');
});

test('heat: one outlet writing a lot counts less than many outlets', async () => {
    const flood = story(Array.from({ length: 20 }, (_, i) => item(`f${i}`, 'mediapool', i * 0.1)));
    const broad = story(['mediapool', 'sega', 'clubz', 'offnews'].map((s, i) => item(`b${i}`, s, 0.5)));
    assert.ok(heatAt(broad, NOW) > heatAt(flood, NOW), 'four outlets beat twenty items from one');
    // The outlet's newest item is the one that counts in full.
    const recentRepeat = story([item('o', 'mediapool', 12), item('n', 'mediapool', 0)]);
    assert.ok(heatAt(recentRepeat, NOW) > 1, 'a fresh item keeps the outlet on the story');
});

test('news clock: at night, with nothing published, a story keeps most of its heat', async () => {
    const { newsClock } = await import('../live/lib/stories.js');
    // A busy day (100 items between 08:00 and 20:00), then a silent night.
    const day = Date.UTC(2026, 10, 27, 6, 0);
    const items = Array.from({ length: 100 }, (_, i) => item(`d${i}`, 'bta', 0, { at: day + i * 432000 }));
    const evening = Date.UTC(2026, 10, 27, 18, 0);
    const morning = Date.UTC(2026, 10, 28, 4, 0);
    const big = story([item('x', 'sega', 0, { at: evening })], { id: 'x' });
    const all = [story(items, { id: 'day' }), big];
    const clock = newsClock(all, morning);
    const kept = heatAt(big, morning, clock) / heatAt(big, evening, clock);
    const wall = heatAt(big, morning) / heatAt(big, evening);
    assert.ok(kept > 0.6, `kept ${kept.toFixed(2)} of its heat overnight`);
    assert.ok(wall < 0.35, 'the wall clock would have taken most of it');
});

test('at most MAX_HOT stories are hot', async () => {
    const { MAX_HOT } = await import('../live/lib/stories.js');
    const outlets = ['bta', 'bnt', 'sega', 'clubz', 'offnews', 'mediapool', 'dnes', '24chasa'];
    const many = Array.from({ length: MAX_HOT + 3 }, (_, n) =>
        story(
            outlets.map((o, i) => item(`${n}-${i}`, o, 0.1)),
            { id: `s${n}`, title: `История ${n}` },
        ),
    );
    const ranked = rankStories(many, NOW);
    assert.equal(ranked.filter((r) => r.level.id === 'hot').length, MAX_HOT);
});

test('tidy: the percent sign sits right after the number', async () => {
    const { tidy } = await import('../live/lib/text.js');
    assert.equal(tidy('около 40 % от нарушенията'), 'около 40% от нарушенията');
});

test('tidy: a sentence never begins with „се“, „си“, „му“…, but a name stays', async () => {
    const { tidy } = await import('../live/lib/text.js');
    assert.equal(tidy('се прибраха в България'), 'прибраха се в България');
    assert.equal(tidy('Се ударили челно'), 'Ударили се челно');
    assert.equal(tidy('се е прибрал вкъщи'), 'прибрал се е вкъщи');
    assert.equal(tidy('му се обади министърът'), 'обади му се министърът');
    assert.equal(tidy('Си Дзинпин заяви'), 'Си Дзинпин заяви');
    assert.equal(tidy('ще следи за нарушения'), 'ще следи за нарушения');
});

test('a quote no source says word for word is caught; a name in quotes is not a quote', async () => {
    const { unverifiedQuotes, unquote } = await import('../live/lib/policy.js');
    const sources = ['Министърът заяви: „Няма да подам оставка, докато не приключи проверката“, каза той.'];
    assert.deepEqual(unverifiedQuotes('заяви, че „няма да подам оставка, докато не приключи проверката“', sources), []);
    assert.deepEqual(unverifiedQuotes('каза „няма да подам оставка … приключи проверката“', sources), []);
    assert.deepEqual(unverifiedQuotes('работи в „Топлофикация София“', sources), []);
    const made = 'заяви: „Ще подам оставка утре сутринта“';
    const loose = unverifiedQuotes(made, sources);
    assert.deepEqual(loose, ['Ще подам оставка утре сутринта']);
    assert.equal(unquote(made, loose), 'заяви: Ще подам оставка утре сутринта');
});

test('trust: retelling another outlet, an interview or a dispute does not confirm', () => {
    // Three outlets, but two only retell BTA: one outlet knows it for itself.
    const retold = story([
        item('a', 'bta', 1),
        item('b', 'sega', 1, { cites: 'БТА', citesKind: 'media' }),
        item('c', 'mediapool', 1, { cites: 'БТА', citesKind: 'media' }),
    ]);
    assert.equal(trustOf(retold).id, 'several');
    assert.equal(trustOf(retold).independent, 1);
    // A person speaking in an interview is a view, not a first-hand fact.
    const interview = story([
        item('a', 'mediapool', 1, { cites: 'проф. Иванов', citesKind: 'person' }),
        item('b', 'sega', 1),
    ]);
    assert.equal(trustOf(interview).id, 'several');
    // Sources that contradict each other: never "Потвърдено".
    const confirmed = story([item('a', 'bta', 1), item('b', 'sega', 1), item('c', 'mediapool', 1)]);
    assert.equal(trustOf(confirmed).id, 'confirmed');
    assert.equal(trustOf({ ...confirmed, disputed: 'Кой е виновен' }).id, 'several');
});

test('a sensitive story: headlines hidden on the page, sealed in the state, opened again', async () => {
    const { openSeals } = await import('../live/lib/seal.js');
    const before = process.env.LIVE_SEAL_KEY;
    process.env.LIVE_SEAL_KEY = 'test-key';
    try {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
        const s = story(
            [
                item('a', 'mediapool', 1, { title: 'Детето Иван е в болница' }),
                item('b', 'bnt-yt', 1, { title: 'Видео за Иван', videoId: 'abcDEF12345' }),
                item('c', 'sega', 1, { title: 'Иван е добре' }),
            ],
            { id: 'sens1234', sensitive: true, summary: 'Дете е в болница.' },
        );
        const state = { updatedAt: NOW, stories: [s], sources: {} };
        await buildSite(state, { now: NOW, outDir: out, images: false });
        const page = fs.readFileSync(path.join(out, 's', 'sens1234', 'index.html'), 'utf8');
        const published = fs.readFileSync(path.join(out, 'state.json'), 'utf8');
        for (const text of [page, published]) {
            assert.ok(!text.includes('Иван'), 'no headline names the child');
            assert.ok(!text.includes('abcDEF12345'), 'no video');
        }
        assert.equal(s.items[0].title, 'Детето Иван е в болница', 'the state in memory is untouched');
        const back = JSON.parse(published);
        openSeals(back);
        assert.equal(back.stories[0].items[0].title, 'Детето Иван е в болница');
        assert.equal(back.stories[0].items[1].videoId, 'abcDEF12345');
        // Another key cannot open it, and keeps it sealed rather than lose it.
        const again = JSON.parse(published);
        process.env.LIVE_SEAL_KEY = 'another-key';
        openSeals(again);
        assert.equal(again.stories[0].items[0].title, '');
        assert.ok(again.stories[0].items[0].sealed);
        fs.rmSync(out, { recursive: true, force: true });
    } finally {
        if (before === undefined) delete process.env.LIVE_SEAL_KEY;
        else process.env.LIVE_SEAL_KEY = before;
    }
});

test('a cold story and a remembered one keep their pages; „Никой не казва“ is gone', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    const hot = story([item('a', 'bta', 1), item('b', 'sega', 1), item('c', 'mediapool', 1)], {
        id: 'hot12345',
        framing: { angles: [{ label: 'Ъгъл', summary: 'Обяснение', items: ['a'] }], missing: 'Нищо', at: NOW },
    });
    const cold = story([item('d', 'bta', 60)], { id: 'cold1234', title: 'Стара история' });
    const state = {
        updatedAt: NOW,
        stories: [hot, cold],
        sources: {},
        memory: [{ id: 'gone1234', title: 'Забравена история', summary: 'Какво беше.', at: NOW - 80 * HOUR }],
    };
    await buildSite(state, { now: NOW, outDir: out, images: false });
    const coldPage = fs.readFileSync(path.join(out, 's', 'cold1234', 'index.html'), 'utf8');
    assert.match(coldPage, /Тази история изстина/);
    assert.match(coldPage, /<meta name="robots" content="noindex"/);
    const gonePage = fs.readFileSync(path.join(out, 's', 'gone1234', 'index.html'), 'utf8');
    assert.match(gonePage, /Забравена история/);
    assert.match(gonePage, /Вече не се следи/);
    const hotPage = fs.readFileSync(path.join(out, 's', 'hot12345', 'index.html'), 'utf8');
    assert.ok(!hotPage.includes('Никой не казва'));
    assert.ok(!hotPage.includes('noindex'));
    assert.ok(!fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8').includes('cold1234'));
    fs.rmSync(out, { recursive: true, force: true });
});

test('a blocked story leaves the memory too, so it gets no page', async () => {
    const { applyBlocklist } = await import('../live/lib/policy.js');
    const state = {
        stories: [],
        memory: [
            { id: 'blok1234', title: 'Блокирана', summary: '', at: NOW },
            { id: 'keep1234', title: 'Остава', summary: '', at: NOW },
        ],
    };
    applyBlocklist(state, { blocklist: { stories: ['blok1234'], items: [], outlets: [], names: [] } });
    assert.deepEqual(
        state.memory.map((m) => m.id),
        ['keep1234'],
    );
});

test('merging a sensitive story into another keeps its items hidden', async () => {
    const { mergeInto } = await import('../live/lib/depth.js');
    const keep = story([item('a', 'bta', 1)], { id: 'keep1234' });
    const other = story([item('b', 'sega', 1)], { id: 'sens1234', sensitive: true });
    mergeInto(keep, [other]);
    assert.equal(keep.sensitive, true);
});

test('the writer unquotes every quote no source has, in the summary and in each step', () => {
    const sources = ['Премиерът каза: „Бюджетът ще бъде приет до края на годината“.'];
    const result = {
        title: 'Бюджетът',
        summary: 'Премиерът обеща: „Бюджетът ще бъде приет до края на годината“.',
        disputed: '',
        background: '',
        events: [
            { what: 'заяви: „Няма да има нови данъци догодина“' },
            { what: 'обеща „бюджетът ще бъде приет до края на годината“' },
        ],
    };
    const loose = checkQuotes(result, story([]), sources);
    assert.deepEqual(loose, ['Няма да има нови данъци догодина']);
    assert.equal(result.summary, 'Премиерът обеща: „Бюджетът ще бъде приет до края на годината“.');
    assert.equal(result.events.length, 2, 'no step is dropped');
    assert.equal(result.events[0].what, 'заяви: Няма да има нови данъци догодина');
    assert.equal(result.events[1].what, 'обеща „бюджетът ще бъде приет до края на годината“');
});

test('proofreading reads only new text, each distinct text once, and retries what failed', () => {
    const old = story([], { title: 'Старо заглавие', summary: 'Старо обобщение.', timeline: [] });
    const state = { stories: [old], overview: null };
    const proofedBefore = new Set(['Старо заглавие', 'Старо обобщение.', 'Иван Иванов, министър']);
    const e1 = { who: 'Иван Иванов, министър', what: 'заяви нещо' };
    const e2 = { who: 'Мария Петрова, кмет', what: 'заяви нещо' };
    old.timeline.push(e1, e2);
    old.disputed = 'Спорът от миналия път.';
    const proof = [
        [old, 'title'],
        [old, 'summary'],
        [e1, 'who'],
        [e1, 'what'],
        [e2, 'who'],
        [e2, 'what'],
    ];
    const { queued, distinct } = proofQueue(proof, state, proofedBefore, new Set(['Спорът от миналия път.']));
    assert.deepEqual(distinct, ['заяви нещо', 'Мария Петрова, кмет', 'Спорът от миналия път.']);
    assert.equal(queued.length, 4, 'both steps get the fix to their shared text');
});

test('only a busy or unreachable API counts as passing trouble', () => {
    assert.equal(isTransient({ status: 529 }), true);
    assert.equal(isTransient({ status: 429 }), true);
    assert.equal(isTransient({ name: 'APIConnectionTimeoutError' }), true);
    assert.equal(isTransient({ status: 400 }), false);
    assert.equal(isTransient(new SyntaxError('Unexpected token')), false);
});

test('a card says when its story last gained a step; the trend never reads like the group', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    const s = story([item('a', 'bta', 9), item('b', 'sega', 8), item('c', 'mediapool', 7)], {
        id: 'step1234',
        timeline: [{ at: NOW - 8 * HOUR, who: 'МВР', what: 'съобщи', items: ['b'] }],
    });
    await buildSite({ updatedAt: NOW, stories: [s], sources: {} }, { now: NOW, outDir: out, images: false });
    const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(home, new RegExp(`data-step="${NOW - 8 * HOUR}"`));
    assert.ok(!/▼ утихва/.test(home), 'the falling trend is „отслабва“');
    fs.rmSync(out, { recursive: true, force: true });
});

test('a deadline enters the ledger only word for word, with a real future date and someone to answer for it', async () => {
    const { acceptCommitments, recordCommitments } = await import('../live/lib/ledger.js');
    const a = item('a', 'sega', 2, { title: 'Парното се връща' });
    const b = item('b', 'bta', 1, { title: 'Топлофикация обеща парно' });
    const texts = new Map([
        ['a', 'Топлофикация София съобщи за аварии със заявено възстановяване на 29 ноември в Лозенец.'],
        ['b', 'Дружеството обеща парно със заявено възстановяване на 29 ноември в Лозенец, каза говорителят.'],
    ]);
    const good = {
        n: [0],
        owner: 'Топлофикация София',
        kind: 'deadline',
        quote: 'със заявено възстановяване на 29 ноември в Лозенец',
        due: '2026-11-29',
        dueKind: 'on',
    };
    const result = {
        commitments: [
            good,
            { ...good, quote: 'ще възстанови всичко до 29 ноември без изключение' }, // not in the text
            { ...good, due: '2026-11-31' }, // no such day
            { ...good, due: '2026-11-01' }, // before the article
            { ...good, owner: '' }, // no one answers for it
            { ...good, quote: 'аварии в Лозенец и Младост днес' }, // carries no date
        ],
    };
    const s = story([a, b], { id: 'toplo123' });
    const ok = acceptCommitments({ result, story: s, pending: [a, b], texts, now: NOW });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].story, 'toplo123');
    assert.equal(
        acceptCommitments({ result, story: { ...s, sensitive: true }, pending: [a, b], texts, now: NOW }).length,
        0,
    );
    // Flagged sensitive in this very write: none either.
    const flagged = { ...result, sensitive: true };
    assert.equal(acceptCommitments({ result: flagged, story: s, pending: [a, b], texts, now: NOW }).length, 0);
    // Only the words with the date, not a paragraph.
    const long = { ...good, quote: `${'дълго изречение '.repeat(12)}със заявено възстановяване на 29 ноември` };
    const withLong = new Map([...texts, ['a', `${texts.get('a')} ${long.quote}`]]);
    const longResult = { commitments: [long] };
    assert.equal(
        acceptCommitments({ result: longResult, story: s, pending: [a, b], texts: withLong, now: NOW }).length,
        0,
    );

    const state = {};
    assert.equal(recordCommitments(state, ok, NOW).length, 1);
    // The same deadline from another outlet joins the entry.
    const again = acceptCommitments({
        result: { commitments: [{ ...good, n: [1] }] },
        story: s,
        pending: [a, b],
        texts,
        now: NOW,
    });
    assert.equal(recordCommitments(state, again, NOW).length, 0);
    assert.equal(state.ledger.length, 1);
    assert.equal(state.ledger[0].sources.length, 2);
    assert.equal(state.ledger[0].status, 'open');
});

test('the blocklist reaches the ledger: a blocked story and a blocked name leave it', async () => {
    const { applyBlocklist } = await import('../live/lib/policy.js');
    const state = {
        stories: [],
        ledger: [
            { story: 'blok1234', owner: 'МВР', quote: 'до 5 декември ще бъде готово' },
            { story: 'keep1234', owner: 'Иван Секретов', quote: 'до 5 декември ще бъде готово' },
            { story: 'keep1234', owner: 'МВР', quote: 'до 6 декември ще бъде готово' },
        ],
    };
    applyBlocklist(state, { blocklist: { stories: ['blok1234'], items: [], outlets: [], names: ['Секретов'] } });
    assert.deepEqual(
        state.ledger.map((e) => e.quote),
        ['до 6 декември ще бъде готово'],
    );
});

test('a new story is shown the earlier stories it shares rare words with, not just the newest', async () => {
    const { pastFor } = await import('../live/lib/depth.js');
    const memory = [
        {
            id: 'm1',
            title: 'ОИК във Варна отстрани кмета Благомир Коцев',
            summary: 'Решението е обжалвано.',
            at: NOW - 90 * HOUR,
        },
        ...Array.from({ length: 60 }, (_, i) => ({
            id: `x${i}`,
            title: `България и новина номер ${i}`,
            summary: 'В България се случи нещо.',
            at: NOW - i * HOUR,
        })),
    ];
    const state = { stories: [], memory };
    const fresh = story([item('a', 'bta', 1, { title: 'Съдът във Варна спря отстраняването на Коцев' })], {
        id: 'new12345',
        title: 'Делото за кмета Благомир Коцев',
    });
    const past = pastFor(state, fresh, NOW, fresh.items);
    assert.equal(past[0].id, 'm1');
    assert.ok(past.length < 25, 'a word in every story („България“) brings nothing');
});

test('a headlines-only source gives the model its headline and link, not its excerpt', () => {
    const e = {
        url: 'https://bntnews.bg/a',
        title: 'Заглавие',
        description: 'Откъс от статията',
        at: NOW,
        kind: 'article',
    };
    assert.equal(toItem({ ...e, source: 'bnt' }).description, '');
    assert.equal(toItem({ ...e, source: 'sega' }).description, 'Откъс от статията');
});
