'use strict';
// probe-superlight.js — read-only HID++ 2.0 probe for Logitech receivers
// (PRO X Superlight / Superlight 2). Mirrors Featherweight's wire format:
//   write: [0x11, devIdx, featureIdx, (fn<<4)|0x0A, params…] (20 bytes)
//   read : report 0x10/0x11, match devIdx + featureIdx + fn|swId
// Protocol sources: github.com/Ad1FPS/Featherweight (MIT), Solaar, libratbag.
const HID = require('node-hid');
const VID = 0x046d;

const SWID = 0x0a;
const RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

const cols = HID.devices().filter(
  (d) => d.vendorId === VID && (d.usagePage || 0) === 0xff00 && (d.usage || 0) === 0x0002
);
if (!cols.length) {
  console.log('[!] no HID++ long-report collection (usagePage 0xFF00/usage 2)');
  process.exit(1);
}
console.log('[i] long-report collection: ' + cols[0].path.split('&').slice(-2).join('&'));
const dev = new HID.HID(cols[0].path);

let REPORT_OUT = 0x11;
function request(devIdx, featIdx, fn, params = [], timeoutMs = 800, retries = 1) {
  const pkt = Buffer.alloc(20, 0);
  pkt[0] = REPORT_OUT;
  pkt[1] = devIdx;
  pkt[2] = featIdx;
  pkt[3] = (fn << 4) | SWID;
  for (let i = 0; i < Math.min(params.length, 16); i++) pkt[4 + i] = params[i] & 0xff;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try { dev.write(pkt); } catch (e) { return null; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let raw;
      try { raw = dev.readTimeout(100); } catch (e) { continue; }
      if (!raw || raw.length < 7) continue;
      const d = Buffer.from(raw);
      if (d[0] !== 0x10 && d[0] !== 0x11) continue;
      if (d[1] !== devIdx) continue;
      if ((d[2] === 0xff || d[2] === 0x8f) && d[3] === featIdx && d[4] === pkt[3]) {
        return { error: d[5] };
      }
      if (d[2] === featIdx && d[3] === pkt[3]) return { reply: d.slice(0, 20) };
    }
  }
  return null;
}

function getFeatureIndex(devIdx, featureId) {
  const r = request(devIdx, 0x00, 0, [(featureId >> 8) & 0xff, featureId & 0xff]);
  if (!r || r.error || !r.reply) return 0;
  return r.reply[4];
}

function readName(devIdx) {
  const fIdx = getFeatureIndex(devIdx, 0x0005);
  if (!fIdx) return null;
  const len = request(devIdx, fIdx, 0);
  if (!len || !len.reply) return null;
  const n = len.reply[4];
  const out = [];
  for (let off = 0; off < n; off += 16) {
    const r = request(devIdx, fIdx, 1, [off]);
    if (!r || !r.reply) return null;
    out.push(...r.reply.slice(4, 4 + Math.min(16, n - off)));
  }
  return Buffer.from(out).toString('latin1');
}

function featureList(devIdx) {
  const fsIdx = getFeatureIndex(devIdx, 0x0001);
  if (!fsIdx) return [];
  const cnt = request(devIdx, fsIdx, 0);
  if (!cnt || !cnt.reply) return [];
  const list = [];
  for (let i = 0; i <= Math.min(cnt.reply[4], 64); i++) {
    const r = request(devIdx, fsIdx, 1, [i]);
    if (!r || !r.reply) continue;
    list.push({ index: i, id: (r.reply[4] << 8) | r.reply[5], type: r.reply[6] });
  }
  return list;
}

// ---- find the mouse behind the receiver ----
let devIdx = null;
for (const idx of [1, 2, 3, 4, 5, 6, 0xff]) {
  const r = request(idx, 0x00, 0, [0x00, 0x01], 500, 0);
  if (r && r.reply && r.reply[4] !== 0) {
    devIdx = idx;
    console.log('[+] device index 0x' + idx.toString(16) + ' answered (feature set present)');
    break;
  }
}
if (devIdx == null) {
  console.log('[!] no paired device answered — move/click the mouse and retry');
  process.exit(1);
}

const name = readName(devIdx);
console.log('[i] device name: "' + name + '"');

const feats = featureList(devIdx);
console.log('[i] feature table (' + feats.length + ' entries):');
for (const f of feats) {
  console.log('      idx=' + pad(f.index.toString(10), 3) + ' id=0x' + f.id.toString(16).padStart(4, '0') + ' type=0x' + f.type.toString(16));
}
const has = (id) => feats.some((f) => f.id === id);

// ---- battery ----
if (has(0x1004)) {
  const b = request(devIdx, getFeatureIndex(devIdx, 0x1004), 1);
  if (b && b.reply) {
    console.log('[i] battery (0x1004): ' + b.reply[4] + '%  status=' + b.reply[6] + ' extPower=' + b.reply[7]);
  }
} else {
  console.log('[i] 0x1004 unified battery: not present');
}

// ---- DPI (0x2202 SL2 / 0x8060 original) ----
if (has(0x2202)) {
  const fIdx = getFeatureIndex(devIdx, 0x2202);
  const d = request(devIdx, fIdx, 5, [0, 0, 0]);
  if (d && d.reply) {
    const be16 = (o) => (d.reply[o] << 8) | d.reply[o + 1];
    console.log('[i] DPI (0x2202 fn5): x=' + be16(5) + ' y=' + be16(9) + ' defaultX=' + be16(7) + ' lod=' + d.reply[13]);
  }
} else if (has(0x8060)) {
  const fIdx = getFeatureIndex(devIdx, 0x8060);
  const d = request(devIdx, fIdx, 1, [0]);
  if (d && d.reply) {
    const be16 = (o) => (d.reply[o] << 8) | d.reply[o + 1];
    console.log('[i] DPI (0x8060 fn1): ' + be16(5) + ' (sensor list at fn2)');
  }
} else {
  console.log('[i] no DPI feature found');
}

// ---- report rate (0x8061) ----
if (has(0x8061)) {
  const fIdx = getFeatureIndex(devIdx, 0x8061);
  const sup = request(devIdx, fIdx, 1, [0, 0, 0]);
  if (sup && sup.reply) {
    const mask = sup.reply[5];
    const hz = RATES.filter((_, bit) => mask & (1 << bit));
    console.log('[i] report rates supported (mask=0x' + mask.toString(16) + '): ' + hz.join('/') + ' Hz');
  }
  for (const conn of [1, 0]) {
    const cur = request(devIdx, fIdx, 2, [conn, 0, 0]);
    if (cur && cur.reply && cur.reply[4] < RATES.length) {
      console.log('[i] current report rate (conn=' + conn + '): ' + RATES[cur.reply[4]] + ' Hz (idx=' + cur.reply[4] + ') ' + hex(cur.reply));
      break;
    }
  }
} else {
  console.log('[i] 0x8061 extended report rate: not present (original Superlight?)');
}

// ---- onboard profiles (0x8100) ----
if (has(0x8100)) {
  const fIdx = getFeatureIndex(devIdx, 0x8100);
  const desc = request(devIdx, fIdx, 0);
  if (desc && desc.reply) {
    const be16 = (o) => (desc.reply[o] << 8) | desc.reply[o + 1];
    console.log('[i] onboard profiles (0x8100 fn0): format=' + desc.reply[4] +
      ' numProfiles=' + desc.reply[5] + ' sectorSize=' + be16(6) + ' numSectors=' + be16(8) +
      ' profileSector=' + be16(10) + ' romSector=' + be16(12));
  }
  const mode = request(devIdx, fIdx, 2);
  if (mode && mode.reply) {
    console.log('[i] onboard mode (fn2): ' + (mode.reply[4] === 2 ? 'HOST' : mode.reply[4] === 1 ? 'ONBOARD' : mode.reply[4]) + ' (raw=' + mode.reply[4] + ')');
  }
  const prof = request(devIdx, fIdx, 4);
  const dpiIdx = request(devIdx, fIdx, 0x0b);
  if (prof && prof.reply) {
    console.log('[i] current onboard profile (fn4): ' + prof.reply[4] +
      ' / dpi index: ' + (dpiIdx && dpiIdx.reply ? dpiIdx.reply[4] : '?'));
  }
  // read sector 0x0001 (16 bytes around the DPI stage 0 + rate byte + sleep timers)
  const sec = request(devIdx, fIdx, 5, [0x00, 0x01, 0x00, 0x00]);
  if (sec && sec.reply) {
    console.log('[i] sector 0x0001 bytes 0x00-0x0F: ' + hex(sec.reply.slice(4, 20)));
  }
  const sec2 = request(devIdx, fIdx, 5, [0x00, 0x01, 0x00, 0x20]);
  if (sec2 && sec2.reply) {
    console.log('[i] sector 0x0001 bytes 0x20-0x2F: ' + hex(sec2.reply.slice(4, 20)) +
      '  (sleep ps/po at 0x2C/0x2E)');
  }
}

dev.close();
console.log('[i] done');
