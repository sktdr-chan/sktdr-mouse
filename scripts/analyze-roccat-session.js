#!/usr/bin/env node
// scripts/analyze-roccat-session.js — decode the Swarm↔Kone Pro Air capture.
//
// Value-signature analysis: the user toggles known values in Swarm
// (DPI 800/1600, polling 125/1000, color FF0000, debounce 4ms); this script
// classifies every 64-byte control write by its command header, prints the
// unique payloads of config writes with diffs, summarizes the AIMO animation
// stream, and lists the device's 64-byte responses.
//
// Usage: node scripts/analyze-roccat-session.js <capture.pcap> [--report file.txt]
//
// USBPcap packet header layout: desowin.org/usbpcap/captureformat.html

'use strict';

const fs = require('fs');

const TRANSFER_TYPES = ['ISO', 'INT', 'CTRL', 'BULK'];

function hex(buf, max = 72) {
  const end = Math.min(buf.length, max);
  const parts = [];
  for (let i = 0; i < end; i++) parts.push(buf[i].toString(16).padStart(2, '0'));
  if (buf.length > end) parts.push(`…(+${buf.length - end})`);
  return parts.join(' ');
}

function readPcap(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24) throw new Error(`${file}: too short`);
  if (buf.readUInt32LE(0) !== 0xa1b2c3d4) throw new Error(`${file}: not a classic pcap (LE) file`);
  const packets = [];
  let off = 24;
  while (off + 16 <= buf.length) {
    const tsSec = buf.readUInt32LE(off);
    const tsUsec = buf.readUInt32LE(off + 4);
    const inclLen = buf.readUInt32LE(off + 8);
    off += 16;
    if (off + inclLen > buf.length) break;
    packets.push({ ts: tsSec + tsUsec / 1e6, data: buf.slice(off, off + inclLen) });
    off += inclLen;
  }
  return packets;
}

function parseUsbpcap(data) {
  if (data.length < 27) return null;
  const headerLen = data.readUInt16LE(0);
  const out = {
    headerLen,
    device: data.readUInt16LE(19),
    endpoint: data[21],
    transfer: TRANSFER_TYPES[data[22]] || `T${data[22]}`,
    complete: (data[16] & 1) === 1,
    payload: data.length > headerLen ? data.slice(headerLen) : Buffer.alloc(0),
  };
  if (out.transfer === 'CTRL' && data.length >= 36 && data[27] === 0) {
    out.setup = {
      bmRequestType: data[28],
      bRequest: data[29],
      wValue: data.readUInt16LE(30),
      wIndex: data.readUInt16LE(32),
      wLength: data.readUInt16LE(34),
    };
  }
  return out;
}

function classify(payload) {
  if (payload.length < 4) return 'short';
  const b0 = payload[0];
  const b1 = payload[1];
  if (b0 === 0x10 && b1 === 0x50) return `config-${payload[2].toString(16)}`; // 10 50 <sub> …
  if (b0 === 0x10 && b1 === 0x10) return 'anim'; // 10 10 0b … (AIMO live stream)
  return `other-${b0.toString(16)}-${b1.toString(16)}`;
}

function diffPayloads(a, b) {
  const changes = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const va = i < a.length ? a[i] : null;
    const vb = i < b.length ? b[i] : null;
    if (va !== vb) changes.push(`[${i}]${va != null ? va.toString(16).padStart(2, '0') : '??'}→${vb != null ? vb.toString(16).padStart(2, '0') : '??'}`);
  }
  return changes.join(' ');
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/analyze-roccat-session.js <capture.pcap> [--report file.txt]');
    process.exit(1);
  }
  let reportPath = null;
  const idx = process.argv.indexOf('--report');
  if (idx > 0 && process.argv[idx + 1]) reportPath = process.argv[idx + 1];

  const packets = readPcap(file);
  const base = packets.length ? packets[0].ts : 0;
  const all = [];
  const epStats = new Map();
  for (const pkt of packets) {
    const info = parseUsbpcap(pkt.data);
    if (!info) continue;
    const key = `dev${info.device}/${info.transfer}/${info.endpoint & 0x80 ? 'IN' : 'OUT'}${info.endpoint & 0x7f}`;
    const rec = epStats.get(key) || { count: 0, lens: new Map() };
    rec.count++;
    rec.lens.set(info.payload.length, (rec.lens.get(info.payload.length) || 0) + 1);
    epStats.set(key, rec);
    all.push({ ts: pkt.ts - base, info });
  }

  const lines = [];
  lines.push(`capture: ${file}  packets=${packets.length}  duration=${(all.length ? all[all.length - 1].ts : 0).toFixed(1)}s`);
  lines.push('=== endpoint summary (top 24) ===');
  [...epStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 24)
    .forEach(([k, v]) => {
      const lens = [...v.lens.entries()].sort((a, b) => b[0] - a[0]).slice(0, 3).map(([l, c]) => `len${l}:${c}`).join(' ');
      lines.push(`  ${k}  n=${v.count}  ${lens}`);
    });

  // control channel = INT OUT payload 64 (writes) on the device with the most
  const writes = all.filter(
    (e) => e.info.transfer === 'INT' && !(e.info.endpoint & 0x80) && e.info.payload.length === 64
  );
  const reads = all.filter(
    (e) => e.info.transfer === 'INT' && (e.info.endpoint & 0x80) && e.info.payload.length === 64
  );
  let focusDev = null;
  let focusCount = 0;
  const devMap = new Map();
  for (const e of writes) {
    devMap.set(e.info.device, (devMap.get(e.info.device) || 0) + 1);
  }
  for (const [d, c] of devMap) if (c > focusCount) { focusCount = c; focusDev = d; }
  const devWrites = writes.filter((e) => e.info.device === focusDev);
  const devReads = reads.filter((e) => e.info.device === focusDev);

  lines.push('');
  lines.push(`focus device ${focusDev}: writes=${devWrites.length} reads=${devReads.length}`);

  // classify
  const byClass = new Map();
  for (const e of devWrites) {
    const c = classify(e.info.payload);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(e);
  }
  lines.push('');
  lines.push('=== write classes ===');
  for (const [c, list] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${c}: n=${list.length}  span=${list[0].ts.toFixed(1)}s..${list[list.length - 1].ts.toFixed(1)}s`);
  }

  // config writes: unique payloads + timeline + pairwise diffs
  for (const [c, list] of [...byClass.entries()].sort()) {
    if (c === 'anim') continue;
    lines.push('');
    lines.push(`=== class ${c}: ${list.length} writes ===`);
    const seen = new Map();
    for (const e of list) {
      const key = e.info.payload.toString('hex');
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(e.ts);
    }
    const uniq = [...seen.entries()];
    lines.push(`  unique payloads: ${uniq.length}`);
    uniq.forEach(([key, times], i) => {
      const p = Buffer.from(key, 'hex');
      lines.push(`  #${i} (x${times.length}, ${times.map((t) => t.toFixed(2)).slice(0, 12).join(', ')}${times.length > 12 ? ',…' : ''})`);
      lines.push(`      ${hex(p)}`);
    });
    if (uniq.length > 1) {
      lines.push('  pairwise diffs (first vs each other):');
      const p0 = Buffer.from(uniq[0][0], 'hex');
      uniq.slice(1).forEach(([key], i) => {
        const p = Buffer.from(key, 'hex');
        lines.push(`    #0↔#${i + 1}: ${diffPayloads(p0, p)}`);
      });
    }
  }

  // animation stream summary
  const anim = byClass.get('anim') || [];
  if (anim.length) {
    lines.push('');
    lines.push(`=== anim stream: ${anim.length} writes ===`);
    lines.push(`  first: [${anim[0].ts.toFixed(2)}s] ${hex(anim[0].info.payload, 24)}`);
    lines.push(`  last:  [${anim[anim.length - 1].ts.toFixed(2)}s] ${hex(anim[anim.length - 1].info.payload, 24)}`);
    // value ranges of the changing bytes
    const ranges = {};
    for (const e of anim) {
      const p = e.info.payload;
      for (const i of [5, 6, 7, 9, 10, 11, 12, 13, 14]) {
        const v = p[i];
        if (v == null) continue;
        if (!ranges[i]) ranges[i] = { min: 255, max: 0 };
        ranges[i].min = Math.min(ranges[i].min, v);
        ranges[i].max = Math.max(ranges[i].max, v);
      }
    }
    lines.push('  byte ranges: ' + Object.entries(ranges).map(([i, r]) => `[${i}]:${r.min}..${r.max}`).join(' '));
    // gaps: is the stream continuous or in bursts?
    let gaps = [];
    for (let i = 1; i < anim.length; i++) gaps.push(anim[i].ts - anim[i - 1].ts);
    gaps.sort((a, b) => a - b);
    lines.push(`  dt median=${gaps[Math.floor(gaps.length / 2)].toFixed(3)}s max=${gaps[gaps.length - 1].toFixed(2)}s`);
  }

  // responses (IN) — unique payloads with counts and timing sample
  lines.push('');
  lines.push(`=== responses (INT IN 64B): ${devReads.length} ===`);
  const readSeen = new Map();
  for (const e of devReads) {
    const key = e.info.payload.toString('hex');
    if (!readSeen.has(key)) readSeen.set(key, []);
    readSeen.get(key).push(e.ts);
  }
  lines.push(`  unique responses: ${readSeen.size}`);
  [...readSeen.entries()].slice(0, 60).forEach(([key, times], i) => {
    const p = Buffer.from(key, 'hex');
    lines.push(`  r#${i} (x${times.length}) ${hex(p, 32)}`);
  });

  // ctrl transfers to focus device
  const ctrls = all.filter((e) => e.info.transfer === 'CTRL' && e.info.setup && e.info.device === focusDev);
  lines.push('');
  lines.push(`=== CTRL transfers to focus device: ${ctrls.length} ===`);
  const ctrlSeen = new Map();
  for (const e of ctrls) {
    const s = e.info.setup;
    const name =
      s.bmRequestType === 0x21 && s.bRequest === 0x09
        ? `SET type=${(s.wValue >> 8) & 0xff} id=0x${(s.wValue & 0xff).toString(16)} if=${s.wIndex} len=${s.wLength}`
        : s.bmRequestType === 0xa1 && s.bRequest === 0x01
        ? `GET type=${(s.wValue >> 8) & 0xff} id=0x${(s.wValue & 0xff).toString(16)} if=${s.wIndex} len=${s.wLength}`
        : `bm=0x${s.bmRequestType.toString(16)} req=0x${s.bRequest.toString(16)} val=0x${s.wValue.toString(16)} idx=0x${s.wIndex.toString(16)} len=${s.wLength}`;
    ctrlSeen.set(name, (ctrlSeen.get(name) || 0) + 1);
  }
  for (const [n, c] of ctrlSeen.entries()) lines.push(`  ${c}× ${n}`);

  const report = lines.join('\n');
  if (reportPath) {
    fs.writeFileSync(reportPath, report + '\n');
    console.log(`report written: ${reportPath} (${lines.length} lines)`);
    console.log(lines.slice(0, 80).join('\n'));
  } else {
    console.log(report);
  }
}

main();
