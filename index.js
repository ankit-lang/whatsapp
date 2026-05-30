const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

// Enable open Cross-Origin Resource Sharing (CORS) for your Vercel Next.js frontend
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Configure the WhatsApp client interface mapping inside the Docker workspace
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session_store' }),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium', // System level path inside debian-slim container
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

// Generate textual QR code arrays directly into the space application container logs
client.on('qr', (qr) => {
    console.log('============= ACCESS INITIALIZATION LOGS =============');
    console.log('SCAN THE REGISTRATION PATTERN MATRIX DEPLOYED BELOW:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp API Stream Hooked up and Monitoring Inputs.');
});

// Primary operational endpoint mapping
app.post('/api/v1/send-lead', async (req, res) => {
    const { name, email, phone, message } = req.body;

    if (!name || !email) {
        return res.status(400).json({ success: false, error: 'Missing baseline identity profiles.' });
    }

    // Set the specific destination phone number (Include full country code, no + or spaces)
    const targetDestinationNumber = "91XXXXXXXXXX"; 

    const textTemplate = `📩 *New Lead Captured*\n\n` +
                         `👤 *Name:* ${name}\n` +
                         `📧 *Email:* ${email}\n` +
                         `📞 *Phone:* ${phone || 'Not Left'}\n` +
                         `💬 *Message:* ${message || 'None'}`;

    try {
        const structuralChatId = `${targetDestinationNumber}@c.us`;
        await client.sendMessage(structuralChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Data transmitted to target console.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Root validation response route to let Hugging Face parameters pass health-checks
app.get('/', (res) => {
    res.send('WhatsApp System Online and Actively Listening.');
});

// Hugging Face strictly enforces internal pipeline tracking on port 7860
const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    client.initialize();
});