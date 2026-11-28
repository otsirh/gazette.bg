// Sources we have looked at and do not read, and why. Internal only: never
// shown on the site.
//
// WANTED: worth reading, but the source does not let us (yet). Checked again
// every week by .github/workflows/recheck-sources.yml; when one becomes
// readable, an issue is opened so it can be added to sources.js. `contact`
// is where to ask for access, when known.
//   why: 'robots'   — its robots.txt shuts out Anthropic's agents or everyone
//        'ai-input' — Content-Signal ai-input=no
//        'tdm'      — a TDM reservation (tdmrep.json)
//        'terms'    — its terms of use forbid robots or aggregation (checked
//                     by hand; the weekly check only reminds)
//        'bot-wall' — a bot challenge (Cloudflare) refuses servers; never
//                     worked around
//        'outlet'   — a channel whose outlet refuses AI on its own site
//        'gone'     — no feed, or the site moved
//   check: what the weekly check reads: { feed } | { list, pattern } |
//          { robotsOf } (the site whose robots.txt decides, for channels) |
//          { page } (a bot wall: readable once the page answers)
//
// DECLINED: looked at and not taken, with the rule of SOURCES-POLICY.md it
// breaks and the examples. Kept so a later review knows it was decided, and
// why; reviewed again every six months.
//
// This repository is public, so every reason here is a public statement:
// write the rule and what was seen, never a judgment of the outlet or a
// person; in a quoted example, a person's name becomes [име], so an
// accusation or an insult is never repeated here.

export const WANTED = [
    {
        id: '24chasa',
        name: '24 часа',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.24chasa.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. Под всяка страница: „Забранява се възпроизвеждането изцяло или отчасти на материали и публикации, без предварително съгласие на редакцията; чл.24 ал.1 т.5 от ЗАвПСП не се прилага“; условията (чл. 12, т. 5) забраняват извличане с технически средства. Добър кандидат за писмо.',
    },
    {
        id: '168chasa',
        name: '168 часа',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.168chasa.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. Същите условия като на „24 часа“ (същата група).',
    },
    {
        id: 'money',
        name: 'Money.bg',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://money.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. „Уеб Медия Груп“: съдържанието не може да се използва „включително с цел агрегиране на съдържанието и сходни услуги“ без писмено разрешение.',
    },
    {
        id: 'forbes',
        name: 'Forbes България',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://forbesbulgaria.com',
        },
        contact: '',
        note: 'Махнат 2026-11. Условията: „Никакви връзки към този Уебсайт не могат да бъдат публикувани на друг уебсайт без предварително писмено разрешение“.',
    },
    {
        id: 'dir',
        name: 'Dir.bg',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://dir.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. Потребителско споразумение VI.1 забранява копиране или разпространение на съдържание „или каквито и да е части от него“ без съгласие. Ако даде разрешение — първо преглед по правило A (DFRLab, 09.06.2026, го споменава).',
    },
    {
        id: 'investor',
        name: 'Investor.bg, Dnes.bg и сайтовете на „Инвестор.БГ“',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.investor.bg',
        },
        contact: '',
        note: 'Махнати 2026-11: investor, dnes, „Черно море“ (Варна). Общите условия на групата (ibg.bg/id-157): RSS само „за персонална, нетърговска употреба“ (3.2), не може да се разпространява като производни RSS продукти (3.3), възпроизвеждането — само със съгласие (3.5). Bloomberg TV и Bulgaria ON AIR имат собствени условия, които позволяват цитиране с хипервръзка, и остават със заглавие и връзка. Добър кандидат за писмо.',
    },
    {
        id: 'utroruse',
        name: 'Утро (Русе)',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://utroruse.com',
        },
        contact: '',
        note: 'Махнат 2026-11. Условията (utroruse.com/terms) повтарят тези на „Инвестор.БГ“: RSS само за персонална, нетърговска употреба.',
    },
    {
        id: 'lex',
        name: 'Lex.bg',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://news.lex.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. Условията 9.3: съдържанието не може да се използва, освен „незначителна по обем информация, предназначена за лично ползване“.',
    },
    {
        id: 'sega',
        name: 'Сега',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.segabg.com',
        },
        contact: '',
        note: 'Махнат 2026-11. Под всяка страница: „Възпроизвеждането на цели или части от текста … става след изрично писмено разрешение на СЕГА АД“; условията забраняват извличане с технически средства. Важен източник — добър кандидат за писмо.',
    },
    {
        id: 'bnt',
        name: 'БНТ (сайт)',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://bntnews.bg',
        },
        contact: '',
        note: 'Махнат 2026-11. Общите условия (bnt.bg/obshti-usloviya-279pages.html) забраняват „роботи, паяци или други автоматични устройства … за каквато и да е цел“ и всяко ползване освен лично. Каналите на БНТ в YouTube се четат. Добър кандидат за писмо.',
    },
    {
        id: 'svobodnaevropa-yt',
        name: 'Свободна Европа / Свободна точка (видео)',
        why: 'outlet',
        since: '2026-11',
        check: {
            robotsOf: 'https://svobodnatochka.bg',
            channel: 'UC4NwHyV2nUhKF3xV4wqAyxQ',
        },
        contact: '',
        note: 'Махнат 2026-11. Сайтът на Свободна Европа не се обновява от 31.03.2026; екипът е в svobodnatochka.bg, който посочва канала и чийто robots.txt спира ClaudeBot и anthropic-ai.',
    },
    {
        id: 'slivenpress',
        name: 'SlivenPress',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://slivenpress.bg',
        },
        contact: '',
        note: 'robots.txt спира ClaudeBot и anthropic-ai.',
    },
    {
        id: 'dnevnik',
        name: 'Дневник',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://www.dnevnik.bg/rss/',
        },
        contact: '',
        note: 'Икономедиа; robots.txt забранява AI агентите.',
    },
    {
        id: 'capital',
        name: 'Капитал',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://www.capital.bg/rss/',
        },
        contact: '',
        note: 'Икономедиа; robots.txt забранява AI агентите. Каналът им в YouTube е махнат по същата причина.',
    },
    {
        id: 'novinite',
        name: 'Novinite',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://www.novinite.bg/rss',
        },
        contact: '',
        note: '',
    },
    {
        id: 'plovdiv24',
        name: 'Plovdiv24',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://www.plovdiv24.bg/rss.php',
        },
        contact: '',
        note: 'Регионален, Пловдив.',
    },
    {
        id: 'varna24',
        name: 'Varna24',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://www.varna24.bg/rss.php',
        },
        contact: '',
        note: 'Регионален, Варна.',
    },
    {
        id: 'frognews',
        name: 'Frognews',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://frognews.bg/rss.xml',
        },
        contact: '',
        note: '',
    },
    {
        id: 'evrokom-yt',
        name: 'Евроком (видео)',
        why: 'outlet',
        since: '2026-11',
        check: {
            robotsOf: 'https://eurocom.bg',
            channel: 'UCYRY_SSdXPpeV8oxI96Q51w',
        },
        contact: '',
        note: 'Каналът е в YouTube, но самият Евроком забранява AI на сайта си (ClaudeBot Disallow: /, ai-train=no).',
    },
    {
        id: 'bgnes-yt',
        name: 'BGNES (видео)',
        why: 'outlet',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.bgnes.com',
            channel: 'UCNkRuL_6Jqtwx8yfTJx0yfQ',
        },
        contact: '',
        note: 'Каналът е в YouTube, но самият BGNES забранява AI на сайта си.',
    },
    {
        id: 'newsbg',
        name: 'News.bg',
        why: 'terms',
        since: '2026-11',
        check: {
            feed: 'https://news.bg/services/rss/1',
        },
        contact: '',
        note: 'Условията им забраняват агрегиране. Проверява се на ръка.',
    },
    {
        id: 'zaistinata',
        name: 'Заистината',
        why: 'robots',
        since: '2026-11',
        check: {
            feed: 'https://zaistinata.com/feed/',
        },
        contact: '',
        note: 'robots.txt забранява емисията.',
    },
    {
        id: 'kanev',
        name: 'Евгени Канев (Substack)',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://evgenikanev.substack.com/feed',
        },
        contact: '',
        note: 'Substack спира облачните сървъри с проверка на Cloudflare.',
    },
    {
        id: 'manolov',
        name: 'Калин Манолов (Substack)',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://kalinmanolov.substack.com/feed',
        },
        contact: '',
        note: 'Substack спира облачните сървъри с проверка на Cloudflare.',
    },
    {
        id: 'tagarev',
        name: 'Тодор Тагарев (Substack)',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://tagarev.substack.com/feed',
        },
        contact: '',
        note: 'Substack спира облачните сървъри с проверка на Cloudflare.',
    },
    {
        id: 'valkov',
        name: 'Константин Вълков (Substack)',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://konstantinvalkov.substack.com/feed',
        },
        contact: '',
        note: 'Substack спира облачните сървъри с проверка на Cloudflare. Каналът му в YouTube се чете.',
    },
    {
        id: 'eurocom',
        name: 'Евроком',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://eurocom.bg',
        },
        contact: '',
        note: 'robots.txt: ClaudeBot Disallow: / и ai-train=no. Там е предаването на Сашо Диков; каналите им в YouTube не четем по същата причина. Добър кандидат за писмо.',
    },
    {
        id: 'dw-bg',
        name: 'DW на български',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.dw.com',
        },
        contact: '',
        note: 'robots.txt спира ClaudeBot и anthropic-ai.',
    },
    {
        id: 'marginalia',
        name: 'Маргиналия',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.marginalia.bg',
        },
        contact: '',
        note: 'Правозащитно издание; robots.txt спира ClaudeBot.',
    },
    {
        id: 'bhc-obektiv',
        name: 'БХК „Обектив“',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.bghelsinki.org',
        },
        contact: '',
        note: 'Български хелзинкски комитет; robots.txt спира AI агентите.',
    },
    {
        id: 'csd',
        name: 'Център за изследване на демокрацията',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://csd.eu',
        },
        contact: '',
        note: 'robots.txt спира AI агентите.',
    },
    {
        id: 'economy-bg',
        name: 'Economy.bg',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.economy.bg',
        },
        contact: '',
        note: 'robots.txt спира ClaudeBot, ai-train=no.',
    },
    {
        id: 'shumenonline',
        name: 'Шумен Онлайн',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.shumenonline.bg',
        },
        contact: '',
        note: 'Единственият сериозен сайт в Шумен; ClaudeBot Disallow: /. Засега Радио Шумен (БНР).',
    },
    {
        id: 'netnews-yambol',
        name: 'NetNews (Ямбол)',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://netnews.bg',
        },
        contact: '',
        note: 'ClaudeBot Disallow: /. Засега Радио Стара Загора (БНР).',
    },
    {
        id: 'radio999',
        name: 'Радио 999 (Ямбол)',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://radio999.bg',
        },
        contact: '',
        note: 'ClaudeBot Disallow: /.',
    },
    {
        id: 'afp-factcheck',
        name: 'AFP Проверка на фактите',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://proveri.afp.com/rss',
        },
        contact: '',
        note: 'Защита от ботове (403).',
    },
    {
        id: 'banker',
        name: 'Банкер',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            page: 'https://www.banker.bg/',
        },
        contact: '',
        note: 'Проверка на Cloudflare спира сървърите.',
    },
    {
        id: 'minfin',
        name: 'Министерство на финансите',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            page: 'https://www.minfin.bg/',
        },
        contact: '',
        note: 'Проверка на Cloudflare дори на robots.txt. Важен източник — добър кандидат за писмо.',
    },
    {
        id: 'mon',
        name: 'МОН',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            page: 'https://www.mon.bg/',
        },
        contact: '',
        note: 'Проверка на Cloudflare. Засега „Аз-буки“.',
    },
    {
        id: '3e-news',
        name: '3e-news',
        why: 'bot-wall',
        since: '2026-11',
        check: {
            feed: 'https://www.3e-news.net/rss/all.xml',
        },
        contact: '',
        note: 'Енергетика; емисията отказва (403) от сървърите.',
    },
    {
        id: 'portal-silistra',
        name: 'Портал Силистра',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.portal-silistra.eu',
        },
        contact: '',
        note: 'Условията забраняват използване „с цел агрегиране на съдържанието“ без писмено разрешение. Добър кандидат за писмо.',
    },
    {
        id: 'baricada',
        name: 'Барикада',
        why: 'terms',
        since: '2026-11',
        check: {
            feed: 'https://baricada.org/feed/',
        },
        contact: '',
        note: 'Ляво издание с подписани материали; условията забраняват разпространение без писмено разрешение. Добър кандидат за писмо (баланс на гледните точки).',
    },
    {
        id: 'progbg-yt',
        name: 'Прогресивна България (видео)',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://progresivnabulgaria.com',
        },
        contact: '',
        note: 'Управляващата партия. Каналът UCPsX7wNd3YHBlg9gRRYZU8w се представя за официален, но сайтът на партията не го посочва — чакаме потвърждение (връзка от сайта им).',
    },
    {
        id: 'zhechev',
        name: 'Любомир Жечев',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.youtube.com',
        },
        contact: '',
        note: 'Сатира за правосъдието и корупцията; каналът му не е намерен по име — да се намери ID.',
    },
    {
        id: 'mod-news',
        name: 'Министерство на отбраната (сайт)',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.mod.bg',
        },
        contact: '',
        note: 'Новините се отварят с JavaScript (onclick), без връзки. Засега armymedia.bg.',
    },
    {
        id: 'vks',
        name: 'ВКС',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.vks.bg',
        },
        contact: '',
        note: 'Списъкът няма заглавия във връзките; трябва отделен четец.',
    },
    {
        id: 'noi',
        name: 'НОИ',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://nssi.bg',
        },
        contact: '',
        note: 'Списъкът е без връзки с дати; трябва отделен четец (datePublished).',
    },
    {
        id: 'mlsp',
        name: 'МТСП',
        why: 'terms',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.mlsp.government.bg',
        },
        contact: '',
        note: 'Условията искат писмено съгласие за възпроизвеждане; и списъкът не се чете надеждно.',
    },
    {
        id: 'mjs',
        name: 'Министерство на правосъдието',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://justice.government.bg',
        },
        contact: '',
        note: 'Новините идват от JSON API; трябва отделен четец.',
    },
    {
        id: 'nra-customs-egov',
        name: 'НАП, Митници, е-управление',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://nra.bg',
        },
        contact: '',
        note: 'Порталите зареждат новините с JavaScript, без стабилни адреси.',
    },
    {
        id: 'mpes',
        name: 'Министерство на младежта и спорта',
        why: 'robots',
        since: '2026-11',
        check: {
            robotsOf: 'https://mpes.government.bg',
        },
        contact: '',
        note: 'robots.txt: Disallow: / за всички.',
    },
    {
        id: 'gerb-yt',
        name: 'ГЕРБ (видео)',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://gerb.bg',
        },
        contact: '',
        note: 'Официалният канал UC_boJf3ewIsSlwLSzxkYoDg (@gerb-official) няма клип от май 2026; ГЕРБ се чете от сайта си (gerb.bg/news). Каналът да се върне, ако започне пак.',
    },
    {
        id: 'itn-yt',
        name: 'Има такъв народ (видео)',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://itn.bg',
        },
        contact: '',
        note: 'Каналът UCGKMX5rSDuaEnfN5d9FjfgQ няма клип от май 2026; партията не е в парламента.',
    },
    {
        id: 'tasheva-yt',
        name: 'Отвъд заглавията (видео)',
        why: 'gone',
        since: '2026-11',
        check: {
            robotsOf: 'https://www.youtube.com',
        },
        contact: '',
        note: 'Каналът UCMNokTD7DK4o22P6UrIqm-g беше на Магдалена Ташева, която почина на 19.10.2025; продължава да публикува, но не е ясно кой отговаря за него (правило 2). Да се върне, ако каналът посочи автор.',
    },
];

export const DECLINED = [
    {
        id: 'genov-yt',
        name: 'Асен Генов (видео)',
        why: 'Не е журналист или журналистическо издание: блогър и активист.',
        since: '2026-11',
    },
    {
        id: 'vasilev-yt',
        name: 'Илиян Василев (видео)',
        why: 'Не е журналист или журналистическо издание: бивш дипломат, анализатор.',
        since: '2026-11',
    },
    {
        id: 'akf-yt',
        name: 'Антикорупционен фонд (видео)',
        why: 'Не е журналист или журналистическо издание: неправителствена организация.',
        since: '2026-11',
    },
    {
        id: 'delaidemokracia-yt',
        name: 'Дела и демокрация (видео)',
        why: 'Не е журналист или журналистическо издание: видеоподкаст на неправителствена организация.',
        since: '2026-11',
    },
    {
        id: '2and200-yt',
        name: '2&200 (видео)',
        why: 'Не е журналист или журналистическо издание: подкаст.',
        since: '2026-11',
    },
    {
        id: 'ime-yt',
        name: 'Спонтанният ред, ИПИ (видео)',
        why: 'Не е журналист или журналистическо издание: подкаст на мозъчен тръст.',
        since: '2026-11',
    },
    {
        id: 'myara-yt',
        name: 'Въпрос на мяра (видео)',
        why: 'Не е журналист или журналистическо издание: продукция на социологическа агенция.',
        since: '2026-11',
    },
    {
        id: 'chestnaduma',
        name: 'Честна дума, Людмил Арсов',
        why: 'Не е журналист или журналистическо издание: подкаст.',
        since: '2026-11',
    },
    {
        id: 'yurukov',
        name: 'Боян Юруков',
        why: 'Не е журналист или журналистическо издание: граждански блог.',
        since: '2026-11',
    },
    {
        id: 'slatinski',
        name: 'Николай Слатински',
        why: 'Не е журналист или журналистическо издание: личен сайт.',
        since: '2026-11',
    },
    {
        id: 'paskov-yt',
        name: 'Пламен Пасков (видео)',
        why: 'Не е журналист или журналистическо издание: личен канал на ветеринарен лекар. Освен това — A: Factcheck.bg (член на EFCSN) го описва като многократно разобличаван разпространител на дезинформация (27.06.2025; 14.04.2022).',
        since: '2026-11',
    },
    {
        id: 'ivelinnikolov-yt',
        name: 'Ивелин Николов (видео)',
        why: 'Не е журналист или журналистическо издание: коментарен канал, авторът не е журналист. Освен това — D: заглавия-въпроси с обвинения към назовани политици („Прецакаха ли [име] с ВСС?“, „[име] по стъпките на [име] и [име]?“, „… сагата с [име]?“) — ноем. 2026.',
        since: '2026-11',
    },
    {
        id: 'novetika-yt',
        name: 'Novetika (видео)',
        why: 'Не е журналист или журналистическо издание: коментарен канал, авторът не е журналист. Освен това — Правило 2: каналът не посочва човек или фирма.',
        since: '2026-11',
    },
    {
        id: 'katincharova-yt',
        name: 'Катинчарова (видео)',
        why: 'Не е журналист или журналистическо издание: коментарен канал, авторът не е журналист. Освен това — Правило 3: два клипа за 30 дни, с месеци прекъсване; правило 2: каналът не посочва кой го води.',
        since: '2026-11',
    },
    {
        id: 'nmarkov-yt',
        name: 'Николай Марков (видео)',
        why: 'Не е журналист или журналистическо издание: коментарен канал, авторът не е журналист.',
        since: '2026-11',
    },
    {
        id: 'kardamski-yt',
        name: 'Валентин Кардамски (видео)',
        why: 'Не е журналист или журналистическо издание: коментарен канал, авторът не е журналист. Освен това — A: Factcheck.bg (член на EFCSN) опроверга поне 8 твърдения на свързания с водещия сайт kritichno.bg (напр. 22.02.2024, 22.09.2025).',
        since: '2026-11',
    },
    {
        id: 'tsanov-yt',
        name: 'Цанов, Напред и нагоре (видео)',
        why: 'Не е журналист или журналистическо издание: канал за интервюта, авторът не е журналист. Освен това — D: описание на видео, което приписва тежки престъпления на назовани живи хора без източник (21.11.2026); A: Factcheck.bg (член на EFCSN), 22.11.2025 — разпространил фалшиво видео.',
        since: '2026-11',
    },
    {
        id: 'blitz',
        name: 'Блиц',
        why: 'Правило E: основното съдържание е личният живот на известни хора (преглед ноем. 2026).',
        since: '2026-11',
    },
    {
        id: 'alfa',
        name: 'Alfa.bg',
        why: 'Сайтът пренасочва другаде; няма емисия.',
        since: '2026-11',
    },
    {
        id: 'alfa-yt',
        name: 'ALFA TV (UCFFwtNtz1XH20tg8DW2-oJQ)',
        why: 'Грешен канал: македонската ALFA TV. Българската ТВ „Алфа“ е каналът на „Атака“.',
        since: '2026-11',
    },
    {
        id: 'bnr-yt',
        name: 'БНР (UCoNokfwANJSKM01xa0OwfjQ)',
        why: 'Главно клипове от награди; заменен с „Новините на БНР“.',
        since: '2026-11',
    },
    {
        id: 'dremdzhiev-yt',
        name: 'ДЕНЯТ с В. Дремджиев',
        why: 'Над 300 клипа месечно; не сме установили кой отговаря за канала (правило 2).',
        since: '2026-11',
    },
    {
        id: 'skat',
        name: 'СКАТ',
        why: 'Не е избран при прегледа през ноември 2026; при следващия да се прегледа по правилата с примери.',
        since: '2026-11',
    },
    {
        id: 'benovska',
        name: 'Беновска пита (Радио К2)',
        why: 'Не е избран при прегледа през ноември 2026; при следващия да се прегледа по правилата с примери.',
        since: '2026-11',
    },
    {
        id: 'eurocom-shows',
        name: 'Предаванията на Евроком в YouTube (Делници, ЕвроДикоФ, Контра…)',
        why: 'Правило 1: robots.txt на Евроком спира AI агентите (виж „eurocom“ в WANTED).',
        since: '2026-11',
    },
    {
        id: 'tabloids',
        name: 'ПИК, Флагман, Монитор, Дума, Pariteni, Novini.bg',
        why: 'Не са избрани при прегледа през ноември 2026; при следващия всеки да се прегледа поотделно по правилата с примери.',
        since: '2026-11',
    },
    {
        id: 'konkurent',
        name: 'Конкурент (Монтана)',
        why: 'Правило 2: на сайта не намерихме собственик и автори (проверка ноем. 2026).',
        since: '2026-11',
    },
    {
        id: 'az-agency',
        name: 'Агенция по заетостта',
        why: 'При проверката сайтът показваше чуждо съдържание (реклами за хазарт); да се провери отново.',
        since: '2026-11',
    },
    {
        id: 'governmentbg-yt',
        name: '@GovernmentBG',
        why: 'Не е официален канал на правителството.',
        since: '2026-11',
    },
    {
        id: 'maika-bulgaria-yt',
        name: 'Майка България (UCL-z_epirz4KnhxbJGemUPg)',
        why: 'Не е каналът на Народното събрание.',
        since: '2026-11',
    },
    {
        id: 'tv-evropa',
        name: 'ТВ Европа, 7/8 ТВ',
        why: 'Неактивни.',
        since: '2026-11',
    },
    {
        id: 'pogled',
        name: 'Поглед.инфо',
        why: 'A: по данни на DFRLab („Sanctioned Russian content enters Bulgarian information space via Pogled.Info“, февр. 2026) и ЦИД („Defending the Vote“, март 2026) публикува съдържание на санкционирани руски медии (Регламент 833/2014).',
        since: '2026-11',
    },
    {
        id: 'enchev-yt',
        name: 'Дискусионен форум с Велизар Енчев',
        why: 'B: заглавия, които приписват събития на етническа или религиозна група (3 примера от ноем. 2026, единият с фамилия, използвана като стереотип). Да се допълнят примерите при преглед.',
        since: '2026-11',
    },
    {
        id: 'karakolev-yt',
        name: 'Неизбежния Караколев',
        why: 'C: заглавия, които наричат хора с обидни думи или ги излагат публично („ТИ СИ ПРОСТ И НАГЪЛ ЧОВЕК – …“, „СПИПАХ …“, „… СИ ИЗХВЪРЛИ БОКЛУКА ПРЕД ОБЩИНАТА“); D: обвинение под формата на въпрос към [име] — ноем. 2026.',
        since: '2026-11',
    },
    {
        id: 'razkritia',
        name: 'Разкрития',
        why: 'E: заглавия за външността и имотите на известни хора (3 примера с [име]); D: обвинение под формата на въпрос („… в пликове от [име] ли събориха [име]?“) — ноем. 2026.',
        since: '2026-11',
    },
    {
        id: 'zarata',
        name: 'Zarata.info',
        why: 'Правило 2: на сайта не намерихме собственик и автори (авторът е „admin_zarata“); материалите са от други медии.',
        since: '2026-11',
    },
    {
        id: 'bgisvetat-yt',
        name: 'България и светът',
        why: 'Правило 2: каналът не посочва водещ или собственик.',
        since: '2026-11',
    },
    {
        id: 'expert',
        name: 'Expert.bg',
        why: 'Правило 3 и F: главно корпоративни назначения и продукти, част от тях платени материали (3 примера от ноем. 2026: банкови продукти и класации на работодатели).',
        since: '2026-11',
    },
    {
        id: 'nova-official-yt',
        name: 'NOVA Official (UCKe2NUqtkmsbnaNG63L7hCQ)',
        why: 'Правило 3: главно забавления и реклама на предаванията на NOVA (песни, риалити, финали, книги — 4 примера от 28.11.2026). Новините на NOVA се четат от nova.bg и новинарските ѝ канали.',
        since: '2026-11',
    },
    {
        id: 'bnews',
        name: 'BNews.bg',
        why: 'A: Factcheck.bg (член на EFCSN) опроверга твърдения на сайта (factcheck.bg/claim_author/bnews-bg/, 2023–2025); C и D: заглавия с обидни прякори и обвинения към назовани политици (28.11.2026); правило 2: сайтът не посочва собственик. Не е бургаски, а национален.',
        since: '2026-11',
    },
    {
        id: 'struma',
        name: 'Струма (Благоевград)',
        why: 'F: три необозначени рекламни статии с търговски връзки сред новините (28.11.2026); правило 2: сайтът не посочва собственик или редактор.',
        since: '2026-11',
    },
    {
        id: 'ekip7',
        name: 'Екип 7 (Разград)',
        why: 'Правило 3: вестникът спря да излиза (29.08.2025); сайтът публикува главно обяви и прессъобщения.',
        since: '2026-11',
    },
    {
        id: 'novjivot',
        name: 'Нов живот (Кърджали)',
        why: 'Правило 2: сайтът не посочва собственик или редактор, всички материали са от „Администратор“. Да се върне, ако собственикът се потвърди (регистър на Министерството на културата).',
        since: '2026-11',
    },
    {
        id: 'karbovski-yt',
        name: 'Мартин Карбовски (видео)',
        why: 'A: Factcheck.bg (член на EFCSN) опроверга твърдения, разпространени от канала и от свързания сайт Lentata.com (factcheck.bg, 26.07.2023; 11.04.2025; 28.07, 28.10, 30.10, 31.10.2026).',
        since: '2026-11',
    },
    {
        id: 'dachkov-yt',
        name: 'Явор Дачков (видео)',
        why: 'A: Factcheck.bg (член на EFCSN) опроверга твърдения, споделени от водещия и от неговото издание „Гласове“ (factcheck.bg, 18.11.2024; 13.06.2025; 26.02, 03.04, 22.06, 04.10.2026).',
        since: '2026-11',
    },
    {
        id: 'glasove',
        name: 'Гласове',
        why: 'A: същото като „dachkov-yt“; Factcheck.bg (член на EFCSN) го посочва сред сайтовете, многократно разпространявали дезинформация (18.11.2024).',
        since: '2026-11',
    },
    {
        id: 'epicenter',
        name: 'Епицентър',
        why: 'A: Factcheck.bg (член на EFCSN) опроверга твърдения, публикувани от сайта (21.07.2022; 15.12.2023; 15.04.2024; 26.02.2026).',
        since: '2026-11',
    },
    {
        id: 'indzhev',
        name: 'Иво Инджев',
        why: 'C: заглавия, които наричат политици с обидни прякори (5 примера, 15–28.11.2026).',
        since: '2026-11',
    },
    {
        id: 'telegraph',
        name: 'Телеграф',
        why: 'Правило 3: от 50 материала в емисията 29 са спорт, куриози и риалити (28.11.2026).',
        since: '2026-11',
    },
    {
        id: 'no-owner-regional',
        name: 'ЯмболСвят, Razgradnews, Перник Днес, Blagoevgrad.eu',
        why: 'Правило 2: сайтовете не посочват собственик (проверка 28.11.2026). Да се прегледат пак, ако посочат.',
        since: '2026-11',
    },
    {
        id: 'haskovonews',
        name: 'HaskovoNews',
        why: 'Сайтът сам пише, че публикува „автоматизирано генерирани текстове“.',
        since: '2026-11',
    },
    {
        id: 'bili',
        name: 'БИПИ',
        why: 'Правило 3: около две публикации месечно.',
        since: '2026-11',
    },
];
