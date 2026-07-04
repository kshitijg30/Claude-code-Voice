# Self-Evolving Agent — Vision & Roadmap

**Date:** 2026-07-04  
**Status:** North-star plan (living document)  
**Builds on:** [voice-cc-agent design](./2026-07-04-voice-cc-agent-design.md)

---

## What you're actually building

You're not building a chatbot with a fixed UI. You're building **software that lives in a folder, remembers through files, and reshapes itself as you talk**.

The loop you want:

```
You speak  →  agent acts in the folder  →  folder changes  →  UI reflects new reality  →  you speak again
```

Every turn can change **code, config, layout, agents, and memory**. The folder *is* the organism. The browser is a window into it, not the source of truth.

What exists today is the **nervous system** (voice in, Claude Code out, multi-agent, session history). What's missing is the **metabolism** — rules for how the system decides *what* to change about itself and *when*.

---

## Core principles

| Principle | Meaning |
|-----------|---------|
| **Folder = memory** | Context, preferences, agent personas, UI layout, and history are files — not hidden DB state or cloud accounts. |
| **UI is generated, not fixed** | `index.html` (or modules it loads) is edited by the agent when your workflow changes. Tabs, panels, and dashboards appear because you asked for them. |
| **Agents are roles, not chats** | Each agent is a Claude Code session with a prompt, scope, and status. They parallelize work and hand off summarized context. |
| **Evolution is incremental** | Small, reversible edits every session — git commits, not rewrites. You can always roll back. |
| **You stay in the loop** | Voice + visible trace. You see thinking, tools, and file changes. Nothing silently restructures itself without a trace. |

---

## The folder layout (target state)

Everything the system "knows" should be inspectable on disk:

```
voice-cc-agent/                 ← PROJECT_DIR (the organism)
├── index.html                  ← UI shell (agent-editable)
├── ui/                         ← generated panels, styles, widgets
│   ├── manifest.json           ← what tabs/panels exist and why
│   └── panels/                 ← one file per self-added view
├── agents/                     ← agent definitions (not just runtime)
│   ├── registry.json           ← name, prompt, status, parent handoffs
│   └── prompts/                ← one .md per agent persona
├── memory/                     ← durable context the UI doesn't need to render
│   ├── goals.md                ← what you're trying to accomplish
│   ├── decisions.md            ← locked-in choices + rationale
│   ├── preferences.md          ← how you like to work
│   └── index.json              ← searchable map of memory files
├── sessions.db                 ← turn/activity log (already exists)
├── evolution/                  ← the self-improvement audit trail
│   ├── changelog.md            ← human-readable "what changed and why"
│   └── proposals/              ← pending self-edits awaiting your OK
└── server.js                   ← bridge (stable core, rarely touched)
```

**Rule:** if the agent "remembers" something important, it writes a file. If the UI needs a new capability, it adds a file under `ui/` and registers it in `manifest.json`.

---

## Architecture (three layers)

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3 — EVOLUTION                                        │
│  "Should I add a tab? Reorganize agents? Update my prompt?" │
│  Reads goals.md + recent turns → proposes edit → applies     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 2 — ORGANIZATION                                     │
│  Multi-agent orchestration, handoffs, pause/resume           │
│  Session history, activity trace, per-agent prompts          │
│  ← mostly built today                                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 1 — INTERFACE                                        │
│  Voice in (Flux) · TTS out (Puter) · live UI (index.html)   │
│  WebSocket bridge · file-backed state                        │
│  ← built today                                               │
└─────────────────────────────────────────────────────────────┘
```

Layer 1 talks. Layer 2 coordinates. Layer 3 **decides how to grow**.

---

## How self-evolution actually works

Evolution is not magic — it's a **repeatable loop** the agent runs (on request or on schedule):

### 1. Observe
- Read recent turns from `sessions.db`
- Read `memory/goals.md`, `agents/registry.json`, `ui/manifest.json`
- Diff git status — what changed this session?

### 2. Reflect
- Ask: *Does the current UI match how I'm actually working?*
- Ask: *Are agents duplicated, idle, or missing a role?*
- Ask: *Is anything in memory stale or contradictory?*

### 3. Propose
- Write a short proposal to `evolution/proposals/YYYY-MM-DD-<slug>.md`:
  - **Problem** — what's friction right now?
  - **Change** — exact files to add/edit/remove
  - **Risk** — what could break?
  - **Rollback** — how to undo

### 4. Apply (with guardrails)
- Small changes: apply immediately, commit, speak a one-line summary
- Large changes (server.js, auth, deletes): wait for explicit "yes" via voice
- Always: append to `evolution/changelog.md`

### 5. Render
- Hot-reload UI modules from `ui/manifest.json`
- Browser picks up new tabs/panels without a full rewrite of `index.html`

---

## Phased roadmap

### Phase 0 — Today ✅
*Voice agent whose brain is Claude Code, living in one folder.*

- [x] Voice → Deepgram Flux → `claude -p --resume`
- [x] Live activity trace (thinking, tools, results)
- [x] Multi-agent parallel sessions
- [x] Per-agent system prompts
- [x] Pause / handoff with session summarization
- [x] SQLite session history

### Phase 1 — Folder as memory (next)
*Move identity and context out of code and into files.*

- [ ] `memory/goals.md` — agent reads/writes each session start
- [ ] `agents/registry.json` — sync with DB; prompts live in `agents/prompts/`
- [ ] `ui/manifest.json` — declare tabs/panels; server serves `ui/panels/*`
- [ ] Voice command: *"remember that I prefer X"* → writes `memory/preferences.md`
- [ ] Git auto-commit after each evolution step (with local user identity)

**Outcome:** You can open the folder in Finder and read everything the system knows.

### Phase 2 — Self-modifying UI
*The interface grows as you describe new needs.*

- [ ] Dynamic tab loader — reads `ui/manifest.json`, injects panels at runtime
- [ ] Agent can add a panel: e.g. *"give me a kanban for my tasks"* → creates `ui/panels/kanban.html` + manifest entry
- [ ] Agent can hide/remove stale panels
- [ ] Shared component library in `ui/components/` so new panels match the aesthetic
- [ ] Live reload when manifest changes (WebSocket `ui:reload` event)

**Outcome:** You say *"I need a dashboard for all running agents"* and a new tab appears — built by the agent, stored in the folder, committed to git.

### Phase 3 — Self-organizing agents
*Agents spawn, merge, pause, and retire based on workload.*

- [ ] Agent registry rules: max parallel, auto-pause idle agents
- [ ] Auto-spawn: *"Also track the backend while you do frontend"* → new agent with scoped prompt + handoff
- [ ] Auto-retire: agent with 0 turns for N days → archived in `agents/archive/`
- [ ] Cross-agent bus: file-based inbox (`agents/inbox/<agent-id>.jsonl`) for async messages
- [ ] Meta-agent ("Organizer") whose only job is registry + UI + memory hygiene

**Outcome:** You talk about work; the right number of agents exist without manual setup.

### Phase 4 — Continuous evolution
*The system improves its own prompts, layout, and workflows.*

- [ ] End-of-session evolution pass (triggered by *"wrap up"* or idle timeout)
- [ ] Prompt tuning: agent revises its own system prompt based on what worked/failed
- [ ] UI A/B via git branches — try a layout on a branch, merge if you like it
- [ ] `evolution/metrics.json` — track latency, tool errors, turns-to-completion
- [ ] Weekly digest spoken aloud: *"This week I added 2 panels, 1 agent, changed your frontend prompt"*

**Outcome:** The software feels like it learns how you work, not just what you say.

---

## Final outcome (the north star)

Imagine opening **http://localhost:5111** six months in:

- **The UI looks nothing like day one.** You have tabs you never designed — a project board, a memory browser, an agent fleet view, a "what changed today" feed — all created by talking.
- **The folder tells your story.** `memory/goals.md` tracks what you're building. `evolution/changelog.md` is a diary of how the software grew. Git history is the organism's genome.
- **Agents organize themselves.** Frontend, tests, research, and "organizer" agents exist because your work required them. Idle ones sleep. New ones spin up from handoffs with full context.
- **You mostly talk.** Complex work still happens (code edits, commands, file reads) but you experience it as conversation + a live trace, not IDE juggling.
- **It's yours and local.** No account, no cloud memory. Unplug the machine and the entire mind is still in the folder. Copy the folder → copy the agent.

In one sentence:

> **A local folder that becomes personal software — voice-operated, self-documenting, self-layouting, and self-improving through Claude Code acting on its own files.**

---

## What NOT to do (guardrails)

- **Don't evolve server.js casually.** Keep a thin stable bridge; push variability into `ui/` and `agents/`.
- **Don't hide state in the browser.** localStorage is cache, not memory. Files win.
- **Don't auto-evolve without trace.** Every self-edit must appear in Agent trace + `evolution/changelog.md`.
- **Don't skip git.** Evolution without rollback is just corruption.
- **Don't over-agent.** One organizer + a few workers beats twenty idle sessions.

---

## Immediate next steps (concrete)

1. Create `memory/goals.md` and teach the default agent to read it at session start.
2. Add `ui/manifest.json` with current tabs (Chat, Agent trace, Agents, History).
3. Extract one panel (e.g. Agents dashboard) into `ui/panels/agents.html` loaded dynamically.
4. Add voice trigger: *"log this decision"* → append to `memory/decisions.md`.
5. After any UI file change, auto-commit with message `evolve: <reason>`.

Start with Phase 1. Each phase is useful on its own — you don't need the full north star to get value tomorrow.

---

## Success criteria

| Milestone | How you'll know it worked |
|-----------|---------------------------|
| Folder memory | You can grep the folder and find any preference you've stated |
| Self-modifying UI | A new tab exists that you didn't hand-code |
| Self-organizing agents | You didn't click "new agent" — the system spawned one from context |
| Continuous evolution | `evolution/changelog.md` has 10+ entries and the UI is noticeably different from v1 |
| North star | A fresh clone of the folder + `npm start` + talking reconstructs *your* workflow |

---

*This document should itself evolve. When the agent changes strategy, update this file and commit.*
