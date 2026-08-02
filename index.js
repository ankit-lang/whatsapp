const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());

// Custom HTTPS agent to resolve OpenSSL / TLS handshake errors (EPROTO / SSL alert number 0) on cloud containers
const customAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    rejectUnauthorized: false
});

const SESSION_DIR = path.join(__dirname, 'session_store');
const CONNECT_TIMEOUT_MS = Number(process.env.BAILEYS_CONNECT_TIMEOUT_MS || 120000);
const QUERY_TIMEOUT_MS = Number(process.env.BAILEYS_QUERY_TIMEOUT_MS || 120000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.BAILEYS_MAX_RECONNECT_DELAY_MS || 60000);

// Restore session from SESSION_BASE64 environment variable if session_store does not already exist or is missing creds.json
function restoreSessionFromEnv() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        const envSession = process.env.SESSION_BASE64 || process.env.SESSION_DATA;
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        const sessionFiles = fs.existsSync(SESSION_DIR)
            ? fs.readdirSync(SESSION_DIR).filter(file => fs.statSync(path.join(SESSION_DIR, file)).isFile())
            : [];

        if (!envSession) {
            return;
        }

        if (sessionFiles.length > 0 && fs.existsSync(credsFile)) {
            console.log('✅ SESSION_BASE64 found, but existing session_store already contains saved credentials. Using current session_store files.');
            return;
        }

        console.log('📦 Restoring WhatsApp session credentials from SESSION_BASE64 environment variable...');
        const buffer = Buffer.from(envSession, 'base64');
        const jsonStr = buffer.toString('utf-8');

        // Check if it's a single creds.json content or multi-file JSON bundle
        try {
            const parsed = JSON.parse(jsonStr);
            if (parsed['creds.json']) {
                // Multi-file bundle object
                for (const [filename, content] of Object.entries(parsed)) {
                    fs.writeFileSync(path.join(SESSION_DIR, filename), typeof content === 'string' ? content : JSON.stringify(content));
                }
            } else {
                // Single creds.json file
                fs.writeFileSync(credsFile, jsonStr);
            }
            console.log('✅ WhatsApp session restored successfully from environment variable!');
        } catch (parseErr) {
            fs.writeFileSync(credsFile, jsonStr);
            console.log('✅ WhatsApp creds.json written from environment variable!');
        }
    } catch (err) {
        console.error('⚠️ Failed to restore session from env:', err.message);
    }
}

// Function to get current session state as Base64 for deployment persistent storage
function exportSessionToBase64() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return null;
        const files = fs.readdirSync(SESSION_DIR);
        const bundle = {};
        for (const file of files) {
            const filePath = path.join(SESSION_DIR, file);
            if (fs.statSync(filePath).isFile()) {
                bundle[file] = fs.readFileSync(filePath, 'utf-8');
            }
        }
        return Buffer.from(JSON.stringify(bundle)).toString('base64');
    } catch (err) {
        console.error('Error exporting session:', err.message);
        return null;
    }
}

let sock;
let currentSessionState = {
    qrCodeSvg: null,
    isReady: false
};
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

function calculateReconnectDelay(attempt) {
    const baseDelayMs = 5000;
    return Math.min(baseDelayMs * (2 ** attempt), MAX_RECONNECT_DELAY_MS);
}

function scheduleReconnect(reason) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    const delay = calculateReconnectDelay(reconnectAttempts);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
    console.log(`🔁 Scheduling reconnect in ${delay / 1000}s due to ${reason}`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToWhatsApp();
    }, delay);
}

function buildLeadMessage(body = {}) {
    const finalName = body.name || body.fullName || body.customerName || body.contactName || 'Unknown';
    const email = body.email || body.customerEmail || 'N/A';
    const phone = body.phone || body.mobile || body.phoneNumber || '';
    const normalizedPhone = phone.replace(/\D/g, '');

    let bodyText = `🚨 *NEW WEBSITE LEAD RECEIVED* 🚨\n\n` +
        `👤 *Customer Name:* ${finalName}\n` +
        `📧 *Customer Email:* ${email}\n` +
        `📞 *Customer Phone:* ${normalizedPhone ? `+${normalizedPhone}` : 'N/A'}\n`;

    const fieldMap = [
        { key: 'serviceType', label: '🛠️ *Service Type*' },
        { key: 'eventType', label: '🎉 *Event Type*' },
        { key: 'eventDate', label: '🗓️ *Event Date*' },
        { key: 'numGuests', label: '👥 *Guests*' },
        { key: 'venue', label: '📍 *Venue*' },
        { key: 'message', label: '💬 *Message*' }
    ];

    fieldMap.forEach(field => {
        const value = body[field.key] ?? body[field.key.toUpperCase()] ?? body[`reservation_${field.key}`];
        if (value) bodyText += `${field.label}: ${value}\n`;
    });

    const extraFields = [
        ['reservationType', '🧾 *Reservation Type*'],
        ['checkoutType', '🛒 *Checkout Type*'],
        ['notes', '📝 *Notes*']
    ];

    extraFields.forEach(([key, label]) => {
        const value = body[key] ?? body[key.toUpperCase()] ?? body[`reservation_${key}`];
        if (value) bodyText += `${label}: ${value}\n`;
    });

    return {
        finalName,
        email,
        phone: normalizedPhone,
        bodyText
    };
}

async function sendLeadNotification(body = {}) {
    if (!currentSessionState.isReady || !sock) {
        throw new Error('WhatsApp is not connected yet.');
    }

    const { finalName, email, phone, bodyText } = buildLeadMessage(body);

    const selfJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    await sock.sendMessage(selfJid, { text: bodyText });
    console.log(`📩 Lead message sent successfully to WhatsApp for ${finalName} (${email})`);

    return {
        success: true,
        finalName,
        email,
        phone,
        whatsappMessage: bodyText
    };
}

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

async function connectToWhatsApp() {
    if (isConnecting) {
        console.log('⏳ Connection attempt already in progress; skipping duplicate connect request.');
        return;
    }

    isConnecting = true;
    restoreSessionFromEnv();

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        // Quick fallback version to prevent HF network delays
        let version = [2, 3000, 1015901307];
        try {
            const latest = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]);
            if (latest && latest.version) version = latest.version;
        } catch (e) {
            console.log('ℹ️ Using default Baileys version for fast connection handshake.');
        }

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '110.0.5563.146'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
            defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
            qrTimeout: CONNECT_TIMEOUT_MS,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
            maxMsgRetryCount: 8,
            agent: customAgent,
            fetchAgent: customAgent,
            options: {
                agent: customAgent,
                rejectUnauthorized: false,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
                    'Origin': 'https://web.whatsapp.com'
                }
            }
        });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const sessionB64 = exportSessionToBase64();
        if (sessionB64) {
            console.log('\n💡 [PERSISTENCE NOTICE] Save this SESSION_BASE64 in your HF Space / Docker secrets to auto-login on redeployment:');
            console.log(`SESSION_BASE64="${sessionB64.substring(0, 40)}... (Length: ${sessionB64.length})"\n`);
        }
    });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n🔄 New QR Code generated!');
                console.log(`📱 Open your Hugging Face Space app URL to scan the QR Code!\n`);
                currentSessionState.qrCodeSvg = await QRCode.toString(qr, { type: 'svg', margin: 2 });
                currentSessionState.isReady = false;
            }

            if (connection === 'open') {
                isConnecting = false;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp Connected successfully via Baileys!');
                currentSessionState.qrCodeSvg = null;
                currentSessionState.isReady = true;

                const sessionB64 = exportSessionToBase64();
                if (sessionB64) {
                    console.log('🔐 [SESSION BACKUP GENERATED] Copy this Base64 string into your SESSION_BASE64 environment variable so your deployment NEVER logs out:\n');
                    console.log(sessionB64);
                    console.log('\n------------------------------------------------------------\n');
                }
            }

            if (connection === 'close') {
                isConnecting = false;
                currentSessionState.isReady = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'Unknown Disconnect';
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`⚠️ Connection closed. Reason: ${reason} (Code: ${statusCode}). Reconnecting: ${!isLoggedOut}`);

                if (isLoggedOut) {
                    console.log('❌ Device was manually logged out from WhatsApp. Clear session_store to re-scan QR code.');
                } else {
                    scheduleReconnect(reason);
                }
            }
        });
    } catch (err) {
        isConnecting = false;
        console.error('❌ Failed to initialize Baileys connection:', err.message);
        scheduleReconnect(err.message);
    }
}

// Web UI to view QR Code or Session Export
app.get('/', (req, res) => {
    if (currentSessionState.isReady) {
        const sessionB64 = exportSessionToBase64();
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:60px; padding:20px;">
                <h1 style="color:#25D366;">✅ WhatsApp Connected</h1>
                <p>Baileys WebSocket engine is online and active.</p>
                <div style="margin-top:30px; background:#f5f5f5; padding:15px; border-radius:8px; display:inline-block; max-width:800px; text-align:left; overflow-x:auto;">
                    <h3>🔐 Persistent Session Key (For Deployment):</h3>
                    <p style="font-size:13px; color:#555;">Set an Environment Variable named <code>SESSION_BASE64</code> with the value below in Hugging Face / Docker settings to prevent logging out on restart:</p>
                    <textarea readonly style="width:100%; height:120px; font-family:monospace; font-size:11px; padding:8px;" onclick="this.select()">${sessionB64 || 'Generating...'}</textarea>
                </div>
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
                <p style="color:#666;">Scan using WhatsApp > Linked Devices</p>
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

// Simple health endpoint for deployment platforms such as Render
app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        ready: currentSessionState.isReady,
        qrAvailable: !!currentSessionState.qrCodeSvg,
        timestamp: new Date().toISOString()
    });
});

app.get('/checkout-demo', (req, res) => {
    res.sendFile(path.join(__dirname, 'checkout-demo.html'));
});

// Endpoint to send website lead alerts
app.post('/api/v1/send-lead', async (req, res) => {
    const { name, fullName, email, phone } = req.body;
    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details.' });
    }

    try {
        const result = await sendLeadNotification(req.body);
        return res.status(200).json({
            success: true,
            message: 'Lead sent successfully.',
            whatsappMessage: result.whatsappMessage
        });
    } catch (err) {
        console.error('Error sending message:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/v1/contact-reservation-checkout', async (req, res) => {
    try {
        const result = await sendLeadNotification(req.body);
        return res.status(200).json({
            success: true,
            message: 'Reservation checkout message sent successfully.',
            whatsappMessage: result.whatsappMessage
        });
    } catch (err) {
        console.error('Error sending checkout message:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 7860;

// Built-in Self-Ping Keep-Alive system (Prevents server from sleeping)
function startKeepAlive() {
    setInterval(() => {
        const appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
        const httpLib = appUrl.startsWith('https') ? require('https') : require('http');
        httpLib.get(appUrl, (res) => {
            console.log(`⏰ Self-Ping Keep-Alive pinged ${appUrl} (Status: ${res.statusCode})`);
        }).on('error', (err) => {
            console.log('⏰ Self-Ping check:', err.message);
        });
    }, 4 * 60 * 1000); // Pings every 4 minutes
}

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 API Container active on port ${PORT}`);
        connectToWhatsApp();
        startKeepAlive();
    });
}

module.exports = {
    app,
    connectToWhatsApp,
    calculateReconnectDelay,
    buildLeadMessage,
    sendLeadNotification,
    exportSessionToBase64,
    restoreSessionFromEnv
};