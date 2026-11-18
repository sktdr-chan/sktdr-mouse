'use strict';
// Darmoshark M5 probe 13 — WRITE path verification (no-op except the light,
// which turns steady red at 25% so the user can see it worked).
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
  for (const r of frames) {
    console.log('  ' + label + ' <- ' + hex(r.slice(0, 24)) + (r.length > 24 ? ' …' : ''));
  }
  if (!frames.length) console.log('  ' + label + ' <- (nothing)');
  return frames[0] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('[i] baseline');
  cmd(frame(0x45, 0x81, 0x01), 'getLight ');

  console.log('[i] setLight: steady RED, brightness 0x40 (visible!)');
  cmd(frame(0x45, 0x91, 0x02, [0x01, 0x40, 0x07, 0x01, 0x01, 0x01, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00]), 'setLight ');
  await sleep(150);
  cmd(frame(0x4a, 0x81, 0x01), 'saveData ');
  await sleep(300);
  cmd(frame(0x45, 0x81, 0x01), 'getLight2');

  console.log('[i] no-op writes (verify each command is accepted)');
  cmd(frame(0x44, 0x86, 0x0e, [0x58, 0x02, 0x58, 0x02, 0x00]), 'setBtnTime');
  await sleep(150);
  cmd(frame(0x44, 0x84, 0x04, [0x04]), 'setRate  ');
  await sleep(150);
  cmd(frame(0x44, 0x84, 0x0a, [0xb0, 0x00, 0x00]), 'setExt   ');
  await sleep(150);

  // setDpi no-op: payload = image bytes 4..54 as read from getBaseInfo
  const bi = cmd(frame(0x44, 0x81, 0x01), 'getBaseI ');
  if (bi) {
    const payload = [...bi.slice(4, 55)];
    cmd(frame(0x44, 0xb5, 0x02, payload), 'setDpi   ');
    await sleep(150);
  }
  cmd(frame(0x4a, 0x81, 0x01), 'saveData2');
  await sleep(300);
  cmd(frame(0x44, 0x81, 0x01), 'getBaseI2');

  dev.close();
  console.log('[i] done');
})();
