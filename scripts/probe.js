// scripts/probe.js — Scyrox (VID 0x3554) HID protocol probe
//
// 単体診断ツール（coreに依存しないスタンドアロン実装）。
// 通信内容の保守管理は devices/scyrox-v8.json と HANDOFF_PROMPT.md が正本。
// プロトコル出典: https://github.com/azais-corentin/scyrox — docs/protocol.md
// 参照: https://github.com/zzy6-a/ScyroxTray
//
// Read-only by default. Pass --write-test to also validate the write path
// with no-op writes (writes the currently stored values back unchanged).
'use strict';

const HID = require('node-hid');

const VID = 0x3554;
const PIDS = [0xf5f6, 0xf5f7, 0xf5f4]; // wired, 4K dongle, standard dongle
const REPORT_ID = 8;
const PKT_LEN = 16;

const CMD = {
  HANDSHAKE: 0x01,
  PC_DRIVER_STATUS: 0x02,
  DEVICE_ONLINE: 0x03,
  BATTERY: 0x04,
  READ_FLASH: 0x08,
  WRITE_FLASH: 0x07,
  GET_CONFIG: 0x0e,
  MOUSE_VERSION: 0x12,
  DONGLE_VERSION: 0x1d,
};

function checksum16(p) {
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += p[i];
  return (((0x55 - (sum & 0xff) - REPORT_ID) % 256) + 256) % 256;
}

function buildPacket(cmd, addr = 0, len = 0, data = []) {
  const p = Buffer.alloc(PKT_LEN, 0);
  p[0] = cmd;
  p[2] = (addr >> 8) & 0xff;
  p[3] = addr & 0xff;
  p[4] = len & 0xff;
  for (let i = 0; i < Math.min(data.length, 10); i++) p[5 + i] = data[i] & 0xff;
  p[15] = checksum16(p);
  return p;
}

function buildSingleByteWrite(addr, value) {
  return buildPacket(CMD.WRITE_FLASH, addr, 2, [value, (0x55 - value) & 0xff]);
}

function transact(dev, packet, { timeout = 250, retries = 3, quiet = false } = {}) {
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
      /* timeout — retry */
    }
    if (!raw || raw.length === 0) continue;
    const buf = Buffer.from(raw);
    let res = buf[0] === REPORT_ID ? buf.slice(1, 1 + PKT_LEN) : buf.slice(0, PKT_LEN);
    if (res.length < PKT_LEN) continue;
    if (res[0] === 0x0a) {
      // unsolicited StatusChanged notification
      if (!quiet) console.log(`    [notif] StatusChanged flags=0x${res[5].toString(16)}`);
      continue;
    }
    if (res[0] === packet[0]) {
      if (packet[0] === CMD.READ_FLASH) {
        // bytes 0-4 must echo the request
        if (res.slice(0, 5).equals(packet.slice(0, 5))) return res;
        continue;
      }
      return res;
    }
  }
  return null;
}

function decodeReportRate(v) {
  if (v === 0) return null;
  return v >= 16 ? (v / 16) * 2000 : 1000 / v;
}

function decodeDpi(b) {
  const high = (b[2] & 0x0c) >> 2;
  const val = b[0] | (high << 8);
  return (val + 1) * 50;
}

function hexDump(buf, base = 0) {
  for (let off = 0; off < buf.length; off += 16) {
    const row = buf.slice(off, off + 16);
    const addr = (base + off).toString(16).padStart(4, '0');
    const bytes = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`      ${addr}: ${bytes}`);
  }
}

const LOD_NAMES = { 3: '0.7mm', 1: '1.0mm', 2: '2.0mm' };
const LIGHT_MODES = {
  0: 'Off', 1: 'Color Flow', 2: 'Single Color Breathing', 3: 'Constant Color',
  4: 'Neon', 5: 'Mixed Color Breathing', 6: 'Colorful Constant',
};

function listCandidates() {
  const pidFilter = process.argv[2] ? parseInt(process.argv[2], 16) : null;
  const all = HID.devices().filter(
    (d) =>
      d.vendorId === VID &&
      (pidFilter ? d.productId === pidFilter : PIDS.includes(d.productId))
  );
  console.log(`[i] ${all.length} HID top-level collection(s) found for VID 0x3554`);
  for (const d of all) {
    console.log(
      `    path=${d.path}\n    product=${JSON.stringify(d.product)} iface=${d.interface} ` +
      `usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)}`
    );
  }
  const vendor = all.filter((d) => (d.usagePage || 0) >= 0xff00);
  // Prefer FF02 (17-byte control collection on all known Compx devices)
  const sorted = vendor.sort((a, b) => {
    const aScore = (a.usagePage || 0) === 0xff02 ? 0 : 1;
    const bScore = (b.usagePage || 0) === 0xff02 ? 0 : 1;
    return aScore - bScore;
  });
  return sorted.length ? sorted : all;
}

function tryOpen(path) {
  try {
    const dev = new HID.HID(path);
    try { dev.readTimeout(30); } catch (e) { /* drain */ }
    return dev;
  } catch (e) {
    return null;
  }
}

function fmtVersion(res) {
  if (!res) return 'n/a';
  return `v${res[5]}.${res[6].toString(16).padStart(2, '0')}`;
}

async function main() {
  const doWriteTest = process.argv.includes('--write-test');
  const candidates = listCandidates();

  let opened = null;
  let dev = null;
  for (const cand of candidates) {
    const d = tryOpen(cand.path);
    if (!d) {
      console.log(`[i] cannot open ${cand.path.split('&').slice(-2).join('&')} (protected or busy)`);
      continue;
    }
    // Some 1K dongles answer DONGLE_VERSION with status != 0 (unsupported);
    // any echo still proves this collection speaks the protocol. Confirm
    // with DEVICE_ONLINE, which every Compx dongle answers.
    let r = transact(d, buildPacket(CMD.DONGLE_VERSION), { timeout: 150, retries: 1 });
    if (r && r[1] !== 0x00) {
      const on = transact(d, buildPacket(CMD.DEVICE_ONLINE), { timeout: 150, retries: 1, quiet: true });
      r = on ? r : null;
    }
    if (r) {
      dev = d;
      opened = cand;
      if (r[1] === 0x00) {
        console.log(`[+] control collection opened (dongle fw ${fmtVersion(r)})`);
      } else {
        console.log('[+] control collection opened (dongle version not supported — 1K receiver)');
      }
      break;
    }
    d.close();
  }

  if (!dev) {
    console.error('[!] No responding control collection found. Is the dongle plugged in?');
    process.exit(1);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Announce driver presence first (keeps the radio link alive on some firmwares)
  transact(dev, buildPacket(CMD.PC_DRIVER_STATUS, 0, 1, [0x01]));

  let online = null;
  for (let i = 0; i < 120; i++) {
    online = transact(dev, buildPacket(CMD.DEVICE_ONLINE), { timeout: 200, retries: 1, quiet: true });
    if (online && online[5] === 1) break;
    if (i === 0) console.log('[i] mouse is offline/asleep — MOVE or CLICK the mouse to wake it...');
    if (i % 10 === 9) console.log(`    ...still waiting (${((i + 1) * 1.5) | 0}s)`);
    await sleep(1500);
  }
  if (!online || online[5] !== 1) {
    console.error('[!] mouse did not come online within 180s.');
    transact(dev, buildPacket(CMD.PC_DRIVER_STATUS, 0, 1, [0x00]));
    dev.close();
    process.exit(1);
  }
  console.log(`[i] mouse online=1 address=${[online[8], online[7], online[6]].map((x) => x.toString(16)).join(':')}`);

  // Notify driver connected, then handshake
  transact(dev, buildPacket(CMD.PC_DRIVER_STATUS, 0, 1, [0x01]));
  const rnd = [0x12, 0x34, 0x56, 0x78];
  const hs = transact(dev, buildPacket(CMD.HANDSHAKE, 0, 8, [...rnd, 0, 0, 0, 0]));
  if (!hs) {
    console.error('[!] handshake failed');
    dev.close();
    process.exit(1);
  }
  console.log(
    `[i] handshake OK (echo=${hs.slice(5, 9).toString('hex')}) CID=${hs[9]} MID=${hs[10]} type=${hs[11]}`
  );
  const connTypes = {
    0: 'wireless std (1K)', 1: 'wireless 4K', 2: 'wired std', 3: 'wired 8K',
    4: 'wireless 2K', 5: 'wireless 8K',
  };
  console.log(`[i] connection type: ${connTypes[hs[11]] ?? 'unknown ' + hs[11]}`);

  // Read full basic config: 0x0000-0x00FF
  const flash = Buffer.alloc(256, 0);
  let addr = 0;
  while (addr < 256) {
    const len = Math.min(10, 256 - addr);
    const res = transact(dev, buildPacket(CMD.READ_FLASH, addr, len));
    if (!res) {
      console.error(`[!] flash read failed at 0x${addr.toString(16)}`);
      dev.close();
      process.exit(1);
    }
    Buffer.from(res.slice(5, 5 + len)).copy(flash, addr);
    addr += len;
  }
  console.log('[i] flash 0x0000-0x00FF:');
  hexDump(flash);

  // Parse
  const rate = decodeReportRate(flash[0]);
  const dpiCount = flash[2];
  const curDpi = flash[4];
  const sensor20k = flash[8];
  const lod = flash[0x0a];
  const stages = [];
  for (let i = 0; i < 8; i++) {
    const o = 0x0c + i * 4;
    stages.push({
      dpi: decodeDpi(flash.slice(o, o + 4)),
      color: [flash[0x2c + i * 4], flash[0x2c + i * 4 + 1], flash[0x2c + i * 4 + 2]],
    });
  }
  console.log('[i] parsed config:');
  console.log(`      report rate   : ${rate} Hz (raw ${flash[0]})`);
  console.log(`      dpi count     : ${dpiCount}, current stage: ${curDpi}`);
  console.log(`      20K sensor    : ${sensor20k ? 'on' : 'off'}`);
  console.log(`      LOD           : ${LOD_NAMES[lod] ?? 'unknown ' + lod}`);
  for (let i = 0; i < 8; i++) {
    const s = stages[i];
    console.log(
      `      dpi stage ${i}  : ${s.dpi} dpi, color rgb(${s.color.join(',')})`
    );
  }
  const light = {
    mode: flash[0xa0], rgb: [flash[0xa1], flash[0xa2], flash[0xa3]],
    speed: flash[0xa4], brightness: flash[0xa5], on: flash[0xa7],
  };
  console.log(
    `      light         : ${LIGHT_MODES[light.mode] ?? light.mode} rgb(${light.rgb.join(',')}) ` +
    `speed=${light.speed} brightness=${light.brightness} on=${light.on}`
  );
  console.log(`      debounce      : ${flash[0xa9]} ms`);
  console.log(`      motion sync   : ${flash[0xab] ? 'on' : 'off'}`);
  console.log(`      sleep time    : ${flash[0xad]}`);
  console.log(`      angle snap    : ${flash[0xaf] ? 'on' : 'off'}`);
  console.log(`      ripple ctrl   : ${flash[0xb1] ? 'on' : 'off'}`);
  console.log(`      moving-off lt : ${flash[0xb3]}`);
  console.log(`      perf mode     : ${flash[0xb5] ? 'on' : 'off'} (time=${flash[0xb7]})`);
  console.log(`      sensor mode   : ${flash[0xb9] === 1 ? 'HP' : 'LP'}`);

  // Versions / profile / battery
  const mv = transact(dev, buildPacket(CMD.MOUSE_VERSION));
  console.log(`[i] mouse firmware : ${fmtVersion(mv)}`);
  const cfg = transact(dev, buildPacket(CMD.GET_CONFIG));
  console.log(`[i] active profile : ${cfg ? cfg[5] : 'n/a'}`);
  const bat = transact(dev, buildPacket(CMD.BATTERY));
  if (bat) {
    const voltage = (bat[7] << 8) | bat[8];
    console.log(`[i] battery        : ${bat[5]}% charging=${bat[6]} voltage=${voltage}mV`);
  }

  if (doWriteTest) {
    console.log('[i] write test (writes unchanged values back):');
    // 1) single-byte write: current DPI index
    const w1 = transact(dev, buildSingleByteWrite(0x0004, curDpi));
    console.log(`      single-byte write (cur dpi idx=${curDpi}) -> ${w1 ? 'ACK' : 'FAILED'}`);
    // 2) 4-byte flash write: stage 0 DPI encoded
    const encoded = (dpi) => {
      const enc = dpi / 50 - 1;
      const low = enc & 0xff;
      const high = (enc >> 8) & 0x03;
      const byte2 = (high << 2) | (high << 6);
      const ck = (0x55 - ((low + low + byte2) & 0xff)) & 0xff;
      return [low, low, byte2, ck];
    };
    const w2 = transact(dev, buildPacket(CMD.WRITE_FLASH, 0x000c, 4, encoded(stages[0].dpi)));
    console.log(`      4-byte write (dpi stage0=${stages[0].dpi}) -> ${w2 ? 'ACK' : 'FAILED'}`);
    // verify
    const back = transact(dev, buildPacket(CMD.READ_FLASH, 0x000c, 10));
    if (back) {
      const okDpi = decodeDpi(back.slice(5, 9)) === stages[0].dpi;
      console.log(`      verify read-back: stage0=${decodeDpi(back.slice(5, 9))} dpi (${okDpi ? 'OK' : 'MISMATCH'})`);
    }
  }

  // Disconnect driver + close
  transact(dev, buildPacket(CMD.PC_DRIVER_STATUS, 0, 1, [0x00]));
  dev.close();
  console.log('[i] done.');
}

main().catch((e) => {
  console.error('[!] probe error:', e);
  process.exit(1);
});
