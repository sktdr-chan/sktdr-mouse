'use strict';
// Darmoshark M5 probe 9 — sweep dongle-local command space (read-only opcodes).
// Type 0 (getVersion) always works; find which other types the 8K dongle
// answers directly. Skips known write opcodes and type 9 (recovery).
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

function tryCmd(f, label) {
  // drain pending
  try { dev.readTimeout(30); } catch (e) {}
  try { dev.write(f); } catch (e) { console.log('  ' + label + ' write fail'); return; }
  let got = [];
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(80, deadline - Date.now()));
      if (raw && raw.length) got.push(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
  for (const r of got) {
    const t = r[0] & 0x3f;
    if (t === 0x1f) continue; // offline NACK — skip silently
    console.log('  ' + label + ' <- ' + hex(r));
  }
  if (!got.length) console.log('  ' + label + ' <- (nothing)');
}

console.log('[i] sweep: types 0-8,11-30 with opcode 0x81 sub 0/1 (skip 9)');
for (let ty = 0; ty <= 8; ty++) {
  if (ty === 9) continue;
  tryCmd(frame(ty, 0x81, 0x00), 'T' + ty + ' op81 sub0');
}
for (let ty = 11; ty <= 30; ty++) {
  tryCmd(frame(ty, 0x81, 0x00), 'T' + ty + ' op81 sub0');
}
console.log('');
for (let ty = 0; ty <= 8; ty++) {
  tryCmd(frame(ty, 0x81, 0x01), 'T' + ty + ' op81 sub1');
}
for (let ty = 11; ty <= 30; ty++) {
  tryCmd(frame(ty, 0x81, 0x01), 'T' + ty + ' op81 sub1');
}

console.log('\n[i] bond queries (type 0x1D opcode 0x8B)');
tryCmd(frame(0x1d, 0x8b, 0x01, [0x07, 0x25]), 'bond donglePID');
tryCmd(frame(0x1d, 0x8b, 0x01, [0x07, 0x16]), 'bond mousePID ');
tryCmd(frame(0x1d, 0x8b, 0x00), 'bond sub0     ');
tryCmd(frame(0x1d, 0x81, 0x01), 'T1D op81 sub1 ');

console.log('\n[i] done');
dev.close();
