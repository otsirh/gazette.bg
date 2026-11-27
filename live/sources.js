// Every source live.gazette.bg reads, with how much its word weighs.
//
// The weight is by checkable criteria, never by political line:
//   1 — first-hand: an institution's own channel, or the person speaking on
//       camera. Nothing stands between the reader and who said it.
//   2 — news agency or public broadcaster: bound by law to report and
//       correct, with a newsroom that answers for every item.
//   3 — editorial outlet with a known owner and signed articles.
//   4 — no known owner or author, or mostly re-posts others' text.
// A source is added only with a working feed and a reason for its weight.

export const TIERS = {
    1: { label: 'Първоизточник', short: 'първоизточник', weight: 1.3 },
    2: { label: 'Агенция или обществена медия', short: 'обществена', weight: 1.2 },
    3: { label: 'Редакционна медия', short: 'редакционна', weight: 1 },
    4: { label: 'Без ясен собственик или автор', short: 'неясна', weight: 0.6 },
};

const yt = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

export const SOURCES = [
    // 1 — first-hand
    {
        id: 'parliament',
        name: 'Народно събрание',
        home: 'https://www.parliament.bg',
        feed: 'https://www.parliament.bg/feed/news',
        kind: 'article',
        tier: 1,
        why: 'Официалните съобщения на парламента.',
        aliases: ['Народното събрание', 'парламента', 'парламентът'],
    },
    {
        id: 'cik-yt',
        name: 'ЦИК (видео)',
        home: 'https://www.youtube.com/channel/UC1IbhR8-YZCyo0o6NfbEdAQ',
        feed: yt('UC1IbhR8-YZCyo0o6NfbEdAQ'),
        kind: 'video',
        tier: 1,
        why: 'Каналът на Централната избирателна комисия: заседанията и брифингите ѝ.',
        aliases: ['ЦИК', 'Централната избирателна комисия'],
    },

    // 2 — agencies and public broadcasters
    {
        id: 'bta',
        name: 'БТА',
        home: 'https://www.bta.bg',
        feed: 'https://www.bta.bg/bg/rss/free',
        kind: 'article',
        tier: 2,
        why: 'Националната информационна агенция; по закон отговаря за точността на съобщенията си.',
        aliases: ['БТА', 'BTA', 'Българската телеграфна агенция'],
    },
    {
        id: 'bnt',
        name: 'БНТ',
        home: 'https://bntnews.bg',
        feed: 'https://bntnews.bg/bg/rss/news',
        kind: 'article',
        tier: 2,
        why: 'Обществената телевизия; Законът за радиото и телевизията я задължава с безпристрастност.',
        aliases: ['БНТ', 'BNT', 'Българската национална телевизия', 'bntnews'],
    },
    {
        id: 'bnt-yt',
        name: 'БНТ (видео)',
        home: 'https://www.youtube.com/channel/UC8jnuRbBzMICRHsC0qqVd9Q',
        feed: yt('UC8jnuRbBzMICRHsC0qqVd9Q'),
        kind: 'video',
        tier: 2,
        why: 'Емисиите и интервютата на обществената телевизия.',
        aliases: [],
    },
    {
        id: 'bnr-yt',
        name: 'БНР (видео)',
        home: 'https://www.youtube.com/channel/UCoNokfwANJSKM01xa0OwfjQ',
        feed: yt('UCoNokfwANJSKM01xa0OwfjQ'),
        kind: 'video',
        tier: 2,
        why: 'Обществената радиостанция; тук са видеоверсиите на интервютата ѝ.',
        aliases: ['БНР', 'BNR', 'Българското национално радио', 'програма „Хоризонт“', 'Хоризонт'],
    },

    // 3 — editorial outlets with a known owner and signed articles
    {
        id: 'dnevnik',
        name: 'Дневник',
        home: 'https://www.dnevnik.bg',
        feed: 'https://www.dnevnik.bg/rss/',
        kind: 'article',
        tier: 3,
        why: 'Икономедиа; подписани материали, публикувана собственост.',
        aliases: ['Дневник', 'dnevnik.bg'],
    },
    {
        id: 'capital',
        name: 'Капитал',
        home: 'https://www.capital.bg',
        feed: 'https://www.capital.bg/rss/',
        kind: 'article',
        tier: 3,
        why: 'Икономедиа; подписани материали, публикувана собственост.',
        aliases: ['Капитал', 'capital.bg'],
    },
    {
        id: 'mediapool',
        name: 'Медиапул',
        home: 'https://www.mediapool.bg',
        feed: 'https://www.mediapool.bg/rss/',
        kind: 'article',
        tier: 3,
        why: 'Политически сайт с подписани материали и известен собственик.',
        aliases: ['Медиапул', 'Mediapool'],
    },
    {
        id: 'sega',
        name: 'Сега',
        home: 'https://www.segabg.com',
        feed: 'https://www.segabg.com/rss',
        kind: 'article',
        tier: 3,
        why: 'Всекидневник с подписани материали и известен собственик.',
        aliases: ['Сега', 'вестник „Сега“', 'segabg'],
    },
    {
        id: 'offnews',
        name: 'OFFNews',
        home: 'https://offnews.bg',
        feed: 'https://offnews.bg/rss/all',
        kind: 'article',
        tier: 3,
        why: 'Новинарски сайт с известен собственик и редакция.',
        aliases: ['OFFNews', 'Офнюз'],
    },
    {
        id: 'offnews-yt',
        name: 'OFFNews (видео)',
        home: 'https://www.youtube.com/channel/UCGqTxb6ns2tF64L34rh9Jog',
        feed: yt('UCGqTxb6ns2tF64L34rh9Jog'),
        kind: 'video',
        tier: 3,
        why: 'Интервютата и репортажите на OFFNews.',
        aliases: [],
    },
    {
        id: 'clubz',
        name: 'Клуб Z',
        home: 'https://clubz.bg',
        feed: 'https://clubz.bg/rss',
        kind: 'article',
        tier: 3,
        why: 'Новинарски сайт с известен собственик и подписани материали.',
        aliases: ['Клуб Z', 'Club Z', 'clubz'],
    },
    {
        id: '24chasa',
        name: '24 часа',
        home: 'https://www.24chasa.bg',
        feed: 'https://www.24chasa.bg/rss',
        kind: 'article',
        tier: 3,
        why: 'Всекидневник с известен собственик и редакция.',
        aliases: ['24 часа', '„24 часа“', '24chasa'],
    },
    {
        id: 'btv',
        name: 'bTV Новините',
        home: 'https://btvnovinite.bg',
        feed: 'https://btvnovinite.bg/lbin/v3/rss.php',
        kind: 'article',
        tier: 3,
        why: 'Частна телевизия с лиценз от СЕМ и публикувана собственост.',
        aliases: ['bTV', 'БТВ', 'bTV Новините'],
    },
    {
        id: 'btv-yt',
        name: 'bTV (видео)',
        home: 'https://www.youtube.com/channel/UCgGUFNM1VuzCSZlcJCTBZpA',
        feed: yt('UCgGUFNM1VuzCSZlcJCTBZpA'),
        kind: 'video',
        tier: 3,
        why: 'Емисиите и интервютата на bTV.',
        aliases: [],
    },
    {
        id: 'nova-yt',
        name: 'NOVA (видео)',
        home: 'https://www.youtube.com/channel/UCspzCJuJ-n2frc9o-rXXZBg',
        feed: yt('UCspzCJuJ-n2frc9o-rXXZBg'),
        kind: 'video',
        tier: 3,
        why: 'Частна телевизия с лиценз от СЕМ; емисиите и интервютата ѝ.',
        aliases: ['NOVA', 'Нова телевизия', 'Нова', 'nova.bg'],
    },
    {
        id: 'svobodna-yt',
        name: 'Свободна Европа (видео)',
        home: 'https://www.youtube.com/channel/UC4NwHyV2nUhKF3xV4wqAyxQ',
        feed: yt('UC4NwHyV2nUhKF3xV4wqAyxQ'),
        kind: 'video',
        tier: 3,
        why: 'Българската редакция на Радио Свободна Европа; финансира се от Конгреса на САЩ.',
        aliases: ['Свободна Европа', 'Радио Свободна Европа'],
    },
    {
        id: 'bloomberg-yt',
        name: 'Bloomberg TV Bulgaria (видео)',
        home: 'https://www.youtube.com/channel/UCTJe8dA3UVlPV96m31A6EmA',
        feed: yt('UCTJe8dA3UVlPV96m31A6EmA'),
        kind: 'video',
        tier: 3,
        why: 'Бизнес телевизия с известен собственик.',
        aliases: ['Bloomberg TV Bulgaria', 'Bloomberg TV', 'Блумбърг ТВ'],
    },
    {
        id: 'actualno',
        name: 'Actualno',
        home: 'https://www.actualno.com',
        feed: 'https://www.actualno.com/rss/novini-new',
        kind: 'article',
        tier: 3,
        why: 'Новинарски сайт с известен собственик.',
        aliases: ['Actualno', 'Актуално'],
    },
    {
        id: 'vesti',
        name: 'Vesti.bg',
        home: 'https://www.vesti.bg',
        feed: 'https://www.vesti.bg/rss',
        kind: 'article',
        tier: 3,
        why: 'Новинарски сайт на Нетинфо (група „Нова“).',
        aliases: ['Vesti.bg', 'Вести'],
    },
    {
        id: 'bivol',
        name: 'Биволъ',
        home: 'https://bivol.bg',
        feed: 'https://bivol.bg/feed',
        kind: 'article',
        tier: 3,
        why: 'Разследваща медия с подписани материали.',
        aliases: ['Биволъ', 'Bivol'],
    },
    {
        id: 'factcheck',
        name: 'Factcheck.bg',
        home: 'https://www.factcheck.bg',
        feed: 'https://www.factcheck.bg/feed/',
        kind: 'article',
        tier: 3,
        why: 'Проверка на факти; член на международната мрежа EFCSN.',
        aliases: ['Factcheck.bg', 'Фактчек'],
    },
];

export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export function tierOf(sourceId) {
    return SOURCE_BY_ID.get(sourceId)?.tier ?? 4;
}

const normalize = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[„“"«»()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

const ALIAS_INDEX = new Map();
for (const s of SOURCES) {
    for (const a of [s.name, ...s.aliases]) {
        const key = normalize(a);
        // The article outlet wins over its video channel for the same name.
        if (!ALIAS_INDEX.has(key) || s.kind === 'article') ALIAS_INDEX.set(key, s.id);
    }
}

// The source an article names as where it got the news ("според БТА"), or
// null when that is not one of ours.
export function sourceIdForName(name) {
    if (!name) return null;
    return ALIAS_INDEX.get(normalize(name)) ?? null;
}

// The outlet a video channel belongs to, so "according to BNT" points at BNT
// whether we read it from its site or its channel.
export function outletOf(sourceId) {
    return sourceId.replace(/-yt$/, '');
}
