const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let sock;
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

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./session_store');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chopras Lead Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('🔄 New QR Code generated.');
            currentSessionState.qrCodeSvg = await QRCode.toString(qr, { type: 'svg', margin: 2 });
            currentSessionState.isReady = false;
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Connected successfully via Baileys!');
            currentSessionState.qrCodeSvg = null;
            currentSessionState.isReady = true;
        }

        if (connection === 'close') {
            currentSessionState.isReady = false;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        }
    });
}

// Web UI to view QR Code
app.get('/', (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ WhatsApp Connected</h1>
                <p>Baileys WebSocket engine is online and monitoring leads.</p>
            </div>
        `);
    }

    if (currentSessionState.qrCodeSvg) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
                <h1 style="color:#128C7E;">Scan WhatsApp QR Code</h1>
                <div style="margin:20px auto; max-width:300px; padding:20px; border:1px solid #ddd; background:#fff; border-radius:12px;">
                    ${currentSessionState.qrCodeSvg}
                </div>
            </div>
        `);
    }

    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Initializing WhatsApp Engine...</h2>
            <script>setTimeout(() => { window.location.reload(); }, 3000);</script>
        </div>
    `);
});

// Endpoint to send website lead alerts
app.post('/api/v1/send-lead', async (req, res) => {
    const { name, fullName, email, phone } = req.body;
    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details.' });
    }

    if (!currentSessionState.isReady || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp is not connected yet.' });
    }

    try {
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
            if (req.body[field.key]) bodyText += `${field.label}: ${req.body[field.key]}\n`;
        });

        // Send to your own WhatsApp account
        const selfJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        await sock.sendMessage(selfJid, { text: bodyText });

        return res.status(200).json({ success: true, message: 'Lead sent successfully.' });
    } catch (err) {
        console.error('Error sending message:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = 7860;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${PORT}`);
    connectToWhatsApp();
});