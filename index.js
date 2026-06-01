const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// Helper function to simulate human-like variable delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

let currentSessionState = {
    pairingCode: null,
    isReady: false,
    initializationTarget: '31630645930' 
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

client.on('qr', async (qr) => {
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

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details (name, email, or phone).' });
    }

    const cleanDestinationNumber = phone.replace(/\D/g, ''); 
    const structuralChatId = `${cleanDestinationNumber}@c.us`;

    try {
        if (!currentSessionState.isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client session is not authenticated yet.' });
        }

        // --- ANTI-BAN HUMAN DELAY MECHANIC ---
        // Generates a random sleep timer between 3 to 7 seconds before triggering layout builds
        const randomSleepTime = Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;
        await delay(randomSleepTime);

        // Define header depending on layout context
        let headerText = '';
        if (serviceType) {
            headerText = `📩 *New ${serviceType.toUpperCase()} Inquiry*\n\n`;
        } else if (date || time || persons) {
            headerText = `📩 *Reservation Confirmation*\n\n`;
        } else {
            headerText = `📩 *Contact Form Submission*\n\n`;
        }

        let greetingText = `Hello ${finalName},\n\nThank you for choosing us. Get ready for great food, good vibes, and a wonderful time ahead!\n\n`;

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

        let bodyText = `👤 *Name:* ${finalName}\n` +
                       `📧 *Email:* ${email}\n` +
                       `📞 *Phone:* +${cleanDestinationNumber}\n`;

        fieldMap.forEach(field => {
            const value = req.body[field.key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                bodyText += `${field.label}: ${value}\n`;
            }
        });

        // --- ANTI-BAN DYNAMIC POLYSIGNATURE ---
        // Attaching a micro timestamp at the end tricks scanners tracking identical bulk strings
        let structuralFingerprint = `\n_Ref ID: ${Date.now().toString().slice(-6)}_\n`;
        let footerText = `\nSee you soon! 🍽️\nWarm regards,\nTeam Chopras${structuralFingerprint}`;
        
        const textTemplate = `${headerText}${greetingText}${bodyText}${footerText}`;

        // Send directly. Browser runtime gracefully fails to catch block if number is dead.
        await client.sendMessage(structuralChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Message routed successfully.' });
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