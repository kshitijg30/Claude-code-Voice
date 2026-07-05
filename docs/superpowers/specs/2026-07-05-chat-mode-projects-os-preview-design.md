# Design: Chat/Voice Modes, `projects/` OS, Live Preview, Clean UI

Date: 2026-07-05
Status: Approved (brainstorm)

## Summary

Four related changes to `voice-cc-agent`:

1. **Two input modes** — Chat and Voice as distinct modes over the same agent/session.
2. **`projects/` as the OS** — all new project work lands in `projects/<name>/`, enforced by a hook; agents stay in the DB for now.
3. **Live preview** — a Projects panel with a live file tree and a hot-reloading iframe preview, with no server restart and no full-page reload.
4. **Clean visual redesign** — remove emoji/neon, restrained palette, real type scale, seamless layout.

Non-goals this round: materializing agents as files on disk; per-project framework dev-servers (React/Vite build).

---

## 1. Two input modes (Chat & Voice)

### Behavior
- A **mode toggle** in the navbar: `Voice` / `Chat`. Both drive the **same active agent/session**, so turn history and trace are shared; switching mid-conversation is seamless.
- **Voice mode** = today's behavior: mic → Deepgram Flux → Claude → spoken reply (Puter TTS).
- **Chat mode**: the center stage becomes a chat thread with a text composer. A submitted message runs a text turn against the active agent and renders the reply as **markdown text**. Mic is not opened and **TTS never fires** in this mode.

### Server changes (`server.js`)
- `runAgentTurn(agentId, text, opts)` already takes `opts.voice`. Chat turns call it with `voice:false` (no Deepgram close, no `status: speaking`, no TTS handshake).
- New inbound WS message `{ type: 'chat', agentId, text }` → `runAgentTurn(agentId, text, { voice:false })`. (The existing `agent:run` path is equivalent; `chat` is an explicit alias so the client intent is clear and the active-agent default is applied server-side.)
- Replies already flow back as `agent:reply`; the client decides whether to speak based on the **current mode**, not the server.

### Client changes (`index.html`)
- Mode state (`voice` | `chat`) stored in JS and reflected on `body[data-mode]`.
- Voice mode shows the mic control; Chat mode shows the thread + composer, both bound to the active agent.
- `speak()` is only invoked when `mode === 'voice'`. In chat mode replies are rendered through the existing markdown renderer.

---

## 2. `projects/` and `agents/` as the OS (hard-enforced)

### Convention
- New project work is created under `voice-cc-agent/projects/<project-name>/`.
- Agents remain DB-backed this round (no `agents/*.md`), but any files an agent produces still land under `projects/`.

### System prompt
Append explicit rules to `DEFAULT_SYSTEM_PROMPT`:
> New projects always go in `projects/<name>/` (create the subfolder). Never write to the user's home, the system, or the repo root. You may edit your own OS files (server.js, index.html, etc.) when explicitly asked to change how you work.

### Hook enforcement (`cc-hook.js`)
Extend the existing PreToolUse hook. Currently it only inspects `Bash` command text; broaden it to also receive `Write`/`Edit`/`Bash` (the settings matcher expands accordingly) and evaluate the **target path**:

Let `ROOT = /Users/kshitijgera/Desktop/projects/voice-cc-agent` (passed via env/arg, not hardcoded in logic — resolved from the hook's own location).

Decision for a write/edit at absolute path `P`:
- **Deny** if `P` is outside `ROOT` (no touching home/system).
- **Allow** if `P` is inside `ROOT/projects/` or `ROOT/agents/`.
- **Allow** if `P` targets an **existing** OS file/dir inside `ROOT` (self-edit carve-out: `server.js`, `index.html`, `cc-hook.js`, `db.js`, `docs/`, `README.md`, etc.).
- **Deny** creating a **new** file directly in `ROOT` or a non-`projects`/`agents` subdir (forces new work into `projects/`).

For `Bash`: keep the existing `speak.py`/`agents.log.yaml` block, and additionally deny commands whose obvious write target (redirects `>`/`>>`, `mkdir`, `touch`, `cp`/`mv` destination) resolves outside `ROOT`. Best-effort — the primary guard is on `Write`/`Edit`; Bash is a secondary net. Path resolution treats relative paths against the session cwd (`PROJECT_DIR`).

`exit 2` blocks the call and returns the reason on stderr so Claude self-corrects (e.g. "write under projects/<name>/ instead").

### Settings (`server.js`)
The `.cc-settings.json` that `server.js` writes must register the hook for `Write|Edit|Bash`, not just `Bash`.

---

## 3. Live preview (file tree + web preview)

No framework switch. Vanilla + iframe + WebSocket live-reload delivers the "runtime like React" feel.

### Static serving (`server.js`)
- New route `GET /preview/<project>/<path>` serves files directly from `ROOT/projects/<project>/<path>` with correct content-types; directory requests fall back to `index.html`. Path-traversal guarded (reject `..`, resolve and confirm the result stays under `projects/`).
- Because Node serves files on demand, newly written files are immediately available — **no server restart, ever**.

### File APIs (`server.js`)
- `GET /api/projects` → `[{ name, hasIndex }]` for folders under `projects/`.
- `GET /api/projects/<name>/tree` → nested tree of files/dirs.
- `GET /api/projects/<name>/file?path=<rel>` → `{ path, content, type }` (type ∈ code/markdown/html/binary).

### Live updates
- Server watches `ROOT/projects/` recursively (`fs.watch({ recursive:true })`, debounced ~150ms) and broadcasts `{ type:'fs:change', project, path }` to all connected browsers over the existing WS.
- Client, on `fs:change`:
  - refresh the file tree for the affected project (if the Projects panel is open),
  - if a preview iframe is open for that project, **reload only the iframe** (`iframe.contentWindow.location.reload()` or reassign `src` with a cache-buster) — never the whole page.

### Projects panel (`index.html`)
- New left-nav entry **Projects**. Panel layout: file tree (left column) + content view (right). Selecting a file shows highlighted code / rendered markdown / and for `index.html` (or when "Preview" is chosen) an embedded **iframe** pointed at `/preview/<name>/`.
- The panel and preview update themselves live as Claude writes files during a conversation.

---

## 4. Clean visual redesign

Applies across the whole `index.html`.

- **No emoji as UI.** Remove all decorative emoji (nav glyphs, mic emoji, tag dots-as-emoji, chapter "quest" flourishes). Where an icon aids scanning (nav, file types), use minimal **inline SVG line icons** (~1.5px stroke, `currentColor`). Most labels are plain text.
- **Restrained palette.** Remove the multi-color radial-gradient background, neon glows, and colored box-shadows. One deep neutral background; surfaces differentiated by small lightness steps; hairline borders; a **single muted indigo accent** used only for active/primary states. No cyan, no rainbow.
- **Typography.** Keep Inter, used deliberately: a tight modular scale, weights limited to 400/500/600, sensible line-heights, minimal letter-spacing (drop the ALL-CAPS 2px-tracked labels). Monospace reserved for paths/code.
- **Seamless layout & motion.** Unified spacing/radius/border tokens (CSS custom properties). Replace pulsing rings, breathing halos, and spinning borders with calm, minimal state indication. The mic becomes a quiet, well-proportioned control.
- Implementation uses the **frontend-design** skill for intentional, non-templated results.

---

## Data flow

```
Chat/Voice turn → runAgentTurn(voice?) → claude -p (cwd=PROJECT_DIR, hook-guarded writes → projects/)
        writes files → fs.watch(projects/) → WS 'fs:change' → UI: refresh tree + reload iframe only
Preview iframe → GET /preview/<name>/index.html   (served live from disk, no restart)
```

## Components & boundaries

| Unit | Responsibility | Interface |
|------|----------------|-----------|
| `runAgentTurn` (server) | Run a turn, voice or chat | `(agentId, text, {voice})` → WS events |
| `cc-hook.js` | Enforce write boundaries | stdin tool JSON → exit 0/2 |
| preview route (server) | Serve project files live | `GET /preview/<name>/*` |
| file APIs (server) | List/read project files | `GET /api/projects...` |
| fs watcher (server) | Emit change events | `fs.watch` → WS `fs:change` |
| Projects panel (client) | Tree + content + iframe preview | consumes file APIs + `fs:change` |
| mode controller (client) | Voice vs Chat rendering & TTS gate | `body[data-mode]` |

## Error handling
- Preview/file APIs: 404 on missing project/file; 400 on traversal attempts; never serve outside `projects/`.
- Hook: on unparseable input, fail **open** for existing behavior but **closed** for out-of-root paths; always emit a clear stderr reason on deny.
- `fs.watch`: wrap in try/catch; if recursive watch is unavailable, fall back to a shallow watch of `projects/` top level; debounce to avoid event storms.
- WS `fs:change` is best-effort; the file tree also refreshes on panel open so state self-heals.

## Testing
Manual e2e (extend `test-e2e.js` patterns):
1. **Chat turn** returns text and does **not** trigger TTS/Deepgram.
2. **Voice turn** still speaks (unchanged path).
3. **Hook** blocks a `Write` to `~/foo.txt` and to `ROOT/loose.txt`; **allows** `ROOT/projects/demo/index.html` and an edit to existing `ROOT/server.js`.
4. **Preview**: writing `projects/demo/index.html` emits `fs:change`; `GET /preview/demo/` serves it with no restart; open iframe reloads.
5. **No emoji** remain in `index.html`; visual pass on palette/type.
