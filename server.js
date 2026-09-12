const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');

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
            try { 
                tiktokLiveConnection.disconnect(); 
            } catch (e) {
                console.error("خطأ أثناء فصل الاتصال السابق:", e);
            }
        }

        // إنشاء كائن الاتصال للنسخة الجديدة
        tiktokLiveConnection = new TikTokLiveConnection(uniqueId, {
            processInitialData: false,
            enableExtendedOption: true,
            requestOptions: {
                timeout: 10000
            }
        });

        socket.emit('tiktok-status', { status: 'connecting', message: 'جاري الاتصال بالبث...' });

        tiktokLiveConnection.connect().then(state => {
            console.log(`تم الاتصال بنجاح ببث: ${uniqueId}`);
            socket.emit('tiktok-status', { status: 'connected', message: `تم الاتصال ببث: ${uniqueId}` });
        }).catch(err => {
            console.error('خطأ في الاتصال:', err);
            socket.emit('tiktok-status', { 
                status: 'disconnected', 
                message: 'فشل الاتصال! تأكد أن البث مفتوح حالياً وأن اسم المستخدم صحيح.' 
            });
        });

        // الاستماع لأحداث الشات بشكل مباشر ومضمون
        tiktokLiveConnection.on('chat', data => {
            // تنظيف النص وتمريره للواجهة
            const cleanComment = data.comment ? data.comment.trim() : '';
            console.log(`[تعليق] ${data.uniqueId}: ${cleanComment}`);

            socket.emit('tiktok-chat', {
                uniqueId: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                comment: cleanComment
            });
        });

        // الاستماع لحدث انتهاء البث
        tiktokLiveConnection.on('streamEnd', () => {
            console.log('انتهى البث المباشر');
            socket.emit('tiktok-status', { status: 'disconnected', message: 'انتهى البث المباشر' });
        });

        // الاستماع لانقطاع الاتصال
        tiktokLiveConnection.on('disconnected', () => {
            console.log('تم انقطاع الاتصال بالبث');
            socket.emit('tiktok-status', { status: 'disconnected', message: 'تم انقطاع الاتصال بالبث' });
        });

        // إدارة الأخطاء غير المتوقعة لمنع توقف الخادم
        tiktokLiveConnection.on('error', err => {
            console.error('خطأ في اتصال تيكتوك:', err);
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
