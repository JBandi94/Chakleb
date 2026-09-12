const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`[Socket] متصفح متصل: ${socket.id}`);
    let tiktokConnection = null;

    socket.on('connect-tiktok', (username) => {
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
        }

        const cleanUsername = String(username).replace('@', '').trim();
        console.log(`[TikTok] محاولة الاتصال بـ: ${cleanUsername}`);

        // استخدام الإعدادات المحدثة والمتوافقة مع بيئة Render
        tiktokConnection = new WebcastPushConnection(cleanUsername, {
            processInitialData: false,
            enableExtendedGiftInfo: false,
            enableWebsocketUpgrade: true,
            requestOptions: {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }
        });

        socket.emit('tiktok-status', { status: 'connecting', message: 'جاري الاتصال بالبث...' });

        tiktokConnection.connect().then(state => {
            console.log(`[TikTok] تم الاتصال بنجاح: ${cleanUsername}`);
            socket.emit('tiktok-status', { status: 'connected', message: `متصل ببث: ${cleanUsername}` });
        }).catch(err => {
            console.error('[TikTok Error]:', err.message || err);
            socket.emit('tiktok-status', { 
                status: 'disconnected', 
                message: 'فشل الاتصال! تأكد أن البث مفتوح حالياً واليوزر صحيح.' 
            });
        });

        tiktokConnection.on('chat', data => {
            socket.emit('tiktok-chat', {
                uniqueId: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                comment: data.comment ? String(data.comment).trim() : ''
            });
        });

        tiktokConnection.on('streamEnd', () => {
            socket.emit('tiktok-status', { status: 'disconnected', message: 'انتهى البث المباشر' });
        });

        tiktokConnection.on('disconnected', () => {
            socket.emit('tiktok-status', { status: 'disconnected', message: 'تم قطع الاتصال بالبث' });
        });

        tiktokConnection.on('error', err => {
            console.error('[TikTok Runtime Error]:', err.message || err);
        });
    });

    socket.on('disconnect-tiktok', () => {
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
            tiktokConnection = null;
        }
        socket.emit('tiktok-status', { status: 'disconnected', message: 'تم قطع الاتصال' });
    });

    socket.on('disconnect', () => {
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
        }
        console.log(`[Socket] انقطع اتصال المتصفح: ${socket.id}`);
    });
});

// المنفذ الخاص بـ Render مع الاستماع على 0.0.0.0
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});
