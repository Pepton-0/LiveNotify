'use strict';

import fs from 'node:fs/promises';
import { Client, GatewayIntentBits } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';

// 通知対象にするライブタイトル条件。
// 英字は大文字小文字を無視して判定する。
const LIVE_TITLE_KEYWORDS = [
    'ARMORED CORE',
    'AC',
    'アーマードコア'
];

// RSS確認頻度。
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

// 日本時間で走査する時間帯。
// 現在の設定: 15:00 <= 現在時刻 < 24:00
const ACTIVE_START_HOUR_JST = 15;
const ACTIVE_END_HOUR_JST = 24;

// 各チャンネルのRSSから見る最新動画数。
const RSS_ENTRY_LIMIT_PER_CHANNEL = 15;

// 予約開始時刻ちょうどだとYouTube API側の反映が遅れる可能性があるため、少し後に再確認する。
const UPCOMING_RECHECK_DELAY_MS = 2 * 60 * 1000;

// scheduledStartTime が取れなかった upcoming の保険。
const UPCOMING_WITHOUT_SCHEDULE_RECHECK_MS = 10 * 60 * 1000;

// Bot再起動時に通知先チャンネルから過去YouTube URLを読む最大件数。
// 多すぎるとDiscord API呼び出しが増えるため、必要に応じて増減する。
const STARTUP_NOTIFY_CHANNEL_SCAN_LIMIT = 500;

// 状態チャンネル削除処理の安全上限。
// 100件ずつ取得して削除する。
const STATE_CHANNEL_CLEAR_MAX_MESSAGES = 500;

const ENV_PATH = './env.json';

// YouTube handle / URL から解決した channelId を保存するファイル。
const YT_IDS_PATH = './yt_ids.json';

const env = JSON.parse(await fs.readFile(ENV_PATH, 'utf-8'));

const {
    DISCORD_TOKEN,
    YOUTUBE_API_KEY,
    GUILD_ID,
    NOTIFYCHANNEL_ID,
    YTSTATECHANNEL_ID,
    YOUTUBERS,
    TIME_DIFF_FROM_UST,
} = env;

if (!DISCORD_TOKEN) throw new Error('env.json に DISCORD_TOKEN がありません');
if (!YOUTUBE_API_KEY) throw new Error('env.json に YOUTUBE_API_KEY がありません');
if (!GUILD_ID) throw new Error('env.json に GUILD_ID がありません');
if (!NOTIFYCHANNEL_ID) throw new Error('env.json に NOTIFYCHANNEL_ID がありません');
if (!YTSTATECHANNEL_ID) throw new Error('env.json に YTSTATECHANNEL_ID がありません');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,

        // 起動時に通知先チャンネルの既存メッセージ本文からYouTube URLを拾うために使う。
        // Discord Developer Portal側でも Message Content Intent を有効化する必要がある場合がある。
        GatewayIntentBits.MessageContent
    ]
});

const xmlParser = new XMLParser({
    ignoreAttributes: false
});

// すでにDiscordへ通知した videoId。
const notifiedVideoIds = new Set();

// 通常動画、終了済みライブ、起動時に既存投稿から拾った動画、
// またはタイトル条件に合わなかったライブなど、今後確認しない videoId。
const ignoredVideoIds = new Set();

// videoIdごとの次回確認可能時刻。
// 主に upcoming の予約枠に対して使う。
// key: videoId
// value: Unix time milliseconds
const nextCheckAtByVideoId = new Map();

// channelIdごとの当日ライブ検知状態。
// key: channelId
// value: { dateKey: 'YYYY-MM-DD', lastDetectedAtMs: number }
const liveStateByChannelId = new Map();

// handle/channelId 解決済みの監視対象。
let resolvedChannels = [];

// ./yt_ids.json の中身。
let ytIdCache = {};

// チェック処理の多重起動防止。
let isChecking = false;

function getJstTimeString() {
    const now = new Date();

    // JST = UTC + 9
    const jst = new Date(now.getTime() + TIME_DIFF_FROM_UST * 60 * 60 * 1000);

    const hh = String(jst.getUTCHours()).padStart(2, '0');
    const mm = String(jst.getUTCMinutes()).padStart(2, '0');
    const ss = String(jst.getUTCSeconds()).padStart(2, '0');

    return `[${hh}:${mm}:${ss}]`;
}

function log(...args) {
    console.log(getJstTimeString(), ...args);
}

function logError(...args) {
    console.error(getJstTimeString(), ...args);
}

function getCurrentHourInJst() {
    const now = new Date();
    return (now.getUTCHours() + 9) % 24;
}

function getJstDateParts(ms = Date.now()) {
    const jst = new Date(ms + 9 * 60 * 60 * 1000);

    return {
        year: jst.getUTCFullYear(),
        month: jst.getUTCMonth() + 1,
        day: jst.getUTCDate(),
        hour: jst.getUTCHours(),
        minute: jst.getUTCMinutes(),
        second: jst.getUTCSeconds()
    };
}

function getJstDateKey(ms = Date.now()) {
    const p = getJstDateParts(ms);

    const yyyy = String(p.year).padStart(4, '0');
    const mm = String(p.month).padStart(2, '0');
    const dd = String(p.day).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
}

function formatJstClock(ms) {
    const p = getJstDateParts(ms);

    const hh = String(p.hour).padStart(2, '0');
    const mm = String(p.minute).padStart(2, '0');
    const ss = String(p.second).padStart(2, '0');

    return `${hh}:${mm}:${ss}`;
}

function isActiveTimeInJst() {
    const hour = getCurrentHourInJst();

    // 通常ケース
    // 例: 15時〜24時
    if (ACTIVE_START_HOUR_JST < ACTIVE_END_HOUR_JST) {
        return ACTIVE_START_HOUR_JST <= hour && hour < ACTIVE_END_HOUR_JST;
    }

    // 日付またぎケース
    // 例: 22時〜翌3時
    if (ACTIVE_START_HOUR_JST > ACTIVE_END_HOUR_JST) {
        return ACTIVE_START_HOUR_JST <= hour || hour < ACTIVE_END_HOUR_JST;
    }

    // start と end が同じなら、常時有効扱い。
    return true;
}

async function loadYtIdCache() {
    try {
        const text = await fs.readFile(YT_IDS_PATH, 'utf-8');
        const json = JSON.parse(text);

        if (!json || typeof json !== 'object' || Array.isArray(json)) {
            throw new Error('yt_ids.json のルート要素が object ではありません');
        }

        return json;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {};
        }

        throw err;
    }
}

async function saveYtIdCache() {
    const text = JSON.stringify(ytIdCache, null, 4);
    await fs.writeFile(YT_IDS_PATH, text, 'utf-8');
}

function normalizeYoutubeInput(input) {
    return input.trim();
}

function extractYoutubeIdentifier(input) {
    const trimmed = normalizeYoutubeInput(input);

    // @tsuyukusa_v
    if (trimmed.startsWith('@')) {
        return {
            type: 'handle',
            value: trimmed
        };
    }

    // https://www.youtube.com/@tsuyukusa_v
    // https://www.youtube.com/@Ita-chan/videos
    {
        const match = trimmed.match(/youtube\.com\/(@[^/?#]+)/);
        if (match) {
            return {
                type: 'handle',
                value: match[1]
            };
        }
    }

    // https://www.youtube.com/channel/UCxxxx
    {
        const match = trimmed.match(/youtube\.com\/channel\/([^/?#]+)/);
        if (match) {
            return {
                type: 'channelId',
                value: match[1]
            };
        }
    }

    // UCxxxx
    if (/^UC[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return {
            type: 'channelId',
            value: trimmed
        };
    }

    throw new Error(`YouTube識別子を抽出できません: ${input}`);
}

function getCacheKey(input) {
    const identifier = extractYoutubeIdentifier(input);

    if (identifier.type === 'handle') {
        return identifier.value;
    }

    return identifier.value;
}

function extractYoutubeVideoIdsFromText(text) {
    if (!text) {
        return [];
    }

    const ids = new Set();

    // https://www.youtube.com/watch?v=VIDEO_ID
    for (const match of text.matchAll(/youtube\.com\/watch\?[^ \n\r\t<>]*v=([a-zA-Z0-9_-]{11})/g)) {
        ids.add(match[1]);
    }

    // https://youtu.be/VIDEO_ID
    for (const match of text.matchAll(/youtu\.be\/([a-zA-Z0-9_-]{11})/g)) {
        ids.add(match[1]);
    }

    // https://www.youtube.com/live/VIDEO_ID
    for (const match of text.matchAll(/youtube\.com\/live\/([a-zA-Z0-9_-]{11})/g)) {
        ids.add(match[1]);
    }

    // https://www.youtube.com/shorts/VIDEO_ID
    for (const match of text.matchAll(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/g)) {
        ids.add(match[1]);
    }

    return [...ids];
}

function titleMatchesLiveKeyword(title) {
    const source = title ?? '';
    const upper = source.toUpperCase();

    return LIVE_TITLE_KEYWORDS.some(keyword => {
        const k = keyword.toUpperCase();
        return upper.includes(k);
    });
}

async function fetchText(url) {
    const res = await fetch(url);

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return await res.text();
}

async function fetchJson(url) {
    const res = await fetch(url);

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return await res.json();
}

async function getTextBasedChannel(channelId, label) {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(channelId);

    if (!channel) {
        throw new Error(`${label} が見つかりません: ${channelId}`);
    }

    if (!channel.isTextBased()) {
        throw new Error(`${label} がテキスト送信可能ではありません: ${channelId}`);
    }

    return channel;
}

async function resolveChannel(input) {
    const identifier = extractYoutubeIdentifier(input);
    const cacheKey = getCacheKey(input);

    // channelId が直接指定されている場合は、YouTube APIを使わない。
    if (identifier.type === 'channelId') {
        if (!ytIdCache[cacheKey]) {
            ytIdCache[cacheKey] = {
                channelId: identifier.value,
                title: identifier.value,
                source: 'direct-channel-id',
                updatedAt: new Date().toISOString()
            };

            await saveYtIdCache();
        }

        return {
            input,
            cacheKey,
            handle: null,
            channelId: identifier.value,
            title: ytIdCache[cacheKey]?.title ?? identifier.value
        };
    }

    // handle / URL から解決済みの channelId がある場合は、YouTube APIを使わない。
    const cached = ytIdCache[cacheKey];
    if (cached?.channelId) {
        log(`Cache hit: ${cacheKey} -> ${cached.channelId}`);

        return {
            input,
            cacheKey,
            handle: identifier.value,
            channelId: cached.channelId,
            title: cached.title ?? identifier.value
        };
    }

    // cache に存在しない場合だけ channels.list を呼ぶ。
    log(`Cache miss: ${cacheKey}. Resolving by YouTube API...`);

    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('forHandle', identifier.value);
    url.searchParams.set('key', YOUTUBE_API_KEY);

    const json = await fetchJson(url);

    if (!json.items || json.items.length === 0) {
        throw new Error(`チャンネルが見つかりません: ${identifier.value}`);
    }

    const channel = json.items[0];

    const resolved = {
        channelId: channel.id,
        title: channel.snippet?.title ?? identifier.value,
        source: 'youtube-api-forHandle',
        updatedAt: new Date().toISOString()
    };

    ytIdCache[cacheKey] = resolved;
    await saveYtIdCache();

    return {
        input,
        cacheKey,
        handle: identifier.value,
        channelId: resolved.channelId,
        title: resolved.title
    };
}

async function fetchAtomEntries(channel) {
    const url = new URL('https://www.youtube.com/feeds/videos.xml');
    url.searchParams.set('channel_id', channel.channelId);

    const xml = await fetchText(url);
    const parsed = xmlParser.parse(xml);

    const feed = parsed.feed;
    if (!feed) {
        return [];
    }

    let entries = feed.entry ?? [];
    if (!Array.isArray(entries)) {
        entries = [entries];
    }

    return entries
        .slice(0, RSS_ENTRY_LIMIT_PER_CHANNEL)
        .map(entry => {
            const videoId = entry['yt:videoId'];
            const title = entry.title;
            const published = entry.published;
            const updated = entry.updated;

            let link = null;

            if (Array.isArray(entry.link)) {
                link = entry.link.find(x => x['@_rel'] === 'alternate')?.['@_href'] ?? null;
            } else if (entry.link) {
                link = entry.link['@_href'] ?? null;
            }

            return {
                videoId,
                title,
                published,
                updated,
                url: link ?? `https://www.youtube.com/watch?v=${videoId}`,
                rssChannelTitle: feed.title,
                channelId: channel.channelId
            };
        })
        .filter(entry => entry.videoId);
}

function chunkArray(array, size) {
    const chunks = [];

    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }

    return chunks;
}

async function fetchVideoDetails(videoIds) {
    const uniqueVideoIds = [...new Set(videoIds)];

    if (uniqueVideoIds.length === 0) {
        return [];
    }

    const results = [];

    // videos.list の id は最大50件までまとめられる。
    for (const chunk of chunkArray(uniqueVideoIds, 50)) {
        const url = new URL('https://www.googleapis.com/youtube/v3/videos');
        url.searchParams.set('part', 'snippet,liveStreamingDetails');
        url.searchParams.set('id', chunk.join(','));
        url.searchParams.set('key', YOUTUBE_API_KEY);

        const json = await fetchJson(url);
        results.push(...(json.items ?? []));
    }

    return results;
}

function shouldCheckVideoId(videoId) {
    if (notifiedVideoIds.has(videoId)) {
        return false;
    }

    if (ignoredVideoIds.has(videoId)) {
        return false;
    }

    const nextCheckAt = nextCheckAtByVideoId.get(videoId);
    if (nextCheckAt && Date.now() < nextCheckAt) {
        return false;
    }

    return true;
}

function isCurrentlyLive(video) {
    const liveBroadcastContent = video.snippet?.liveBroadcastContent;
    const details = video.liveStreamingDetails;

    return (
        liveBroadcastContent === 'live' &&
        Boolean(details?.actualStartTime) &&
        !details?.actualEndTime
    );
}

function recordLiveDetected(video) {
    const channelId = video.snippet?.channelId;
    if (!channelId) {
        return;
    }

    const nowMs = Date.now();

    liveStateByChannelId.set(channelId, {
        dateKey: getJstDateKey(nowMs),
        lastDetectedAtMs: nowMs
    });
}

function updateVideoCheckState(video) {
    const videoId = video.id;
    const liveBroadcastContent = video.snippet?.liveBroadcastContent;
    const details = video.liveStreamingDetails;

    if (!videoId) {
        return;
    }

    // 現在ライブ中なら、通知処理側で notifiedVideoIds / ignoredVideoIds を決める。
    // ここでは次回確認制限だけ解除する。
    if (liveBroadcastContent === 'live') {
        nextCheckAtByVideoId.delete(videoId);
        return;
    }

    // 通常動画、または終了済みライブは永久除外。
    if (liveBroadcastContent === 'none') {
        ignoredVideoIds.add(videoId);
        nextCheckAtByVideoId.delete(videoId);

        log(`[IGNORED] ${videoId} liveBroadcastContent=none`);
        return;
    }

    // 予約枠。
    // 予約時刻が取れるなら、その時刻を過ぎるまで再確認しない。
    if (liveBroadcastContent === 'upcoming') {
        const scheduledStartTime = details?.scheduledStartTime;

        if (scheduledStartTime) {
            const scheduledStartAt = Date.parse(scheduledStartTime);

            if (!Number.isNaN(scheduledStartAt)) {
                nextCheckAtByVideoId.set(
                    videoId,
                    scheduledStartAt + UPCOMING_RECHECK_DELAY_MS
                );

                const nextCheckDate = new Date(scheduledStartAt + UPCOMING_RECHECK_DELAY_MS);
                log(
                    `[UPCOMING] ${videoId} ` +
                    `nextCheckAt=${nextCheckDate.toISOString()}`
                );

                return;
            }
        }

        // scheduledStartTime が取れなかった場合だけ、保険で一定時間後に再確認。
        nextCheckAtByVideoId.set(
            videoId,
            Date.now() + UPCOMING_WITHOUT_SCHEDULE_RECHECK_MS
        );

        log(
            `[UPCOMING] ${videoId} ` +
            `scheduledStartTime not found. Recheck later.`
        );
    }
}

async function seedIgnoredVideoIdsFromNotifyChannel() {
    const channel = await getTextBasedChannel(NOTIFYCHANNEL_ID, '通知先チャンネル');

    let before = null;
    let scanned = 0;
    let found = 0;

    while (scanned < STARTUP_NOTIFY_CHANNEL_SCAN_LIMIT) {
        const limit = Math.min(100, STARTUP_NOTIFY_CHANNEL_SCAN_LIMIT - scanned);

        const options = {
            limit
        };

        if (before) {
            options.before = before;
        }

        const messages = await channel.messages.fetch(options);

        if (messages.size === 0) {
            break;
        }

        for (const message of messages.values()) {
            scanned++;

            const videoIds = extractYoutubeVideoIdsFromText(message.content);

            for (const videoId of videoIds) {
                if (!ignoredVideoIds.has(videoId)) {
                    ignoredVideoIds.add(videoId);
                    found++;
                }
            }
        }

        before = messages.last()?.id;

        if (!before || messages.size < limit) {
            break;
        }
    }

    log(`[STARTUP] scanned notify channel messages=${scanned}, seeded ignoredVideoIds=${found}`);
}

async function clearChannelMessages(channel, maxMessages) {
    let deleted = 0;
    let failed = 0;

    while (deleted + failed < maxMessages) {
        const remaining = maxMessages - deleted - failed;
        const limit = Math.min(100, remaining);

        const messages = await channel.messages.fetch({ limit });

        if (messages.size === 0) {
            break;
        }

        let deletedInThisBatch = 0;

        for (const message of messages.values()) {
            try {
                await message.delete();
                deleted++;
                deletedInThisBatch++;
            } catch (err) {
                failed++;
                logError(`[ERROR] メッセージ削除失敗: ${message.id}`, err);
            }
        }

        // 権限不足などで1件も削除できない場合、同じメッセージを再取得し続けるため止める。
        if (deletedInThisBatch === 0) {
            break;
        }

        if (messages.size < limit) {
            break;
        }
    }

    return {
        deleted,
        failed
    };
}

function buildYtStateMessage() {
    const todayKey = getJstDateKey();

    const lines = resolvedChannels.map(channel => {
        const state = liveStateByChannelId.get(channel.channelId);
        const hasLiveToday = state?.dateKey === todayKey;

        const mark = hasLiveToday ? '●' : '×';
        const lastTime = hasLiveToday
            ? formatJstClock(state.lastDetectedAtMs)
            : '-';

        return `${mark} ${channel.title}: ${lastTime}`;
    });

    return lines.join('\n') || '監視対象チャンネルがありません';
}

async function updateYtStateChannel() {
    const channel = await getTextBasedChannel(YTSTATECHANNEL_ID, 'YT状態チャンネル');

    const result = await clearChannelMessages(channel, STATE_CHANNEL_CLEAR_MAX_MESSAGES);

    if (result.deleted > 0 || result.failed > 0) {
        log(`[YTSTATE] cleared messages deleted=${result.deleted}, failed=${result.failed}`);
    }

    const content = buildYtStateMessage();

    await channel.send({
        content
    });

    log('[YTSTATE] updated');
}

async function notifyDiscord(video) {
    const channel = await getTextBasedChannel(NOTIFYCHANNEL_ID, '通知先チャンネル');

    const videoId = video.id;
    const title = video.snippet?.title ?? '(no title)';
    const channelTitle = video.snippet?.channelTitle ?? '(unknown channel)';
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    await channel.send({
        content:
            `🔴 **${channelTitle} がライブ配信を開始しました**\n` +
            `**${title}**\n` +
            `${url}`
    });
}

async function checkLivesOnce() {
    if (isChecking) {
        log('[SKIP] 前回の更新確認がまだ実行中です');
        return;
    }

    isChecking = true;

    try {
        if (!isActiveTimeInJst()) {
            log(
                `[SKIP] 現在は走査時間外です。active=${ACTIVE_START_HOUR_JST}:00-${ACTIVE_END_HOUR_JST}:00 JST`
            );
            return;
        }

        const rssEntries = [];

        for (const channel of resolvedChannels) {
            try {
                const entries = await fetchAtomEntries(channel);
                rssEntries.push(...entries);
            } catch (err) {
                logError(`[ERROR] RSS取得失敗: ${channel.title} (${channel.channelId})`, err);
            }
        }

        const candidateVideoIds = rssEntries
            .map(entry => entry.videoId)
            .filter(videoId => shouldCheckVideoId(videoId));

        if (candidateVideoIds.length === 0) {
            log('[CHECK] candidate videos: 0');
            return;
        }

        let videos = [];

        try {
            videos = await fetchVideoDetails(candidateVideoIds);
        } catch (err) {
            logError('[ERROR] videos.list 失敗', err);
            return;
        }

        log(`[CHECK] candidate videos: ${candidateVideoIds.length}, details: ${videos.length}`);

        // 先に状態更新する。
        // none は ignoredVideoIds に入り、upcoming は次回確認時刻が設定される。
        for (const video of videos) {
            updateVideoCheckState(video);
        }

        // live のものを処理する。
        for (const video of videos) {
            if (!isCurrentlyLive(video)) {
                continue;
            }

            recordLiveDetected(video);

            const title = video.snippet?.title ?? '';

            if (!titleMatchesLiveKeyword(title)) {
                ignoredVideoIds.add(video.id);
                nextCheckAtByVideoId.delete(video.id);

                log(
                    `[LIVE_IGNORED_KEYWORD] ${video.id} ` +
                    `${video.snippet?.channelTitle}: ${title}`
                );

                continue;
            }

            if (notifiedVideoIds.has(video.id)) {
                continue;
            }

            try {
                await notifyDiscord(video);

                notifiedVideoIds.add(video.id);
                ignoredVideoIds.delete(video.id);
                nextCheckAtByVideoId.delete(video.id);

                log(
                    `[NOTIFIED] ${video.id} ${video.snippet?.channelTitle}: ${title}`
                );
            } catch (err) {
                logError(`[ERROR] Discord通知失敗: ${video.id}`, err);
            }
        }
    } finally {
        try {
            await updateYtStateChannel();
        } catch (err) {
            logError('[ERROR] YT状態チャンネル更新失敗', err);
        }

        isChecking = false;
    }
}

client.once('ready', async () => {
    log(`Discord bot logged in as ${client.user.tag}`);

    try {
        ytIdCache = await loadYtIdCache();
    } catch (err) {
        logError('[ERROR] yt_ids.json の読み込みに失敗しました', err);
        throw err;
    }

    resolvedChannels = [];

    for (const youtuber of YOUTUBERS) {
        try {
            const resolved = await resolveChannel(youtuber);
            resolvedChannels.push(resolved);

            log(
                `Resolved: ${resolved.input} -> ${resolved.title} (${resolved.channelId})`
            );
        } catch (err) {
            logError(`[ERROR] チャンネル解決失敗: ${youtuber}`, err);
        }
    }

    if (resolvedChannels.length === 0) {
        logError('監視対象チャンネルが1件も解決できませんでした');
        return;
    }

    try {
        await seedIgnoredVideoIdsFromNotifyChannel();
    } catch (err) {
        logError('[ERROR] 通知先チャンネルから既存YouTube URLの取得に失敗しました', err);
        throw err;
    }

    // discordにすでに投稿した動画の読み込みが終わってから初回確認。
    await checkLivesOnce();

    // 以後、定期確認。
    setInterval(() => {
        checkLivesOnce().catch(err => {
            logError('[ERROR] scheduled check failed:', err);
        });
    }, CHECK_INTERVAL_MS);
});

await client.login(DISCORD_TOKEN);