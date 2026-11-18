'use strict';
// probe-philips.js — identify the Philips Evnia receiver protocol.
// iface 2 (0xFF01/0x10) exposes 65-byte reports (report id 0 + 64 data),
// the same shape as the Nordic MOJI family. Try fingerprints.
const HID = require('node-hid');
const VID = 0x25aa, PID = 0x2012;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const cols = HID.devices().filter((d) => d.vendorId === VID && d.productId === PID && (d.usagePage || 0) === 0xff01);
if (!cols.length) { console.log('[!] vendor collection not found'); process.exit(1); }
const dev = new HID.HID(cols[0].path);
console.log('[i] opened iface 2 (0xFF01/0x10), 65-byte reports');

function cksumA1(frame) {
  let s = 0;
  for (let i = 0; i < 63; i++) s += frame[i];
  return (0xa1 - (s & 0xff)) & 0xff;
}
function mojiFrame(type, opcode, sub, payload = []) {
  const f = Buffer.alloc(64, 0);
  f[0] = type; f[2] = opcode; f[3] = sub;
  for (let i = 0; i < Math.min(payload.length, 59); i++) f[4 + i] = payload[i] & 0xff;
  f[63] = cksumA1(f);
  return f;
}
function readFor(ms, onFrame) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(100, deadline - Date.now()));
      if (raw && raw.length) onFrame(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
}
function attempt(frame, label, waitMs = 500) {
  try { dev.write(Buffer.concat([Buffer.from([0x00]), frame])); } catch (e) {
    console.log('  ' + label + ' write fail: ' + e.message);
    return;
  }
  const frames = [];
  readFor(waitMs, (r) => frames.push(r));
  for (const r of frames) console.log('  ' + label + ' <- ' + hex(r));
  if (!frames.length) console.log('  ' + label + ' <- (nothing)');
}

console.log('\n[i] MOJI/Darmoshark fingerprints (checksum 0xA1 family)');
attempt(mojiFrame(0x01, 0x81, 0x01), 'MOJI hs 01 00 81 01');
attempt(mojiFrame(0x41, 0x81, 0x01), 'MOJI hs 41 00 81 01');

console.log('\n[i] plain 0x01 ping variants');
for (const cmd of [[0x01], [0x03], [0x04], [0x90, 0x0a], [0x0a], [0x81], [0xc0, 0x01]]) {
  const f = Buffer.alloc(64, 0);
  f[0] = cmd[0];
  if (cmd[1] != null) f[1] = cmd[1];
  f[63] = cksumA1(f);
  attempt(f, 'probe ' + hex(f.slice(0, 4)));
}

console.log('\n[i] passive listen 4s — move the mouse');
const seen = new Set();
readFor(4000, (r) => {
  const k = hex(r.slice(0, 4));
  if (!seen.has(k)) { seen.add(k); console.log('  <- ' + hex(r)); }
});

dev.close();
console.log('[i] done');
