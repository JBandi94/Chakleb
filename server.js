import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import {
    TikTokLiveConnection,
    WebcastEvent,
    ControlEvent
} from 'tiktok-live-connector';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.static(process.cwd()));

// TikTok avatar cache: download the image on the server and serve it from
// the same Render origin. This avoids browser hotlink/CORS/CDN restrictions.
const avatarCache = new Map();
const avatarPending = new Map();

function avatarCandidates(data) {
    const user = data?.user || {};
    const lists = [
        data?.profilePictureUrl,
        data?.profilePicture?.url,
        ...(Array.isArray(data?.profilePicture?.urls) ? data.profilePicture.urls : []),
        user?.profilePictureUrl,
        user?.profilePicture?.url,
        ...(Array.isArray(user?.profilePicture?.urls) ? user.profilePicture.urls : []),
        user?.userDetails?.profilePictureUrl,
        ...(Array.isArray(user?.userDetails?.profilePictureUrls) ? user.userDetails.profilePictureUrls : []),
        data?.userDetails?.profilePictureUrl,
        ...(Array.isArray(data?.userDetails?.profilePictureUrls) ? data.userDetails.profilePictureUrls : []),
        user?.avatarLarge?.urlList?.[0],
        user?.avatarMedium?.urlList?.[0],
        user?.avatarThumb?.urlList?.[0],
        data?.avatarLarge?.urlList?.[0],
        data?.avatarMedium?.urlList?.[0],
        data?.avatarThumb?.urlList?.[0],
        user?.avatarLarger,
        user?.avatarMedium,
        user?.avatarThumb,
        data?.avatarLarger,
        data?.avatarMedium,
        data?.avatarThumb
    ];
    return [...new Set(lists.filter(v => typeof v === 'string' && /^https?:\/\//i.test(v.trim())).map(v => v.trim()))];
}

function extractProfilePictureUrl(data) {
    return avatarCandidates(data)[0] || '';
}

function avatarKey(uniqueId, userId) {
    return String(uniqueId || userId || '').trim().replace(/^@/, '').toLowerCase();
}

async function downloadAvatar(key, urls) {
    if (!key || avatarPending.has(key)) return;
    const candidates = [...new Set((urls || []).filter(Boolean))];
    if (!candidates.length) return;

    const job = (async () => {
        for (const rawUrl of candidates) {
            try {
                const response = await fetch(rawUrl, {
                    redirect: 'follow',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Referer': 'https://www.tiktok.com/'
                    }
                });
                if (!response.ok) continue;
                const contentType = response.headers.get('content-type') || 'image/jpeg';
                if (!contentType.toLowerCase().startsWith('image/')) continue;
                const buffer = Buffer.from(await response.arrayBuffer());
                if (!buffer.length) continue;
                avatarCache.set(key, {
                    buffer,
                    contentType,
                    expires: Date.now() + 24 * 60 * 60 * 1000
                });
                console.log(`[AVATAR CACHE] ${key}: OK ${contentType} ${buffer.length} bytes`);
                return;
            } catch (err) {
                console.warn(`[AVATAR CACHE] ${key}: failed candidate - ${err?.message || err}`);
            }
        }
        console.warn(`[AVATAR CACHE] ${key}: ALL CANDIDATES FAILED`);
    })().finally(() => avatarPending.delete(key));

    avatarPending.set(key, job);
}

app.get('/avatar', async (req, res) => {
    const key = avatarKey(req.query.id, req.query.userId);
    if (!key) return res.status(400).end();

    const cached = avatarCache.get(key);
    if (cached && cached.expires > Date.now()) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        return res.send(cached.buffer);
    }

    // If the event has just arrived, give the download a moment to finish.
    const pending = avatarPending.get(key);
    if (pending) {
        await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 5000))]);
        const ready = avatarCache.get(key);
        if (ready) {
            res.setHeader('Content-Type', ready.contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
            return res.send(ready.buffer);
        }
    }

    return res.status(404).end();
});

let tiktokConnection = null;
let activeUniqueId = null;
let connectionGeneration = 0;

function cleanUniqueId(value) {
    let uniqueId = String(value ?? '').trim();

    uniqueId = uniqueId
        .replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
        .split(/[/?#]/)[0]
        .replace(/^@/, '')
        .trim();

    return uniqueId;
}

function errorToMessage(err) {
    if (!err) return 'خطأ غير معروف من TikTok';

    const name = err.name || '';
    const message = err.message || String(err);

    if (/offline|not live|useroffline/i.test(`${name} ${message}`)) {
        return 'الحساب ليس في بث مباشر الآن أو أن البث غير متاح للاتصال.';
    }

    if (/room.?id|roomid/i.test(`${name} ${message}`)) {
        return 'تعذر الحصول على رقم غرفة البث (room ID) من TikTok.';
    }

    if (/websocket|upgrade|socket/i.test(`${name} ${message}`)) {
        return 'TikTok رفض اتصال WebSocket أو لم يسمح بترقية الاتصال.';
    }

    if (/timeout|timed out|ETIMEDOUT/i.test(`${name} ${message}`)) {
        return 'انتهت مهلة الاتصال بخوادم TikTok.';
    }

    if (/sign|signature|signing/i.test(`${name} ${message}`)) {
        return 'فشل توقيع اتصال TikTok WebSocket. قد تكون خدمة التوقيع غير متاحة مؤقتاً.';
    }

    return `${name ? name + ': ' : ''}${message}`;
}

async function safelyDisconnectTikTok() {
    const connection = tiktokConnection;
    tiktokConnection = null;
    activeUniqueId = null;

    if (!connection) return;

    try {
        await connection.disconnect();
    } catch (err) {
        console.warn('خطأ أثناء فصل اتصال TikTok السابق:', err?.message || err);
    }
}


io.on('connection', (socket) => {
    console.log('عميل جديد متصل عبر Socket.IO:', socket.id);

    socket.on('connect-tiktok', async (data = {}) => {
        const uniqueId = cleanUniqueId(data.uniqueId);

        if (!uniqueId) {
            socket.emit('tiktok-status', {
                success: false,
                message: 'يرجى إدخال اسم حساب TikTok صحيح.'
            });
            return;
        }

        const generation = ++connectionGeneration;

        await safelyDisconnectTikTok();

        console.log(`[TikTok] محاولة الاتصال بالحساب: @${uniqueId}`);

        socket.emit('tiktok-status', {
            success: false,
            message: `جاري الاتصال ببث @${uniqueId}...`
        });

        try {
            const connection = new TikTokLiveConnection(uniqueId, {
                processInitialData: false,
                fetchRoomInfoOnConnect: true,
                enableExtendedGiftInfo: false
            });

            tiktokConnection = connection;
            activeUniqueId = uniqueId;

            // Always handle the library's error event so Node does not
            // end up with an unhandled EventEmitter error.
            connection.on(ControlEvent.ERROR, ({ info, exception } = {}) => {
                console.error('[TikTok] ERROR:', info || '', exception || '');

                if (generation !== connectionGeneration) return;

                io.emit('tiktok-status', {
                    success: false,
                    message: `خطأ TikTok: ${errorToMessage(exception || info)}`
                });
            });

            connection.on(ControlEvent.CONNECTED, () => {
                console.log(`[TikTok] Connected: @${uniqueId}`);
            });

            connection.on(ControlEvent.WEBSOCKET_CONNECTED, () => {
                console.log(`[TikTok] WebSocket connected: @${uniqueId}`);
            });

            connection.on(ControlEvent.DISCONNECTED, () => {
                console.log(`[TikTok] Disconnected: @${uniqueId}`);

                if (generation === connectionGeneration) {
                    io.emit('tiktok-disconnected', {
                        message: 'تم قطع اتصال TikTok.'
                    });
                }
            });

            connection.on(WebcastEvent.CHAT, (data) => {
                if (generation !== connectionGeneration) return;

                // v2.x normally exposes the message as data.comment and the
                // sender as data.user. Keep fallbacks because TikTok/connector
                // payloads can differ between message types/versions.
                const user = data?.user || {};

                // v2.4.4 normally exposes data.user.uniqueId + data.comment.
                // Keep several fallbacks because TikTok has used different
                // shapes for viewer comments (especially newer/v3 payloads).
                const rawUniqueId =
                    user.uniqueId ??
                    user.unique_id ??
                    user.uniqueID ??
                    user.userDetails?.uniqueId ??
                    user.userDetails?.unique_id ??
                    data?.uniqueId ??
                    data?.unique_id ??
                    data?.userDetails?.uniqueId ??
                    data?.userDetails?.unique_id ??
                    data?.userId ??
                    data?.user_id ??
                    user.userId ??
                    user.user_id ??
                    user.id ??
                    '';

                const uniqueId = String(rawUniqueId ?? '').trim().replace(/^@/, '');
                const userId = String(
                    user.userId ?? user.user_id ?? user.id ?? data?.userId ?? data?.user_id ?? ''
                ).trim();

                const nickname = String(
                    user.nickname ??
                    user.displayName ??
                    user.userDetails?.nickname ??
                    data?.nickname ??
                    data?.displayName ??
                    data?.userDetails?.nickname ??
                    uniqueId ??
                    userId ??
                    'مستخدم'
                ).trim();

                const commentCandidates = [
                    data?.comment,
                    data?.content,
                    data?.text,
                    data?.message?.content,
                    data?.message?.text,
                    data?.chatMessage?.comment,
                    data?.chatMessage?.content,
                    data?.chatMessage?.text
                ];

                const comment = commentCandidates
                    .find(value => typeof value === 'string' && value.trim() !== '')
                    ?.trim() || '';

                // TikTok exposes followRole on chat user data:
                // 0 = not following, 1 = follower, 2 = friends.
                const followRole = Number(
                    user.followRole ??
                    data?.followRole ??
                    data?.followInfo?.followStatus ??
                    user.followInfo?.followStatus ??
                    0
                );

                console.log(`[TikTok CHAT] @${uniqueId} (${nickname}) [followRole=${followRole}]: ${comment}`);

                const profilePictureUrl = extractProfilePictureUrl(data);
                const avatarKeyValue = avatarKey(uniqueId, userId);
                downloadAvatar(avatarKeyValue, avatarCandidates(data));

                console.log(`[TikTok AVATAR] @${uniqueId}: ${profilePictureUrl ? 'OK' : 'MISSING'} ${profilePictureUrl ? profilePictureUrl.slice(0, 100) : ''}`);

                io.emit('tiktok-chat', {
                    uniqueId,
                    userId,
                    nickname: nickname || uniqueId || userId || 'مستخدم',
                    comment,
                    followRole,
                    profilePictureUrl,
                    avatarKey: avatarKeyValue
                });
            });

            connection.on(WebcastEvent.MEMBER, (data) => {
                if (generation !== connectionGeneration) return;

                const user = data?.user || {};
                const memberUniqueId = String(user.uniqueId || data?.uniqueId || '').trim();
                const memberNickname = String(user.nickname || data?.nickname || memberUniqueId || 'مستخدم').trim();
                const followRole = Number(
                    user.followRole ??
                    data?.followRole ??
                    user.followInfo?.followStatus ??
                    data?.followInfo?.followStatus ??
                    0
                );

                const memberProfilePictureUrl = extractProfilePictureUrl(data);
                const memberAvatarKey = avatarKey(memberUniqueId, user.userId ?? data?.userId);
                downloadAvatar(memberAvatarKey, avatarCandidates(data));

                io.emit('tiktok-member-event', {
                    uniqueId: memberUniqueId,
                    nickname: memberNickname,
                    followRole,
                    profilePictureUrl: memberProfilePictureUrl,
                    avatarKey: memberAvatarKey,
                    action: 'join'
                });
            });

            const state = await connection.connect();

            if (generation !== connectionGeneration || tiktokConnection !== connection) {
                try {
                    await connection.disconnect();
                } catch {}
                return;
            }

            console.log(
                `[TikTok] SUCCESS @${uniqueId} roomId=${state?.roomId || 'unknown'}`
            );

            socket.emit('tiktok-status', {
                success: true,
                message: `تم الاتصال بنجاح ببث: @${uniqueId}`,
                roomId: state?.roomId || null
            });

        } catch (err) {
            console.error('[TikTok] فشل الاتصال:', err);
            console.error('[TikTok] التفاصيل:', err?.stack || err);

            if (generation === connectionGeneration) {
                tiktokConnection = null;
                activeUniqueId = null;

                socket.emit('tiktok-status', {
                    success: false,
                    message: `فشل الاتصال: ${errorToMessage(err)}`
                });
            }
        }
    });

    socket.on('disconnect-tiktok', async () => {
        ++connectionGeneration;
        await safelyDisconnectTikTok();

        socket.emit('tiktok-status', {
            success: false,
            message: 'تم فصل الاتصال بالحساب.'
        });
    });

    socket.on('disconnect', () => {
        console.log('قطع اتصال عميل Socket.IO:', socket.id);
    });
});

const PORT = Number(process.env.PORT) || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`الخادم يعمل على المنفذ ${PORT}`);
    console.log(`NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});
