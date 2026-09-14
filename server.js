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

                const uniqueId = String(
                    user.uniqueId ??
                    user.unique_id ??
                    data?.uniqueId ??
                    data?.unique_id ??
                    data?.userId ??
                    data?.user_id ??
                    ''
                ).trim();

                const nickname = String(
                    user.nickname ??
                    user.displayName ??
                    data?.nickname ??
                    data?.displayName ??
                    uniqueId ??
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

                io.emit('tiktok-chat', {
                    uniqueId,
                    nickname: nickname || uniqueId || 'مستخدم',
                    comment,
                    followRole,
                    profilePictureUrl: user.profilePictureUrl || data?.profilePictureUrl || ''
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

                // MEMBER is emitted when a viewer enters the LIVE.
                // The browser uses it to restore a previously registered player
                // without changing their saved score.
                io.emit('tiktok-member-event', {
                    uniqueId: memberUniqueId,
                    nickname: memberNickname,
                    followRole,
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
