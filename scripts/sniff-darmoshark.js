'use strict';
// Darmoshark M5 sniffer — passive listener on the vendor collection.
// Run this WHILE the official web driver talks to the dongle; Windows HID
// delivers input reports to all open handles, so we see the device's
// responses to the browser's commands.
const HID = require('node-hid');
const VID = 0x1915, PID = 0x0725;
const RUN_MS = 10 * 60 * 1000;

function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

let dev = null;
const cols = HID.devices().filter(d => d.vendorId === VID && (d.usagePage || 0) >= 0xff00);
if (!cols.length) { console.log('[!] no vendor collection — is the dongle plugged in?'); process.exit(1); }
console.log('[i] sniffing ' + cols[0].path.slice(0, 60) + '...');
dev = new HID.HID(cols[0].path);

const START = Date.now();
let offline = 0, lastReport = START;

while (Date.now() - START < RUN_MS) {
  try {
    const raw = dev.readTimeout(500);
    if (!raw || !raw.length) continue;
    const r = Buffer.from(raw);
    const t = ((Date.now() - START) / 1000).toFixed(1);
    if ((r[0] & 0x3f) === 0x1f) {
      offline++;
      if (Date.now() - lastReport > 15000) {
        console.log('[' + t + 's] ... ' + offline + ' offline frames so far');
        lastReport = Date.now();
      }
      continue;
    }
    console.log('[' + t + 's] FRAME: ' + hex(r));
    lastReport = Date.now();
  } catch (e) {
    // read timeout — loop
  }
}
console.log('[i] sniff done. offline frames: ' + offline);
dev.close();
