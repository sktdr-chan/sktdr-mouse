'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const { loadProfiles } = require('../core/profile');
const codecNode = require('../core/codec');
const transportNode = require('../core/transport');
const adapterNode = require('../core/adapter');

const ROOT = path.join(__dirname, '..');
const profilesById = new Map(loadProfiles().map((p) => [p.id, p]));

function createBrowserEnv() {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    Uint8Array,
    Int8Array,
    Uint16Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    Error,
    TypeError,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Date,
    RegExp,
    localStorage,
    crypto: {
      getRandomValues(arr) {
        const bytes = crypto.randomBytes(arr.length);
        arr.set(bytes);
        return arr;
      },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const rel of ['core/codec.js', 'core/transport.js', 'core/adapter.js']) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return { ctx, storage };
}

function makeFakeAsyncChannel(onSend, onFeature) {
  let onData = null;
  const sent = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    startRead(cb) {
      onData = cb;
    },
    emitInput(bytes) {
      if (onData && !closed) onData(Uint8Array.from(bytes));
    },
    async sendReport(reportId, payload) {
      const copy = Uint8Array.from(payload);
      sent.push({ reportId, payload: copy });
      if (onSend) await onSend(reportId, copy, (bytes) => this.emitInput(bytes));
    },
    async sendFeatureReport(reportId, payload) {
      const copy = Uint8Array.from(payload);
      sent.push({ featureReportId: reportId, payload: copy });
      if (onFeature) await onFeature('send', reportId, copy);
    },
    async receiveFeatureReport(reportId, bodyLength) {
      if (onFeature) return onFeature('recv', reportId, bodyLength);
      return new Uint8Array(bodyLength);
    },
    close() {
      closed = true;
    },
  };
}

test('NodeHidChannel wraps node-hid device with identical wire bytes', () => {
  const writes = [];
  const featWrites = [];
  const fakeDev = {
    write(buf) {
      writes.push(Uint8Array.from(buf));
    },
    sendFeatureReport(buf) {
      featWrites.push(Uint8Array.from(buf));
    },
    getFeatureReport(rid, len) {
      const out = new Uint8Array(len);
      out[0] = rid;
      out[1] = 0x02;
      out[7] = 0x04;
      out[8] = 0x86;
      return out;
    },
    read() {},
    close() {},
  };

  const { Transport, NodeHidChannel } = transportNode;
  const scyrox = profilesById.get('compx-generic');
  const ch = new NodeHidChannel(fakeDev);
  const tr = new Transport(ch, {}, scyrox);
  const pkt = tr.buildByName('dongleVersion');
  const { reportId, payload } = tr._packetToReport(pkt);
  assert.equal(reportId, 8);
  assert.equal(payload.length, 16);
  ch.sendReport(reportId, payload);
  assert.equal(writes[0].length, 17);
  assert.equal(writes[0][0], 8);
  assert.deepEqual([...writes[0].slice(1)], [...pkt]);

  const razerBody = ch.receiveFeatureReport(0, 90);
  assert.equal(razerBody.length, 90);
  assert.equal(razerBody[0], 0x02);
  assert.equal(razerBody[6], 0x04);
  tr.destroy();
});

test('Core modules execute cleanly in browser VM without Buffer/require/process', async (t) => {
  const { ctx, storage } = createBrowserEnv();
  const { Transport, MouseAdapter } = ctx.SktdrCore;
  assert.equal(typeof Transport, 'function');
  assert.equal(typeof MouseAdapter, 'function');
  assert.equal(typeof ctx.Buffer, 'undefined');
  assert.equal(typeof ctx.require, 'undefined');

  // Verify hid16 (Compx generic) full init + write + notification forwarding
  const compx = profilesById.get('compx-generic');
  const flash = new Uint8Array(256);
  flash[0x00] = 0x01; // 1000Hz
  flash[0x02] = 0x01; // count 1
  flash[0x04] = 0x00; // current 0
  // DPI stage 0 at 0x000C = 800 (enc = 800/50 - 1 = 15 = 0x0f)
  flash[0x0c] = 0x0f;
  flash[0x0d] = 0x0f;
  flash[0x0e] = 0x00;
  flash[0x0f] = (0x55 - 0x1e) & 0xff;

  const ch = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(rid, 8);
    const cmd = pkt[0];
    const resp = new Uint8Array(16);
    resp[0] = cmd;
    resp[1] = 0x00;
    if (cmd === 0x1d) {
      resp[5] = 2;
      resp[6] = 0x17;
    } else if (cmd === 0x03) {
      resp[5] = 1;
    } else if (cmd === 0x01) {
      resp[9] = 62;
      resp[10] = 1; // Scyrox V8
      resp[11] = 2; // 8K dongle
    } else if (cmd === 0x12) {
      resp[5] = 2;
      resp[6] = 0x22;
    } else if (cmd === 0x04) {
      resp[5] = 88;
      resp[6] = 0;
      resp[7] = 0x0f;
      resp[8] = 0xa0;
    } else if (cmd === 0x08) {
      const addr = (pkt[2] << 8) | pkt[3];
      const len = pkt[4];
      resp[2] = pkt[2];
      resp[3] = pkt[3];
      resp[4] = len;
      for (let i = 0; i < len; i++) resp[5 + i] = flash[addr + i];
    } else if (cmd === 0x07) {
      const addr = (pkt[2] << 8) | pkt[3];
      const len = pkt[4];
      if (len === 2 && ((pkt[5] + pkt[6]) & 0xff) === 0x55) {
        flash[addr] = pkt[5];
      } else {
        for (let i = 0; i < len; i++) flash[addr + i] = pkt[5 + i];
      }
    } else if (cmd === 0x0e) {
      resp[5] = 0;
    } else if (cmd === 0x17) {
      resp[1] = 1; // unsupported
    }
    let sum = 0;
    for (let i = 0; i < 15; i++) sum += resp[i];
    resp[15] = (((0x55 - (sum & 0xff) - 8) % 256) + 256) % 256;
    setTimeout(() => push([8, ...resp]), 1);
  });

  const tr = new Transport(ch, { product: 'Scyrox V8' }, compx);
  const adapter = new MouseAdapter(tr, compx);
  t.after(() => adapter.destroy());
  const events = [];
  adapter.onEvent((type, data) => events.push({ type, data }));

  const online = await adapter.initialize({ waitOnlineMs: 500 });
  assert.equal(online, true);
  assert.equal(adapter.mid, 1);
  assert.equal(adapter.dongleVersion, 'v2.17');
  assert.equal(adapter.mouseVersion, 'v2.22');
  assert.equal(adapter.config.dpi.records[0].value, 800);

  // Write DPI stage 0 to 1600
  const updated = await adapter.applySetting('dpi', { op: 'stageValue', index: 0, value: 1600 });
  assert.equal(updated.dpi.records[0].value, 1600);

  // Unsolicited 0x0A notification should be forwarded by MouseAdapter
  const notif = new Uint8Array(16);
  notif[0] = 0x0a;
  notif[5] = 0x01;
  let nsum = 0;
  for (let i = 0; i < 15; i++) nsum += notif[i];
  notif[15] = (((0x55 - (nsum & 0xff) - 8) % 256) + 256) % 256;
  ch.emitInput([8, ...notif]);
  assert.ok(events.some((e) => e.type === 'notification' && e.data === 1));

  // Verify localStorage wasn't polluted by non-cache device
  assert.equal(storage.size, 0);

  await adapter.gracefulClose();
  assert.equal(ch.closed, true);
  assert.equal(ch.sent[ch.sent.length - 1].payload[0], 0x02);
});

test('All 7 protocol transports split (reportId, payload) and handle browser cacheStore', async (t) => {
  const { ctx, storage } = createBrowserEnv();
  const { Transport, MouseAdapter } = ctx.SktdrCore;
  const cleanups = [];
  t.after(() => {
    for (const c of cleanups) {
      try {
        c.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  });

  // 1. swarmEcho64 (ROCCAT) -> localStorage cache + 64B reportId 0
  const roccat = profilesById.get('roccat-kone-pro-air');
  const roccatCh = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(rid, 0);
    assert.equal(pkt.length, 64);
    const resp = new Uint8Array(64);
    resp[0] = pkt[0];
    resp[1] = pkt[1];
    resp[2] = pkt[0] === 0x90 ? 0x04 : 0x03;
    if (pkt[0] === 0x90 && pkt[1] === 0x0a) {
      resp[5] = 75;
      resp[8] = 0x60;
      resp[9] = 0x0f;
    }
    setTimeout(() => push(resp), 1);
  });
  const roccatAd = new MouseAdapter(new Transport(roccatCh, {}, roccat), roccat);
  cleanups.push(roccatAd);
  await roccatAd.initialize();
  assert.equal(roccatAd.battery.level, 75);
  await roccatAd.applySetting('debounce', { value: 4 });
  const savedRoccat = JSON.parse(storage.get('sktdr-mouse:cache:roccat-kone-pro-air'));
  assert.equal(savedRoccat.debounce, 4);
  roccatAd.destroy();

  // 2. moji64 (Darmoshark M5) -> checksum 0xA1 & reportId 0
  const darmo = profilesById.get('darmoshark-m5');
  const darmoCh = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(rid, 0);
    assert.equal(pkt.length, 64);
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += pkt[i];
    assert.equal(sum & 0xff, 0xa1);
    const resp = new Uint8Array(64);
    resp[0] = pkt[0] & ~0x40;
    resp[3] = pkt[3];
    if (pkt[0] === 0x41) resp[6] = 90;
    if (pkt[0] === 0x44 && pkt[2] === 0x81) {
      resp[5] = 4; // 1000Hz code
      resp[6] = 0x0f; // 4 stages
      resp[7] = 1; // stage 2
      resp[8] = 0x20;
      resp[9] = 0x03; // 800 DPI
    }
    let rsum = 0;
    for (let i = 0; i < 63; i++) rsum += resp[i];
    resp[63] = (0xa1 - (rsum & 0xff) + 256) % 256;
    setTimeout(() => push(resp), 1);
  });
  const darmoTr = new Transport(darmoCh, {}, darmo);
  const darmoAd = new MouseAdapter(darmoTr, darmo);
  cleanups.push(darmoAd);
  await darmoAd.initialize();
  assert.equal(darmoAd.config.dpi.records[0].value, 800);
  darmoAd.destroy();

  // 3. hidpp (Logitech) -> reportId 0x11, 19B payload, ROOT index resolution
  const logi = profilesById.get('logitech-pro-x-wireless');
  const logiCh = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(rid, 0x11);
    assert.equal(pkt.length, 19);
    const featIdx = pkt[1];
    const fnByte = pkt[2];
    const resp = new Uint8Array(20);
    resp[0] = 0x11;
    resp[1] = pkt[0];
    resp[2] = featIdx;
    resp[3] = fnByte;
    if (featIdx === 0) resp[4] = 5; // resolved feature index
    else if (pkt[3] === 0x00 && featIdx === 5) {
      // DPI 1600
      resp[5] = 0x06;
      resp[6] = 0x40;
    }
    setTimeout(() => push(resp), 1);
  });
  const logiTr = new Transport(logiCh, {}, logi);
  cleanups.push(logiTr);
  const idx = await logiTr.resolveFeatureIndex(0x2201);
  assert.equal(idx, 5);
  logiTr.destroy();

  // 4. ngenuity64 (Haste Wireless) -> reportId 0, 64B payload, async FF 03 state
  const haste1 = profilesById.get('hyperx-pulsefire-haste-wireless');
  const haste1Ch = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(rid, 0);
    assert.equal(pkt.length, 64);
    const resp = new Uint8Array(64);
    resp[0] = pkt[0];
    if (pkt[0] === 0x51) resp[4] = 80;
    setTimeout(() => push(resp), 1);
  });
  const haste1Ad = new MouseAdapter(new Transport(haste1Ch, {}, haste1), haste1);
  cleanups.push(haste1Ad);
  await haste1Ad.initialize();
  const statePkt = new Uint8Array(64);
  statePkt.set([0xff, 0x03, 0x02, 0x01, 0x01]);
  haste1Ch.emitInput(statePkt);
  assert.equal(haste1Ad.config.dpi.current, 2);
  haste1Ad.destroy();

  // 5. ngenuityUniversal (Haste 2 Wireless) -> reportId === command byte, 63B payload
  const haste2 = profilesById.get('hyperx-pulsefire-haste-2-wireless');
  const haste2Ch = makeFakeAsyncChannel((rid, pkt, push) => {
    assert.equal(pkt.length, 63);
    const resp = new Uint8Array(64);
    resp[0] = (rid + 1) & 0xff;
    resp[1] = pkt[0] & 0x3f;
    if (rid === 0x50) resp[2] = 83;
    setTimeout(() => push(resp), 1);
  });
  const haste2Tr = new Transport(haste2Ch, {}, haste2);
  cleanups.push(haste2Tr);
  const batRes = await haste2Tr.commandByName('battery');
  assert.equal(batRes[2], 83);
  haste2Tr.destroy();

  // 6. razer -> async feature report + NotAllowedError classification
  const razer = profilesById.get('razer-deathadder-v3-pro');
  let lastCls = 0;
  let lastCmd = 0;
  const razerCh = makeFakeAsyncChannel(null, (op, rid, arg) => {
    assert.equal(rid, 0);
    if (op === 'send') {
      assert.equal(arg.length, 90);
      lastCls = arg[6];
      lastCmd = arg[7];
      return;
    }
    const resp = new Uint8Array(90);
    resp[0] = 0x02;
    resp[6] = lastCls;
    resp[7] = lastCmd;
    resp[9] = 1;
    resp[10] = 0;
    return resp;
  });
  const razerTr = new Transport(razerCh, {}, razer);
  cleanups.push(razerTr);
  const ver = await razerTr.commandByName('mouseVersion');
  assert.equal(ver[9], 1);
  razerTr.destroy();

  const blockedCh = makeFakeAsyncChannel(null, () => {
    const err = new Error('Permission denied');
    err.name = 'NotAllowedError';
    throw err;
  });
  const blockedTr = new Transport(blockedCh, {}, razer);
  cleanups.push(blockedTr);
  await assert.rejects(
    () => blockedTr.commandByName('mouseVersion'),
    (e) => e.code === 'not-allowed'
  );
  blockedTr.destroy();
});
