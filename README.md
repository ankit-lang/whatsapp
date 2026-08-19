# WhatsApp Gateway - Render Free Plan Setup & Control Center

A high-performance WhatsApp Gateway service powered by `@whiskeysockets/baileys` and Express. Features **Phone Pairing Code Authentication** (no fast-expiring QR codes), **Permanent Render Free Plan Session Retention**, and **Anti-Sleep Keep-Alive Monitoring**.

---

## 🚀 Deployment Guide on Render (Free Plan)

### Step 1: Deploy to Render
1. Push this repository to your GitHub account.
2. Go to [Render Dashboard](https://dashboard.render.com/) > **New** > **Blueprint**.
3. Select your repository. Render will automatically read `render.yaml` (configured for the **Free Plan**).
4. Click **Apply**. Render will build and launch your service.

---

## 📲 Authenticating WhatsApp (Pair by Code or QR)

### Option A: Pair by Phone Code (Recommended — Gives More Time!)
1. Open your deployed Render App URL (e.g. `https://whatsapp-gateway-xyz.onrender.com`).
2. Under **Pair by Phone Code**, enter your WhatsApp phone number with country code (e.g., `919876543210` or `31612345678`).
3. Click **Get Pairing Code 📲**. An 8-character code will appear (e.g., `ABCD-1234`).
4. Open **WhatsApp** on your primary phone:
   - Go to **Settings** (or ⋮ Menu) > **Linked Devices**.
   - Tap **Link a Device**.
   - Tap **Link with phone number instead** at the bottom.
   - Enter the 8-character code shown on your control center!

### Option B: Pair by QR Code
- Simply view the control center homepage to see the live QR Code SVG and scan it with WhatsApp.

---

## 🔐 Never Reconnect: Persistent Session on Render Free Plan

Render's Free Tier resets ephemeral container storage on restart. To ensure **you NEVER have to reconnect WhatsApp again**:

1. After logging in once (via Pairing Code or QR Code), open your app control center dashboard at `https://<your-render-app>.onrender.com`.
2. Find the **Render Free Plan Session Storage** section.
3. Click **Copy SESSION_BASE64 for Render**.
4. Go to **Render Dashboard** > select your service > **Environment**.
5. Add an Environment Variable:
   - **Key**: `SESSION_BASE64`
   - **Value**: (Paste the copied string)
6. Click **Save Changes**.

Now every time Render restarts or deploys, your service will instantly restore session credentials from `SESSION_BASE64` without logging out!

---

## ⏰ Preventing Server Sleep (100% 24/7 Uptime)

Render Free web services sleep after 15 minutes of inactivity. To keep your server awake permanently:

1. **Built-in Self-Ping**: The app automatically pings its public health endpoint every 4 minutes.
2. **Free External Monitor (Recommended)**:
   - Create a free account at [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org).
   - Create an HTTP Monitor pointing to: `https://<your-render-app>.onrender.com/health`
   - Set the monitoring interval to **5 minutes**.
   - Your Render web service will stay awake 24/7, 365 days a year!

---

## 📡 API Endpoints

### 1. Send Website Lead Alert
`POST /api/v1/send-lead`
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+31612345678",
  "serviceType": "Catering",
  "eventDate": "2026-09-01",
  "numGuests": "50",
  "message": "Looking for private event catering."
}
```

### 2. Request Pairing Code via API
`POST /api/v1/pair-code`
```json
{
  "phoneNumber": "31612345678"
}
```

### 3. Service Health Check
`GET /health`
```json
{
  "ok": true,
  "ready": true,
  "qrAvailable": false,
  "pairingCode": null,
  "appUrl": "https://whatsapp-gateway-xyz.onrender.com",
  "uptimeSeconds": 3600,
  "timestamp": "2026-08-19T18:30:00.000Z"
}
```

---

## 🛠️ Re-authenticating / Clearing Session

If you manually log out from your phone and need to link a new WhatsApp account:
1. Open Render Dashboard > **Environment**.
2. Add `RESET_SESSION=true` and save.
3. Once restarted, remove `RESET_SESSION=true` and pair with your new code/QR.
