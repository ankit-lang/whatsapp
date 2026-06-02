const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

// Main state store for our QR transmission
let currentSessionState = {
    qrCodeSvg: null,
    isReady: false
};

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session_store' }),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-zygote',
            '--disable-gpu',
            '--no-first-run'
        ]
    }
});

// Capture raw string and convert it straight to a visual SVG element
client.on('qr', async (qr) => {
    try {
        console.log('🔄 New QR Code string captured. Converting to image...');
        const svgString = await QRCode.toString(qr, { type: 'svg', margin: 2 });
        currentSessionState.qrCodeSvg = svgString;
    } catch (err) {
        console.error("❌ QR conversion error:", err);
    }
});

client.on('ready', () => {
    currentSessionState.qrCodeSvg = null;
    currentSessionState.isReady = true;
    console.log('✅ Bot successfully authenticated and ready to route metrics.');
});

// Dashboard panel renders QR directly in line
app.get('/', (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ Client Authenticated</h1>
                <p>Your API Stream is online. Leads will automatically send to your own chat window.</p>
            </div>
        `);
    }

    if (currentSessionState.qrCodeSvg) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
                <h1 style="color:#128C7E;">Scan WhatsApp QR Code</h1>
                <p>Open WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>
                <div style="margin:20px auto; max-width:300px; padding:20px; border:1px solid #ddd; background:#fff; border-radius:8px;">
                    ${currentSessionState.qrCodeSvg}
                </div>
                <p style="color:#666; font-size:12px;">Refreshes every 10 seconds automatically until linked.</p>
                <script>setTimeout(() => { window.location.reload(); }, 10000);</script>
            </div>
        `);
    }

    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Initializing Engine & Fetching QR...</h2>
            <script>setTimeout(() => { window.location.reload(); }, 4000);</script>
        </div>
    `);
});

app.post('/api/v1/send-lead', async (req, res) => {
    const { name, fullName, email, phone } = req.body;
    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing core identity details (name, email, or phone).' });
    }

    try {
        if (!currentSessionState.isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp backend not fully linked.' });
        }

        const randomSleepTime = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
        await delay(randomSleepTime);

        // Map payload fields cleanly
        let alertMessage = `🚨 *NEW WEBSITE LEAD RECEIVED* 🚨\n\n` +
                           `👤 *Customer Name:* ${finalName}\n` +
                           `📧 *Customer Email:* ${email}\n` +
                           `📞 *Customer Phone:* +${phone.replace(/\D/g, '')}\n`;

        const structuralFields = ['serviceType', 'eventType', 'date', 'time', 'venue', 'notes', 'message'];
        structuralFields.forEach(key => {
            if (req.body[key]) {
                alertMessage += `📝 *${key}:* ${req.body[key]}\n`;
            }
        });

        // SELF-MESSAGE WORKAROUND: Grabs the bot's own internal phone tracking ID directly from runtime state
        const selfChatId = client.info.wid._serialized;

        await client.sendMessage(selfChatId, alertMessage);
        return res.status(200).json({ success: true, message: 'Message successfully sent to yourself.' });
    } catch (err) {
        console.error("Internal dispatch exception:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    client.initialize();
});