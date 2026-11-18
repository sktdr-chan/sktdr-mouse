'use strict';
// scripts/probe-darmoshark.js — read-only probe for Darmoshark M5 (VID 0x1915)
// The vendor control collection is on interface 3 (usagePage 0xFF0A).
// Unknown protocol — try common patterns from other mouse families.
'use strict';
const HID = require('node-hid');
const VID = 0x1915, PID = 0x0725;

function hex(buf, max = 32) {
  return [...buf.slice(0, max)].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection'); process.exit(1); }
console.log('[i] vendor collection: iface=' + cols[0].interface + ' usagePage=0x' + cols[0].usagePage.toString(16));
const dev = new HID.HID(cols[0].path);

function readAll(ms = 400) {
  const results = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = dev.readTimeout(Math.min(100, deadline - Date.now())); if (r && r.length) results.push(Buffer.from(r)); } catch(e) { break; }
  }
  return results;
}

// Try 1: Scyrox-style (report ID 8, 16 bytes)
console.log('\n=== Try Scyrox-style (report ID 8, 16 bytes) ===');
try {
  const p = Buffer.alloc(16, 0);
  p[0] = 0x1d; // dongle version
  p[15] = 0x55 - 0x1d - 8;
  dev.write(Buffer.from([8, ...p]));
  const res = readAll(300);
  console.log('  sent dongleVer, got ' + res.length + ' responses');
  res.forEach((r, i) => console.log('  [' + i + '] ' + hex(r)));
} catch(e) { console.log('  write failed: ' + e.message); }

// Try 2: Scyrox-style battery (report ID 8, 16 bytes)
try {
  const p = Buffer.alloc(16, 0);
  p[0] = 0x04; // battery
  p[15] = 0x55 - 0x04 - 8;
  dev.write(Buffer.from([8, ...p]));
  const res = readAll(300);
  console.log('  sent battery, got ' + res.length + ' responses');
  res.forEach((r, i) => console.log('  [' + i + '] ' + hex(r)));
} catch(e) { console.log('  write failed: ' + e.message); }

// Try 3: MAD R-style battery (no report ID, 64 bytes)
console.log('\n=== Try MAD R-style (no report ID, 64 bytes) ===');
try {
  const p = Buffer.alloc(64, 0);
  p[0] = 0x90; p[1] = 0x0a;
  p[63] = 0x55 - 0x90 - 0x0a - 0x08; // checksum
  dev.write(p);
  const res = readAll(300);
  console.log('  sent 90 0a, got ' + res.length + ' responses');
  res.forEach((r, i) => console.log('  [' + i + '] ' + hex(r)));
} catch(e) { console.log('  write failed: ' + e.message); }

// Try 4: Report ID 1 (common Nordic pattern)
console.log('\n=== Try report ID 1 ===');
for (const cmd of [0x01, 0x03, 0x04, 0x0a, 0x12, 0x1d, 0x90]) {
  try {
    const p = Buffer.alloc(32, 0);
    p[0] = cmd;
    dev.write(Buffer.from([1, ...p]));
    const res = readAll(200);
    if (res.length) {
      console.log('  cmd=0x' + cmd.toString(16) + ' → ' + res.length + ' responses');
      res.forEach((r, i) => console.log('    [' + i + '] ' + hex(r)));
    }
  } catch(e) { /* skip */ }
}

// Try 5: Feature report
console.log('\n=== Try feature reports ===');
for (const rid of [1, 2, 4, 6, 8]) {
  try {
    const data = dev.getFeatureReport(rid, 64);
    if (data && data.length > 1 && data.some(b => b !== 0)) {
      console.log('  feature report ' + rid + ': ' + hex(Buffer.from(data)));
    }
  } catch(e) { /* not supported */ }
}

// Try 6: Raw input listening (passive, 3 seconds)
console.log('\n=== Passive listen (3s) — move the mouse ===');
const passive = readAll(3000);
console.log('  received ' + passive.length + ' packets');
passive.slice(0, 5).forEach((r, i) => console.log('  [' + i + '] ' + hex(r)));

dev.close();
console.log('\n[i] done.');
