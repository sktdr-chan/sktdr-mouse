'use strict';
// probe-superlight4.js — verify DPI (0x2201 fn2 read / fn3 write) on the
// PRO X Wireless. Restores the original host-mode value afterwards.
const HID = require('node-hid');
const VID = 0x046d;
const SWID = 0x0a;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const longCol = HID.devices().find((d) => d.vendorId === VID && (d.usagePage || 0) === 0xff00 && (d.usage || 0) === 0x0002);
if (!longCol) { console.log('[!] no long collection'); process.exit(1); }
const dev = new HID.HID(longCol.path);
const DEV = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(featIdx, fn, params = [], timeoutMs = 1500, retries = 2) {
  const pkt = Buffer.alloc(20, 0);
  pkt[0] = 0x11; pkt[1] = DEV; pkt[2] = featIdx; pkt[3] = (fn << 4) | SWID;
  for (let i = 0; i < Math.min(params.length, 16); i++) pkt[4 + i] = params[i] & 0xff;
  for (let a = 0; a <= retries; a++) {
    try { dev.write(pkt); } catch (e) { return { error: 0xff }; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let raw;
      try { raw = dev.readTimeout(100); } catch (e) { continue; }
      if (!raw || raw.length < 7) continue;
      const d = Buffer.from(raw);
      if (d[1] !== DEV) continue;
      if ((d[2] === 0xff || d[2] === 0x8f) && d[3] === featIdx && d[4] === pkt[3]) return { error: d[5] };
      if (d[2] === featIdx && d[3] === pkt[3]) return { reply: d };
    }
  }
  return null;
}

(async () => {
  const r0 = request(0x00, 0, [0x22, 0x01]);
  const dpiF = r0.reply ? r0.reply[4] : 0;
  const r1 = request(0x00, 0, [0x81, 0x00]);
  const obF = r1.reply ? r1.reply[4] : 0;
  console.log('[i] DPI feature idx=' + dpiF + ', onboard idx=' + obF);

  const cur = request(dpiF, 2, [0]);
  if (cur && cur.reply) {
    const dpi = (cur.reply[5] << 8) | cur.reply[6];
    const def = (cur.reply[7] << 8) | cur.reply[8];
    console.log('[i] current host DPI (fn2): ' + dpi + '  default: ' + def + '  raw: ' + hex(cur.reply.slice(4, 10)));
  } else {
    console.log('[i] DPI read failed: ' + JSON.stringify(cur));
  }

  // ensure host mode, write 800, read back
  console.log('[i] switching to HOST mode for the write test');
  request(obF, 1, [2]);
  await sleep(300);
  const w = request(dpiF, 3, [0, (800 >> 8) & 0xff, 800 & 0xff]);
  console.log('    set 800: ' + JSON.stringify(w && w.error != null ? { error: w.error } : 'ok'));
  const rb = request(dpiF, 2, [0]);
  if (rb && rb.reply) console.log('    read back: ' + ((rb.reply[5] << 8) | rb.reply[6]));

  // try a high value to learn the accepted range
  const w2 = request(dpiF, 3, [0, (25600 >> 8) & 0xff, 25600 & 0xff]);
  const rb2 = request(dpiF, 2, [0]);
  console.log('    set 25600: ' + JSON.stringify(w2 && w2.error != null ? { error: w2.error } : 'ok') +
    ' → ' + (rb2 && rb2.reply ? ((rb2.reply[5] << 8) | rb2.reply[6]) : '?'));
  const w3 = request(dpiF, 3, [0, (12345 >> 8) & 0xff, 12345 & 0xff]);
  const rb3 = request(dpiF, 2, [0]);
  console.log('    set 12345 (non-multiple-of-50): ' + JSON.stringify(w3 && w3.error != null ? { error: w3.error } : 'ok') +
    ' → ' + (rb3 && rb3.reply ? ((rb3.reply[5] << 8) | rb3.reply[6]) : '?'));

  // restore original
  if (cur && cur.reply) {
    const orig = (cur.reply[5] << 8) | cur.reply[6];
    const target = orig || (cur.reply[7] << 8) | cur.reply[8];
    if (target) {
      request(dpiF, 3, [0, (target >> 8) & 0xff, target & 0xff]);
      console.log('[i] restored host DPI to ' + target);
    }
  }
  // back to onboard mode
  request(obF, 1, [1]);
  await sleep(200);
  const m = request(obF, 2);
  console.log('[i] mode now: ' + (m && m.reply ? (m.reply[4] === 1 ? 'ONBOARD' : m.reply[4]) : '?'));
  dev.close();
  console.log('[i] done');
})();
