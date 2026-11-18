'use strict';
// probe-razer3.js — write tests for the DeathAdder V3 Pro (wired):
// poll rate set (0x00/0x05), idle time set (0x07/0x03), and a no-op
// dpi-stages write-back (0x04/0x06) — all restored afterwards.
const HID = require('node-hid');
const VID = 0x1532, PID = 0x00b6;
const VARSTORE = 0x01;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const d = HID.devices().find((x) => x.vendorId === VID && x.productId === PID && x.interface === 0);
if (!d) { console.log('[!] device not found'); process.exit(1); }
const dev = new HID.HID(d.path);

function crc(body) {
  let c = 0;
  for (let i = 2; i < 88; i++) c ^= body[i];
  return c & 0xff;
}
function report(cls, cmd, dataSize, args = []) {
  const r = Buffer.alloc(90, 0);
  r[0] = 0x00;
  r[1] = 0x1f;
  r[5] = dataSize;
  r[6] = cls;
  r[7] = cmd;
  for (let i = 0; i < Math.min(args.length, 80); i++) r[8 + i] = args[i] & 0xff;
  r[88] = crc(r);
  return r;
}
function transact(cls, cmd, dataSize, args = [], label = '') {
  const req = report(cls, cmd, dataSize, args);
  dev.sendFeatureReport(Buffer.concat([Buffer.from([0x00]), req]));
  const resp = Buffer.from(dev.getFeatureReport(0x00, 91)).slice(1, 91);
  const ok = (resp[0] === 0x02 || resp[0] === 0x01) && resp[6] === cls && resp[7] === cmd;
  if (label) console.log('  ' + label + ' status=' + resp[0] + (ok ? '' : ' ✖'));
  return ok ? resp : null;
}

const RATES = { 1: 1000, 2: 500, 8: 125 };
const RATE_CODE = { 1000: 1, 500: 2, 125: 8 };

// baseline
const rate0 = transact(0x00, 0x85, 0x01, [], '');
const origRate = RATES[rate0[8]];
const idle0 = transact(0x07, 0x83, 0x02, [], '');
const origIdle = (idle0[8] << 8) | idle0[9];
console.log('[i] baseline: rate=' + origRate + 'Hz idle=' + origIdle + 's');

// poll rate write test
console.log('[i] poll rate 1000 -> 500 -> back');
let r = transact(0x00, 0x05, 0x01, [RATE_CODE[500]], '  set 500:');
let rb = transact(0x00, 0x85, 0x01, [], '  read:');
console.log('    => now ' + RATES[rb[8]] + 'Hz');
r = transact(0x00, 0x05, 0x01, [RATE_CODE[1000]], '  restore 1000:');
rb = transact(0x00, 0x85, 0x01, [], '  read:');
console.log('    => now ' + RATES[rb[8]] + 'Hz');

// idle time write test
console.log('[i] idle time ' + origIdle + ' -> 400 -> back');
r = transact(0x07, 0x03, 0x02, [(400 >> 8) & 0xff, 400 & 0xff], '  set 400:');
rb = transact(0x07, 0x83, 0x02, [], '  read:');
console.log('    => now ' + ((rb[8] << 8) | rb[9]) + 's');
r = transact(0x07, 0x03, 0x02, [(origIdle >> 8) & 0xff, origIdle & 0xff], '  restore ' + origIdle + ':');
rb = transact(0x07, 0x83, 0x02, [], '  read:');
console.log('    => now ' + ((rb[8] << 8) | rb[9]) + 's');

// DPI stages no-op write-back (write exactly what we read)
console.log('[i] dpi stages no-op write-back');
const st = transact(0x04, 0x86, 0x26, [VARSTORE], '  read stages:');
if (st) {
  const active = st[9], count = st[10];
  const args = [VARSTORE, active, count];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 7; j++) args.push(st[11 + i * 7 + j]);
  }
  const w = transact(0x04, 0x06, 0x26, args, '  write back:');
  const st2 = transact(0x04, 0x86, 0x26, [VARSTORE], '  read again:');
  if (st2) {
    console.log('    => active=' + st2[9] + ' count=' + st2[10] +
      ' stage1=' + ((st2[12] << 8) | st2[13]) + ' stage2=' + ((st2[19] << 8) | st2[20]));
    const same = st.slice(0, 11 + count * 7).equals(st2.slice(0, 11 + count * 7));
    console.log('    => identical: ' + same);
  }
}

// DPI stage value write test: stage1 800 -> 900 -> back
console.log('[i] dpi stage1 value test (800 -> 900 -> back)');
if (st) {
  const active = st[9], count = st[10];
  const buildArgs = (s1x) => {
    const a = [VARSTORE, active, count];
    for (let i = 0; i < count; i++) {
      if (i === 0) {
        a.push(1, (s1x >> 8) & 0xff, s1x & 0xff, (s1x >> 8) & 0xff, s1x & 0xff, 0, 0);
      } else {
        for (let j = 0; j < 7; j++) a.push(st[11 + i * 7 + j]);
      }
    }
    return a;
  };
  transact(0x04, 0x06, 0x26, buildArgs(900), '  set stage1=900:');
  let s2 = transact(0x04, 0x86, 0x26, [VARSTORE], '  read:');
  console.log('    => stage1=' + ((s2[12] << 8) | s2[13]));
  transact(0x04, 0x06, 0x26, buildArgs(800), '  restore 800:');
  s2 = transact(0x04, 0x86, 0x26, [VARSTORE], '  read:');
  console.log('    => stage1=' + ((s2[12] << 8) | s2[13]));
}

dev.close();
console.log('[i] done');
