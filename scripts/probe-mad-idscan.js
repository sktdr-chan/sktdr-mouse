// scripts/probe-mad-idscan.js — find which output report ID the MAD R's
// 17-byte collection (usagePage 0xFF02) accepts on Windows.
// Sends the harmless battery query with every candidate report ID and
// reports which IDs are accepted by the HID layer and whether the device
// answers. Read-only in effect (the payload is always a battery read).
'use strict';

const HID = require('node-hid');

const VID = 0x373b;

function checksum16(p) {
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += p[i];
  return (((0x55 - (sum & 0xff) - 8) % 256) + 256) % 256;
}

function batteryPacket() {
  const p = Buffer.alloc(16, 0);
  p[0] = 0x04;
  p[15] = checksum16(p);
  return p;
}

function main() {
  const cols = HID.devices().filter(
    (d) => d.vendorId === VID && (d.usagePage || 0) === 0xff02
  );
  if (!cols.length) {
    console.error('[!] FF02 collection not found');
    process.exit(1);
  }
  const dev = new HID.HID(cols[0].path);
  const pkt = batteryPacket();
  const results = [];
  for (let id = 0; id <= 0x20; id++) {
    const buf = Buffer.alloc(17, 0);
    buf[0] = id;
    pkt.copy(buf, 1);
    let err = null;
    try {
      dev.write(buf);
    } catch (e) {
      err = e.message.replace('Cannot write to hid device: ', '');
    }
    if (!err) {
      // accepted — try to read an answer
      let res = null;
      try {
        res = dev.readTimeout(120);
      } catch (e) { /* timeout */ }
      const hex = res ? [...res].map((b) => b.toString(16).padStart(2, '0')).join(' ') : '(no answer)';
      results.push(`  id=0x${id.toString(16).padStart(2, '0')}: ACCEPTED → ${hex.slice(0, 90)}`);
    }
  }
  console.log('[i] accepted output report IDs for the FF02 collection:');
  console.log(results.length ? results.join('\n') : '  (none — output may be unnumbered or absent)');
  try { dev.close(); } catch (e) { /* ignore */ }
}

main();
