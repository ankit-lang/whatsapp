const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// Memory store to keep track of current machine states
let currentSessionState = {
    qrRawString: null,
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
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// Cache the latest token string when WhatsApp refreshes authorization
client.on('qr', (qr) => {
    currentSessionState.qrRawString = qr;
    currentSessionState.isReady = false;
    console.log('🔄 New WhatsApp Link string cached.');
});

client.on('ready', () => {
    currentSessionState.qrRawString = null;
    currentSessionState.isReady = true;
    console.log('✅ WhatsApp Stream Hooked up and Monitoring Inputs.');
});

// Root HTML UI rendering path for Hugging Face Viewport
app.get('/', async (req, res) => {
    // Scenario A: Client setup is complete
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ Client Authenticated</h1>
                <p>Your API Stream is online and waiting for inbound leads from your Next.js application.</p>
            </div>
        `);
    }

    // Scenario B: Waiting for initialization scan
    if (currentSessionState.qrRawString) {
        try {
            const dataUrlImg = await QRCode.toDataURL(currentSessionState.qrRawString, { width: 350, margin: 2 });
            return res.send(`
                <div style="font-family:sans-serif; text-align:center; margin-top:50px;">
                    <h1 style="color:#128C7E;">Scan to Link WhatsApp</h1>
                    <p>Open WhatsApp > Linked Devices > Link a Device</p>
                    <div style="margin: 30px auto; padding: 15px; background:white; display:inline-block; border-radius:10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        <img src="${dataUrlImg}" alt="Scan Me" />
                    </div>
                    <p style="color:#666; font-size:13px;">This dashboard updates automatically. Page auto-refreshes every 5 seconds.</p>
                    <script>
                        setTimeout(() => { window.location.reload(); }, 5000);
                    </script>
                </div>
            `);
        } catch (err) {
            return res.status(500).send("Failed to construct matrix graphics.");
        }
    }

    // Scenario C: Booting runtime containers
    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Initializing Engine Environment...</h2>
            <p>Spinning up background Chromium subprocess. This screen refreshes automatically.</p>
            <script>
                setTimeout(() => { window.location.reload(); }, 3000);
            </script>
        </div>
    `);
});

app.post('/api/v1/send-lead', async (req, res) => {
    const { name, email, phone, message } = req.body;

    if (!name || !email) {
        return res.status(400).json({ success: false, error: 'Missing baseline identity profiles.' });
    }

    const targetDestinationNumber = "918178573528"; // Change to your active number

    const textTemplate = `📩 *New Lead Captured*\n\n` +
                         `👤 *Name:* ${name}\n` +
                         `📧 *Email:* ${email}\n` +
                         `📞 *Phone:* ${phone || 'Not Left'}\n` +
                         `💬 *Message:* ${message || 'None'}`;

    try {
        const structuralChatId = `${targetDestinationNumber}@c.us`;
        await client.sendMessage(structuralChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Data transmitted successfully.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    client.initialize();
});