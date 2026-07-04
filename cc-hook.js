#!/usr/bin/env node
// PreToolUse hook for the voice-cc-agent's headless Claude sessions.
// Blocks ONLY the two side effects the user's global CLAUDE.md would otherwise
// force on every turn: running speak.py (double-speech) and appending to
// agents.log.yaml (log spam). Everything else is allowed — full agent stays intact.
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = (JSON.parse(data).tool_input || {}).command || ''; } catch {}
  if (/speak\.py|agents\.log\.yaml/i.test(cmd)) {
    // exit 2 = block the tool call; stderr is fed back to Claude as the reason.
    process.stderr.write('Blocked in voice app: skip speak.py/activity-log; your text reply is already spoken.');
    process.exit(2);
  }
  process.exit(0);
});
