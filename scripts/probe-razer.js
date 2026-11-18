'use strict';
// probe-razer.js — can we open the DeathAdder V3 Pro interfaces, and does
// the openrazer control protocol work over HID feature reports on Windows?
const HID = require('node-hid');
const VID = 0x1532;

function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const devs = HID.devices().filter((d) => d.vendorId === VID);
for (const d of devs) {
  let opened = null;
  try {
    opened = new HID.HID(d.path);
    console.log('[+] OPEN iface=' + d.interface + ' usagePage=0x' + (d.usagePage || 0).toString(16) + ' usage=0x' + (d.usage || 0).toString(16));
    // feature report caps?
    try {
      const feat = opened.getFeatureReport(0x00, 91);
      console.log('    getFeatureReport(0, 91) -> ' + hex(Buffer.from(feat)));
    } catch (e) {
      console.log('    getFeatureReport failed: ' + e.message);
    }
    opened.close();
  } catch (e) {
    console.log('[-] iface=' + d.interface + ' usagePage=0x' + (d.usagePage || 0).toString(16) + ': ' + e.message);
  }
}

// build a razer report and try the fw-version query on every openable iface
function crc(report) {
  let c = 0;
  for (let i = 2; i < 88; i++) c ^= report[i];
  return c & 0xff;
}
function razerReport(cls, cmd, dataSize, args = [], transaction = 0x1f) {
  const r = Buffer.alloc(90, 0);
  r[0] = 0x00; // status
  r[1] = transaction;
  // [2..3] remaining packets BE = 0
  r[4] = 0x00; // protocol type
  r[5] = dataSize;
  r[6] = cls;
  r[7] = cmd;
  for (let i = 0; i < Math.min(args.length, 80); i++) r[8 + i] = args[i] & 0xff;
  r[88] = crc(r);
  r[89] = 0x00;
  return r;
}

for (const d of devs) {
  let dev = null;
  try {
    dev = new HID.HID(d.path);
  } catch (e) {
    continue;
  }
  console.log('[i] trying fw-version on iface=' + d.interface + ' usage=' + (d.usage || 0).toString(16));
  const req = razerReport(0x00, 0x81, 0x02);
  const buf = Buffer.concat([Buffer.from([0x00]), req]); // report id 0 + body
  try {
    const w = dev.sendFeatureReport(buf);
    console.log('    sendFeatureReport -> ' + w + ' bytes');
    const resp = Buffer.from(dev.getFeatureReport(0x00, 91));
    console.log('    response: ' + hex(resp));
  } catch (e) {
    console.log('    failed: ' + e.message);
  }
  dev.close();
}
