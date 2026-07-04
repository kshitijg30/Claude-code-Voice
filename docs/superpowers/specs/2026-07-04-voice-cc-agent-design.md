# Voice → Claude Code Agent — Design

**Date:** 2026-07-04
**Status:** Approved (design), pending implementation plan

## Concept

A single-page browser app where you speak, Deepgram Flux decides when you've
finished a sentence, the transcript is handed to a **persistent headless Claude
Code session** that can do agentic coding work in a project folder, and Claude's
reply is spoken back via Puter.js TTS.

The distinguishing property: the "LLM" is **Claude Code itself** (the `claude`
CLI running headless), not a hosted API model. One resumed session id gives
continuous memory + tool state across turns.

## Architecture

Three pieces:

```
┌─────────────── index.html (browser) ───────────────┐
│  mic ──stream──> Deepgram Flux WS                    │
│                    ↑ partial transcripts (live text) │
│                    └ EndOfTurn + final transcript ───┼──┐
│  Puter TTS <── reply text <──────────────────────────┼─┐│
└──────────────────────────────────────────────────────┘ ││
                                                          ││ WebSocket
┌─────────────── server.js (local Node bridge) ─────────┐││
│  on transcript:  claude -p "<text>" \                  │◄┘│
│     --resume <SESSION_ID> --add-dir <PROJECT> \        │  │
│     --permission-mode acceptEdits \                    │  │
│     --output-format json                               │──┘ reply text
│  (spawns per turn, reuses ONE session id = memory)     │
│  serves index.html + /config (Deepgram key)            │
└────────────────────────────────────────────────────────┘
```

### 1. `index.html` (browser)

- Captures mic audio.
- Opens a **Deepgram Flux** WebSocket — Flux handles streaming ASR + voice
  activity + end-of-turn detection in one connection (replaces Whisper + VAD +
  BERT entirely).
- Opens a WebSocket to the local bridge (`server.js`).
- On Flux `EndOfTurn`, sends the final transcript to the bridge.
- On reply text from the bridge, speaks it with Puter.js `puter.ai.txt2speech`.
- UI states: `listening` / `thinking` / `speaking`, live partial transcript,
  and Claude's text reply.
- Deepgram key is fetched at runtime from the server's `/config` endpoint, not
  hardcoded in the HTML.

### 2. `server.js` (local Node bridge, ~100 lines, `ws` + `http`)

- Serves `index.html`.
- `GET /config` → returns the Deepgram key (read from env var
  `DEEPGRAM_API_KEY`).
- WebSocket endpoint: on each incoming transcript, spawns:
  ```
  claude -p "<transcript>" \
    --resume <SESSION_ID> \
    --add-dir <PROJECT_DIR> \
    --permission-mode acceptEdits \
    --output-format json
  ```
- Parses the JSON result, sends `result` text back to the browser over the WS.
- Config via env vars: `DEEPGRAM_API_KEY`, `PROJECT_DIR`, `PORT`.

### 3. Persistent "same session"

- First turn: generate a UUID, run with `--session-id <uuid>`.
- Every later turn: `--resume <uuid>`.
- This is what makes it **one continuous Claude Code session** — memory, project
  context, and tool state carry across turns.

## Data flow (one turn)

1. You speak → Flux streams partials → fires **EndOfTurn** with final transcript.
2. Browser sends transcript to bridge; UI shows "🤔 thinking".
3. Bridge runs `claude -p --resume … --add-dir <project> --permission-mode acceptEdits`.
4. Claude may read/edit files, run commands, then returns a text answer.
5. Bridge sends text back → browser speaks it via Puter → UI "🔊 speaking" →
   back to listening.

## Decisions locked in

- **Full agent**, scoped to a project dir (configurable via `PROJECT_DIR` env
  var), `--permission-mode acceptEdits` so headless runs don't hang on prompts.
- **Speech-in:** Deepgram Flux only (ASR + VAD + end-of-turn in one WS). No
  Whisper/VAD/BERT.
- **TTS:** Puter.js `txt2speech` (free, no keys, in-browser).
- **Bridge:** local Node server spawning `claude -p --resume` (chosen over the
  live interactive session and over the Agent SDK).
- **Git identity for this repo:** local config `kshitijg30` /
  `kshitijgera785@gmail.com` (not the global `kshitij947`).

## v1 cuts (deferred to v2)

- **No barge-in** — interrupting TTS by talking over it. v2 enhancement.
- **No streaming TTS** — v1 waits for the full reply, then speaks. v2:
  `--output-format stream-json` to speak sentence-by-sentence for lower latency.

## Error handling

- Flux WS disconnect → auto-reconnect + status badge.
- `claude` non-zero exit / timeout → speak a short "something went wrong" +
  show stderr in the UI.
- Empty / garbled transcript → ignore, keep listening.

## Testing

- **Bridge unit test:** transcript → claude spawn (mock `claude`, assert
  `--resume` / `--session-id` and `--add-dir` flags are correct).
- **Manual end-to-end:** speak a turn, confirm memory carries across turns
  ("remember X" → later "what did I say?").

## Layout

```
voice-cc-agent/
  index.html
  server.js
  package.json
  README.md
  docs/superpowers/specs/2026-07-04-voice-cc-agent-design.md
```
