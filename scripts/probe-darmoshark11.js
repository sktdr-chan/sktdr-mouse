'use strict';
// Darmoshark M5 probe 11 — full read suite with CORRECT 65-byte writes
// ([0x00 report ID prefix] + 64-byte frame) and the 0x40 work-mode bit.
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

function cmd(type, opcode, sub, payload, label, waitMs = 600) {
  const f = frame(type, opcode, sub, payload);
  let sent;
  try { sent = dev.write(Buffer.concat([Buffer.from([0x00]), f])); } catch (e) {
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
  const real = frames.filter((r) => (r[0] & 0x3f) !== 0x1f);
  for (const r of frames) console.log('  ' + label + ' <- ' + hex(r) + ((r[0] & 0x3f) === 0x1f ? ' [offline]' : ' ★'));
  if (!frames.length) console.log('  ' + label + ' <- (nothing)');
  return real[0] || null;
}

console.log('[i] full suite (65B writes, W=0x40 where applicable)\n');
cmd(0x41, 0x81, 0x01, [], 'handshake ', 500);
cmd(0x44, 0x81, 0x01, [], 'getBaseInfo', 800);
cmd(0x45, 0x81, 0x01, [], 'getLight   ', 800);
cmd(0x40, 0x81, 0x00, [], 'getVersion ', 500);
for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
  cmd(0x43, 0x82, 0x03, [idx], 'getBtn#' + idx + '  ', 350);
}
cmd(0x47, 0x83, 0x01, [0, 0], 'getMacro#0 ', 400);
cmd(0x44, 0x81, 0x01, [], 'getBaseInfo2', 800);

console.log('\n[i] passive 5s');
const dl = Date.now() + 5000;
while (Date.now() < dl) {
  try {
    const raw = dev.readTimeout(200);
    if (raw && raw.length) {
      const r = Buffer.from(raw);
      if ((r[0] & 0x3f) !== 0x1f) console.log('  <- ' + hex(r));
    }
  } catch (e) { /* timeout */ }
}
dev.close();
console.log('\n[i] done');
