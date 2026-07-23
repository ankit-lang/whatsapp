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

// Restore session from SESSION_BASE64 environment variable if directory is missing or empty
function restoreSessionFromEnv() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }
        
        const envSession = process.env.SESSION_BASE64 || process.env.SESSION_DATA;
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        
        if (envSession && !fs.existsSync(credsFile)) {
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

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

async function connectToWhatsApp() {
    restoreSessionFromEnv();

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
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        qrTimeout: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 5,
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
            currentSessionState.isReady = false;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'Unknown Disconnect';
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            
            console.log(`⚠️ Connection closed. Reason: ${reason} (Code: ${statusCode}). Reconnecting: ${!isLoggedOut}`);
            
            if (isLoggedOut) {
                console.log('❌ Device was manually logged out from WhatsApp. Clear session_store to re-scan QR code.');
            } else {
                // Reconnect automatically after 5s for Hugging Face network handshakes
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Container active on port ${PORT}`);
    connectToWhatsApp();
    startKeepAlive();
});