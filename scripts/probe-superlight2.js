'use strict';
// probe-superlight2.js — read-only HID++ probe, transport-agnostic:
// tries long reports (0x12/0x11) on the 20-byte collection and short
// reports (0x10) on the 7-byte collection, with verbose logging.
const HID = require('node-hid');
const VID = 0x046d;
const SWID = 0x0a;
const RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

const longCol = HID.devices().find((d) => d.vendorId === VID && (d.usagePage || 0) === 0xff00 && (d.usage || 0) === 0x0002);
const shortCol = HID.devices().find((d) => d.vendorId === VID && (d.usagePage || 0) === 0xff00 && (d.usage || 0) === 0x0001);
if (!longCol && !shortCol) {
  console.log('[!] no HID++ collections found');
  process.exit(1);
}
console.log('[i] long coll: ' + (longCol ? 'yes' : 'no') + ', short coll: ' + (shortCol ? 'yes' : 'no'));
const longDev = longCol ? new HID.HID(longCol.path) : null;
const shortDev = shortCol ? new HID.HID(shortCol.path) : null;

const VERBOSE = process.argv.includes('-v');
const modes = [];
if (longDev) {
  // Verified on PRO X Superlight receivers: requests go out as 20-byte
  // reports with report id 0x11 on the long collection (0x12 is rejected).
  modes.push({ label: 'long/0x11', dev: longDev, rid: 0x11, len: 20 });
}
if (shortDev) {
  modes.push({ label: 'short/0x10', dev: shortDev, rid: 0x10, len: 7 });
}

function tryRequest(mode, devIdx, featIdx, fn, params, timeoutMs = 1200) {
  const pkt = Buffer.alloc(mode.len, 0);
  pkt[0] = mode.rid;
  pkt[1] = devIdx;
  pkt[2] = featIdx;
  pkt[3] = (fn << 4) | SWID;
  for (let i = 0; i < Math.min(params.length, mode.len - 4); i++) pkt[4 + i] = params[i] & 0xff;
  let wrote;
  try { wrote = mode.dev.write(pkt); } catch (e) {
    if (VERBOSE) console.log('    write fail: ' + e.message);
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw;
    try { raw = mode.dev.readTimeout(100); } catch (e) { continue; }
    if (!raw || !raw.length) continue;
    const d = Buffer.from(raw);
    if (VERBOSE) console.log('    <- ' + hex(d));
    if (d.length < 7) continue;
    if (d[1] !== devIdx) continue;
    if ((d[2] === 0xff || d[2] === 0x8f) && d[3] === featIdx && d[4] === pkt[3]) {
      return { error: d[5] };
    }
    if (d[2] === featIdx && d[3] === pkt[3]) return { reply: d };
  }
  return null;
}

// Find a working mode + device index with ROOT.GetFeature(0x0001).
// Sleeping mice take 1-2 s to wake and answer — use a long timeout and a
// retry pause (mirrors Featherweight's reconnect probe behaviour).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mode = null;
let devIdx = null;
(async () => {
  for (const m of modes) {
    for (const idx of [1, 2, 3]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (VERBOSE) console.log('[i] try ' + m.label + ' devIdx=' + idx + ' attempt=' + attempt);
        const r = tryRequest(m, idx, 0x00, 0, [0x00, 0x01], 2500);
        if (r && r.reply && r.reply[4] !== 0) {
          mode = m;
          devIdx = idx;
          console.log('[+] transport: ' + m.label + ', device index ' + idx + ' — feature set index=' + r.reply[4]);
          break;
        }
        await sleep(800);
      }
      if (mode) break;
    }
    if (mode) break;
  }
  if (!mode) {
    console.log('[!] no transport answered — move/click the mouse, close G HUB, retry (-v for trace)');
    if (longDev) longDev.close();
    if (shortDev) shortDev.close();
    process.exit(1);
  }
  await main();
})();

async function main() {
function request(featIdx, fn, params = [], timeoutMs = 900, retries = 1) {
  for (let a = 0; a <= retries; a++) {
    const r = tryRequest(mode, devIdx, featIdx, fn, params, timeoutMs);
    if (r) return r;
  }
  return null;
}
function getFeatureIndex(featureId) {
  const r = request(0x00, 0, [(featureId >> 8) & 0xff, featureId & 0xff]);
  if (!r || r.error || !r.reply) return 0;
  return r.reply[4];
}
function readName() {
  const fIdx = getFeatureIndex(0x0005);
  if (!fIdx) return null;
  const len = request(fIdx, 0);
  if (!len || !len.reply) return null;
  const n = len.reply[4];
  const out = [];
  for (let off = 0; off < n; off += mode.len - 4) {
    const r = request(fIdx, 1, [off]);
    if (!r || !r.reply) return null;
    const chunk = mode.len - 4;
    out.push(...r.reply.slice(4, 4 + Math.min(chunk, n - off)));
  }
  return Buffer.from(out).toString('latin1');
}
function featureList() {
  const fsIdx = getFeatureIndex(0x0001);
  if (!fsIdx) return [];
  const cnt = request(fsIdx, 0);
  if (!cnt || !cnt.reply) return [];
  const list = [];
  for (let i = 0; i <= Math.min(cnt.reply[4], 64); i++) {
    const r = request(fsIdx, 1, [i]);
    if (!r || !r.reply) continue;
    list.push({ index: i, id: (r.reply[4] << 8) | r.reply[5], type: r.reply[6] });
  }
  return list;
}

const name = readName();
console.log('[i] device name: "' + name + '"');
const feats = featureList();
console.log('[i] features (' + feats.length + '):');
for (const f of feats) {
  console.log('      0x' + f.id.toString(16).padStart(4, '0') + ' (idx ' + f.index + ', type 0x' + f.type.toString(16) + ')');
}
const has = (id) => feats.some((f) => f.id === id);

if (has(0x1004)) {
  const b = request(getFeatureIndex(0x1004), 1);
  if (b && b.reply) {
    console.log('[i] battery: ' + b.reply[4] + '% status=' + b.reply[6] + ' extPower=' + b.reply[7] + ' | ' + hex(b.reply.slice(4, 9)));
  }
}
if (has(0x1000)) {
  const b = request(getFeatureIndex(0x1000), 0);
  if (b && b.reply) {
    console.log('[i] battery 0x1000: ' + hex(b.reply.slice(4, 10)));
  }
}
if (has(0x2202)) {
  const d = request(getFeatureIndex(0x2202), 5, [0, 0, 0]);
  if (d && d.reply) {
    const be16 = (o) => (d.reply[o] << 8) | d.reply[o + 1];
    console.log('[i] DPI 0x2202: x=' + be16(5) + ' y=' + be16(9) + ' defaultX=' + be16(7) + ' lod=' + d.reply[13]);
  }
}
if (has(0x8060)) {
  const d = request(getFeatureIndex(0x8060), 1, [0]);
  if (d && d.reply) {
    const be16 = (o) => (d.reply[o] << 8) | d.reply[o + 1];
    console.log('[i] DPI 0x8060 fn1: ' + be16(5) + ' | ' + hex(d.reply.slice(4, 12)));
  }
}
if (has(0x8061)) {
  const fIdx = getFeatureIndex(0x8061);
  const sup = request(fIdx, 1, [0, 0, 0]);
  if (sup && sup.reply) {
    const mask = sup.reply[5];
    console.log('[i] report rates mask=0x' + mask.toString(16) + ': ' + RATES.filter((_, bit) => mask & (1 << bit)).join('/') + ' Hz');
  }
  for (const conn of [1, 0]) {
    const cur = request(fIdx, 2, [conn, 0, 0]);
    if (cur && cur.reply && cur.reply[4] < RATES.length) {
      console.log('[i] current rate (conn=' + conn + '): ' + RATES[cur.reply[4]] + ' Hz | ' + hex(cur.reply.slice(4, 9)));
      break;
    }
  }
}
if (has(0x8100)) {
  const fIdx = getFeatureIndex(0x8100);
  const desc = request(fIdx, 0);
  if (desc && desc.reply) {
    const be16 = (o) => (desc.reply[o] << 8) | desc.reply[o + 1];
    console.log('[i] onboard desc: format=' + desc.reply[4] + ' profiles=' + desc.reply[5] +
      ' sectorSize=' + be16(6) + ' sectors=' + be16(8) + ' profileSector=' + be16(10) + ' romSector=' + be16(12));
  }
  const m = request(fIdx, 2);
  if (m && m.reply) console.log('[i] onboard mode: ' + (m.reply[4] === 2 ? 'HOST' : m.reply[4] === 1 ? 'ONBOARD' : m.reply[4]));
  const s1 = request(fIdx, 5, [0x00, 0x01, 0x00, 0x00]);
  if (s1 && s1.reply) console.log('[i] sector 0x0001 @0x00: ' + hex(s1.reply.slice(4, 20)));
  const s2 = request(fIdx, 5, [0x00, 0x01, 0x00, 0x20]);
  if (s2 && s2.reply) console.log('[i] sector 0x0001 @0x20: ' + hex(s2.reply.slice(4, 20)));
}

if (longDev) longDev.close();
if (shortDev) shortDev.close();
console.log('[i] done');
}
