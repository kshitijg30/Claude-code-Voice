// End-to-end: stream synthesized speech (16k mono s16le WAV) to the bridge like
// the browser would, and print partials / transcript / Claude's reply.
const fs = require('fs');
const WebSocket = require('ws');

const wav = fs.readFileSync('/tmp/utt.wav');
const pcm = wav.subarray(44); // skip WAV header → raw s16le
const CHUNK = 2560;           // 1280 samples * 2 bytes = 80ms
const silence = Buffer.alloc(CHUNK); // to trigger end-of-turn

const ws = new WebSocket('ws://localhost:5111');
ws.on('open', async () => {
  console.log('bridge open; starting mic session');
  ws.send(JSON.stringify({ type: 'start' }));
  await sleep(300);
  for (let i = 0; i < pcm.length; i += CHUNK) {
    ws.send(pcm.subarray(i, i + CHUNK)); await sleep(80);
  }
  console.log('speech sent; sending 1.5s silence to force end-of-turn');
  for (let i = 0; i < 19; i++) { ws.send(silence); await sleep(80); }
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'partial') process.stdout.write('  …partial: ' + m.text + '\r');
  else if (m.type === 'transcript') console.log('\nTRANSCRIPT (you):', JSON.stringify(m.text));
  else if (m.type === 'status') console.log('  [status]', m.state);
  else if (m.type === 'reply') { console.log('CLAUDE REPLY:', JSON.stringify(m.text), m.error ? '(ERR '+m.error+')' : ''); ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.log('WS error', e.message); process.exit(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
setTimeout(() => { console.log('\ntimeout — no reply'); process.exit(1); }, 150000);
