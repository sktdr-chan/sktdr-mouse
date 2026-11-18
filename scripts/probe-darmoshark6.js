'use strict';
// Darmoshark M5 probe 6 — RETRY each command until a real response arrives.
// The dongle answers 0x1f ("mouse unreachable") instantly while the mouse
// sleeps; real responses only come while the mouse is physically active.
// => The user must keep the mouse MOVING; retries catch the awake windows.
const HID = require('node-hid');
const VID = 0x1915, PID = 0x0725;
const LEN = 64, TARGET = 0xa1;

function cksum(f) {
  let s = 0;
  for (let i = 0; i < LEN - 1; i++) s += f[i];
  f[LEN - 1] = (TARGET - (s & 0xff)) & 0xff;
  return f;
}
function frame(type, opcode, sub, payload = []) {
  const f = Buffer.alloc(LEN, 0);
  f[0] = type & 0xff; f[2] = opcode & 0xff; f[3] = sub & 0xff;
  for (let i = 0; i < Math.min(payload.length, LEN - 5); i++) f[4 + i] = payload[i] & 0xff;
  return cksum(f);
}
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection'); process.exit(1); }
const dev = new HID.HID(cols[0].path);

function readFor(ms, onFrame) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(80, deadline - Date.now()));
      if (raw && raw.length) onFrame(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
}

// Send a command repeatedly until a frame with matching (type&0x3f, sub)
// and a non-zero payload arrives, or the deadline passes.
// Async status frames (link 0x8c / power 0x8e) are logged as they appear.
function cmdUntil(type, opcode, sub, payload, label, deadlineMs) {
  const f = frame(type, opcode, sub, payload);
  const deadline = Date.now() + deadlineMs;
  let offline = 0, result = null;
  const seenAsync = new Set();
  while (Date.now() < deadline && !result) {
    try { dev.write(f); } catch (e) { console.log('[!] write fail'); break; }
    readFor(300, (r) => {
      const t = r[0] & 0x3f;
      const hasPayload = r.slice(4, 63).some(b => b !== 0);
      if (t === (type & 0x3f) && r[3] === (sub & 0xff) && hasPayload && r[2] !== 0x8c) {
        result = r;
      } else if (t === 0x1f) {
        offline++;
      } else {
        const key = hex(r.slice(0, 4));
        if (!seenAsync.has(key)) {
          seenAsync.add(key);
          console.log('  [' + label + '] async <- ' + hex(r));
        }
      }
    });
  }
  if (result) {
    console.log('  ' + pad(label, 14) + 'OK after ' + offline + 'x offline: ' + hex(result));
  } else {
    console.log('  ' + pad(label, 14) + 'FAILED (' + offline + 'x offline, timeout)');
  }
  return result;
}

console.log('[i] RETRY probe — KEEP THE MOUSE MOVING THE WHOLE TIME!');
console.log('[i] getBaseInfo is first and most important.\n');

cmdUntil(0x44, 0x81, 0x01, [], 'getBaseInfo', 30000);
cmdUntil(0x45, 0x81, 0x01, [], 'getLight', 20000);
cmdUntil(0x41, 0x81, 0x01, [], 'getPower', 15000);
cmdUntil(0x40, 0x81, 0x00, [], 'getVersion', 15000);
for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
  cmdUntil(0x43, 0x82, 0x03, [idx], 'getBtn#' + idx, 10000);
}
cmdUntil(0x47, 0x83, 0x01, [0, 0], 'getMacro#0', 10000);
cmdUntil(0x44, 0x81, 0x01, [], 'getBaseInfo#2', 20000);

console.log('\n[i] done');
dev.close();
