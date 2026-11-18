'use strict';
// probe-razer2.js — full read suite over HID feature reports (iface 0),
// openrazer protocol. Verified format:
//   send: sendFeatureReport([0x00, ...90-byte report])
//   recv: getFeatureReport(0x00, 91) -> [0x00, ...90-byte response]
const HID = require('node-hid');
const VID = 0x1532, PID = 0x00b6;
const VARSTORE = 0x01;
const RATES = { 0x01: 8000, 0x02: 4000, 0x04: 2000, 0x08: 1000, 0x10: 500, 0x40: 125 };
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

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
  r[1] = 0x1f; // transaction id (DA V3 Pro)
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
  const raw = Buffer.from(dev.getFeatureReport(0x00, 91));
  const resp = raw.slice(1, 91);
  const status = resp[0];
  const ok =
    (status === 0x02 || status === 0x01) &&
    resp[6] === cls &&
    resp[7] === cmd;
  console.log(
    '  ' + pad(label, 18) + ' -> status=' + status + (ok ? '' : ' ✖') + ' ' + hex(resp.slice(0, 20)) +
    (resp.length > 20 ? ' …' : '')
  );
  return ok ? resp : null;
}

console.log('[i] full read suite (openrazer protocol, feature reports)');

// firmware version
const fw = transact(0x00, 0x81, 0x02, [], 'fw version');
if (fw) console.log('      => v' + fw[9] + '.' + String(fw[10]).padStart(2, '0'));

// serial
const ser = transact(0x00, 0x82, 0x16, [], 'serial');
if (ser) {
  let s = '';
  for (let i = 9; i < 9 + 22; i++) if (ser[i] >= 0x20 && ser[i] < 0x7f) s += String.fromCharCode(ser[i]);
  console.log('      => "' + s.trim() + '"');
}

// DPI stages: [VARSTORE] -> resp: args[1]=active, args[2]=count,
// stages at args[3 + 7*i]: [idx, Xhi, Xlo, Yhi, Ylo, 0, 0]
const st = transact(0x04, 0x86, 0x26, [VARSTORE], 'dpi stages');
if (st) {
  const active = st[9], count = st[10];
  console.log('      => active=' + active + ' count=' + count);
  for (let i = 0; i < count; i++) {
    const o = 11 + i * 7;
    const x = (st[o + 1] << 8) | st[o + 2];
    const y = (st[o + 3] << 8) | st[o + 4];
    console.log('      => stage ' + st[o] + ': ' + x + 'x' + y);
  }
}

// current DPI (VARSTORE)
const dpi = transact(0x04, 0x85, 0x07, [VARSTORE], 'dpi xy');
if (dpi) {
  const x = (dpi[9] << 8) | dpi[10];
  const y = (dpi[11] << 8) | dpi[12];
  console.log('      => ' + x + 'x' + y);
}

// polling rate (rate2: code in args[0])
const rate = transact(0x00, 0xc0, 0x01, [], 'poll rate');
if (rate) console.log('      => ' + (RATES[rate[8]] || '?') + ' Hz (code 0x' + rate[8].toString(16) + ')');

// battery level (args[1]) and charging (args[1])
const bat = transact(0x07, 0x80, 0x02, [], 'battery');
if (bat) console.log('      => level=' + bat[9]);
const chg = transact(0x07, 0x84, 0x02, [], 'charging');
if (chg) console.log('      => charging=' + chg[9]);

// idle time (BE16 seconds)
const idle = transact(0x07, 0x83, 0x02, [], 'idle time');
if (idle) console.log('      => ' + ((idle[8] << 8) | idle[9]) + ' sec');

dev.close();
console.log('[i] done');
