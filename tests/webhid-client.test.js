'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadProfiles } = require('../core/profile');

const ROOT = path.join(__dirname, '..');
const profiles = loadProfiles().map((p) => {
  const c = { ...p };
  delete c._file;
  return c;
});

function loadWebHidInVm(mockHid, mockFetch) {
  const storage = new Map();
  const winListeners = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    Uint8Array,
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
    isSecureContext: true,
    navigator: { hid: mockHid },
    fetch: mockFetch,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
        return arr;
      },
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const rel of [
    'core/codec.js',
    'core/transport.js',
    'core/adapter.js',
    'public/webhid.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }
  return { ctx, storage, winListeners };
}

function makeMockHidDevice({
  vendorId,
  productId,
  productName = 'Mock Mouse',
  collections = [],
  onSendReport = null,
  onSendFeature = null,
  onReceiveFeature = null,
  failOpenError = null,
}) {
  const listeners = new Map();
  const dev = {
    vendorId,
    productId,
    productName,
    collections,
    opened: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    async open() {
      if (failOpenError) throw failOpenError;
      dev.opened = true;
    },
    async close() {
      dev.opened = false;
    },
    async sendReport(reportId, data) {
      const payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (onSendReport) {
        await onSendReport(reportId, payload, (inRid, bytes) => {
          const buf = Uint8Array.from(bytes);
          const ev = {
            reportId: inRid,
            data: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
          };
          for (const fn of listeners.get('inputreport') || []) fn(ev);
        });
      }
    },
    async sendFeatureReport(reportId, data) {
      const payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (onSendFeature) await onSendFeature(reportId, payload);
    },
    async receiveFeatureReport(reportId) {
      if (onReceiveFeature) return onReceiveFeature(reportId);
      return new DataView(new ArrayBuffer(0));
    },
  };
  return dev;
}

function makeMockHidManager(initialDevices = [], pickerDevices = []) {
  const hidListeners = new Map();
  const devices = [...initialDevices];
  const hid = {
    lastRequestFilters: null,
    addEventListener(type, fn) {
      if (!hidListeners.has(type)) hidListeners.set(type, new Set());
      hidListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (hidListeners.has(type)) hidListeners.get(type).delete(fn);
    },
    async getDevices() {
      return [...devices];
    },
    async requestDevice({ filters }) {
      hid.lastRequestFilters = filters;
      for (const d of pickerDevices) {
        if (!devices.includes(d)) devices.push(d);
      }
      return [...pickerDevices];
    },
    emitConnect(device) {
      if (!devices.includes(device)) devices.push(device);
      for (const fn of hidListeners.get('connect') || []) fn({ device });
    },
    emitDisconnect(device) {
      const idx = devices.indexOf(device);
      if (idx >= 0) devices.splice(idx, 1);
      for (const fn of hidListeners.get('disconnect') || []) fn({ device });
    },
  };
  return hid;
}

test('buildWebHidFilters omits usagePage and deduplicates VID/PID pairs', () => {
  const hid = makeMockHidManager();
  const { ctx } = loadWebHidInVm(hid);
  const { buildWebHidFilters } = ctx.SktdrWebHid;

  const filters = buildWebHidFilters(profiles);
  assert.ok(filters.length >= 6);
  for (const f of filters) {
    assert.equal(f.usagePage, undefined);
    assert.equal(typeof f.vendorId, 'number');
  }
  assert.ok(filters.some((f) => f.vendorId === 0x3554 && f.productId === undefined));
  assert.ok(filters.some((f) => f.vendorId === 0x1915 && f.productId === 0x0725));
  assert.ok(filters.some((f) => f.vendorId === 0x046d && f.productId === 0xc547));
});

test('scoreWebHidCandidate ranks real control collection ahead of unrelated interfaces', () => {
  const hid = makeMockHidManager();
  const { ctx } = loadWebHidInVm(hid);
  const { scoreWebHidCandidate, matchesWebHidDevice } = ctx.SktdrWebHid;

  const compx = profiles.find((p) => p.id === 'compx-generic');
  const mouseIface = {
    vendorId: 0x3554,
    productId: 0xf5f7,
    collections: [{ usagePage: 0x01, usage: 0x02, outputReports: [] }],
  };
  const wrongVendorIface = {
    vendorId: 0x3554,
    productId: 0xf5f7,
    collections: [{ usagePage: 0xff00, usage: 0x01, outputReports: [{ reportId: 1 }] }],
  };
  const controlIface = {
    vendorId: 0x3554,
    productId: 0xf5f7,
    collections: [
      {
        usagePage: 0xff02,
        usage: 0x02,
        outputReports: [{ reportId: 8 }],
        inputReports: [{ reportId: 8 }],
      },
    ],
  };

  assert.equal(matchesWebHidDevice(compx, mouseIface), false);
  assert.equal(matchesWebHidDevice(compx, controlIface), true);
  assert.ok(
    scoreWebHidCandidate(compx, controlIface) > scoreWebHidCandidate(compx, wrongVendorIface)
  );

  // Logitech HID++ prefers reportId 0x11 long report collection
  const logi = profiles.find((p) => p.id === 'logitech-pro-x-wireless');
  const shortOnly = {
    vendorId: 0x046d,
    productId: 0xc547,
    collections: [{ usagePage: 0xff00, usage: 0x01, outputReports: [{ reportId: 0x10 }] }],
  };
  const longHidpp = {
    vendorId: 0x046d,
    productId: 0xc547,
    collections: [
      {
        usagePage: 0xff00,
        usage: 0x02,
        outputReports: [{ reportId: 0x11 }],
        inputReports: [{ reportId: 0x11 }],
      },
    ],
  };
  assert.ok(scoreWebHidCandidate(logi, longHidpp) > scoreWebHidCandidate(logi, shortOnly));
});

test('WebHidBackend connects via requestDevice, configures mouse, and handles hotplug disconnect', async (t) => {
  const flash = new Uint8Array(256);
  flash[0x00] = 0x01; // 1000Hz
  flash[0x02] = 0x01;
  flash[0x04] = 0x00;
  flash[0x0c] = 0x0f; // 800 DPI at 0x000C
  flash[0x0d] = 0x0f;
  flash[0x0e] = 0x00;
  flash[0x0f] = 0x55 - 0x1e;

  const scyroxDev = makeMockHidDevice({
    vendorId: 0x3554,
    productId: 0xf5f7,
    productName: 'Scyrox V8 8K Dongle',
    collections: [
      {
        usagePage: 0xff02,
        usage: 0x02,
        outputReports: [{ reportId: 8 }],
        inputReports: [{ reportId: 8 }],
      },
    ],
    onSendReport(rid, pkt, emitInput) {
      assert.equal(rid, 8);
      const cmd = pkt[0];
      const resp = new Uint8Array(16);
      resp[0] = cmd;
      if (cmd === 0x1d) {
        resp[5] = 2;
        resp[6] = 0x17;
      } else if (cmd === 0x03) {
        resp[5] = 1;
      } else if (cmd === 0x01) {
        resp[9] = 62;
        resp[10] = 1;
        resp[11] = 2;
      } else if (cmd === 0x12) {
        resp[5] = 2;
        resp[6] = 0x22;
      } else if (cmd === 0x04) {
        resp[5] = 92;
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
        if (len === 2 && ((pkt[5] + pkt[6]) & 0xff) === 0x55) flash[addr] = pkt[5];
        else for (let i = 0; i < len; i++) flash[addr + i] = pkt[5 + i];
      } else if (cmd === 0x0e) {
        resp[5] = 0;
      } else if (cmd === 0x17) {
        resp[1] = 1;
      }
      let sum = 0;
      for (let i = 0; i < 15; i++) sum += resp[i];
      resp[15] = (((0x55 - (sum & 0xff) - 8) % 256) + 256) % 256;
      setTimeout(() => emitInput(8, resp), 1);
    },
  });

  const hid = makeMockHidManager([], [scyroxDev]);
  const mockFetch = async (url) => {
    assert.equal(url, '/api/profiles');
    return { async json() { return { ok: true, profiles }; } };
  };
  const { ctx } = loadWebHidInVm(hid, mockFetch);
  const { WebHidBackend } = ctx.SktdrWebHid;

  const events = [];
  const backend = new WebHidBackend({ waitOnlineMs: 500 });
  await backend.init((type, data) => events.push({ type, data }));
  t.after(() => backend.manager && backend.manager.destroy());

  const req = await backend.requestDevice();
  assert.equal(req.ok, true);
  assert.deepEqual([...req.connected], ['compx-generic']);

  const status = await backend.getStatus();
  const scyStatus = status.find((d) => d.id === 'compx-generic');
  assert.equal(scyStatus.connected, true);
  assert.equal(scyStatus.online, true);
  assert.equal(scyStatus.productName, 'Scyrox V8');

  const cfgRes = await backend.getConfig('compx-generic');
  assert.equal(cfgRes.config.dpi.records[0].value, 800);

  const applyRes = await backend.applySetting('compx-generic', 'dpi', {
    op: 'stageValue',
    index: 0,
    value: 1600,
  });
  assert.equal(applyRes.config.dpi.records[0].value, 1600);

  // Hotplug disconnect cleans up adapter
  hid.emitDisconnect(scyroxDev);
  const afterDisc = await backend.getStatus();
  assert.equal(afterDisc.find((d) => d.id === 'compx-generic').connected, false);
  await backend.manager.destroy();
});

test('WebHidDeviceManager handles NotAllowedError and auto-connects granted devices', async (t) => {
  // 1. NotAllowedError on protected Razer feature report
  const err = new Error('Protected collection');
  err.name = 'NotAllowedError';
  const razerBlocked = makeMockHidDevice({
    vendorId: 0x1532,
    productId: 0x00b6,
    collections: [{ usagePage: 0x01, usage: 0x02, featureReports: [{ reportId: 0 }] }],
    onSendFeature() {
      throw err;
    },
  });
  const hid1 = makeMockHidManager([], [razerBlocked]);
  const { ctx: ctx1 } = loadWebHidInVm(hid1);
  const mgr1 = new ctx1.SktdrWebHid.WebHidDeviceManager(profiles, { hid: hid1, waitOnlineMs: 200 });
  t.after(() => mgr1.destroy());
  const r1 = await mgr1.requestDevice('razer-deathadder-v3-pro');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'not-allowed');
  await mgr1.destroy();

  // 2. Auto-connect already-granted Haste 2 device on start()
  const haste2Granted = makeMockHidDevice({
    vendorId: 0x03f0,
    productId: 0x0f98,
    collections: [
      {
        usagePage: 0xff00,
        usage: 0x01,
        outputReports: [{ reportId: 0x10 }, { reportId: 0x52 }, { reportId: 0x50 }],
        inputReports: [{ reportId: 0x11 }, { reportId: 0x53 }, { reportId: 0x51 }],
      },
    ],
    onSendReport(rid, pkt, emitInput) {
      const resp = new Uint8Array(63);
      resp[0] = pkt[0] & 0x3f;
      if (rid === 0x52) resp[1] = 1; // deviceOnline = true
      if (rid === 0x50) resp[1] = 77; // battery = 77%
      if (rid === 0x32) {
        resp[1] = 0x08; // 1000Hz
        resp[2] = 0x03; // 2 stages
        resp[3] = 0;
        resp[4] = 15; // stage 0 = 800 DPI
      }
      setTimeout(() => emitInput((rid + 1) & 0xff, resp), 1);
    },
  });
  const hid2 = makeMockHidManager([haste2Granted], []);
  const { ctx: ctx2 } = loadWebHidInVm(hid2);
  const mgr2 = new ctx2.SktdrWebHid.WebHidDeviceManager(profiles, { hid: hid2, waitOnlineMs: 200 });
  t.after(() => mgr2.destroy());
  await mgr2.start();
  const st = mgr2.statusPayload().find((d) => d.id === 'hyperx-pulsefire-haste-2-wireless');
  assert.equal(st.connected, true);
  assert.equal(st.online, true);
  assert.equal(st.battery.level, 77);
  await mgr2.destroy();
});
