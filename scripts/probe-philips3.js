'use strict';
// probe-philips3.js — command sweep with the discovered magic header AA FA AE 69.
// The event frame seen: aa fa ae 69 38 01 01 01 d0 5e + zeros.
// Try requests of the shape [magic][cmd][...] and watch for replies.
const HID = require('node-hid');
const VID = 0x25aa, PID = 0x2012;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const col = HID.devices().find((d) => d.vendorId === VID && d.productId === PID && (d.usagePage || 0) === 0xff01);
if (!col) { console.log('[!] no vendor collection'); process.exit(1); }
const dev = new HID.HID(col.path);

const MAGIC = Buffer.from([0xaa, 0xfa, 0xae, 0x69]);
function frame(...payload) {
  const f = Buffer.alloc(64, 0);
  MAGIC.copy(f, 0);
  for (let i = 0; i < Math.min(payload.length, 60); i++) f[4 + i] = payload[i] & 0xff;
  return f;
}
function send(frameBuf, label, waitMs = 350) {
  try { dev.write(Buffer.concat([Buffer.from([0x00]), frameBuf])); } catch (e) {
    console.log('  ' + label + ' write fail: ' + e.message);
    return null;
  }
  const frames = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const raw = dev.readTimeout(Math.min(80, deadline - Date.now()));
      if (raw && raw.length) frames.push(Buffer.from(raw));
    } catch (e) { /* timeout */ }
  }
  for (const r of frames) console.log('  ' + label + ' <- ' + hex(r.slice(0, 20)) + (r.length > 20 ? ' …' : ''));
  return frames[0] || null;
}

console.log('[i] echo the observed event frame');
send(frame(0x38, 0x01, 0x01, 0x01, 0xd0, 0x5e), 'echo event');

console.log('\n[i] command sweep [AA FA AE 69][cmd][01][00...]');
for (const cmd of [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x12, 0x14, 0x16, 0x18, 0x20, 0x21, 0x22, 0x24, 0x28, 0x30, 0x32, 0x34, 0x36, 0x38, 0x3a,
  0x40, 0x50, 0x60, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x90, 0xa0, 0xc0, 0xff,
]) {
  const r = send(frame(cmd, 0x01), 'cmd ' + cmd.toString(16).padStart(2, '0'), 220);
  if (r) console.log('    ^^^ RESPONDED');
}

console.log('\n[i] 0x38-style frames with sub variations');
for (const sub of [0x00, 0x01, 0x02, 0x03]) {
  send(frame(0x38, sub, 0x01, 0x01), '38 sub=' + sub);
}
for (const cmd of [0x37, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]) {
  send(frame(cmd, 0x01, 0x01, 0x01), 'neighbor ' + cmd.toString(16));
}

dev.close();
console.log('[i] done');
