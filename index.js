const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// 1. Initialize Express App (Fixes the "app is not defined" error)
const app = express();
app.use(express.json());

let currentSessionState = {
    qrRawString: null,
    isReady: false
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
// Configure a highly stable, multi-process Chromium layout for Docker environments
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
            // ❌ REMOVED '--single-process' to prevent container thread execution crashes
        ]
    }
});

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

// 4. Root HTML UI Dashboard Viewport Route
app.get('/', async (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ Client Authenticated</h1>
                <p>Your API Stream is online and waiting for inbound leads from your Next.js application.</p>
            </div>
        `);
    }

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
        const isRegistered = await client.isRegisteredUser(structuralChatId);
        if (!isRegistered) {
            console.log(`⚠️ Number ${cleanDestinationNumber} is not active on WhatsApp.`);
            return res.status(400).json({ success: false, error: 'The provided phone number is not active on WhatsApp.' });
        }

        let textTemplate = '';

        if (date || time || persons) {
            // Layout Structure for Form 1: Reservations
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
            // Layout Structure for Form 2: Generic Contact
            textTemplate = `📩 *Contact Form Submission*\n\n` +
                           `Hello ${finalName},\n\n` +
                           `Thank you for choosing us. Get ready for great food, good vibes, and a wonderful time ahead! See you soon!\n\n` +
                           `👤 *Name:* ${finalName}\n` +
                           `📧 *Email:* ${email}\n` +
                           `📞 *Phone:* +${cleanDestinationNumber}\n` +
                           `📌 *Subject:* ${subject || 'No Subject'}\n` +
                           `💬 *Message:* ${message || 'No Message'}\n\n` +
                           `See You Soon! 💬`;
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