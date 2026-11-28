// YouTube channels through the YouTube Data API v3, the way YouTube allows
// programs to read it (its robots.txt disallows the public channel feeds).
// One playlistItems call per channel per update (1 unit each; the free
// daily quota is 10,000), and one videos call per 50 new videos to learn
// which are "made for kids" — those are linked, never embedded.
// API data is kept only as long as a story is on the page (at most 7 days,
// well inside the 30 days the API terms allow).

const API = 'https://www.googleapis.com/youtube/v3';

export const channelIdOf = (feedUrl) => new URL(feedUrl).searchParams.get('channel_id');

async function call(path, params, key) {
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    // The key is in the URL: errors never repeat it.
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
    return res.json();
}

// A channel's latest uploads, in the shape parseFeed gives.
export async function channelUploads(channelId, key, now = Date.now()) {
    if (!/^UC[\w-]{22}$/.test(channelId ?? '')) throw new Error('bad channel id');
    const data = await call(
        'playlistItems',
        { part: 'snippet,contentDetails', maxResults: '15', playlistId: `UU${channelId.slice(2)}` },
        key,
    );
    return (data.items ?? [])
        .map((it) => {
            const sn = it.snippet ?? {};
            const videoId = it.contentDetails?.videoId ?? sn.resourceId?.videoId;
            if (
                !/^[\w-]{6,20}$/.test(videoId ?? '') ||
                !sn.title ||
                sn.title === 'Private video' ||
                sn.title === 'Deleted video'
            )
                return null;
            let at = Date.parse(it.contentDetails?.videoPublishedAt ?? sn.publishedAt);
            if (!Number.isFinite(at) || at > now + 10 * 60 * 1000) at = now;
            return {
                url: `https://www.youtube.com/watch?v=${videoId}`,
                title: String(sn.title).slice(0, 300),
                description: String(sn.description ?? '').slice(0, 600),
                at,
                category: '',
                videoId,
                thumb: null,
            };
        })
        .filter(Boolean);
}

// Which of these videos YouTube marks "made for kids".
export async function madeForKids(ids, key) {
    const out = new Set();
    for (let i = 0; i < ids.length; i += 50) {
        const data = await call('videos', { part: 'status', id: ids.slice(i, i + 50).join(',') }, key);
        for (const v of data.items ?? []) if (v.status?.madeForKids) out.add(v.id);
    }
    return out;
}
