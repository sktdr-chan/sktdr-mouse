// scripts/probe-roccat.js — read-only probe for ROCCAT Kone Pro Air (wired)
//
// Device under test: 1e7d:2c92 "ROCCAT Kone Pro Air", wired.
// Control channel: interface 1 (usagePage 0xFF13), UNNUMBERED 65-byte
// input/output reports (verified via HidP caps dump — no feature reports).
//
// Protocol references (same device family):
//  - Kone Pro wired 1e7d:2c88 — Tobbesson/roccat-konepro-linux (konepro.c):
//    feature-report register protocol, interface 3:
//      04 <profile> 80 00   -> select profile's SETTINGS register (read-select)
//      04 <profile> 90 00   -> select profile's BUTTONS register
//      GET report 06       -> 69-byte profile data (DPI/polling/LED...)
//      report 11           -> debounce time (13 bytes + checksum)
//    profile data layout: [6] active DPI switch, [7+2i] DPI (x50, LE16),
//    [29] polling (125*2^n), [30] LED mode, [31] LED speed, [32] brightness,
//    [38-40]/[43-45] left/right RGB, [67-68] checksum (sum of bytes 0..66, LE)
//  - Kone Pro Air dongle 1e7d:2c8e — mattiasdjarv/kone-battery (kone-daemon):
//    the mouse PUSHES diagnostic input reports: 90 0A <battery%>,
//    90 07 0D (charging) on a vendor usagePage 0xFF00/FF01 collection.
//
// This probe only performs passive listening and documented READ-select
// register commands. Nothing that changes configuration is sent.
'use strict';

const HID = require('node-hid');

const VENDOR_ID = 0x1e7d;
const REPORT_LEN = 65;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hex(buf, max = 32) {
  return [...buf.slice(0, max)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function openControl() {
  const meta = HID.devices().find((d) => d.vendorId === VENDOR_ID && (d.usagePage || 0) === 0xff13);
  if (!meta) return null;
  return new HID.HID(meta.path);
}

function readPacket(dev, ms) {
  try {
    const raw = dev.readTimeout(ms);
    if (raw && raw.length) return Buffer.from(raw);
  } catch (e) {
    /* timeout */
  }
  return null;
}

async function listen(dev, ms, label) {
  const deadline = Date.now() + ms;
  let count = 0;
  while (Date.now() < deadline) {
    const pkt = readPacket(dev, Math.min(500, deadline - Date.now()));
    if (!pkt) continue;
    count += 1;
    const tag = pkt[0] === 0x90 ? ' *** DIAGNOSTIC ***' : '';
    console.log(`    [${label}] ${hex(pkt)}${tag}`);
    if (pkt[0] === 0x90 && pkt[1] === 0x0a) {
      console.log(`    [${label}] *** battery=${pkt[5]}%`);
    }
  }
  if (count === 0) console.log(`    [${label}] (nothing pushed)`);
}

async function tx(dev, payload, label, listenMs = 2500) {
  const buf = Buffer.alloc(REPORT_LEN, 0);
  buf[0] = 0x00; // unnumbered report
  for (let i = 0; i < Math.min(payload.length, REPORT_LEN - 1); i++) buf[1 + i] = payload[i] & 0xff;
  try {
    dev.write(buf);
  } catch (e) {
    console.log(`    ${label}: write failed (${e.message})`);
    return;
  }
  console.log(`    ${label}: sent, listening for answers…`);
  await listen(dev, listenMs, label);
}

async function main() {
  const dev = openControl();
  if (!dev) {
    console.error('[!] Kone Pro Air control collection (usagePage 0xFF13) not found');
    process.exit(1);
  }
  console.log('[i] control collection opened (iface 1, usagePage 0xFF13)');

  // passive listening while the user interacts with the mouse:
  // the device family pushes diagnostic reports (battery 90 0A, DPI stage,
  // profile changes…) on its vendor input channel on button presses.
  console.log('[i] passive listen 45s — PRESS the DPI button, scroll the wheel,');
  console.log('    and press the profile/Easy-Shift button a few times NOW …');
  await listen(dev, 45000, 'idle');

  dev.close();
  console.log('[i] probe done (read-only).');
}

main().catch((e) => {
  console.error('[!] probe error:', e);
  process.exit(1);
});
