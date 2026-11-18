'use strict';
// Darmoshark M5 probe 4 — wait for mouse to wake, then dump the full read suite
// Protocol (usagePage 0xFF0A): 64-byte non-numbered frames
//   [0]=type (bit6=work mode), [1]=index, [2]=opcode, [3]=sub, [4..62]=payload,
//   [63]=(0xa1 - sum(bytes[0..62])) & 0xff
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

function readFor(ms, onFrame) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(100, deadline - Date.now()));
      if (raw && raw.length) onFrame(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
}
function cmd(f, label, waitMs = 700) {
  dev.write(f);
  const frames = [];
  readFor(waitMs, (r) => frames.push(r));
  for (const r of frames) console.log('  ' + label + ' <- ' + hex(r));
  if (!frames.length) console.log('  ' + label + ' <- (timeout)');
  return frames;
}

// ---- Phase 1: wait for the mouse to become reachable (up to 240s) ----
const hs = frame(0x01, 0x81, 0x01);
const hsW = frame(0x41, 0x81, 0x01);
const DEADLINE = Date.now() + 240000;
let online = null, workMode = 0, flip = false;

console.log('[i] waiting up to 240s for the mouse — PLEASE MOVE / CLICK / POWER ON THE MOUSE');
while (Date.now() < DEADLINE) {
  const q = flip ? hsW : hs; flip = !flip;
  try { dev.write(q); } catch (e) { console.log('[!] write fail'); break; }
  let got = null;
  readFor(260, (r) => {
    const t = r[0] & 0x3f;
    if (t === 0x01 && r[3] === 0x01 && r.slice(4, 63).some(b => b !== 0)) got = r;
    else if (t === 0x1f) { /* still offline */ }
    else if (r.slice(4, 63).some(b => b !== 0)) { got = r; }
  });
  if (got) {
    const t = ((Date.now() % 100000) / 1000).toFixed(1);
    console.log('[' + t + 's] ONLINE! handshake resp: ' + hex(got));
    online = got;
    break;
  }
}
if (!online) { console.log('[!] mouse never became reachable'); dev.close(); process.exit(1); }

// handshake: f[4] bit4 = work mode
workMode = (online[4] >> 4) & 1;
console.log('[i] workMode=' + workMode + '  typeEcho=0x' + online[0].toString(16) + '  f[4]=0x' + online[4].toString(16) + '  f[5..6]=0x' + online[6].toString(16) + online[5].toString(16) + '  f[11..12]=0x' + online[12].toString(16) + online[11].toString(16));
const W = workMode ? 0x40 : 0x00;

// ---- Phase 2: full read suite ----
console.log('\n=== suite (workMode bit 0x' + W.toString(16) + ') ===');
cmd(frame(W | 0x01, 0x81, 0x01), 'handshake/power ');
cmd(frame(W | 0x04, 0x81, 0x01), 'getBaseInfo     ');
cmd(frame(W | 0x05, 0x81, 0x01), 'getLight        ');
cmd(frame(W | 0x00, 0x81, 0x00), 'getVersion      ');
for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
  cmd(frame(W | 0x03, 0x82, 0x03, [idx]), 'getBtn idx=' + idx + '   ', 350);
}
cmd(frame(W | 0x07, 0x83, 0x01, [0, 0]), 'getMacro idx=0  ');

console.log('\n=== passive listen 8s (watch for 0xE2 status frames) ===');
readFor(8000, (r) => { if (r.slice(4, 63).some(b => b !== 0) || (r[0] & 0x3f) !== 0x1f) console.log('  <- ' + hex(r)); });
dev.close();
console.log('\n[i] done');
