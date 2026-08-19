const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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
let skipSessionRestoreFromEnv = false;

function resetSessionIfRequested() {
    if (process.env.RESET_SESSION !== 'true') {
        return false;
    }

    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    skipSessionRestoreFromEnv = true;
    delete process.env.RESET_SESSION;
    console.log('🧹 WhatsApp session cleared. A new QR code will be generated.');
    return true;
}

// Restore session from SESSION_BASE64 environment variable if session_store does not already exist or is missing creds.json
function restoreSessionFromEnv() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        if (skipSessionRestoreFromEnv) {
            return;
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

function normalizePhoneNumber(phone) {
    if (!phone) return '';
    return String(phone).replace(/\D/g, '');
}

let sock;
let currentSessionState = {
    qrCodeSvg: null,
    pairingCode: null,
    pairingPhone: null,
    pairingError: null,
    isReady: false
};
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

async function requestPairingCode(phoneNumber) {
    const cleanPhone = normalizePhoneNumber(phoneNumber);
    if (!cleanPhone) {
        throw new Error('Please provide a valid phone number with country code (e.g. 918178573528 or 31612345678).');
    }

    // Re-initialize socket connection if missing or not open
    if (!sock || !sock.ws || sock.ws.readyState !== 1) {
        console.log('🔄 Re-initializing WhatsApp socket connection for pairing code request...');
        isConnecting = false;
        await connectToWhatsApp();
        await new Promise(r => setTimeout(r, 2000));
    }

    if (sock?.authState?.creds?.registered) {
        throw new Error('WhatsApp is already registered and connected!');
    }

    try {
        const rawCode = await sock.requestPairingCode(cleanPhone);
        const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        currentSessionState.pairingCode = formattedCode;
        currentSessionState.pairingPhone = cleanPhone;
        currentSessionState.pairingError = null;
        console.log(`📱 Pairing Code generated for ${cleanPhone}: ${formattedCode}`);
        return formattedCode;
    } catch (err) {
        console.error('❌ Failed to request pairing code:', err.message);

        // Auto-retry with a fresh socket connection if closed/disconnected
        if (err.message.includes('Closed') || err.message.includes('disconnect') || err.message.includes('not connected') || err.message.includes('timed out')) {
            console.log('🔄 Retrying pairing code request with fresh Baileys connection...');
            isConnecting = false;
            await connectToWhatsApp();
            await new Promise(r => setTimeout(r, 2500));
            if (sock && !sock.authState?.creds?.registered) {
                const retryRaw = await sock.requestPairingCode(cleanPhone);
                const retryCode = retryRaw?.match(/.{1,4}/g)?.join('-') || retryRaw;
                currentSessionState.pairingCode = retryCode;
                currentSessionState.pairingPhone = cleanPhone;
                currentSessionState.pairingError = null;
                console.log(`📱 Pairing Code generated on retry for ${cleanPhone}: ${retryCode}`);
                return retryCode;
            }
        }

        currentSessionState.pairingError = err.message;
        throw err;
    }
}

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
    const normalizedPhone = normalizePhoneNumber(phone);

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
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
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

        // Latest Baileys WhatsApp Web version fallback
        let version = [2, 3000, 1043857760];
        try {
            const latest = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
            if (latest && latest.version) version = latest.version;
        } catch (e) {
            console.log('ℹ️ Using latest fallback Baileys version for fast connection handshake.');
        }

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
            defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
            qrTimeout: CONNECT_TIMEOUT_MS,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
            maxMsgRetryCount: 8
        });

        if (!sock.authState?.creds?.registered && process.env.PAIRING_PHONE_NUMBER) {
            setTimeout(async () => {
                try {
                    console.log(`📱 Requesting automatic pairing code for ${process.env.PAIRING_PHONE_NUMBER}...`);
                    await requestPairingCode(process.env.PAIRING_PHONE_NUMBER);
                } catch (err) {
                    console.error('⚠️ Automatic pairing code request failed:', err.message);
                }
            }, 3000);
        }

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            const sessionB64 = exportSessionToBase64();
            if (sessionB64) {
                console.log('\n💡 [PERSISTENCE NOTICE] Save this SESSION_BASE64 in your Render / Docker secrets to auto-login on redeployment:');
                console.log(`SESSION_BASE64="${sessionB64.substring(0, 40)}... (Length: ${sessionB64.length})"\n`);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                isConnecting = false;
                console.log('\n🔄 New QR Code generated!');
                console.log(`📱 Open your app URL to scan the QR Code or request a Pairing Code!\n`);
                currentSessionState.qrCodeSvg = await QRCode.toString(qr, { type: 'svg', margin: 2 });
                currentSessionState.isReady = false;
            }

            if (connection === 'open') {
                isConnecting = false;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp Connected successfully via Baileys!');
                currentSessionState.qrCodeSvg = null;
                currentSessionState.pairingCode = null;
                currentSessionState.pairingPhone = null;
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
                    console.log('🧹 Session logged out / invalidated (Code 401). Automatically clearing session_store to allow fresh login...');
                    try {
                        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    currentSessionState.pairingCode = null;
                    currentSessionState.pairingPhone = null;
                    currentSessionState.qrCodeSvg = null;
                    reconnectAttempts = 0;
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 1000);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log('🔄 Restart required by WhatsApp. Reconnecting immediately...');
                    connectToWhatsApp();
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

// Web UI Dashboard to Pair by Code, Scan QR Code, and Copy SESSION_BASE64
app.get('/', (req, res) => {
    const sessionB64 = exportSessionToBase64() || '';
    const currentAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://127.0.0.1:${PORT}`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Gateway - Control Center</title>
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-card: #1e293b;
            --bg-input: #090d16;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-green: #22c55e;
            --accent-cyan: #06b6d4;
            --accent-blue: #3b82f6;
            --border-color: #334155;
            --card-radius: 16px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        body { background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; padding: 24px 16px; }
        .container { max-width: 900px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 32px; }
        .header h1 { font-size: 2rem; font-weight: 700; color: #fff; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 9999px; font-weight: 600; font-size: 0.9rem; margin-top: 8px; }
        .status-online { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
        .status-offline { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--card-radius); padding: 24px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3); }
        .card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
        .card-header h2 { font-size: 1.25rem; color: #fff; }
        .badge { background: #3b82f620; color: #60a5fa; padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
        .badge-success { background: #22c55e20; color: #4ade80; }
        .input-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
        label { font-size: 0.875rem; color: var(--text-secondary); }
        input[type="text"] { background: var(--bg-input); border: 1px solid var(--border-color); color: #fff; padding: 12px 16px; border-radius: 8px; font-size: 1rem; outline: none; width: 100%; }
        input[type="text"]:focus { border-color: var(--accent-cyan); box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2); }
        button { background: linear-gradient(135deg, #059669, #10b981); color: #fff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; font-size: 1rem; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; }
        button:hover { opacity: 0.95; transform: translateY(-1px); }
        button:active { transform: translateY(0); }
        .btn-secondary { background: #334155; color: #fff; }
        .btn-secondary:hover { background: #475569; }
        .pairing-code-box { background: #090d16; border: 2px dashed #059669; border-radius: 12px; padding: 20px; text-align: center; margin-top: 16px; }
        .pairing-code { font-size: 2.2rem; font-family: monospace; font-weight: 700; letter-spacing: 6px; color: #34d399; margin: 12px 0; }
        .instructions { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; margin-top: 12px; text-align: left; }
        .instructions ol { padding-left: 20px; }
        .instructions li { margin-bottom: 4px; }
        .qr-box { background: #fff; padding: 16px; border-radius: 12px; text-align: center; margin: 16px auto; max-width: 260px; }
        .qr-box svg { max-width: 100%; height: auto; display: block; }
        .session-textarea { width: 100%; height: 120px; background: var(--bg-input); border: 1px solid var(--border-color); color: #34d399; font-family: monospace; font-size: 0.75rem; padding: 12px; border-radius: 8px; resize: none; margin-bottom: 12px; }
        .alert { background: rgba(59, 130, 246, 0.1); border-left: 4px solid var(--accent-blue); padding: 12px; border-radius: 6px; font-size: 0.85rem; margin-top: 12px; color: #cbd5e1; }
        .alert-success { background: rgba(34, 197, 94, 0.1); border-left-color: var(--accent-green); color: #86efac; }
        .alert-warning { background: rgba(245, 158, 11, 0.1); border-left-color: #f59e0b; color: #fde047; }
        .copy-btn { font-size: 0.85rem; padding: 8px 16px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>💬 WhatsApp Gateway Control Center</h1>
            <div id="status-badge" class="status-badge status-offline">
                <span id="status-dot">🟡</span> <span id="status-text">Checking connection...</span>
            </div>
        </div>

        <div class="grid">
            <!-- Pairing Code Card -->
            <div class="card">
                <div class="card-header">
                    <h2>📲 Pair by Phone Code</h2>
                    <span class="badge badge-success">Recommended</span>
                </div>
                <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:16px;">
                    Pairing code gives you extra time to link your device without expiring fast like QR codes!
                </p>
                <div id="pair-form-container">
                    <div class="input-group">
                        <label for="phoneNumber">Mobile Number with Country Code (No + or spaces)</label>
                        <input type="text" id="phoneNumber" placeholder="e.g. 919876543210 or 31612345678" value="${currentSessionState.pairingPhone || ''}">
                    </div>
                    <button id="btn-request-code" onclick="handlePairRequest()">Get Pairing Code 📲</button>
                    <div id="pair-error" style="color:#ef4444; font-size:0.85rem; margin-top:8px; display:none;"></div>
                </div>

                <div id="pairing-code-display" class="pairing-code-box" style="${currentSessionState.pairingCode ? '' : 'display:none;'}">
                    <div style="font-size:0.85rem; color:var(--text-secondary);">Your WhatsApp Pairing Code:</div>
                    <div id="pairing-code-value" class="pairing-code">${currentSessionState.pairingCode || '---- - ----'}</div>
                    <button class="copy-btn btn-secondary" onclick="copyText(document.getElementById('pairing-code-value').innerText.replace(/\s+/g, ''))">📋 Copy Code</button>
                    <div class="instructions">
                        <strong>Steps to link on your phone:</strong>
                        <ol>
                            <li>Open <strong>WhatsApp</strong> on your phone</li>
                            <li>Tap <strong>Settings</strong> (or 3 dots) &gt; <strong>Linked Devices</strong></li>
                            <li>Tap <strong>Link a Device</strong></li>
                            <li>Tap <strong>Link with phone number instead</strong></li>
                            <li>Enter the 8-digit code shown above</li>
                        </ol>
                    </div>
                </div>
            </div>

            <!-- QR Code Card -->
            <div class="card">
                <div class="card-header">
                    <h2>📷 Pair by QR Code</h2>
                    <span class="badge">Alternative</span>
                </div>
                <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:12px;">
                    Scan directly from WhatsApp linked devices scanner.
                </p>
                <div id="qr-container">
                    ${currentSessionState.qrCodeSvg ? `<div class="qr-box">${currentSessionState.qrCodeSvg}</div>` : `<div style="text-align:center; padding:30px; color:var(--text-secondary);">Waiting for QR Code...</div>`}
                </div>
            </div>
        </div>

        <!-- Session Persistence for Render Free Plan Card -->
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <h2>🔐 Render Free Plan Session Storage (Auto-Login)</h2>
                <span class="badge badge-success">Persistent Login</span>
            </div>
            <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:12px;">
                Render's free plan discards container files when restarted. Copy your <code>SESSION_BASE64</code> key below and set it as an Environment Variable in Render to stay logged in permanently!
            </p>
            <textarea id="session-b64-input" class="session-textarea" readonly placeholder="Connecting to WhatsApp... SESSION_BASE64 will appear here automatically after authentication.">${sessionB64}</textarea>
            <div style="display:flex; gap:12px; flex-wrap:wrap;">
                <button class="copy-btn" style="flex:1;" onclick="copySessionBase64()">📋 Copy SESSION_BASE64 for Render</button>
                <button class="copy-btn btn-secondary" style="flex:1;" onclick="fetchSession()">🔄 Refresh Session Data</button>
            </div>
            <div class="alert alert-success">
                <strong>How to set on Render Free Plan:</strong><br>
                1. Click <strong>Copy SESSION_BASE64 for Render</strong> above.<br>
                2. Open your service in <strong>Render Dashboard</strong> &gt; <strong>Environment</strong>.<br>
                3. Add Environment Variable: Key: <code>SESSION_BASE64</code>, Value: (Paste copied text).<br>
                4. Save Changes. Your service will now auto-restore session on every deploy/restart!
            </div>
        </div>

        <!-- Keep-Alive Anti-Sleep Monitor -->
        <div class="card">
            <div class="card-header">
                <h2>⏰ Anti-Sleep Keep-Alive System</h2>
                <span class="badge">24/7 Uptime</span>
            </div>
            <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:12px;">
                Render Free web services automatically go to sleep after 15 minutes of inactivity. Our server includes built-in self-pinging to:
            </p>
            <div style="background:var(--bg-input); padding:12px; border-radius:8px; font-family:monospace; font-size:0.85rem; color:#38bdf8; margin-bottom:12px; word-break:break-all;">
                Target Health Endpoint: <span id="health-url">${currentAppUrl.replace(/\/$/, '')}/health</span>
            </div>
            <div class="alert alert-warning">
                <strong>Pro-Tip to Guarantee 100% Render Uptime:</strong><br>
                Create a free account on <a href="https://uptimerobot.com" target="_blank" style="color:#60a5fa;">UptimeRobot</a> or <a href="https://cron-job.org" target="_blank" style="color:#60a5fa;">cron-job.org</a>, and add an HTTP monitor pointing to your Render <code>/health</code> URL (ping interval: 5 minutes). This ensures your server never sleeps!
            </div>
        </div>
    </div>

    <script>
        async function handlePairRequest() {
            const phoneInput = document.getElementById('phoneNumber');
            const errDiv = document.getElementById('pair-error');
            const btn = document.getElementById('btn-request-code');
            const phone = phoneInput.value.trim();

            if (!phone) {
                errDiv.innerText = 'Please enter a valid phone number with country code.';
                errDiv.style.display = 'block';
                return;
            }

            errDiv.style.display = 'none';
            btn.disabled = true;
            btn.innerText = 'Requesting Code... ⏳';

            try {
                const res = await fetch('/api/v1/pair-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: phone })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('pairing-code-value').innerText = data.pairingCode;
                    document.getElementById('pairing-code-display').style.display = 'block';
                } else {
                    errDiv.innerText = data.error || 'Failed to generate code.';
                    errDiv.style.display = 'block';
                }
            } catch (err) {
                errDiv.innerText = 'Network error requesting pairing code.';
                errDiv.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerText = 'Get Pairing Code 📲';
            }
        }

        async function fetchSession() {
            try {
                const res = await fetch('/api/v1/session');
                const data = await res.json();
                if (data.success && data.sessionBase64) {
                    document.getElementById('session-b64-input').value = data.sessionBase64;
                }
            } catch (e) {}
        }

        function copyText(text) {
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => {
                alert('Copied to clipboard!');
            }).catch(() => {
                prompt('Copy text manually:', text);
            });
        }

        function copySessionBase64() {
            const val = document.getElementById('session-b64-input').value;
            if (!val) {
                alert('No SESSION_BASE64 available yet. Please complete WhatsApp login first.');
                return;
            }
            copyText(val);
        }

        let lastQrSvg = null;

        async function updateHealth() {
            try {
                const res = await fetch('/health');
                if (!res.ok) return;
                const data = await res.json();
                const badge = document.getElementById('status-badge');
                const dot = document.getElementById('status-dot');
                const text = document.getElementById('status-text');

                if (data.ready) {
                    badge.className = 'status-badge status-online';
                    dot.innerText = '🟢';
                    text.innerText = 'WhatsApp Connected & Active';
                    document.getElementById('qr-container').innerHTML = '<div style="text-align:center; padding:30px; color:#4ade80; font-weight:600;">✅ Connected to WhatsApp!</div>';
                    fetchSession();
                } else {
                    badge.className = 'status-badge status-offline';
                    dot.innerText = '🟡';
                    text.innerText = data.pairingCode ? 'Pairing Code Active' : (data.qrAvailable ? 'QR Code Ready to Scan' : 'Initializing Engine...');
                    
                    if (data.qrCodeSvg && data.qrCodeSvg !== lastQrSvg) {
                        lastQrSvg = data.qrCodeSvg;
                        document.getElementById('qr-container').innerHTML = '<div class="qr-box">' + data.qrCodeSvg + '</div>';
                    } else if (!data.qrCodeSvg && !data.ready && !data.pairingCode) {
                        document.getElementById('qr-container').innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-secondary);">Waiting for QR Code...</div>';
                    }
                }

                if (data.pairingCode) {
                    document.getElementById('pairing-code-value').innerText = data.pairingCode;
                    document.getElementById('pairing-code-display').style.display = 'block';
                }

                if (data.appUrl) {
                    document.getElementById('health-url').innerText = data.appUrl.replace(/\/$/, '') + '/health';
                }
            } catch (e) {
                console.error('Health fetch error:', e);
            }
        }

        async function resetSession() {
            if (!confirm('Are you sure you want to clear your current WhatsApp session and start fresh?')) return;
            try {
                const res = await fetch('/api/v1/reset-session', { method: 'POST' });
                const data = await res.json();
                alert(data.message || 'Session reset successfully.');
                document.getElementById('pairing-code-display').style.display = 'none';
                document.getElementById('session-b64-input').value = '';
                updateHealth();
            } catch (e) {
                alert('Error resetting session.');
            }
        }

        setInterval(updateHealth, 3000);
        updateHealth();
    </script>
</body>
</html>`);
});

// Endpoint to generate pairing code
app.post('/api/v1/pair-code', async (req, res) => {
    const { phoneNumber, phone } = req.body;
    const targetPhone = phoneNumber || phone;

    if (!targetPhone) {
        return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    try {
        const code = await requestPairingCode(targetPhone);
        return res.status(200).json({
            success: true,
            pairingCode: code,
            phone: normalizePhoneNumber(targetPhone),
            message: 'Pairing code generated successfully. Open WhatsApp > Linked Devices > Link with phone number instead.'
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// Endpoint to force reset/wipe session store
app.post('/api/v1/reset-session', async (req, res) => {
    try {
        console.log('🧹 Manual session reset requested...');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        isConnecting = false;
        
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.ws?.close(); } catch (e) {}
            sock = null;
        }

        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        skipSessionRestoreFromEnv = true;
        currentSessionState = {
            qrCodeSvg: null,
            pairingCode: null,
            pairingPhone: null,
            pairingError: null,
            isReady: false
        };
        reconnectAttempts = 0;

        setTimeout(() => {
            connectToWhatsApp();
        }, 1000);

        return res.status(200).json({
            success: true,
            message: 'Session store wiped cleanly. A new QR code / pairing session is initializing...'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint to export session for environment variable backup
app.get('/api/v1/session', (req, res) => {
    const sessionB64 = exportSessionToBase64();
    if (!sessionB64) {
        return res.status(404).json({ success: false, error: 'No active session found.' });
    }
    return res.status(200).json({
        success: true,
        sessionBase64: sessionB64,
        isReady: currentSessionState.isReady
    });
});

// Enhanced health endpoint for monitoring and keep-alive pingers
app.get('/health', (req, res) => {
    const appUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://127.0.0.1:${PORT}`;
    res.status(200).json({
        ok: true,
        ready: currentSessionState.isReady,
        qrAvailable: !!currentSessionState.qrCodeSvg,
        qrCodeSvg: currentSessionState.qrCodeSvg,
        pairingCode: currentSessionState.pairingCode,
        pairingPhone: currentSessionState.pairingPhone,
        pairingError: currentSessionState.pairingError,
        appUrl: appUrl,
        uptimeSeconds: Math.floor(process.uptime()),
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
    const keepAliveIntervalMs = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 240000); // Pings every 4 minutes
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://127.0.0.1:${PORT}`;
        const targetUrl = appUrl.endsWith('/health') ? appUrl : `${appUrl.replace(/\/$/, '')}/health`;
        const httpLib = targetUrl.startsWith('https') ? require('https') : require('http');

        httpLib.get(targetUrl, (res) => {
            console.log(`⏰ [KEEP-ALIVE] Pinged ${targetUrl} (Status: ${res.statusCode})`);
        }).on('error', (err) => {
            console.log('⏰ [KEEP-ALIVE] Ping notice:', err.message);
        });
    }, keepAliveIntervalMs);
}

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 API Container active on port ${PORT}`);
        resetSessionIfRequested();
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
    restoreSessionFromEnv,
    resetSessionIfRequested,
    requestPairingCode,
    normalizePhoneNumber
};