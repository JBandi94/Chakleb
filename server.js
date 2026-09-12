const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
// استدعاء WebcastPushConnection بدلاً من TikTokLiveConnection للتوافق مع التحديثات الأخيرة
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
    console.log(`صفحة اللعبة متصلة بالخادم (المعرف: ${socket.id})`);

    // ربط كائن الاتصال بـ Socket الخاص بكل مستخدم لتفادي التضارب
    let tiktokLiveConnection = null;

    socket.on('connect-tiktok', (uniqueId) => {
        // قطع أي اتصال سابق خاص بهذا المتصفح
        if (tiktokLiveConnection) {
            try { 
                tiktokLiveConnection.disconnect(); 
            } catch (e) {
                console.error("خطأ أثناء فصل الاتصال السابق:", e);
            }
        }

        const cleanUsername = String(uniqueId).replace('@', '').trim();

        // استخدام الكلاس المحدث لربط البث
        tiktokLiveConnection = new WebcastPushConnection(cleanUsername, {
            processInitialData: false,
            enableExtendedGiftInfo: false,
            requestOptions: {
                timeout: 10000
            }
        });

        socket.emit('tiktok-status', { status: 'connecting', message: 'جاري الاتصال بالبث...' });

        tiktokLiveConnection.connect().then(state => {
            console.log(`تم الاتصال بنجاح ببث: ${cleanUsername}`);
            socket.emit('tiktok-status', { status: 'connected', message: `تم الاتصال ببث: ${cleanUsername}` });
        }).catch(err => {
            console.error('خطأ في الاتصال:', err);
            socket.emit('tiktok-status', { 
                status: 'disconnected', 
                message: 'فشل الاتصال! تأكد أن البث مفتوح حالياً وأن اليوزر صحيح.' 
            });
        });

        // استقبال الشات وإرساله للواجهة
        tiktokLiveConnection.on('chat', data => {
            const cleanComment = data.comment ? String(data.comment).trim() : '';
            console.log(`[تعليق] ${data.uniqueId}: ${cleanComment}`);

            socket.emit('tiktok-chat', {
                uniqueId: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                comment: cleanComment
            });
        });

        // حدث مغادرة المتابع لطرده من قائمة اللاعبين تلقائياً
        tiktokLiveConnection.on('member', data => {
            if (data.actionId === 3) { // 3 تعني مغادرة
                socket.emit('tiktok-user-left', { uniqueId: data.uniqueId });
            }
        });

        tiktokLiveConnection.on('streamEnd', () => {
            console.log('انتهى البث المباشر');
            socket.emit('tiktok-status', { status: 'disconnected', message: 'انتهى البث المباشر' });
        });

        tiktokLiveConnection.on('disconnected', () => {
            console.log('تم انقطاع الاتصال بالبث');
            socket.emit('tiktok-status', { status: 'disconnected', message: 'تم انقطاع الاتصال بالبث' });
        });

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

    // التنظيف عند إغلاق المتصفح أو قطع الاتصال بالسيرفر
    socket.on('disconnect', () => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }
        console.log(`انقطع اتصال المتصفح: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});
