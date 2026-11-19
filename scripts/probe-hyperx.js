'use strict';

// Read-only probe for HyperX Pulsefire Haste Wireless (03f0:028e).
// Sends only NGenuity2 "get" commands (0x50 hardware info, 0x51 heartbeat,
// 0x52 LED settings) and prints the replies. No settings are written.

const HID = require('node-hid');

// Usage: node scripts/probe-hyperx.js [--pid=0x028e] [--write-test]
const pidArg = process.argv.find((a) => a.startsWith('--pid='));
const VID = 0x03f0;
const PID = pidArg ? parseInt(pidArg.split('=')[1], 16) : 0x028e;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');

function findPath() {
  const devs = HID.devices().filter(
    (d) =>
      d.vendorId === VID &&
      d.productId === PID &&
      d.interface === 2 &&
      d.usagePage === 0xff00
  );
  if (!devs.length) {
    console.error('device not found (is the mouse/dongle connected?)');
    process.exit(1);
  }
  return devs[0].path;
}

async function main() {
  const path = findPath();
  console.log('path:', path);
  const dev = new HID.HID(path);

  dev.on('data', (d) => console.log('IN  ', d.length, hex(Buffer.from(d))));
  dev.on('error', (e) => console.error('HID error:', e.message));

  // 65 bytes = report ID 0x00 + 64-byte payload
  const send = (cmd, data = []) => {
    const buf = Buffer.alloc(65);
    buf[0] = 0x00;
    buf[1] = cmd;
    for (let i = 0; i < data.length && i < 63; i++) buf[2 + i] = data[i];
    console.log('OUT ', buf.length, hex(buf.subarray(0, 12)), '…');
    dev.write(buf);
  };

  const writeTest = process.argv.includes('--write-test');

  const requests = [
    ['hardware info', 0x50],
    ['heartbeat', 0x51],
    ['LED settings', 0x52],
  ];

  for (const [name, cmd] of requests) {
    console.log(`\n--- ${name} (0x${cmd.toString(16)}) ---`);
    send(cmd);
    await sleep(700);
  }

  if (writeTest) {
    console.log('\n--- write test: polling 1000Hz (D0) ---');
    send(0xd0, [0x00, 0x00, 0x01, 0x03]);
    await sleep(500);

    console.log('\n--- write test: static red, 100% (D2) ---');
    send(0xd2, [0x00, 0x00, 0x08, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x64, 0x00]);
    await sleep(500);
    send(0x52);
    await sleep(700);

    console.log('\n--- restore: static white, 100% (D2) ---');
    send(0xd2, [0x00, 0x00, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x64, 0x00]);
    await sleep(500);
    send(0x52);
    await sleep(700);

    console.log('\n--- save (DE FF) ---');
    send(0xde, [0xff]);
    await sleep(700);
  }

  await sleep(500);
  dev.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
