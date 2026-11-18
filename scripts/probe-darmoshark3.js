'use strict';
// Darmoshark M5 probe 3 — repeated power query for 30s (mouse should be moved/clicked meanwhile)
const HID = require('node-hid');
const VID = 0x1915, PID = 0x0725;
const LEN = 64, TARGET = 0xa1;

function frame(type, index, opcode, sub) {
  const f = Buffer.alloc(LEN, 0);
  f[0] = type; f[1] = index; f[2] = opcode; f[3] = sub;
  let sum = 0;
  for (let i = 0; i < LEN - 1; i++) sum += f[i];
  f[LEN - 1] = (TARGET - (sum & 0xff)) & 0xff;
  return f;
}
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection'); process.exit(1); }
const dev = new HID.HID(cols[0].path);

const START = Date.now();
const DURATION = 90000;
const q = frame(0x41, 0x00, 0x81, 0x01);
let n = 0, nonzero = 0, otherType = 0;

console.log('[i] polling every 300ms for 30s — MOVE / CLICK the mouse now!');

while (Date.now() - START < DURATION) {
  try { dev.write(q); } catch (e) { console.log('[!] write fail: ' + e.message); break; }
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(80, deadline - Date.now()));
      if (raw && raw.length) {
        const r = Buffer.from(raw);
        n++;
        const payloadZero = r.slice(4, 63).every(b => b === 0);
        if (!payloadZero || (r[0] & 0x3f) !== 0x1f) {
          const t = ((Date.now() - START) / 1000).toFixed(1);
          console.log('[' + t + 's] resp: ' + hex(r));
          if (!payloadZero) nonzero++; else otherType++;
        }
      }
    } catch (e) { /* timeout */ }
  }
}
console.log('[i] total responses: ' + n + ', non-zero payload: ' + nonzero + ', other type: ' + otherType);
dev.close();
