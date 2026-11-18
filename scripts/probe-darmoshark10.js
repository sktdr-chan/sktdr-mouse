'use strict';
// Darmoshark M5 probe 10 — the browser (WebHID) writes 65 bytes:
//   [0x00 report ID][64-byte frame]. hidapi may need the same explicit form.
// Compare 64-byte vs 65-byte writes for the handshake and getBaseInfo.
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

function attempt(f, prefix, label, waitMs = 700) {
  const wire = prefix ? Buffer.concat([Buffer.from([0x00]), f]) : f;
  let sent;
  try { sent = dev.write(wire); } catch (e) { console.log('  ' + label + ' WRITE FAILED: ' + e.message); return null; }
  const frames = [];
  readFor(waitMs, (r) => frames.push(r));
  for (const r of frames) {
    const t = r[0] & 0x3f;
    const tag = t === 0x1f ? ' [offline]' : ' ★';
    console.log('  ' + label + ' (wrote ' + wire.length + 'B=' + sent + ') <- ' + hex(r) + tag);
  }
  if (!frames.length) console.log('  ' + label + ' (wrote ' + wire.length + 'B=' + sent + ') <- (nothing)');
  return frames.find((r) => (r[0] & 0x3f) !== 0x1f) || null;
}

console.log('[i] handshake [01 00 81 01]');
attempt(frame(0x01, 0x81, 0x01), false, 'hs 64B plain');
attempt(frame(0x01, 0x81, 0x01), true, 'hs 65B plain');

console.log('[i] getBaseInfo [04 00 81 01]');
attempt(frame(0x04, 0x81, 0x01), false, 'bi 64B plain');
attempt(frame(0x04, 0x81, 0x01), true, 'bi 65B plain');

console.log('[i] getLight [05 00 81 01]');
attempt(frame(0x05, 0x81, 0x01), false, 'li 64B plain');
attempt(frame(0x05, 0x81, 0x01), true, 'li 65B plain');

console.log('[i] getPower [01 00 81 01] 65B again (repeat)');
attempt(frame(0x01, 0x81, 0x01), true, 'hs 65B #2');
attempt(frame(0x44, 0x81, 0x01), true, 'bi 65B W=40');

dev.close();
console.log('\n[i] done');
