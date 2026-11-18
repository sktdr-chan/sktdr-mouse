'use strict';
// Darmoshark M5 probe 5 — full read suite WHILE the user keeps the mouse moving
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
function cmd(f, label, waitMs) {
  dev.write(f);
  const frames = [];
  readFor(waitMs, (r) => frames.push(r));
  for (const r of frames) {
    const t = r[0] & 0x3f;
    const tag = t === 0x1f ? ' [offline]' : '';
    console.log('  ' + pad(label, 16) + '<- ' + hex(r) + tag);
  }
  if (!frames.length) console.log('  ' + pad(label, 16) + '<- (timeout)');
  return frames;
}

// ---- Phase 1: wait for workMode=1 (mouse linked, awake) ----
const hs = frame(0x01, 0x81, 0x01);
const DEADLINE = Date.now() + 180000;
let awake = false;

console.log('[i] waiting up to 180s — KEEP THE MOUSE MOVING CONTINUOUSLY');
while (Date.now() < DEADLINE) {
  try { dev.write(hs); } catch (e) { console.log('[!] write fail'); break; }
  readFor(280, (r) => {
    const t = r[0] & 0x3f;
    if (t === 0x01 && r[3] === 0x01 && (r[4] & 0x08)) { awake = true; }
    else if (r[0] === 0x41 && r[3] === 0x01) { awake = true; }
  });
  if (awake) { console.log('[i] mouse AWAKE and LINKED'); break; }
}
if (!awake) { console.log('[!] never became fully awake'); dev.close(); process.exit(1); }

// ---- Phase 2: suite with work-mode bit ----
console.log('\n=== suite (W=0x40) ===');
cmd(frame(0x41, 0x81, 0x01), 'handshake', 900);
cmd(frame(0x44, 0x81, 0x01), 'getBaseInfo#1', 1200);
cmd(frame(0x45, 0x81, 0x01), 'getLight', 900);
cmd(frame(0x40, 0x81, 0x00), 'getVersion', 900);
for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
  cmd(frame(0x43, 0x82, 0x03, [idx]), 'getBtn#' + idx, 350);
}
cmd(frame(0x47, 0x83, 0x01, [0, 0]), 'getMacro#0', 500);
cmd(frame(0x44, 0x81, 0x01), 'getBaseInfo#2', 1200);
cmd(frame(0x44, 0x81, 0x01), 'getBaseInfo#3', 1200);
cmd(frame(0x41, 0x81, 0x01), 'handshake#2', 900);

console.log('\n[i] done');
dev.close();
