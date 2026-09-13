const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let tiktokConnection = null;
let activeUniqueId = null;

io.on('connection', (socket) => {
    console.log('عميل جديد متصل عبر WebSocket:', socket.id);

    socket.on('connect-tiktok', async (data) => {
        const { uniqueId } = data;
        
        if (!uniqueId) {
            return socket.emit('tiktok-status', { success: false, message: 'يرجى إدخال اسم حساب التيكتوك!' });
        }

        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
            tiktokConnection = null;
        }

        try {
            tiktokConnection = new WebcastPushConnection(uniqueId, {
                processInitialData: false,
                enableExtendedOption: true,
                requestOptions: {
                    timeout: 10000
                }
            });

            const state = await tiktokConnection.connect();
            activeUniqueId = uniqueId;
            
            socket.emit('tiktok-status', { 
                success: true, 
                message: `تم الاتصال بنجاح ببث: ${uniqueId}`,
                roomId: state.roomId 
            });

            tiktokConnection.on('chat', (data) => {
                io.emit('tiktok-chat', {
                    uniqueId: data.uniqueId,
                    nickname: data.nickname,
                    comment: data.comment,
                    profilePictureUrl: data.profilePictureUrl
                });
            });

            tiktokConnection.on('member', (data) => {
                io.emit('tiktok-member-event', {
                    uniqueId: data.uniqueId,
                    nickname: data.nickname,
                    action: 'join'
                });
            });

            tiktokConnection.on('streamEnd', () => {
                io.emit('tiktok-status', { success: false, message: 'انتهى البث المباشر!' });
            });

            tiktokConnection.on('disconnected', () => {
                io.emit('tiktok-disconnected', { message: 'تم قطع الاتصال بالبث المباشر.' });
            });

        } catch (err) {
            console.error('خطأ الاتصال بـ TikTok:', err);
            socket.emit('tiktok-status', { 
                success: false, 
                message: 'تعذر الاتصال بالبث! تأكد أن الحساب في بث مباشر الآن وأن اسم المستخدم صحيح.' 
            });
        }
    });

    socket.on('disconnect-tiktok', () => {
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
            tiktokConnection = null;
            activeUniqueId = null;
            socket.emit('tiktok-status', { success: false, message: 'تم فصل الاتصال بالحساب.' });
        }
    });

    socket.on('disconnect', () => {
        console.log('قطع اتصال عميل WebSocket:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`الخادم يعمل على المنفذ: http://localhost:${PORT}`);
});
