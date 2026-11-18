'use strict';
// probe-philips2.js — passive listen on every vendor channel while the user
// moves the mouse, plus gentle pings on the FF06/0x0b channel.
const HID = require('node-hid');
const VID = 0x25aa, PID = 0x2012;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const targets = [
  { name: 'FF01 iface2', filter: (d) => (d.usagePage || 0) === 0xff01 },
  { name: 'FF05 iface1', filter: (d) => (d.usagePage || 0) === 0xff05 },
  { name: 'FF06 iface1', filter: (d) => (d.usagePage || 0) === 0xff06 },
];
const devs = [];
for (const t of targets) {
  const col = HID.devices().find((d) => d.vendorId === VID && d.productId === PID && t.filter(d));
  if (!col) { console.log('[!] ' + t.name + ' not found'); continue; }
  try {
    devs.push({ name: t.name, dev: new HID.HID(col.path) });
    console.log('[+] ' + t.name + ' opened');
  } catch (e) {
    console.log('[-] ' + t.name + ' open failed: ' + e.message);
  }
}

// gentle pings on FF06 (report id 0x0b + 64 bytes)
const ff06 = devs.find((d) => d.name.startsWith('FF06'));
if (ff06) {
  for (const probe of [
    Buffer.from([0x0b, 0x01, 0x00, 0x00]),
    Buffer.from([0x0b, 0x00, 0x01, 0x00]),
    Buffer.from([0x0b, 0xff, 0xff, 0xff]),
  ]) {
    const f = Buffer.alloc(65, 0);
    probe.copy(f, 0);
    try { ff06.dev.write(f); } catch (e) { console.log('  FF06 write fail: ' + e.message); }
    let got = [];
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      try {
        const raw = ff06.dev.readTimeout(80);
        if (raw && raw.length) got.push(Buffer.from(raw));
      } catch (e) { /* timeout */ }
    }
    for (const r of got) console.log('  FF06 ping ' + hex(f.slice(0, 4)) + ' <- ' + hex(r));
  }
}

console.log('\n[i] passive listen 25s on all channels — MOVE / CLICK THE MOUSE NOW');
const seen = new Map();
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  for (const { name, dev } of devs) {
    try {
      const raw = dev.readTimeout(60);
      if (raw && raw.length) {
        const r = Buffer.from(raw);
        const k = name + ':' + hex(r.slice(0, 8));
        if (!seen.has(k)) {
          seen.set(k, true);
          console.log('[' + ((Date.now() % 100000) / 1000).toFixed(1) + 's] ' + name + ' <- ' + hex(r));
        }
      }
    } catch (e) { /* timeout */ }
  }
}
console.log('[i] done — unique prefixes seen: ' + seen.size);
for (const d of devs) d.dev.close();
