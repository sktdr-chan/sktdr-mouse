// scripts/probe-mad.js — read-only probe for the VXE MAD R / MAD R Major
// (VID 0x373B, PIDs 0x103F wired / 0x1040 8K dongle).
//
// Protocol reference: https://github.com/dkbednarczyk/madr (madr-lib, Rust)
//  - battery  : cmd 0x04 — same layout as the Scyrox family
//  - pages   : cmd 0x08 read / 0x07 write, 16-byte packets, report ID 0x08,
//              checksum = (0x55 - sum - 8) & 0xFF (identical to Scyrox)
//  - page map (from madr-lib):
//      0x00 (6B)  : [pollingRate, comp, 04, 51, activeStage(stored-1), comp]
//      0xA9 (10B) : [debounce, comp, 01, 54, sleepTensOfSec, comp, 00, 55, 00, 55]
//      0xB5 (6B)  : [00, 55, 06, 4f, sensorMode, comp] (mode: 0/1/2)
//      0x0C+8*n   : DPI pair n — 2 stages of [xLow, yLow, hi, ck] (X/Y independent)
//      0x2C+8*n   : RGB pair n — 2 stages of [r, g, b, ck(0x55-sum)]
//
// Pass --write-test to additionally verify the write path with no-op writes
// (writes the currently stored values back unchanged) and check whether
// partial (short) writes preserve the rest of a page.
'use strict';

const HID = require('node-hid');

const VID = 0x373b;
const PIDS = [0x103f, 0x1040];
const REPORT_ID = 8;
const PKT_LEN = 16;

function checksum16(p) {
  let sum = 0;
  for (let i = 0; i < PKT_LEN - 1; i++) sum += p[i];
  return (((0x55 - (sum & 0xff) - REPORT_ID) % 256) + 256) % 256;
}

function buildPacket(cmd, addr = 0, len = 0, data = []) {
  const p = Buffer.alloc(PKT_LEN, 0);
  p[0] = cmd;
  p[3] = addr & 0xff; // MAD R "page" lives at the address-low position
  p[4] = len & 0xff;
  for (let i = 0; i < Math.min(data.length, 10); i++) p[5 + i] = data[i] & 0xff;
  p[15] = checksum16(p);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hex(buf, max = 20) {
  return [...buf.slice(0, max)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function transact(dev, packet, timeout = 200, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      dev.write(Buffer.from([REPORT_ID, ...packet]));
    } catch (e) {
      return null; // this collection does not accept output reports
    }
    let raw = null;
    try {
      raw = dev.readTimeout(timeout);
    } catch (e) {
      /* timeout */
    }
    if (!raw || raw.length === 0) continue;
    const buf = Buffer.from(raw);
    const res = buf[0] === REPORT_ID && buf.length >= PKT_LEN + 1 ? buf.slice(1, 1 + PKT_LEN) : buf.slice(0, PKT_LEN);
    if (res.length >= PKT_LEN && res[0] === packet[0]) return res;
  }
  return null;
}

const readPage = (dev, page, len) => transact(dev, buildPacket(0x08, page, len));
const writePage = (dev, page, data) => transact(dev, buildPacket(0x07, page, data.length, data));

function decodeDpiXY(b) {
  const xHigh = (b[2] >> 2) & 0x0f;
  const yHigh = (b[2] >> 6) & 0x03;
  const x = ((xHigh << 8) | b[0]) + 1;
  const y = ((yHigh << 8) | b[1]) + 1;
  return { x: x * 50, y: y * 50 };
}

const RATES = { 8: 125, 4: 250, 2: 500, 1: 1000, 0x10: 2000, 0x20: 4000, 0x40: 8000 };
const SENSOR_MODES = { 0: 'Basic', 1: 'Competitive', 2: 'Max' };

async function main() {
  const doWriteTest = process.argv.includes('--write-test');
  const all = HID.devices().filter((d) => d.vendorId === VID && PIDS.includes(d.productId));
  console.log(`[i] ${all.length} collection(s) for VID 0x373b`);
  const vendor = all.filter((d) => (d.usagePage || 0) >= 0xff00);

  let dev = null;
  for (const meta of vendor) {
    let d = null;
    try {
      d = new HID.HID(meta.path);
    } catch (e) {
      continue;
    }
    const res = transact(d, buildPacket(0x04), 150, 1);
    // battery may legitimately time out if the mouse is asleep — the collection
    // is still the right one if a page read answers:
    const page = res || transact(d, buildPacket(0x08, 0x00, 6), 150, 1);
    if (page) {
      dev = d;
      console.log(`[+] control collection: usagePage=0x${(meta.usagePage || 0).toString(16)} iface=${meta.interface}`);
      break;
    }
    try { d.close(); } catch (e) { /* ignore */ }
  }
  if (!dev) {
    console.error('[!] no responding control collection found');
    process.exit(1);
  }

  // battery
  const bat = transact(dev, buildPacket(0x04));
  if (bat) {
    const mv = (bat[7] << 8) | bat[8];
    console.log(`[i] battery: ${bat[5]}% charging=${bat[6]} voltage=${mv}mV  (raw: ${hex(bat)})`);
  } else {
    console.log('[!] battery query no answer (mouse asleep? move the mouse)');
  }

  // page reads
  const PAGES = [
    { page: 0x00, len: 6, name: 'performance (rate+stage)' },
    { page: 0xa9, len: 10, name: 'debounce+sleep' },
    { page: 0xb5, len: 6, name: 'sensor mode' },
    ...[0, 1, 2, 3].map((n) => ({ page: 0x0c + n * 8, len: 8, name: `DPI pair ${n + 1}` })),
    ...[0, 1, 2, 3].map((n) => ({ page: 0x2c + n * 8, len: 8, name: `RGB pair ${n + 1}` })),
  ];
  const image = {};
  for (const p of PAGES) {
    const res = readPage(dev, p.page, p.len);
    if (res) {
      const data = res.slice(5, 5 + p.len);
      image[p.page] = Buffer.from(data);
      console.log(`[i] page 0x${p.page.toString(16).padStart(2, '0')} (${p.name}): ${hex(data, 10)}`);
    } else {
      console.log(`[-] page 0x${p.page.toString(16).padStart(2, '0')} (${p.name}): no answer`);
    }
  }

  // decode
  if (image[0x00]) {
    const rate = RATES[image[0x00][0]] || `? (raw ${image[0x00][0]})`;
    console.log(`[i] performance: rate=${rate} Hz, activeStage=${image[0x00][4] + 1} (stored ${image[0x00][4]})`);
  }
  if (image[0xa9]) {
    console.log(`[i] block 0xA9: debounce=${image[0xa9][0]}ms, sleep=${image[0xa9][4] * 10}s`);
  }
  if (image[0xb5]) {
    console.log(`[i] block 0xB5: sensorMode=${SENSOR_MODES[image[0xb5][4]] ?? image[0xb5][4]}`);
  }
  for (let n = 0; n < 4; n++) {
    const pg = image[0x0c + n * 8];
    if (!pg) continue;
    const a = decodeDpiXY(pg.slice(0, 4));
    const b = decodeDpiXY(pg.slice(4, 8));
    console.log(`[i] DPI pair ${n + 1}: stage${n * 2 + 1} X=${a.x}/Y=${a.y}, stage${n * 2 + 2} X=${b.x}/Y=${b.y}`);
  }
  for (let n = 0; n < 4; n++) {
    const pg = image[0x2c + n * 8];
    if (!pg) continue;
    console.log(
      `[i] RGB pair ${n + 1}: rgb(${pg[0]},${pg[1]},${pg[2]}) ck=${pg[3].toString(16)} / rgb(${pg[4]},${pg[5]},${pg[6]}) ck=${pg[7].toString(16)}`
    );
  }

  if (doWriteTest) {
    console.log('[i] write test — no-op writes of current values:');
    // 1) partial write on the performance page: rewrite only [rate, comp]
    if (image[0x00]) {
      const rate = image[0x00][0];
      const res = writePage(dev, 0x00, [rate, (0x55 - rate) & 0xff]);
      console.log(`    partial 0x00 [rate,comp] -> ${res ? 'ACK' : 'no answer'}`);
      const back = readPage(dev, 0x00, 6);
      if (back) {
        const d = back.slice(5, 11);
        const preserved = image[0x00].slice(2, 6).equals(d.slice(2, 6));
        console.log(`    readback: ${hex(d, 6)} — stage/magic bytes ${preserved ? 'PRESERVED ✓' : 'CHANGED ✗ (need full-block writes)'}`);
      }
    }
    // 2) full-block no-op write of DPI pair 1
    if (image[0x0c]) {
      const res = writePage(dev, 0x0c, [...image[0x0c]]);
      console.log(`    full 0x0C DPI pair write-back -> ${res ? 'ACK' : 'no answer'}`);
      const back = readPage(dev, 0x0c, 8);
      if (back) {
        const d = back.slice(5, 13);
        const ok = d.equals(image[0x0c]);
        console.log(`    readback: ${hex(d, 8)} — ${ok ? 'IDENTICAL ✓' : 'DIFFERS ✗'}`);
      }
    }
  }

  try { dev.close(); } catch (e) { /* ignore */ }
  console.log('[i] done.');
}

main().catch((e) => {
  console.error('[!] probe error:', e);
  process.exit(1);
});
