'use strict';
// Darmoshark M5 probe 12 — which commands does the DONGLE answer while the
// MOUSE is (probably) asleep? Correct 65-byte writes.
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

function cmd(f, label, waitMs = 500) {
  let sent;
  try { sent = dev.write(Buffer.concat([Buffer.from([0x00]), f])); } catch (e) {
    console.log('  ' + label + ' write fail: ' + e.message); return null;
  }
  const frames = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(80, deadline - Date.now()));
      if (raw && raw.length) frames.push(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
  for (const r of frames) {
    console.log('  ' + label + ' <- ' + hex(r.slice(0, 16)) + (r.length > 16 ? ' …' : ''));
  }
  if (!frames.length) console.log('  ' + label + ' <- (nothing)');
  return frames[0] || null;
}

console.log('[i] sleep-state probe (mouse idle ~10+ min)');
cmd(frame(0x01, 0x81, 0x01), 'receiverState');
cmd(frame(0x41, 0x81, 0x01), 'power       ');
cmd(frame(0x44, 0x81, 0x01), 'getBaseInfo ');
cmd(frame(0x40, 0x81, 0x00), 'getVersion  ');
dev.close();
console.log('[i] done');
