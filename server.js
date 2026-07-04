// Local bridge: browser <-> Deepgram Flux <-> headless Claude Code.
//
// The browser streams raw mic PCM to this server over one WebSocket. The server
// holds the Deepgram key (proxying Flux so no key ever reaches the browser),
// detects end-of-turn, runs `claude -p` resuming ONE session id, and sends the
// spoken reply text back to the browser for TTS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

// ---- config (.env is a simple KEY=VALUE file, gitignored) ----
loadDotEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '5111', 10);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const PROJECT_DIR = process.env.PROJECT_DIR || __dirname; // Claude works here (sees index.html)
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'opus';
const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS || '180000', 10);
const DG_URL = 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7';

// Voice persona: Claude's text reply is spoken aloud, so it should talk naturally.
const SYSTEM_PROMPT = [
  'You are a hands-on voice assistant. Everything you say is read aloud by a',
  'text-to-speech engine, so speak like a person on a call: warm, natural,',
  'first-person, concise. Never use markdown, bullet points, code fences, emoji,',
  'or raw file paths in your spoken reply. You have full tool access and can read',
  'and edit the files in this project, including index.html and server.js. When',
  'asked to do something, DO it with your tools and narrate what you are doing in',
  'one or two natural sentences, then give a short spoken confirmation. Keep every',
  'reply to a few sentences unless asked for detail.',
].join(' ');

// A PreToolUse hook blocks ONLY speak.py + agents.log.yaml (side effects the
// global CLAUDE.md would otherwise force every turn). --settings needs a FILE path.
const SETTINGS_FILE = path.join(__dirname, '.cc-settings.json');
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: `node ${path.join(__dirname, 'cc-hook.js')}` }] }] },
}, null, 2));

// ---- static server ----
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projectDir: PROJECT_DIR, hasKey: !!DEEPGRAM_API_KEY }));
    return;
  }
  if (url === '/' || url === '/index.html') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html');
  res.writeHead(404); res.end('not found');
});

// ---- per-browser session ----
const wss = new WebSocketServer({ server });

wss.on('connection', (browser) => {
  const sessionId = crypto.randomUUID(); // one continuous Claude Code session
  let started = false;   // first turn creates the session, later turns resume it
  let busy = false;      // true while Claude is thinking/speaking (mic gated off)
  let dg = null;         // Deepgram Flux socket for the current listening window
  log(`browser connected — session ${sessionId}`);

  function say(obj) { try { browser.send(JSON.stringify(obj)); } catch {} }

  function openDeepgram() {
    if (dg && (dg.readyState === WebSocket.OPEN || dg.readyState === WebSocket.CONNECTING)) return;
    dg = new WebSocket(DG_URL, { headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY } });
    dg.on('open', () => say({ type: 'status', state: 'listening' }));
    dg.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type !== 'TurnInfo') return;
      const t = (m.transcript || '').trim();
      if (m.event === 'EndOfTurn') {
        if (!busy && t) handleTurn(t);
      } else if (t) {
        say({ type: 'partial', text: t });
      }
    });
    dg.on('error', (e) => { log('deepgram error: ' + e.message); say({ type: 'status', state: 'error', detail: 'speech service error' }); });
    dg.on('close', () => { /* reopened by start/resume as needed */ });
  }
  function closeDeepgram() { try { dg && dg.close(); } catch {} dg = null; }

  function handleTurn(text) {
    busy = true;
    closeDeepgram();                       // stop listening while we think/speak
    say({ type: 'transcript', text });
    say({ type: 'status', state: 'thinking' });
    log(`turn: "${text}"`);
    runClaude({ text, sessionId, resume: started }, (reply, err) => {
      if (err) { log('claude error: ' + err); say({ type: 'reply', text: 'Sorry, something went wrong on my end. Could you try again?', error: err }); }
      else { started = true; say({ type: 'reply', text: reply }); }
      say({ type: 'status', state: 'speaking' });
    });
  }

  browser.on('message', (data, isBinary) => {
    if (isBinary) {                        // raw PCM audio frame
      if (!busy && dg && dg.readyState === WebSocket.OPEN) dg.send(data);
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start') openDeepgram();
    else if (msg.type === 'stop') closeDeepgram();
    else if (msg.type === 'resume') { busy = false; openDeepgram(); } // TTS finished
  });

  browser.on('close', () => { closeDeepgram(); log(`browser disconnected — session ${sessionId}`); });
});

function runClaude({ text, sessionId, resume }, done) {
  const args = ['-p', text, '--output-format', 'json', '--model', CLAUDE_MODEL,
    '--permission-mode', 'acceptEdits', '--add-dir', PROJECT_DIR,
    '--settings', SETTINGS_FILE, '--append-system-prompt', SYSTEM_PROMPT];
  args.push(resume ? '--resume' : '--session-id', sessionId);

  const child = spawn('claude', args, { cwd: PROJECT_DIR });
  let out = '', errOut = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), TURN_TIMEOUT_MS);
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (errOut += d));
  child.on('error', (e) => { clearTimeout(timer); done(null, e.message); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) return done(null, `exit ${code}: ${errOut.slice(0, 300)}`);
    try { const j = JSON.parse(out); done((j.result || j.text || 'Okay, done.').trim(), null); }
    catch (e) { done(null, `bad JSON: ${e.message}`); }
  });
}

// ---- helpers ----
function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('read error'); return; }
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
}
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`); }

server.listen(PORT, () => {
  log(`voice-cc-agent → http://localhost:${PORT}`);
  log(`project dir: ${PROJECT_DIR}`);
  if (!DEEPGRAM_API_KEY) log('WARNING: DEEPGRAM_API_KEY empty — set it in .env');
});
