---
title: Whatsapp Gateway
emoji: 💬
colorFrom: green
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference

## Deploying to Render

This service authenticates with WhatsApp Web using a QR code. The included `render.yaml` uses a 1 GB persistent disk so the Baileys session survives restarts and deploys. Persistent disks require a paid Render service; a free service will need `SESSION_BASE64` restored after each replacement.

1. Push this repository to GitHub and create a Render Blueprint from the repository. Render will read `render.yaml`.
2. Open the deployed service URL. The home page displays the QR code while authentication is pending.
3. On your phone, open WhatsApp and go to **Settings > Linked Devices > Link a Device**, then scan the QR code.
4. Wait for the page or `/health` to report `"ready": true`.

### Re-authenticate after logout

If WhatsApp reports that the device was logged out, open the Render service's **Environment** settings, add `RESET_SESSION=true`, and deploy/restart once. The app clears the old pairing and shows a new QR code at the service URL. After scanning it, remove `RESET_SESSION` from Render so future restarts keep the new session.

Do not expose or commit the contents of `session_store`; those files are equivalent to a WhatsApp login. The local `npm run export-session` command is only needed when using a deployment without persistent storage. In that case, store its output as the secret Render environment variable `SESSION_BASE64`.
