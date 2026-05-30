const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');


// 1. Initialize Express App
const app = express();
app.use(express.json());

let currentSessionState = {
    pairingCode: null,
    isReady: false,
    initializationTarget: '918178573528' // 👈 Set Lavina's absolute destination number (with country code, no symbols) here
};

// 2. Enable Cross-Origin Resource Sharing (CORS)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// 3. Configure Headless WhatsApp Puppeteer Subprocess
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

// Intercept pairing string sequence instead of parsing raw QR frames
client.on('qr', async (qr) => {
    // If we haven't fetched a pairing code yet, request it now
    if (!currentSessionState.pairingCode && !currentSessionState.isReady) {
        try {
            console.log(`🔄 Requesting Pairing string wrapper for: ${currentSessionState.initializationTarget}`);
            const code = await client.requestPairingCode(currentSessionState.initializationTarget);
            currentSessionState.pairingCode = code;
            console.log(`🔑 ACTIVE PAIRING CODE GENERATED: ${code}`);
        } catch (err) {
            console.error("❌ Failed to register fallback pairing token:", err);
        }
    }
});

client.on('ready', () => {
    currentSessionState.pairingCode = null;
    currentSessionState.isReady = true;
    console.log('✅ WhatsApp Stream Hooked up and Monitoring Inputs.');
});

// 4. Root HTML UI Dashboard Viewport Route (Optimized for Screen Share)
app.get('/', async (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ Client Authenticated</h1>
                <p>Your API Stream is online and waiting for inbound leads from your Next.js application.</p>
            </div>
        `);
    }

    if (currentSessionState.pairingCode) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:50px; background-color: #f7f9fa; padding: 30px;">
                <h1 style="color:#128C7E; font-size: 28px;">Link with WhatsApp Code</h1>
                <p style="font-size: 16px; color: #333;">Open WhatsApp on phone &rarr; <b>Settings</b> &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b></p>
                <p style="color: #555; margin-bottom: 25px;">Tap <b>"Link with phone number instead"</b> at the bottom of your phone screen and type this code:</p>
                
                <div style="margin: 20px auto; padding: 20px 40px; background:#fff; display:inline-block; border-radius:12px; box-shadow: 0 4px 15px rgba(0,0,0,0.15); border: 2px dashed #128C7E;">
                    <span style="font-family:monospace; font-size:42px; font-weight:bold; letter-spacing:5px; color:#333;">${currentSessionState.pairingCode}</span>
                </div>
                
                <p style="color:#666; font-size:13px; margin-top: 30px;">This dashboard updates automatically. Page auto-refreshes every 10 seconds.</p>
                <script>
                    setTimeout(() => { window.location.reload(); }, 10000);
                </script>
            </div>
        `);
    }

    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Requesting Verification Pairing Code...</h2>
            <p>Spinning up background Chromium subprocess. This screen refreshes automatically.</p>
            <script>
                setTimeout(() => { window.location.reload(); }, 4000);
            </script>
        </div>
    `);
});

// 5. Shared Multi-Form Routing POST Endpoint
app.post('/api/v1/send-lead', async (req, res) => {
    const { 
        name, fullName, email, phone, 
        date, time, persons, foundVia, dob, notes, 
        subject, message                            
    } = req.body;

    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details (name, email, or phone).' });
    }

    const cleanDestinationNumber = phone.replace(/\D/g, ''); 
    const structuralChatId = `${cleanDestinationNumber}@c.us`;

    try {
        if (!currentSessionState.isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client session is not authenticated yet.' });
        }

        const isRegistered = await client.isRegisteredUser(structuralChatId);
        if (!isRegistered) {
            console.log(`⚠️ Number ${cleanDestinationNumber} is not active on WhatsApp.`);
            return res.status(400).json({ success: false, error: 'Thee provided phone number is not active on WhatsApp.' });
        }

        let textTemplate = '';

        if (date || time || persons) {
            textTemplate = `📩 *Reservation Confirmation*\n\n` +
                           `Hello ${finalName},\n\n` +
                           `Thank you for choosing us. Get ready for great food, good vibes, and a wonderful time ahead! See you soon!:\n\n` +
                           `👤 *Name:* ${finalName}\n` +
                           `📧 *Email:* ${email}\n` +
                           `📞 *Phone:* +${cleanDestinationNumber}\n` +
                           `🗓️ *Date:* ${date}\n` +
                           `⏰ *Time:* ${time}\n` +
                           `👥 *Persons:* ${persons}\n` +
                           `🎂 *DOB:* ${dob || 'N/A'}\n` +
                           `🔍 *Found Via:* ${foundVia || 'N/A'}\n` +
                           `📝 *Special Requests:* ${notes || 'None'}\n\n` +
                           `See you soon! 🍽️`;
        } else {
            textTemplate = `📩 *Contact Form Submission*\n\n` +
                           `Hello ${finalName},\n\n` +
                           `Thank you for choosing us. Get ready for great food, good vibes, and a wonderful time ahead!\n\n` +
                           `👤 *Name:* ${finalName}\n` +
                           `📧 *Email:* ${email}\n` +
                           `📞 *Phone:* +${cleanDestinationNumber}\n` +
                           `📌 *Subject:* ${subject || 'No Subject'}\n` +
                           `💬 *Message:* ${message || 'No Message'}\n\n` +
                           `We will revert to you shortly.\n\n` +
                           `Warm regards,\n` +
                           `Team Chopras`;
        }

        await client.sendMessage(structuralChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Message routed successfully.' });
    } catch (err) {
        console.error("Internal sending error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Bind to Hugging Face Container Allocation Port
const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    client.initialize();
});