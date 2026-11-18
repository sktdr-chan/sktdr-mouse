#!/usr/bin/env node
// scripts/parse-roccat-capture.js — decode USBPcap captures for the
// ROCCAT Kone Pro Air RE session.
//
// Reads one or more .pcap files produced by USBPcap (classic pcap format with
// USBPcap link-layer headers, format documented at desowin.org/usbpcap),
// and prints a readable timeline of:
//   - HID control transfers (SET_REPORT / GET_REPORT) with setup fields
//   - interrupt transfers (hidapi write/read payloads) — the Kone Pro Air's
//     control channel (interface 1) uses 65-byte unnumbered reports
//
// Usage:
//   node scripts/parse-roccat-capture.js captures\hub*-2026....pcap [--device N] [--min-len 1]
//
// Field layout reference: parse_usbpcap.py from audiovideo1979-sys/roccat-manager
// (MIT-style reference; offsets verified against desowin docs).

'use strict';

const fs = require('fs');

const TRANSFER_TYPES = ['ISO', 'INT', 'CTRL', 'BULK'];

function parseArgs(argv) {
  const files = [];
  const opts = { device: null, minLen: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device') opts.device = Number(argv[++i]);
    else if (a === '--min-len') opts.minLen = Number(argv[++i]);
    else files.push(a);
  }
  return { files, opts };
}

function hex(buf, max = 72) {
  const end = Math.min(buf.length, max);
  const parts = [];
  for (let i = 0; i < end; i++) parts.push(buf[i].toString(16).padStart(2, '0'));
  if (buf.length > end) parts.push(`…(+${buf.length - end})`);
  return parts.join(' ');
}

/** Parse classic pcap file → [{ts, data}] */
function readPcap(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24) throw new Error(`${file}: too short`);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0xa1b2c3d4 && buf.readUInt32BE(0) !== 0xa1b2c3d4) {
    throw new Error(`${file}: not a classic pcap file (magic mismatch)`);
  }
  const le = magic === 0xa1b2c3d4;
  const packets = [];
  let off = 24;
  while (off + 16 <= buf.length) {
    const tsSec = le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
    const tsUsec = le ? buf.readUInt32LE(off + 4) : buf.readUInt32BE(off + 4);
    const inclLen = le ? buf.readUInt32LE(off + 8) : buf.readUInt32BE(off + 8);
    off += 16;
    if (off + inclLen > buf.length) break;
    packets.push({ ts: tsSec + tsUsec / 1e6, data: buf.slice(off, off + inclLen) });
    off += inclLen;
  }
  return packets;
}

/** Parse a USBPcap packet header. Returns null for short/odd packets. */
function parseUsbpcap(data) {
  if (data.length < 27) return null;
  const headerLen = data.readUInt16LE(0);
  const irpId = Number(data.readBigUInt64LE(2));
  const irpStatus = data.readInt32LE(10);
  const urbFunction = data.readUInt16LE(14);
  const irpInfo = data[16];
  const busId = data.readUInt16LE(17);
  const deviceAddr = data.readUInt16LE(19);
  const endpoint = data[21];
  const transferType = data[22];
  const dataLength = data.readUInt32LE(23);

  const out = {
    headerLen,
    irpId,
    urbFunction,
    complete: (irpInfo & 1) === 1,
    busId,
    device: deviceAddr,
    endpoint,
    transfer: TRANSFER_TYPES[transferType] || `T${transferType}`,
    dataLength,
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

function main() {
  const { files, opts } = parseArgs(process.argv);
  if (files.length === 0) {
    console.error('usage: node scripts/parse-roccat-capture.js <capture.pcap …> [--device N]');
    process.exit(1);
  }

  const events = [];
  const deviceStats = new Map();

  for (const file of files) {
    let packets;
    try {
      packets = readPcap(file);
    } catch (e) {
      console.error(`[skip] ${e.message}`);
      continue;
    }
    const base = packets.length ? packets[0].ts : 0;
    for (const pkt of packets) {
      const info = parseUsbpcap(pkt.data);
      if (!info) continue;
      const ts = pkt.ts - base;
      const key = `${info.device}/${info.transfer}/${(info.endpoint & 0x80) ? 'IN' : 'OUT'}`;
      deviceStats.set(key, (deviceStats.get(key) || 0) + 1);
      if (opts.device != null && info.device !== opts.device) continue;
      if (info.payload.length < opts.minLen) continue;
      events.push({ ts, file, info });
    }
  }

  events.sort((a, b) => a.ts - b.ts);

  console.log('=== device/endpoint activity ===');
  for (const [k, v] of [...deviceStats.entries()].sort()) console.log(`  ${k}: ${v} packets`);
  console.log(`\n=== timeline (${events.length} payload packets) ===\n`);

  let lastTs = -1;
  for (const ev of events) {
    const { info } = ev;
    const t = ev.ts.toFixed(3).padStart(9);
    const gap = lastTs >= 0 ? `(+${(ev.ts - lastTs).toFixed(3)}s)` : '';
    lastTs = ev.ts;

    if (info.transfer === 'CTRL' && info.setup) {
      const s = info.setup;
      const reqName =
        s.bmRequestType === 0x21 && s.bRequest === 0x09
          ? `SET_REPORT type=${(s.wValue >> 8) & 0xff} id=0x${(s.wValue & 0xff).toString(16)} if=${s.wIndex} len=${s.wLength}`
          : s.bmRequestType === 0xa1 && s.bRequest === 0x01
          ? `GET_REPORT type=${(s.wValue >> 8) & 0xff} id=0x${(s.wValue & 0xff).toString(16)} if=${s.wIndex} len=${s.wLength}`
          : `bm=0x${s.bmRequestType.toString(16)} req=0x${s.bRequest.toString(16)} val=0x${s.wValue.toString(16)} idx=0x${s.wIndex.toString(16)} len=${s.wLength}`;
      console.log(`${t}s ${gap} dev=${info.device} CTRL ${info.complete ? 'complete' : 'submit  '} ${reqName}`);
      if (info.payload.length) console.log(`              data: ${hex(info.payload)}`);
    } else if (info.transfer === 'INT' && info.payload.length) {
      const dir = info.endpoint & 0x80 ? 'IN ' : 'OUT';
      console.log(`${t}s ${gap} dev=${info.device} INT  ${info.complete ? 'complete' : 'submit  '} EP${dir} len=${info.payload.length}`);
      console.log(`              data: ${hex(info.payload)}`);
    } else if (info.transfer === 'BULK' && info.payload.length) {
      console.log(`${t}s ${gap} dev=${info.device} BULK len=${info.payload.length} data: ${hex(info.payload, 32)}`);
    }
  }
  console.log('\n=== end of timeline ===');
}

main();
