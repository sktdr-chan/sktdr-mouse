'use strict';
// Darmoshark M5 probe 8 — the vendor-command channel appears to be available
// only while the mouse is awake but NOT actively streaming (idle on the desk).
// probe4's only success window was right after brief motion stopped.
// Strategy: user moves the mouse ONCE then leaves it alone; commands retry
// with long deadlines so they catch the idle-awake window.
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
      const raw = dev.readTimeout(Math.min(100, deadline - Date.now()));
      if (raw && raw.length) onFrame(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
}

function cmdUntil(typeBase, opcode, sub, payload, label, deadlineMs) {
  const f0 = frame(typeBase, opcode, sub, payload);
  const fW = frame(typeBase | 0x40, opcode, sub, payload);
  const deadline = Date.now() + deadlineMs;
  let offline = 0, result = null, variant = null;
  const seenAsync = new Set();
  let flip = false;
  while (Date.now() < deadline && !result) {
    const f = flip ? fW : f0; flip = !flip;
    try { dev.write(f); } catch (e) { console.log('[!] write fail'); break; }
    readFor(600, (r) => {
      const t = r[0] & 0x3f;
      const hasPayload = r.slice(4, 63).some(b => b !== 0);
      if (t === typeBase && r[3] === sub && hasPayload && r[2] !== 0x8c && r[2] !== 0x8e) {
        if (!result) { result = r; variant = (r[0] & 0x40) ? 'W' : 'plain'; }
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
    console.log('  ' + pad(label, 14) + 'OK (' + variant + ', ' + offline + 'x offline): ' + hex(result));
  } else {
    console.log('  ' + pad(label, 14) + 'FAILED (' + offline + 'x offline)');
  }
  return result;
}

console.log('[i] MOVE THE MOUSE ONCE NOW, THEN LEAVE IT ALONE ON THE DESK.');
console.log('[i] Long-deadline retries will catch the idle-awake vendor window.\n');

cmdUntil(0x04, 0x81, 0x01, [], 'getBaseInfo', 90000);
cmdUntil(0x05, 0x81, 0x01, [], 'getLight', 45000);
cmdUntil(0x01, 0x81, 0x01, [], 'getPower', 30000);
cmdUntil(0x03, 0x82, 0x03, [0], 'getBtn#0', 20000);
for (const idx of [1, 2, 3, 4, 5, 6, 7]) {
  cmdUntil(0x03, 0x82, 0x03, [idx], 'getBtn#' + idx, 12000);
}
cmdUntil(0x07, 0x83, 0x01, [0, 0], 'getMacro#0', 12000);
cmdUntil(0x00, 0x81, 0x00, [], 'getVersion', 12000);

console.log('\n[i] done');
dev.close();
