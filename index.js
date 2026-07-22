const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

let currentSessionState = {
    qrCodeSvg: null,
    isReady: false,
    isInitializing: false
};

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Configure Client with persistent session flags & stealth settings
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session_store' }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        navigationTimeout: 90000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-gpu',
            '--no-first-run',
            '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    }
});

// 1. Capture QR Code
client.on('qr', async (qr) => {
    try {
        console.log('🔄 New QR Code received. Please scan in browser.');
        const svgString = await QRCode.toString(qr, { type: 'svg', margin: 2 });
        currentSessionState.qrCodeSvg = svgString;
        currentSessionState.isReady = false;
        currentSessionState.isInitializing = false;
    } catch (err) {
        console.error("❌ QR conversion error:", err);
    }
});

// 2. Session Ready Event
client.on('ready', () => {
    currentSessionState.qrCodeSvg = null;
    currentSessionState.isReady = true;
    currentSessionState.isInitializing = false;
    console.log('✅ WhatsApp session active and authenticated.');
    
    // Keep-Alive Ping every 10 minutes to prevent WhatsApp idle disconnection
    setInterval(async () => {
        try {
            if (currentSessionState.isReady) {
                const state = await client.getState();
                console.log(`💓 Keep-alive ping state: ${state}`);
            }
        } catch (e) {
            console.warn('⚠️ Keep-alive check failed:', e.message);
        }
    }, 10 * 60 * 1000);
});

// 3. Automatic Recovery Handlers
client.on('auth_failure', (msg) => {
    console.error('❌ Auth failure. Session corrupted:', msg);
    currentSessionState.isReady = false;
    currentSessionState.qrCodeSvg = null;
    currentSessionState.isInitializing = false;
});

client.on('disconnected', async (reason) => {
    console.log('⚠️ Session disconnected:', reason);
    currentSessionState.isReady = false;
    currentSessionState.qrCodeSvg = null;

    if (!currentSessionState.isInitializing) {
        currentSessionState.isInitializing = true;
        console.log('🔄 Attempting session auto-reconnect in 5 seconds...');
        await delay(5000);
        try {
            await client.initialize();
        } catch (err) {
            console.error('❌ Reconnection failed:', err.message);
            currentSessionState.isInitializing = false;
        }
    }
});

// Web Status Interface
app.get('/', async (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ WhatsApp Session Connected</h1>
                <p>Session is saved and online. Leads are monitored automatically.</p>
            </div>
        `);
    }

    if (currentSessionState.qrCodeSvg) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
                <h1 style="color:#128C7E; font-size: 28px;">Scan WhatsApp QR Code</h1>
                <p style="font-size: 16px; color: #333;">Open WhatsApp on phone &rarr; <b>Settings</b> &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b></p>
                <div style="margin:20px auto; max-width:300px; padding:20px; border:1px solid #ddd; background:#fff; border-radius:12px;">
                    ${currentSessionState.qrCodeSvg}
                </div>
            </div>
        `);
    }

    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Initializing WhatsApp Session...</h2>
            <p>Loading saved session credentials or requesting new QR code...</p>
            <script>setTimeout(() => { window.location.reload(); }, 4000);</script>
        </div>
    `);
});

// Send Lead Endpoint
app.post('/api/v1/send-lead', async (req, res) => {
    const { name, fullName, email, phone } = req.body;
    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details (name, email, or phone).' });
    }

    try {
        if (!currentSessionState.isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client is not connected. Check server status.' });
        }

        await delay(1000);

        let bodyText = `🚨 *NEW WEBSITE LEAD RECEIVED* 🚨\n\n` +
                       `👤 *Customer Name:* ${finalName}\n` +
                       `📧 *Customer Email:* ${email}\n` +
                       `📞 *Customer Phone:* +${phone.replace(/\D/g, '')}\n`;

        const fieldMap = [
            { key: 'serviceType', label: '🛠️ *Service Type*' },
            { key: 'eventType', label: '🎉 *Event Type*' },
            { key: 'eventDate', label: '🗓️ *Event Date*' },
            { key: 'numGuests', label: '👥 *Guests*' },
            { key: 'venue', label: '📍 *Venue*' },
            { key: 'message', label: '💬 *Message*' }
        ];

        fieldMap.forEach(field => {
            const value = req.body[field.key];
            if (value) bodyText += `${field.label}: ${value}\n`;
        });

        const selfChatId = client.info.wid._serialized;
        await client.sendMessage(selfChatId, bodyText);

        return res.status(200).json({ success: true, message: 'Lead sent to WhatsApp successfully.' });
    } catch (err) {
        console.error("Internal sending error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    currentSessionState.isInitializing = true;
    client.initialize();
});