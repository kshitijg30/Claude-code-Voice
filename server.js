// Local bridge: browser <-> Deepgram Flux <-> headless Claude Code (multi-agent).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const store = require('./db');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '5111', 10);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const PROJECT_DIR = process.env.PROJECT_DIR || __dirname;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS || '180000', 10);
const DG_URL = 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7';

const DEFAULT_SYSTEM_PROMPT = [
  'You are a hands-on voice assistant. Everything you say is read aloud by a',
  'text-to-speech engine, so speak like a person on a call: warm, natural,',
  'first-person, concise. Never use markdown, bullet points, code fences, emoji,',
  'or raw file paths in your spoken reply. You have full tool access and can read',
  'and edit files in this project. When asked to do something, DO it with your',
  'tools and narrate briefly, then give a short spoken confirmation.',
].join(' ');

const SETTINGS_FILE = path.join(__dirname, '.cc-settings.json');
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: `node ${path.join(__dirname, 'cc-hook.js')}` }] }] },
}, null, 2));

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/config') {
    return sendJson(res, 200, { projectDir: PROJECT_DIR, hasKey: !!DEEPGRAM_API_KEY, model: CLAUDE_MODEL,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT });
  }
  if (url === '/api/sessions') return sendJson(res, 200, { sessions: store.listSessions() });
  if (url === '/api/agents') return sendJson(res, 200, { agents: store.listAgents() });
  const m = url.match(/^\/api\/(?:sessions|agents)\/([\w-]+)$/);
  if (m) {
    const data = store.getSession(m[1]);
    if (!data) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, data);
  }
  if (url === '/' || url === '/index.html') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html');
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server });

// One claude process per session-id at a time (global across browser tabs).
const sessionLocks = new Map();
function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const job = prev.then(() => new Promise((resolve) => { fn(resolve); })).catch(() => {});
  sessionLocks.set(sessionId, job);
  return job;
}

wss.on('connection', (browser) => {
  let activeAgentId = null;
  let voiceBusy = false;
  let dg = null;
  const rt = new Map(); // agentId -> { busy }

  function say(obj) { try { browser.send(JSON.stringify(obj)); } catch {} }
  function runtime(id) {
    if (!rt.has(id)) rt.set(id, { busy: false });
    return rt.get(id);
  }
  function agentRow(a) {
    const r = runtime(a.id);
    return { id: a.id, name: a.name || 'Agent', status: a.status || 'active',
      turn_count: a.turn_count, parent_id: a.parent_id, busy: r.busy,
      system_prompt: a.system_prompt || DEFAULT_SYSTEM_PROMPT };
  }
  function pushAgents() { say({ type: 'agents', agents: store.listAgents().map(agentRow) }); }

  function ensureDefaultAgent() {
    const list = store.listAgents();
    if (list.length) return list[0].id;
    const id = crypto.randomUUID();
    store.createAgent({ id, name: 'Voice Agent', projectDir: PROJECT_DIR, model: CLAUDE_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT });
    return id;
  }

  activeAgentId = ensureDefaultAgent();
  pushAgents();
  say({ type: 'active_agent', agentId: activeAgentId });

  function openDeepgram() {
    if (dg && (dg.readyState === WebSocket.OPEN || dg.readyState === WebSocket.CONNECTING)) return;
    dg = new WebSocket(DG_URL, { headers: { Authorization: 'Token ' + DEEPGRAM_API_KEY } });
    dg.on('open', () => say({ type: 'status', state: 'listening' }));
    dg.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type !== 'TurnInfo') return;
      const t = (m.transcript || '').trim();
      if (m.event === 'EndOfTurn' && !voiceBusy && t) handleVoiceTurn(t);
      else if (t) say({ type: 'partial', text: t });
    });
    dg.on('error', () => say({ type: 'status', state: 'error', detail: 'speech service error' }));
  }
  function closeDeepgram() { try { dg && dg.close(); } catch {} dg = null; }

  function runAgentTurn(agentId, text, opts = {}) {
    const meta = store.getAgentMeta(agentId);
    if (!meta || meta.status === 'paused') {
      say({ type: 'agent:error', agentId, error: 'Agent is paused' }); return;
    }
    const r = runtime(agentId);
    if (r.busy) { say({ type: 'agent:error', agentId, error: 'Agent is busy' }); return; }

    r.busy = true; pushAgents();
    if (opts.voice) { voiceBusy = true; closeDeepgram(); say({ type: 'transcript', text }); say({ type: 'status', state: 'thinking' }); }

    store.ensureSession({ sessionId: agentId, projectDir: PROJECT_DIR, model: CLAUDE_MODEL,
      name: meta.name, systemPrompt: meta.system_prompt });
    const resume = store.hasTurns(agentId);
    const turnId = store.startTurn({ sessionId: agentId, userText: text });
    const prompt = meta.system_prompt || DEFAULT_SYSTEM_PROMPT;

    withSessionLock(agentId, (unlock) => {
      runClaude({ text, sessionId: agentId, resume, systemPrompt: prompt },
        (ev) => {
          if (ev.type === 'activity') store.recordActivity({ turnId, kind: ev.kind, text: ev.text, detail: ev.detail, isError: ev.isError });
          say({ ...ev, agentId });
        },
        (reply, err) => {
          r.busy = false; pushAgents(); unlock();
          if (err) { store.completeTurn({ turnId, error: err }); say({ type: 'agent:reply', agentId, text: 'Something went wrong.', error: err }); }
          else { store.completeTurn({ turnId, replyText: reply }); say({ type: 'agent:reply', agentId, text: reply }); }
          if (opts.voice) { voiceBusy = false; say({ type: 'status', state: 'speaking' }); }
        });
    });
  }

  function handleVoiceTurn(text) { runAgentTurn(activeAgentId, text, { voice: true }); }

  function handoff(fromId, name, systemPrompt) {
    const meta = store.getAgentMeta(fromId);
    if (!meta) return;
    const r = runtime(fromId);
    if (r.busy) { say({ type: 'agent:error', agentId: fromId, error: 'Agent is busy' }); return; }
    r.busy = true; pushAgents();
    const summaryPrompt = 'Summarize this entire session for handoff to another agent. Include goals, decisions, files changed, current state, and open items. Be concise but complete.';
    withSessionLock(fromId, (unlock) => {
      runClaude({ text: summaryPrompt, sessionId: fromId, resume: store.hasTurns(fromId),
        systemPrompt: 'You produce handoff summaries only. No tools.' },
        () => {},
        (summary, err) => {
          r.busy = false; unlock(); pushAgents();
          const id = crypto.randomUUID();
          const base = systemPrompt || DEFAULT_SYSTEM_PROMPT;
          const full = base + (summary && !err ? '\n\n--- Handoff from ' + (meta.name || 'agent') + ' ---\n' + summary : '');
          store.createAgent({ id, name: name || 'Agent (handoff)', projectDir: PROJECT_DIR, model: CLAUDE_MODEL,
            systemPrompt: full, parentId: fromId, summary: summary || null });
          pushAgents();
          say({ type: 'agent:handoff', fromId, agentId: id, summary: summary || '' });
        });
    });
  }

  browser.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!voiceBusy && dg && dg.readyState === WebSocket.OPEN) dg.send(data);
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start') openDeepgram();
    else if (msg.type === 'stop') closeDeepgram();
    else if (msg.type === 'resume') { voiceBusy = false; openDeepgram(); }
    else if (msg.type === 'agent:create') {
      const id = crypto.randomUUID();
      store.createAgent({ id, name: msg.name || 'Agent', projectDir: PROJECT_DIR, model: CLAUDE_MODEL,
        systemPrompt: msg.systemPrompt || DEFAULT_SYSTEM_PROMPT });
      pushAgents(); say({ type: 'agent:created', agentId: id });
    } else if (msg.type === 'agent:select') {
      activeAgentId = msg.agentId; say({ type: 'active_agent', agentId: activeAgentId });
    } else if (msg.type === 'agent:prompt') {
      store.updateAgent({ id: msg.agentId, systemPrompt: msg.systemPrompt });
      pushAgents();
    } else if (msg.type === 'agent:pause') {
      store.updateAgent({ id: msg.agentId, status: 'paused' }); pushAgents();
    } else if (msg.type === 'agent:resume_agent') {
      store.updateAgent({ id: msg.agentId, status: 'active' }); pushAgents();
    } else if (msg.type === 'agent:run') {
      runAgentTurn(msg.agentId, msg.text || '');
    } else if (msg.type === 'agent:handoff') {
      handoff(msg.fromId, msg.name, msg.systemPrompt);
    }
  });

  browser.on('close', () => closeDeepgram());
});

function runClaude({ text, sessionId, resume, systemPrompt }, onEvent, done, attempt = 0) {
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose',
    '--model', CLAUDE_MODEL, '--permission-mode', 'acceptEdits',
    '--add-dir', PROJECT_DIR, '--settings', SETTINGS_FILE,
    '--append-system-prompt', systemPrompt || DEFAULT_SYSTEM_PROMPT];
  args.push(resume ? '--resume' : '--session-id', sessionId);

  const child = spawn('claude', args, { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', errOut = '', finalText = null, finalErr = null;
  const timer = setTimeout(() => child.kill('SIGKILL'), TURN_TIMEOUT_MS);

  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) handleEvent(line);
    }
  });
  child.stderr.on('data', (d) => (errOut += d));
  child.on('error', (e) => { clearTimeout(timer); done(null, e.message); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const errMsg = errOut.trim();
    if (errMsg.includes('already in use') && attempt < 4) {
      return setTimeout(() => runClaude({ text, sessionId, resume: true, systemPrompt }, onEvent, done, attempt + 1), 800 * (attempt + 1));
    }
    if (finalErr) return done(null, finalErr);
    if (finalText != null) return done(finalText || 'Done.', null);
    if (code === 0) return done('Done.', null);
    done(null, errMsg || (code == null ? 'Process ended unexpectedly' : `exit ${code}`));
  });

  function handleEvent(line) {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'system' && e.subtype === 'init') {
      onEvent({ type: 'session', cwd: e.cwd || PROJECT_DIR, sessionId: e.session_id, model: e.model });
    } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') {
          onEvent({ type: 'activity', kind: 'tool', text: describeTool(c.name, c.input || {}),
            detail: detailForTool(c.name, c.input || {}) });
        } else if (c.type === 'thinking' && c.thinking && c.thinking.trim()) {
          onEvent({ type: 'activity', kind: 'thinking', text: c.thinking.trim() });
        } else if (c.type === 'text' && c.text && c.text.trim()) {
          onEvent({ type: 'activity', kind: 'say', text: c.text.trim() });
        }
      }
    } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result') continue;
        const raw = Array.isArray(c.content)
          ? c.content.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('')
          : typeof c.content === 'string' ? c.content : '';
        const snippet = raw.replace(/\s+/g, ' ').trim();
        if (snippet) onEvent({ type: 'activity', kind: 'result', text: snippet.slice(0, 320), isError: !!c.is_error });
      }
    } else if (e.type === 'result') {
      if (e.subtype === 'success') finalText = (e.result || '').trim();
      else finalErr = e.subtype || 'error';
    }
  }
}

function detailForTool(name, input) {
  if (name === 'Bash') return String(input.command || '');
  if (input.file_path) return input.file_path;
  return '';
}

function describeTool(name, input) {
  const base = (p) => (p ? String(p).split('/').pop() : '');
  switch (name) {
    case 'Read':      return 'Reading ' + base(input.file_path);
    case 'Edit':      return 'Editing ' + base(input.file_path);
    case 'Write':     return 'Writing ' + base(input.file_path);
    case 'Bash':      return 'Running: ' + String(input.command || '').replace(/\s+/g, ' ').slice(0, 70);
    case 'Grep':      return 'Searching for "' + (input.pattern || '') + '"';
    case 'Glob':      return 'Finding files ' + (input.pattern || '');
    default:          return name;
  }
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('read error'); return; }
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
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
