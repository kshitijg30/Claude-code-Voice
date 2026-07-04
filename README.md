# Evolving Software

**Personal software that lives in a folder, grows as you talk, and reorganizes itself.**

The brain is **Claude Code itself** — not a hosted API. You speak, a headless `claude` session reads and edits files in your project folder, and the reply is spoken back. Over time the folder becomes the organism: code, agents, session history, and (next) file-based memory all live on disk.

```
You speak → Deepgram Flux → claude -p --resume → edits folder → reply → Puter TTS
                ↑                              ↓
           live trace UI              sessions.db (turn + activity log)
```

North-star vision: [`docs/superpowers/specs/2026-07-04-self-evolving-agent-vision.md`](docs/superpowers/specs/2026-07-04-self-evolving-agent-vision.md)

---

## What v1 includes today

### Voice agent
- Mic → **Deepgram Flux** (streaming ASR + end-of-turn) → local Node bridge → **`claude -p`**
- Replies spoken via **Puter.js TTS** (no TTS key needed)
- Deepgram key stays server-side; browser only streams PCM audio

### Session-based memory
Each agent is a **persistent Claude Code session** backed by SQLite (`sessions.db`):

| Stored | Where | Purpose |
|--------|-------|---------|
| Turns | `turns` table | Your transcript + Claude's reply per turn |
| Activities | `activities` table | Thinking, tool calls, results — full agent trace |
| Agent metadata | `sessions` table | Name, system prompt, status, handoff parent |

- First turn: `--session-id <uuid>`
- Later turns: `--resume <uuid>` (also restored after page refresh via turn history)
- Browse past sessions in the **History** panel
- API: `GET /api/sessions`, `GET /api/agents`

Session memory = Claude's in-session context **plus** the durable turn/activity log in the folder. File-based memory (`memory/goals.md`, etc.) is planned for v1.1 — see the vision doc.

### Multi-agent orchestration
- Spawn **parallel agents**, each with its own session and **configurable system prompt**
- **Pause / resume** per agent
- **Hand off** — summarizes one session and seeds a new agent with that context
- Pick which agent receives **voice** input
- Send text tasks to any agent while others run in parallel

### UI (sidebar layout)
- **Navbar** — project path, session id, connection status
- **Left sidebar** — navigation + agent list
- **Center** — mic orb + status
- **Right sidebar** — chat, live trace, agent config, history

---

## Requirements

- `claude` CLI logged in (`claude --version` works)
- Node 22+ (uses built-in `node:sqlite` for session store)
- Deepgram API key (Flux access)
- Chrome or similar with mic permission

## Setup

```bash
cd voice-cc-agent   # or clone Evolving-Software
npm install
cp .env.example .env 2>/dev/null || true
# set DEEPGRAM_API_KEY in .env
npm start
```

Open **http://localhost:5111**, click the mic, and talk.

## Config (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `DEEPGRAM_API_KEY` | — | Deepgram Flux key |
| `PORT` | `5111` | Local server port |
| `PROJECT_DIR` | this folder | Directory Claude works in — **the organism lives here** |
| `CLAUDE_MODEL` | `sonnet` | Model alias for `claude --model` |
| `TURN_TIMEOUT_MS` | `180000` | Kill a turn if Claude runs longer |

## Architecture

```
┌─ index.html (browser) ─────────────────────────────────────┐
│  navbar · left nav · mic · right panels                   │
│  WebSocket ←→ PCM audio + JSON events                     │
└───────────────────────────┬──────────────────────────────┘
                            │
┌─ server.js (bridge) ──────▼──────────────────────────────┐
│  Deepgram Flux proxy · multi-agent runtime                │
│  session lock (one claude process per session at a time)  │
│  spawns: claude -p --resume --add-dir PROJECT_DIR …       │
└───────────────────────────┬──────────────────────────────┘
                            │
┌─ on disk ─────────────────▼──────────────────────────────┐
│  sessions.db · index.html · server.js · (future: memory/) │
└──────────────────────────────────────────────────────────┘
```

Key files:

| File | Role |
|------|------|
| `index.html` | UI shell (agent-editable) |
| `server.js` | Voice bridge + multi-agent orchestration |
| `db.js` | Session / turn / activity persistence |
| `sessions.db` | SQLite store (gitignored) |
| `cc-hook.js` | Blocks double-speech side effects in headless mode |

## Roadmap (short)

| Phase | Focus |
|-------|--------|
| **v1** ✅ | Voice, multi-agent, session memory, live trace, sidebar UI |
| **v1.1** | `memory/` folder — goals, preferences, decisions as files |
| **v2** | Self-modifying UI — dynamic panels from `ui/manifest.json` |
| **v3** | Self-organizing agents — auto-spawn, retire, meta-organizer |
| **v4** | Continuous evolution — prompt tuning, changelog, end-of-session growth |

Full roadmap: [`docs/superpowers/specs/2026-07-04-self-evolving-agent-vision.md`](docs/superpowers/specs/2026-07-04-self-evolving-agent-vision.md)

Original voice-agent design: [`docs/superpowers/specs/2026-07-04-voice-cc-agent-design.md`](docs/superpowers/specs/2026-07-04-voice-cc-agent-design.md)

## v1 limits

- No **barge-in** (mic off while Claude thinks/speaks)
- No **streaming TTS** (waits for full reply before speaking)
- Session memory is **SQLite + Claude session**, not yet file-based `memory/`
- Point `PROJECT_DIR` at a folder you trust — agent runs with `acceptEdits`

---

*The folder is the organism. Git is its genome. Voice is how you talk to it.*
