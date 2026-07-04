// Session / agent store — SQLite via Node's built-in module (Node 22.5+).

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, 'sessions.db');
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title TEXT,
    project_dir TEXT,
    model TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    user_text TEXT NOT NULL,
    reply_text TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    detail TEXT,
    is_error INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
  CREATE INDEX IF NOT EXISTS idx_activities_turn ON activities(turn_id);
`);

for (const col of [
  'ALTER TABLE sessions ADD COLUMN name TEXT',
  'ALTER TABLE sessions ADD COLUMN system_prompt TEXT',
  "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active'",
  'ALTER TABLE sessions ADD COLUMN parent_id TEXT',
  'ALTER TABLE sessions ADD COLUMN summary TEXT',
]) {
  try { db.exec(col); } catch {}
}

const insertSession = db.prepare(
  `INSERT OR IGNORE INTO sessions
   (id, started_at, updated_at, project_dir, model, name, system_prompt, status, parent_id, summary)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const touchSession = db.prepare(
  'UPDATE sessions SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?'
);
const updateAgentStmt = db.prepare(
  `UPDATE sessions SET name = COALESCE(?, name), system_prompt = COALESCE(?, system_prompt),
   status = COALESCE(?, status), updated_at = ? WHERE id = ?`
);
const insertTurn = db.prepare(
  'INSERT INTO turns (session_id, ts, user_text) VALUES (?, ?, ?)'
);
const finishTurn = db.prepare(
  'UPDATE turns SET reply_text = ?, error = ? WHERE id = ?'
);
const insertActivity = db.prepare(
  'INSERT INTO activities (turn_id, ts, kind, text, detail, is_error) VALUES (?, ?, ?, ?, ?, ?)'
);

const listSessionsStmt = db.prepare(
  `SELECT s.id, s.started_at, s.updated_at, s.title, s.model, s.name, s.status, s.parent_id,
          (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
     FROM sessions s ORDER BY s.updated_at DESC LIMIT 200`
);
const listAgentsStmt = db.prepare(
  `SELECT s.id, s.started_at, s.updated_at, s.name, s.status, s.parent_id, s.system_prompt,
          s.model, s.summary,
          (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
     FROM sessions s ORDER BY s.updated_at DESC LIMIT 50`
);
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
const getTurnsStmt = db.prepare(
  'SELECT id, ts, user_text, reply_text, error FROM turns WHERE session_id = ? ORDER BY id ASC'
);
const getActivitiesStmt = db.prepare(
  'SELECT ts, kind, text, detail, is_error FROM activities WHERE turn_id = ? ORDER BY id ASC'
);
const turnCountStmt = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?');

function hasTurns(sessionId) {
  return turnCountStmt.get(sessionId).n > 0;
}

function createAgent({ id, name, projectDir, model, systemPrompt, parentId, summary, status }) {
  const now = Date.now();
  insertSession.run(
    id, now, now, projectDir || null, model || null,
    name || 'Agent', systemPrompt || null, status || 'active', parentId || null, summary || null
  );
}

function ensureSession({ sessionId, projectDir, model, name, systemPrompt }) {
  const now = Date.now();
  insertSession.run(sessionId, now, now, projectDir || null, model || null,
    name || 'Agent', systemPrompt || null, 'active', null, null);
}

function updateAgent({ id, name, systemPrompt, status }) {
  updateAgentStmt.run(name ?? null, systemPrompt ?? null, status ?? null, Date.now(), id);
}

function getAgentMeta(id) {
  return getSessionStmt.get(id);
}

function startTurn({ sessionId, userText }) {
  const now = Date.now();
  const info = insertTurn.run(sessionId, now, userText);
  touchSession.run(now, userText.slice(0, 80), sessionId);
  return Number(info.lastInsertRowid);
}

function completeTurn({ turnId, replyText, error }) {
  finishTurn.run(replyText || null, error || null, turnId);
}

function recordActivity({ turnId, kind, text, detail, isError }) {
  insertActivity.run(turnId, Date.now(), kind, text || null, detail || null, isError ? 1 : 0);
}

function listSessions() {
  return listSessionsStmt.all();
}

function listAgents() {
  return listAgentsStmt.all();
}

function getSession(id) {
  const session = getSessionStmt.get(id);
  if (!session) return null;
  const turns = getTurnsStmt.all(id).map((t) => ({
    ...t,
    activities: getActivitiesStmt.all(t.id),
  }));
  return { session, turns };
}

module.exports = {
  createAgent, ensureSession, updateAgent, getAgentMeta, hasTurns,
  startTurn, completeTurn, recordActivity,
  listSessions, listAgents, getSession,
};
