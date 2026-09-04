const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const multer = require('multer');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const upload = multer({ storage: multer.memoryStorage() });

const PREFIX = '!';
const START_TIME = Date.now();
const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'messages.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const NUMBERS_FILE = path.join(__dirname, 'numbers.txt');
const GROUPS_FILE = path.join(__dirname, 'groups.txt');
const MESSAGES_FILE = path.join(__dirname, 'messages.txt');

// Ensure files exist
if (!fs.existsSync(NUMBERS_FILE)) fs.writeFileSync(NUMBERS_FILE, '# Har line par number dalo, e.g. 919876543210\n');
if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, '# Har line par group UID dalo, e.g. 123456789-123456@g.us\n');
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, 'Namaste! Ye auto message hai.\n');

// ---------------- Helpers ----------------
function formatTime(ts) {
  const d = new Date(ts);
  const opts = { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  return d.toLocaleString('en-IN', opts);
}

function readLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  } catch (e) {
    console.error('Read error:', e.message);
    return [];
  }
}

function writeTextArea(filePath, lines) {
  try {
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
}

// ---------------- Log System ----------------
let messageLog = [];
try {
  if (fs.existsSync(LOG_FILE)) messageLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
} catch (e) { messageLog = []; }

function saveLog(entry) {
  messageLog.push(entry);
  if (messageLog.length > 1000) messageLog = messageLog.slice(-1000);
  fs.writeFile(LOG_FILE, JSON.stringify(messageLog, null, 2), (err) => {
    if (err) console.error('Log save error:', err.message);
  });
}

// ---------------- State ----------------
function defaultSenderState() {
  return {
    running: false,
    sentCount: 0,
    failedCount: 0,
    targetCount: 0,
    messageCount: 0,
    currentTarget: null,
    currentMessage: null,
    lastSentAt: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    mode: 'all',
    delaySeconds: 1
  };
}

const state = {
  status: 'starting',
  pairingCode: null,
  lastError: null,
  selfNumber: null,
  sender: defaultSenderState()
};

let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
const sentMessageIds = new Set();

// Sender global vars
let senderLoopActive = false;
let stopSenderFlag = false;
let senderTargets = [];
let senderMessages = [];

// ---------------- Target helpers ----------------
function getTargets() {
  return {
    numbers: readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n)),
    groups: readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us')),
    all: [...readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us')), ...readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n))]
  };
}

function getMessages() {
  return readLines(MESSAGES_FILE);
}

// ---------------- NON-STOP SENDER ----------------
function startSender(mode = 'all', delaySeconds = 1) {
  if (senderLoopActive) return { error: 'Sender abhi already chal raha hai!' };

  const messages = getMessages();
  const { numbers, groups } = getTargets();

  let targets = [];
  if (mode === 'groups') targets = groups;
  else if (mode === 'numbers') targets = numbers;
  else targets = [...groups, ...numbers];

  if (!targets.length) return { error: 'Koi target nahi. Numbers ya Groups add karo.' };
  if (!messages.length) return { error: 'Messages file khali hai. Upload karo.' };

  state.sender = defaultSenderState();
  state.sender.running = true;
  state.sender.targetCount = targets.length;
  state.sender.messageCount = messages.length;
  state.sender.mode = mode;
  state.sender.delaySeconds = delaySeconds;
  state.sender.startedAt = new Date().toISOString();

  senderTargets = targets;
  senderMessages = messages;
  senderLoopActive = true;
  stopSenderFlag = false;

  senderLoop().catch(err => {
    console.error('Sender loop error:', err);
    state.sender.running = false;
    state.sender.stopReason = err.message;
    senderLoopActive = false;
  });

  return { started: true, targets: targets.length, messages: messages.length };
}

function stopSender() {
  if (!senderLoopActive) return { error: 'Sender koi nahi chal raha.' };
  stopSenderFlag = true;
  state.sender.stopReason = 'User ne STOP dabaya';
  return { success: true };
}

async function senderLoop() {
  const delayMs = Math.max(parseInt(state.sender.delaySeconds || 1, 10), 0) * 1000;
  let msgIndex = 0;

  while (!stopSenderFlag) {
    if (!sock || state.status !== 'connected') {
      state.sender.lastError = 'Bot connected nahi hai, 5 sec baad retry...';
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    for (const target of senderTargets) {
      if (stopSenderFlag) break;

      const msg = senderMessages[msgIndex % senderMessages.length];
      msgIndex++;

      state.sender.currentTarget = target;
      state.sender.currentMessage = msg;
      state.sender.lastError = null;

      try {
        let jid = target;
        if (!target.endsWith('@g.us')) {
          const [result] = await sock.onWhatsApp(target);
          if (!result?.exists) throw new Error(`${target} WhatsApp par nahi hai`);
          jid = result.jid;
        }

        const sent = await sock.sendMessage(jid, { text: msg });
        if (sent?.key?.id) sentMessageIds.add(sent.key.id);
        state.sender.sentCount++;
        state.sender.lastSentAt = new Date().toISOString();
        saveLog({ direction: 'sent', to: target, body: msg, via: 'nonstop-sender', at: new Date().toISOString(), humanTime: formatTime(Date.now()) });
        console.log(`📤 [${state.sender.sentCount}] -> ${target} | ${formatTime(Date.now())}`);
      } catch (err) {
        state.sender.failedCount++;
        state.sender.lastError = err.message;
        saveLog({ direction: 'failed', to: target, body: msg, via: 'nonstop-sender', error: err.message, at: new Date().toISOString(), humanTime: formatTime(Date.now()) });
        console.log(`❌ ${target}: ${err.message}`);
      }

      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  state.sender.running = false;
  state.sender.stoppedAt = new Date().toISOString();
  state.sender.currentTarget = null;
  state.sender.currentMessage = null;
  senderLoopActive = false;
}

// ---------------- Text Extract ----------------
function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return extractText(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return extractText(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension) return extractText(message.viewOnceMessageV2Extension.message);
  if (message.editedMessage?.message) return extractText(message.editedMessage.message);
  return '';
}

function deleteAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  } catch (e) { console.error(e.message); }
}

// ---------------- BOT ----------------
async function startBot() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting' && !authState.creds.registered) {
      state.status = 'waiting_for_pairing';
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      state.status = 'connected';
      state.pairingCode = null;
      state.lastError = null;
      state.selfNumber = sock.user?.id || authState.creds.me?.id || null;
      console.log('✅ Bot ready! ' + formatTime(Date.now()));
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        state.status = 'disconnected';
        state.lastError = 'Session logged out. Reset & Re-pair karo.';
        deleteAuthFolder();
      } else if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        state.status = 'reconnecting';
        const delay = Math.min(3000 * reconnectAttempts, 20000);
        setTimeout(startBot, delay);
      } else {
        state.status = 'disconnected';
        state.lastError = 'Reconnect fail. Reset karo.';
        deleteAuthFolder();
      }
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    (async () => {
      try {
        if (m.type !== 'notify') return;

        for (const msg of m.messages || []) {
          if (!msg.message) continue;

          const NOISE_KEYS = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
          const keys = Object.keys(msg.message);
          if (keys.length && keys.every(k => NOISE_KEYS.includes(k))) continue;

          const from = msg.key.remoteJid;
          const isFromMe = msg.key.fromMe;

          const numberOnly = (jid) => (jid || '').split('@')[0].split(':')[0];
          const selfNumber = sock.user
            ? numberOnly(sock.user.id)
            : (authState.creds.me?.id ? numberOnly(authState.creds.me.id) : null);
          const fromNumber = numberOnly(from);
          const isSelfChat = selfNumber && selfNumber === fromNumber;

          if (isFromMe) {
            if (sentMessageIds.has(msg.key.id)) continue;
            if (!isSelfChat) continue;
          }

          const body = extractText(msg.message).trim();
          if (!body.startsWith(PREFIX)) continue;

          const args = body.slice(PREFIX.length).split(/\s+/);
          const command = args.shift().toLowerCase();

          const reply = async (text) => {
            const sent = await sock.sendMessage(from, { text }, { quoted: msg });
            if (sent?.key?.id) sentMessageIds.add(sent.key.id);
            return sent;
          };

          saveLog({ direction: 'received', from, body, at: new Date().toISOString(), humanTime: formatTime(Date.now()) });

          switch (command) {
            case 'ping':
              await reply('🏓 Pong!');
              break;

            case 'help': {
              const helpText =
                `*Commands*\n\n` +
                `${PREFIX}ping\n` +
                `${PREFIX}info\n` +
                `${PREFIX}time\n` +
                `${PREFIX}numbers\n` +
                `${PREFIX}messages\n` +
                `${PREFIX}groups\n` +
                `${PREFIX}addgroup <uid>\n` +
                `${PREFIX}addnum <number>\n` +
                `${PREFIX}bulkstart\n` +
                `${PREFIX}bulkstop`;
              await reply(helpText);
              break;
            }

            case 'info': {
              const { numbers, groups } = getTargets();
              await reply(
                `*Bot Info*\n\n` +
                `Status: Online ✅\n` +
                `Numbers: ${numbers.length}\n` +
                `Groups: ${groups.length}\n` +
                `Messages: ${getMessages().length}\n` +
                `Sender: ${state.sender.running ? 'RUNNING 🟢' : 'OFF ⚪'}\n` +
                `Sent: ${state.sender.sentCount}\n` +
                `Failed: ${state.sender.failedCount}\n` +
                `Time: ${formatTime(Date.now())}`
              );
              break;
            }

            case 'time':
              await reply(`🕒 ${formatTime(Date.now())}`);
              break;

            case 'numbers': {
              const nums = readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n));
              await reply(nums.length ? `📇 *Numbers (${nums.length})*\n${nums.join('\n')}` : 'Numbers file khali hai.');
              break;
            }

            case 'messages': {
              const msgs = getMessages();
              const list = msgs.map((m, i) => `${i + 1}. ${m.slice(0, 50)}${m.length > 50 ? '...' : ''}`).join('\n');
              await reply(msgs.length ? `📝 *Messages (${msgs.length})*\n${list}` : 'Messages file khali hai.');
              break;
            }

            case 'groups': {
              if (!sock || state.status !== 'connected') {
                await reply('Bot connected nahi hai.');
                break;
              }
              try {
                const groups = Object.values(await sock.groupFetchAllParticipating());
                const list = groups.slice(0, 30).map(g => `${g.subject || 'Unknown'}\n${g.id}`).join('\n\n');
                await reply(`👥 *Groups (${groups.length})*\n\n${list}`);
              } catch (err) {
                await reply('Groups fetch nahi ho paye: ' + err.message);
              }
              break;
            }

            case 'addgroup': {
              const gid = args.shift();
              if (!gid || !gid.endsWith('@g.us')) {
                await reply('Usage: !addgroup <group-uid>\n!groups se UID copy karo.');
                break;
              }
              const groups = readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us'));
              if (groups.includes(gid)) {
                await reply('⚠️ Group already hai.');
                break;
              }
              groups.push(gid);
              writeTextArea(GROUPS_FILE, [...readLines(GROUPS_FILE).filter(l => l.startsWith('#')), ...groups]);
              await reply(`✅ Group add ho gaya! Total: ${groups.length}`);
              break;
            }

            case 'addnum': {
              const num = args.shift();
              if (!/^\d{7,15}$/.test(num || '')) {
                await reply('Usage: !addnum 919876543210');
                break;
              }
              const nums = readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n));
              if (nums.includes(num)) {
                await reply('⚠️ Number already hai.');
                break;
              }
              nums.push(num);
              writeTextArea(NUMBERS_FILE, [...readLines(NUMBERS_FILE).filter(l => l.startsWith('#')), ...nums]);
              await reply(`✅ Number add ho gaya! Total: ${nums.length}`);
              break;
            }

            case 'bulkstart': {
              const result = startSender('all', 1);
              if (result.error) await reply('⚠️ ' + result.error);
              else await reply(`🚀 *Non-Stop Sender START!*\nTargets: ${result.targets}\nMessages: ${result.messages}`);
              break;
            }

            case 'bulkstop': {
              stopSender();
              await reply('⏹️ Sender STOP!');
              break;
            }

            default:
              await reply(`Unknown: "${command}". ${PREFIX}help dekho.`);
          }
        }
      } catch (err) {
        console.error('Upsert error:', err);
      }
    })();
  });

  return sock;
}

startBot();

// ---------------- EXPRESS SERVER ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(500).send('public/index.html not found. public folder upload karo.');
});

app.get('/api/status', (req, res) => {
  const { numbers, groups } = getTargets();
  res.json({
    status: state.status,
    pairingCode: state.pairingCode,
    lastError: state.lastError,
    selfNumber: state.selfNumber,
    serverTime: formatTime(Date.now()),
    numbersCount: numbers.length,
    groupsCount: groups.length,
    messagesCount: getMessages().length,
    sender: state.sender
  });
});

app.get('/api/logs', (req, res) => {
  res.json([...messageLog].reverse());
});

// ---------------- File endpoints (content) ----------------
const fileMap = {
  messages: { path: MESSAGES_FILE, get: getMessages },
  numbers: { path: NUMBERS_FILE, get: () => readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n)) },
  groups: { path: GROUPS_FILE, get: () => readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us')) }
};

app.get('/api/files/:type', (req, res) => {
  const type = req.params.type;
  if (!fileMap[type]) return res.status(400).json({ error: 'Invalid type' });
  const full = readLines(fileMap[type].path);
  res.json({ file: type, content: full, parsed: fileMap[type].get() });
});

app.post('/api/files/:type', (req, res) => {
  const type = req.params.type;
  if (!fileMap[type]) return res.status(400).json({ error: 'Invalid type' });
  const { content } = req.body;
  if (!Array.isArray(content)) return res.status(400).json({ error: 'Content array required' });
  writeTextArea(fileMap[type].path, content);
  const parsed = fileMap[type].get();
  res.json({ success: true, count: parsed.length });
});

app.post('/api/files/:type/clear', (req, res) => {
  const type = req.params.type;
  if (!fileMap[type]) return res.status(400).json({ error: 'Invalid type' });
  const header = readLines(fileMap[type].path).filter(l => l.startsWith('#'));
  writeTextArea(fileMap[type].path, header);
  res.json({ success: true, count: 0 });
});

// ---------------- Upload endpoints (file upload) ----------------
app.post('/api/upload/messages', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  fs.writeFileSync(MESSAGES_FILE, req.file.buffer.toString('utf8'));
  res.json({ success: true, count: getMessages().length, message: `${getMessages().length} messages uploaded!` });
});

app.post('/api/upload/numbers', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  fs.writeFileSync(NUMBERS_FILE, req.file.buffer.toString('utf8'));
  const numbers = readLines(NUMBERS_FILE).filter(n => /^\d{7,15}$/.test(n));
  res.json({ success: true, count: numbers.length, message: `${numbers.length} numbers uploaded!` });
});

app.post('/api/upload/groups', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  fs.writeFileSync(GROUPS_FILE, req.file.buffer.toString('utf8'));
  const groups = readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us'));
  res.json({ success: true, count: groups.length, message: `${groups.length} groups uploaded!` });
});

// ---------------- Group add/remove ----------------
app.post('/api/groups/add', (req, res) => {
  const { groupId } = req.body;
  if (!groupId || !groupId.endsWith('@g.us')) return res.status(400).json({ error: 'Valid group UID required.' });
  const groups = readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us'));
  if (groups.includes(groupId)) return res.json({ success: true, message: 'Already hai.', count: groups.length });
  groups.push(groupId);
  writeTextArea(GROUPS_FILE, groups);
  res.json({ success: true, count: groups.length });
});

app.post('/api/groups/remove', (req, res) => {
  const { groupId } = req.body;
  const groups = readLines(GROUPS_FILE).filter(g => g.endsWith('@g.us') && g !== groupId);
  writeTextArea(GROUPS_FILE, groups);
  res.json({ success: true, count: groups.length });
});

// ---------------- Available Groups (from WhatsApp) ----------------
app.get('/api/groups/available', async (req, res) => {
  if (!sock || state.status !== 'connected') return res.status(400).json({ error: 'Bot connected nahi hai.' });
  try {
    const groupsObj = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupsObj).map(g => ({
      id: g.id,
      name: g.subject || g.name || 'Unknown',
      participants: g.participants?.length || 0
    }));
    groups.sort((a, b) => b.participants - a.participants);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Sender endpoints ----------------
app.post('/api/sender/start', (req, res) => {
  const { mode, delaySeconds } = req.body;
  const result = startSender(mode || 'all', parseInt(delaySeconds, 10) || 1);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, ...result });
});

app.post('/api/sender/stop', (req, res) => {
  const result = stopSender();
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

// ---------------- Pairing ----------------
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Valid phone required.' });
  if (!sock) return res.status(400).json({ error: 'Bot starting, wait.' });

  for (let i = 0; i < 3; i++) {
    try {
      const code = await sock.requestPairingCode(phone);
      state.pairingCode = code;
      state.status = 'pairing_requested';
      return res.json({ code });
    } catch (err) {
      console.error('Pairing failed:', err.message);
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  res.status(500).json({ error: 'Pairing code nahi aaya. Reset karke try karo.' });
});

app.post('/api/reset', (req, res) => {
  try {
    if (sock) { try { sock.end(undefined); } catch (e) { } }
    deleteAuthFolder();
    reconnectAttempts = 0;
    state.status = 'starting';
    state.pairingCode = null;
    state.lastError = null;
    setTimeout(startBot, 1000);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`✅ Non-Stop Sender System Ready | ${formatTime(Date.now())}`);
});
