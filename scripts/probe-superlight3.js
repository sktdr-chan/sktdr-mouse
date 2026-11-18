'use strict';
// probe-superlight3.js — PRO X Wireless (HID++): verify live settings features
// and a careful report-rate write test (restore afterwards).
const HID = require('node-hid');
const VID = 0x046d;
const SWID = 0x0a;
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const longCol = HID.devices().find((d) => d.vendorId === VID && (d.usagePage || 0) === 0xff00 && (d.usage || 0) === 0x0002);
if (!longCol) { console.log('[!] no long collection'); process.exit(1); }
const dev = new HID.HID(longCol.path);
const DEV = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(featIdx, fn, params = [], timeoutMs = 1200, retries = 2) {
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

const featIdx = {};
function fi(featureId) {
  if (featIdx[featureId] == null) {
    const r = request(0x00, 0, [(featureId >> 8) & 0xff, featureId & 0xff]);
    featIdx[featureId] = r && r.reply ? r.reply[4] : 0;
  }
  return featIdx[featureId];
}

(async () => {
  // --- DPI (0x2201) ---
  const dpiF = fi(0x2201);
  const list = request(dpiF, 0, [0]);
  if (list && list.reply) {
    const n = list.reply[4];
    const steps = [];
    for (let i = 0; i < n; i++) steps.push((list.reply[5 + i * 2] << 8) | list.reply[6 + i * 2]);
    console.log('[i] DPI steps (0x2201 fn0): ' + steps.join('/') + '  raw: ' + hex(list.reply.slice(4, 5 + n * 2)));
  } else {
    console.log('[i] DPI list failed: ' + JSON.stringify(list));
  }
  const cur = request(dpiF, 1, [0]);
  if (cur && cur.reply) {
    console.log('[i] current DPI (fn1): ' + ((cur.reply[5] << 8) | cur.reply[6]) + '  raw: ' + hex(cur.reply.slice(4, 9)));
  }

  // --- report rate (0x8060: fn0 list bitmask, fn1 get ms, fn2 set ms) ---
  const rateF = fi(0x8060);
  const rl = request(rateF, 0);
  if (rl && rl.reply) {
    const mask = rl.reply[4];
    const ms = [];
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) ms.push(i + 1);
    console.log('[i] report rate list (fn0 mask=0x' + mask.toString(16) + '): ' + ms.map((m) => m + 'ms=' + (1000 / m) + 'Hz').join(', '));
  }
  const rc = request(rateF, 1);
  if (rc && rc.reply) {
    console.log('[i] current rate (fn1): ' + rc.reply[4] + ' ms = ' + (1000 / rc.reply[4]) + ' Hz');
  }

  // --- device fw (0x0003) ---
  const fwF = fi(0x0003);
  const fw = request(fwF, 0);
  if (fw && fw.reply) {
    console.log('[i] fw info (0x0003 fn0): ' + hex(fw.reply.slice(4, 17)));
  }

  // --- onboard (0x8100) ---
  const obF = fi(0x8100);
  const desc = request(obF, 0);
  if (desc && desc.reply) console.log('[i] onboard desc raw: ' + hex(desc.reply.slice(4, 17)));
  const prof = request(obF, 4);
  if (prof && prof.reply) console.log('[i] current profile (fn4): ' + prof.reply[4]);

  // --- WRITE TEST: report rate 2ms (500Hz) then restore ---
  console.log('\n[i] write test: report rate 2ms (500 Hz), then restore 1ms');
  let w = request(rateF, 2, [2]);
  console.log('    set 2ms: ' + JSON.stringify(w && w.error != null ? { error: w.error } : 'ok') + ' raw=' + (w && w.reply ? hex(w.reply.slice(4, 8)) : '-'));
  let rb = request(rateF, 1);
  console.log('    read back: ' + (rb && rb.reply ? rb.reply[4] + ' ms' : 'failed'));

  if (!rb || !rb.reply || rb.reply[4] !== 2) {
    console.log('    not applied in ONBOARD mode — switching to HOST mode (0x8100 fn1 [2])');
    const mw = request(obF, 1, [2]);
    console.log('    set host mode: ' + JSON.stringify(mw && mw.error != null ? { error: mw.error } : 'ok'));
    await sleep(300);
    w = request(rateF, 2, [2]);
    console.log('    set 2ms (host): ' + JSON.stringify(w && w.error != null ? { error: w.error } : 'ok'));
    rb = request(rateF, 1);
    console.log('    read back: ' + (rb && rb.reply ? rb.reply[4] + ' ms' : 'failed'));
  }

  // restore
  const restore = request(rateF, 2, [1]);
  rb = request(rateF, 1);
  console.log('    restore 1ms: ' + JSON.stringify(restore && restore.error != null ? { error: restore.error } : 'ok') +
    ' → now ' + (rb && rb.reply ? rb.reply[4] + ' ms' : '?'));
  const modeNow = request(obF, 2);
  if (modeNow && modeNow.reply) {
    console.log('    mode now: ' + (modeNow.reply[4] === 2 ? 'HOST' : modeNow.reply[4] === 1 ? 'ONBOARD' : modeNow.reply[4]));
    if (modeNow.reply[4] === 2) {
      console.log('    returning to ONBOARD mode');
      request(obF, 1, [1]);
      await sleep(200);
      const m2 = request(obF, 2);
      console.log('    mode now: ' + (m2 && m2.reply ? m2.reply[4] : '?'));
    }
  }

  dev.close();
  console.log('[i] done');
})();
