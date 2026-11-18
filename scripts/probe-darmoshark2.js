'use strict';
// Darmoshark M5 probe 2 — well-formed power query per documented protocol
// Frame: [type|0x40(wireless), index, opcode, sub, payload..., checksum@63]
// checksum: whole 64-byte report sums to 0xa1 mod 256
const HID = require('node-hid');
const VID = 0x1915, PID = 0x0725;
const LEN = 64, TARGET = 0xa1;

function cksum(frame) {
  let sum = 0;
  for (let i = 0; i < LEN - 1; i++) sum += frame[i];
  frame[LEN - 1] = (TARGET - (sum & 0xff)) & 0xff;
  return frame;
}
function frame(type, index, opcode, sub, payload = []) {
  const f = Buffer.alloc(LEN, 0);
  f[0] = type; f[1] = index; f[2] = opcode; f[3] = sub;
  for (let i = 0; i < Math.min(payload.length, LEN - 5); i++) f[4 + i] = payload[i];
  return cksum(f);
}
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection'); process.exit(1); }
console.log('[i] using iface=' + cols[0].interface + ' usagePage=0x' + cols[0].usagePage.toString(16));
const dev = new HID.HID(cols[0].path);

function drain(ms = 100) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { dev.readTimeout(20); } catch (e) { break; }
  }
}
function send(f, label, waitMs = 800) {
  drain(50);
  dev.write(f);
  const deadline = Date.now() + waitMs;
  let n = 0;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(100, deadline - Date.now()));
      if (raw && raw.length) {
        const r = Buffer.from(raw);
        n++;
        console.log('  ' + label + ' resp[' + n + '] (' + r.length + 'B): ' + hex(r));
      }
    } catch (e) { /* timeout */ }
  }
  if (!n) console.log('  ' + label + ': NO RESPONSE');
}

console.log('\n=== power query wireless (41 00 81 01) ===');
send(frame(0x41, 0x00, 0x81, 0x01), 'pw-wireless');

console.log('\n=== power query wired (01 00 81 01) ===');
send(frame(0x01, 0x00, 0x81, 0x01), 'pw-wired');

console.log('\n=== power query wireless, sub=0 (41 00 81 00) ===');
send(frame(0x41, 0x00, 0x81, 0x00), 'pw-sub0');

console.log('\n=== power query wireless, index=1 (41 01 81 01) ===');
send(frame(0x41, 0x01, 0x81, 0x01), 'pw-idx1');

dev.close();
console.log('\n[i] done');
