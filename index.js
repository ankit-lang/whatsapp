const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

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

// Converts the raw QR code text into an SVG string to display in the browser
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
    console.log('✅ WhatsApp Stream Hooked up and Monitoring Inputs.');
});

app.get('/', async (req, res) => {
    if (currentSessionState.isReady) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
                <h1 style="color:#25D366;">✅ Client Authenticated</h1>
                <p>Your API Stream is online and waiting for inbound leads from your Next.js application.</p>
            </div>
        `);
    }

    if (currentSessionState.qrCodeSvg) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
                <h1 style="color:#128C7E; font-size: 28px;">Scan WhatsApp QR Code</h1>
                <p style="font-size: 16px; color: #333;">Open WhatsApp on phone &rarr; <b>Settings</b> &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b></p>
                
                <div style="margin:20px auto; max-width:300px; padding:20px; border:1px solid #ddd; background:#fff; border-radius:12px; box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
                    ${currentSessionState.qrCodeSvg}
                </div>
                
                <p style="color:#666; font-size:13px; margin-top: 30px;">The QR code is stable. Refresh the browser manually only if the scan fails.</p>
            </div>
        `);
    }

    return res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
            <h2>⏳ Requesting Verification QR Code...</h2>
            <p>Spinning up background Chromium subprocess. This screen refreshes automatically.</p>
            <script>
                setTimeout(() => { window.location.reload(); }, 4000);
            </script>
        </div>
    `);
});

app.post('/api/v1/send-lead', async (req, res) => {
    const { 
        name, fullName, email, phone, 
        date, time, persons, foundVia, dob, notes, 
        subject, message, serviceType, eventType,
        eventDate, eventTime, preferredTiming, numGuests,
        venue, kitchenSetup, vegNonVeg, dietaryRequirements,
        cateringType, staffRequired, crockeryRequired
    } = req.body;

    const finalName = name || fullName;

    // Validate core form inputs
    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details (name, email, or phone).' });
    }

    try {
        if (!currentSessionState.isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client session is not authenticated yet.' });
        }

        const randomSleepTime = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
        await delay(randomSleepTime);

        let headerText = `🚨 *NEW WEBSITE LEAD RECEIVED* 🚨\n\n`;

        const fieldMap = [
            { key: 'serviceType', label: '🛠️ *Service Type*' },
            { key: 'eventType', label: '🎉 *Event Type*' },
            { key: 'date', label: '🗓️ *Date*' },
            { key: 'eventDate', label: '🗓️ *Event Date*' },
            { key: 'time', label: '⏰ *Time*' },
            { key: 'eventTime', label: '⏰ *Event Time*' },
            { key: 'preferredTiming', label: '⏱️ *Preferred Timing*' },
            { key: 'persons', label: '👥 *Persons*' },
            { key: 'numGuests', label: '👥 *Number of Guests*' },
            { key: 'venue', label: '📍 *Venue Location*' },
            { key: 'kitchenSetup', label: '🍳 *Kitchen Setup*' },
            { key: 'vegNonVeg', label: '🥗 *Food Preference*' },
            { key: 'cateringType', label: '🍽️ *Catering Type*' },
            { key: 'dietaryRequirements', label: '⚠️ *Dietary Requirements*' },
            { key: 'staffRequired', label: '🧑‍🍳 *Staff Required*' },
            { key: 'crockeryRequired', label: '🍽️ *Crockery Required*' },
            { key: 'dob', label: '🎂 *DOB*' },
            { key: 'foundVia', label: '🔍 *Found Via*' },
            { key: 'subject', label: '📌 *Subject*' },
            { key: 'notes', label: '📝 *Special Requests*' },
            { key: 'message', label: '💬 *Message*' }
        ];

        let bodyText = `👤 *Customer Name:* ${finalName}\n` +
                       `📧 *Customer Email:* ${email}\n` +
                       `📞 *Customer Phone:* +${phone.replace(/\D/g, '')}\n`;

        fieldMap.forEach(field => {
            const value = req.body[field.key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                bodyText += `${field.label}: ${value}\n`;
            }
        });

        let structuralFingerprint = `\n_Lead Tracking ID: ${Date.now().toString().slice(-6)}_\n`;
        let footerText = `${structuralFingerprint}`;
        
        const textTemplate = `${headerText}${bodyText}${footerText}`;

        // TARGET FOR SELF-MESSAGE: Automatically targets the connected account's unique chat ID
        const selfChatId = client.info.wid._serialized;

        await client.sendMessage(selfChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Internal client alert sent successfully to yourself.' });
    } catch (err) {
        console.error("Internal sending error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const APP_PORT = 7860;
app.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${APP_PORT}`);
    client.initialize();
});