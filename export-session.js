const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, 'session_store');
const credsFile = path.join(SESSION_DIR, 'creds.json');

if (!fs.existsSync(credsFile)) {
    console.error('❌ No active session found in ./session_store!');
    console.error('👉 Please run `node index.js` locally and scan the QR code first.');
    process.exit(1);
}

try {
    const files = fs.readdirSync(SESSION_DIR);
    const bundle = {};
    for (const file of files) {
        const filePath = path.join(SESSION_DIR, file);
        if (fs.statSync(filePath).isFile()) {
            bundle[file] = fs.readFileSync(filePath, 'utf-8');
        }
    }
    const sessionB64 = Buffer.from(JSON.stringify(bundle)).toString('base64');
    
    console.log('\n============================================================');
    console.log('✅ LOCAL SESSION EXPORT SUCCESSFUL!');
    console.log('============================================================\n');
    console.log('Copy the entire string below and paste it as a Secret named SESSION_BASE64 in Hugging Face:\n');
    console.log(sessionB64);
    console.log('\n============================================================\n');
} catch (err) {
    console.error('Error exporting session:', err.message);
}
