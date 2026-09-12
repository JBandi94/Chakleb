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

let tiktokLiveConnection = null;

io.on('connection', (socket) => {
    console.log('صفحة اللعبة متصلة بالخادم');

    socket.on('connect-tiktok', (uniqueId) => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }

        // إنشاء الاتصال مع إعدادات إضافية لتفادي الحظر
        tiktokLiveConnection = new WebcastPushConnection(uniqueId, {
            processInitialData: false,
            enableExtendedOption: true,
            requestOptions: {
                timeout: 10000
            }
        });

        socket.emit('tiktok-status', { status: 'connecting', message: 'جاري الاتصال بالبث...' });

        tiktokLiveConnection.connect().then(state => {
            socket.emit('tiktok-status', { status: 'connected', message: `تم الاتصال ببث: ${uniqueId}` });
        }).catch(err => {
            console.error(err);
            socket.emit('tiktok-status', { 
                status: 'disconnected', 
                message: 'فشل الاتصال! تأكد أن البث مفتوح حالياً أو جرب لاحقاً.' 
            });
        });

        tiktokLiveConnection.on('chat', data => {
            socket.emit('tiktok-chat', {
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                comment: data.comment
            });
        });

        tiktokLiveConnection.on('streamEnd', () => {
            socket.emit('tiktok-status', { status: 'disconnected', message: 'انتهى البث المباشر' });
        });

        tiktokLiveConnection.on('disconnected', () => {
            socket.emit('tiktok-status', { status: 'disconnected', message: 'تم انقطاع الاتصال بالبث' });
        });
    });

    socket.on('disconnect-tiktok', () => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
            tiktokLiveConnection = null;
        }
        socket.emit('tiktok-status', { status: 'disconnected', message: 'تم قطع الاتصال' });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});
