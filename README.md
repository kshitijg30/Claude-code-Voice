# Voice · Claude Code

A single-page browser voice agent whose **brain is Claude Code itself** — not a
hosted API model. You talk, Deepgram Flux detects when your sentence ends, the
transcript goes to a persistent headless `claude` session that can read/edit
files and run commands in a project folder, and the reply is spoken back with
Puter.js TTS.

```
mic → local bridge → Deepgram Flux (ASR + end-of-turn) → claude -p --resume → reply → Puter TTS → speaker
```

The browser only captures mic audio and plays TTS. The **Node bridge proxies
Deepgram** (holding the key server-side with proper header auth) and runs Claude,
so no API key ever reaches the browser.

## Requirements

- `claude` CLI logged in (`claude --version` works)
- Node 18+
- A Deepgram API key (Flux access)
- A modern browser (Chrome recommended) with mic permission

## Setup

```bash
cd voice-cc-agent
npm install
# edit .env — set DEEPGRAM_API_KEY (and optionally PROJECT_DIR / CLAUDE_MODEL)
npm start
```

Then open **http://localhost:5111**, click the mic, and start talking.

## How it works

- **`index.html`** — captures mic audio at 16 kHz and streams raw linear16 PCM
  to the local bridge over one WebSocket; shows live partial transcripts and
  speaks Claude's reply with `puter.ai.txt2speech`. No API key in the browser.
- **`server.js`** — serves the page and proxies **Deepgram Flux** (which handles
  transcription *and* end-of-turn detection) using a server-side header auth.
  On each finished turn it spawns:
  ```
  claude -p "<transcript>" --resume <SESSION_ID> \
    --add-dir <PROJECT_DIR> --permission-mode acceptEdits \
    --model <CLAUDE_MODEL> --output-format json \
    --append-system-prompt "<voice persona>"
  ```
  The first turn creates the session; every later turn resumes the **same**
  session id, so memory and tool state carry across the whole conversation.

## Config (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `DEEPGRAM_API_KEY` | — | Deepgram Flux key |
| `PORT` | `5111` | Local server port |
| `PROJECT_DIR` | this folder | Directory Claude works in (so it can see `index.html`) |
| `CLAUDE_MODEL` | `opus` | Model alias passed to `claude --model` |
| `TURN_TIMEOUT_MS` | `180000` | Kill a turn if `claude` runs longer |

## Notes / v1 scope

- **Full agent**, permission mode `acceptEdits` — headless, won't hang on
  prompts. It runs in `PROJECT_DIR`; point that at a repo you trust.
- **No barge-in** yet: the mic is gated off while Claude is thinking/speaking.
- **No streaming**: v1 waits for the full reply, then speaks. (v2 idea:
  `--output-format stream-json` to speak sentence-by-sentence.)

Design spec: [`docs/superpowers/specs/2026-07-04-voice-cc-agent-design.md`](docs/superpowers/specs/2026-07-04-voice-cc-agent-design.md)
