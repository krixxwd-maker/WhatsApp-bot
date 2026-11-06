import express from 'express';
import makeWASocket, { useMultiFileAuthState, Browsers, delay, DisconnectReason, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yts from 'yt-search';
import { createRequire } from 'module';
import multer from 'multer';

const require = createRequire(import.meta.url);
const ytdl = require('@distube/ytdl-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'temp_uploads/' });
if (!fs.existsSync('temp_uploads')) fs.mkdirSync('temp_uploads');

let sock = null;
let isConnected = false;
let pairingCode = null;
let isDownloading = false;
let blastInterval = null;

process.on('uncaughtException', (err) => console.log('⚠️ Error:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Rejection:', err.message));

// API: Check Status & Get Pairing Code
app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, pairingCode });
});

// API: Upload Shayari File
app.post('/api/upload-msg', upload.single('msgFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "File select nahi ki gayi" });
    try {
        fs.renameSync(req.file.path, 'messages.txt');
        const lines = fs.readFileSync('messages.txt', 'utf-8').split('\n').filter(l => l.trim() !== '').length;
        res.json({ ok: true, count: lines });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Pair WhatsApp
app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Number required" });
    if (isConnected) return res.json({ ok: true, msg: "Already connected" });
    
    try {
        if (sock) { try { sock.end(undefined); } catch(e) {} }
        pairingCode = null;
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_krix');
        let version = [2, 3000, 1017531287];
        try { const vData = await fetchLatestWaWebVersion(); version = vData.version; } catch(e) {}

        sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            if (qr && !sock.authState.creds.registered) {
                await delay(3000); // 3 sec wait for Render to be stable
                try {
                    const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    pairingCode = code.match(/.{1,4}/g).join('-');
                } catch (err) { console.log(err.message); }
            }
            if (connection === 'open') {
                isConnected = true;
                pairingCode = null;
                setupMessageListener();
            }
            if (connection === 'close') {
                isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) {
                    // Reconnect logic if needed
                }
            }
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔥 WHATSAPP COMMANDS (Sab kuch yahan se control hoga)
function setupMessageListener() {
    if (!sock) return;
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;
            const sender = msg.key.remoteJid;
            if (!sender || sender === 'status@broadcast') return;

            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
            const lowerText = text.toLowerCase();
            if (!text) return;

            // 🎵 1. MUSIC COMMAND (!play)
            if (lowerText.startsWith("!play ")) {
                const query = text.slice(6).trim();
                if (!query) return sock.sendMessage(sender, { text: "❌ Gaane ka naam likho: !play Kesariya" });
                if (isDownloading) return sock.sendMessage(sender, { text: "⏳ Pehle wala gaana aa raha hai, wait karo!" });
                
                isDownloading = true;
                await sock.sendMessage(sender, { text: `🔍 *Searching:* ${query}...` });
                
                try {
                    const search = await yts(query);
                    const video = search.videos[0];
                    if (!video) throw new Error("Song not found");
                    
                    await sock.sendMessage(sender, { 
                        image: { url: video.thumbnail },
                        caption: `🎵 *Title:* ${video.title}\n👤 *Artist:* ${video.author.name}\n⏱️ *Duration:* ${video.timestamp}\n\n⏳ _Sending Audio..._`
                    });

                    const stream = ytdl(video.url, { filter: 'audioonly', quality: 'highestaudio' });
                    const chunks = [];
                    for await (const chunk of stream) { chunks.push(chunk); }
                    const buffer = Buffer.concat(chunks);
                    
                    await sock.sendMessage(sender, { audio: buffer, mimetype: 'audio/mp4', fileName: `${video.title}.mp3` });
                } catch (err) {
                    await sock.sendMessage(sender, { text: `❌ Download fail: ${err.message}` });
                } finally {
                    isDownloading = false;
                }
                return;
            }

            // 💣 2. BLAST COMMAND (!blast 91xxxxxxxxxx 20)
            if (lowerText.startsWith("!blast ")) {
                if (blastInterval) return sock.sendMessage(sender, { text: "⚠️ Blast pehle se chal raha hai. Rokne ke liye !stopblast likho." });
                
                const args = text.split(" ");
                const target = args[1];
                const delaySec = parseInt(args[2]) || 20;
                
                if (!target) return sock.sendMessage(sender, { text: "❌ Format: !blast 91XXXXXXXXXX 20" });
                if (!fs.existsSync('messages.txt')) return sock.sendMessage(sender, { text: "❌ Pehle Web Panel se messages.txt upload karo!" });
                
                let jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
                let messages = fs.readFileSync('messages.txt', 'utf-8').split('\n').map(m => m.trim()).filter(m => m);
                if (messages.length === 0) return sock.sendMessage(sender, { text: "❌ File khali hai!" });
                
                let index = 0;
                await sock.sendMessage(sender, { text: `🚀 *BLAST STARTED!*\nTarget: ${target}\nDelay: ${delaySec}s\nRokne ke liye: !stopblast` });
                
                blastInterval = setInterval(async () => {
                    if (!isConnected) return;
                    if (index >= messages.length) index = 0;
                    try { await sock.sendMessage(jid, { text: messages[index] }); index++; } catch (e) {}
                }, delaySec * 1000);
                return;
            }

            // 🛑 3. STOP BLAST (!stopblast)
            if (lowerText === "!stopblast") {
                if (blastInterval) {
                    clearInterval(blastInterval);
                    blastInterval = null;
                    return await sock.sendMessage(sender, { text: "🛑 *BLAST STOPPED!*" });
                }
                return await sock.sendMessage(sender, { text: "⚠️ Koi blast nahi chal raha." });
            }

            // 🎮 4. GAMES
            if (lowerText === "!roll") return await sock.sendMessage(sender, { text: `🎲 Dice: *${Math.floor(Math.random() * 6) + 1}*` });
            if (lowerText === "!coin") return await sock.sendMessage(sender, { text: `🎯 Coin: *${Math.random() > 0.5 ? "Heads" : "Tails"}*` });

        } catch (e) {}
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 SERVER RUNNING ON PORT ${PORT}`);
});
