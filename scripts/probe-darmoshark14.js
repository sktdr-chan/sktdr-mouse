'use strict';
// Darmoshark M5 probe 14 — setLight with CORRECT arg mapping:
// caller passes {i: lightMode, l: brightness, s: speed, r, g, b}
// → frame [45 00 91 02 01 <mode> 07 <brightness> 01 <speed> 01 rgb x3]
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

const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection'); process.exit(1); }
const dev = new HID.HID(cols[0].path);

function cmd(f, label, waitMs = 600) {
  try { dev.write(Buffer.concat([Buffer.from([0x00]), f])); } catch (e) {
    console.log('  ' + label + ' write fail'); return null;
  }
  const frames = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(100, deadline - Date.now()));
      if (raw && raw.length) frames.push(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
  for (const r of frames) console.log('  ' + label + ' <- ' + hex(r.slice(0, 20)) + (r.length > 20 ? ' …' : ''));
  if (!frames.length) console.log('  ' + label + ' <- (nothing)');
  return frames[0] || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // mode=1 steady, brightness=0x40, speed=1, RED
  const p = [0x01, 0x01, 0x07, 0x40, 0x01, 0x01, 0x01, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00];
  cmd(frame(0x45, 0x91, 0x02, p), 'setLight ');
  await sleep(150);
  cmd(frame(0x4a, 0x81, 0x01), 'saveData ');
  await sleep(400);
  const li = cmd(frame(0x45, 0x81, 0x01), 'getLight ');
  if (li) {
    console.log('  mode=' + li[5] + ' brightness=' + li[7] + ' speed=' + li[9] +
      ' rgb=(' + li[11] + ',' + li[12] + ',' + li[13] + ')');
  }
  dev.close();
  console.log('[i] done — light should be STEADY RED at ~25%');
})();
