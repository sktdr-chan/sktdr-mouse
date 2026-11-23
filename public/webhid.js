(function (root, factory) {
  'use strict';
  const core = root.SktdrCore || {};
  const api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SktdrWebHid = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  // ===========================================================================
  // public/webhid.js — browser-side WebHID runtime.
  // Bridges navigator.hid (HIDDevice) to core/transport.js and core/adapter.js
  // using the exact same device profiles (served via /api/profiles) as the
  // standalone Node/Electron app.
  // ===========================================================================

  const { num, Transport, TransportError, MouseAdapter } = core;

  function toUint8(data) {
    if (data instanceof Uint8Array) {
      // Ensure a standalone ArrayBuffer slice so WebHID never complains about
      // a shared underlying buffer with an offset.
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
        return data;
      }
      return data.slice();
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    return Uint8Array.from(data || []);
  }

  function metaFromHidDevice(hidDevice) {
    return {
      vendorId: hidDevice.vendorId,
      productId: hidDevice.productId,
      product: hidDevice.productName || null,
      collections: hidDevice.collections || [],
    };
  }

  /**
   * Channel adapter wrapping a browser WebHID HIDDevice to implement the
   * Transport HID channel contract.
   */
  class WebHidChannel {
    constructor(hidDevice) {
      this.device = hidDevice;
      this._onData = null;
      this._onDisconnect = null;
      this._closed = false;
      this._inputHandler = null;
    }

    startRead(onData, onDisconnect) {
      this._onData = onData;
      this._onDisconnect = onDisconnect;
      this._inputHandler = (ev) => {
        if (this._closed || !this._onData || !ev || !ev.data) return;
        const raw = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
        const rid = (ev.reportId || 0) & 0xff;
        if (rid !== 0) {
          const pkt = new Uint8Array(raw.length + 1);
          pkt[0] = rid;
          pkt.set(raw, 1);
          this._onData(pkt);
        } else {
          this._onData(raw.slice());
        }
      };
      this.device.addEventListener('inputreport', this._inputHandler);
    }

    sendReport(reportId, payload) {
      return this.device.sendReport(reportId & 0xff, toUint8(payload));
    }

    sendFeatureReport(reportId, payload) {
      return this.device.sendFeatureReport(reportId & 0xff, toUint8(payload));
    }

    async receiveFeatureReport(reportId, bodyLength) {
      const dv = await this.device.receiveFeatureReport(reportId & 0xff);
      if (!dv) return null;
      const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const rid = reportId & 0xff;
      if (raw.length >= bodyLength + 1 && raw[0] === rid) {
        return raw.slice(1, 1 + bodyLength);
      }
      if (raw.length >= bodyLength) {
        return raw.slice(0, bodyLength);
      }
      return null;
    }

    notifyDisconnected(reason = 'disconnected') {
      if (this._closed) return;
      this._detachListener();
      if (typeof this._onDisconnect === 'function') {
        this._onDisconnect(reason);
      }
    }

    _detachListener() {
      if (this._inputHandler && this.device && typeof this.device.removeEventListener === 'function') {
        try {
          this.device.removeEventListener('inputreport', this._inputHandler);
        } catch (e) {
          /* ignore */
        }
      }
      this._inputHandler = null;
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this._detachListener();
      if (this.device && this.device.opened && typeof this.device.close === 'function') {
        return this.device.close().catch(() => {});
      }
    }
  }

  /**
   * Build navigator.hid.requestDevice({ filters }) entries.
   * Intentionally omits usagePage because WebHID matches usagePage by exact
   * equality, whereas profiles specify a minimum vendor usagePage (0xFF00+).
   * Specific collection filtering happens during candidate matching/scoring.
   */
  function buildWebHidFilters(profiles, profileId = null) {
    const list = profileId ? (profiles || []).filter((p) => p.id === profileId) : profiles || [];
    const seen = new Set();
    const filters = [];
    for (const p of list) {
      const usb = p.usb || {};
      const vid = num(usb.vendorId, -1);
      if (vid < 0) continue;
      const pids = (usb.productIds || []).map((x) => num(x, -1)).filter((x) => x >= 0);
      if (pids.length === 0) {
        const key = `${vid}:*`;
        if (!seen.has(key)) {
          seen.add(key);
          filters.push({ vendorId: vid });
        }
      } else {
        for (const pid of pids) {
          const key = `${vid}:${pid}`;
          if (!seen.has(key)) {
            seen.add(key);
            filters.push({ vendorId: vid, productId: pid });
          }
        }
      }
    }
    return filters;
  }

  /** Check whether a WebHID HIDDevice matches a profile's VID/PID/usagePage. */
  function matchesWebHidDevice(profile, hidDevice) {
    if (!profile || !hidDevice) return false;
    const usb = profile.usb || {};
    if (num(usb.vendorId, -1) !== hidDevice.vendorId) return false;
    const pids = (usb.productIds || []).map((x) => num(x, -1));
    if (pids.length > 0 && !pids.includes(hidDevice.productId)) return false;
    const minUsagePage = num(usb.vendorUsagePageMin, 0xff00);
    if (minUsagePage > 0) {
      const cols = Array.isArray(hidDevice.collections) ? hidDevice.collections : [];
      return cols.some((c) => (c.usagePage || 0) >= minUsagePage);
    }
    return true;
  }

  function collectionByteLength(reportInfo) {
    if (!reportInfo || !Array.isArray(reportInfo.items)) return 0;
    let bits = 0;
    for (const item of reportInfo.items) {
      bits += (item.reportSize || 0) * (item.reportCount || 0);
    }
    return Math.ceil(bits / 8);
  }

  /**
   * Score an HIDDevice interface for a profile so the real control interface is
   * probed first instead of timing out on unrelated collections.
   */
  function scoreWebHidCandidate(profile, hidDevice) {
    const cols = Array.isArray(hidDevice.collections) ? hidDevice.collections : [];
    const t = profile.transport || {};
    const usb = profile.usb || {};
    const type = t.type || 'hid16';
    const pktLen = num(t.packetLength, 16);
    const minUsagePage = num(usb.vendorUsagePageMin, 0xff00);
    let score = 0;

    let expectedOutId = num(t.reportId, 0);
    if (type === 'hidpp') {
      expectedOutId = 0x11;
    } else if (type === 'ngenuityUniversal') {
      const probeName = usb.probeCommand || 'getInfo';
      const cmdDef = (profile.commands || {})[probeName] || {};
      expectedOutId = num(cmdDef.id, 0x10);
    }

    for (const c of cols) {
      const up = c.usagePage || 0;
      const usage = c.usage || 0;
      if (up >= 0xff00) score += 30;
      else if (up >= minUsagePage) score += 10;

      if (type !== 'razer' && up === 0x01 && (usage === 0x02 || usage === 0x06)) {
        score -= 10;
      }

      if (type === 'razer') {
        const feats = Array.isArray(c.featureReports) ? c.featureReports : [];
        for (const fr of feats) {
          if ((fr.reportId || 0) === 0) {
            score += 100;
            if (collectionByteLength(fr) === pktLen) score += 50;
          }
        }
      } else {
        const outs = Array.isArray(c.outputReports) ? c.outputReports : [];
        const ins = Array.isArray(c.inputReports) ? c.inputReports : [];
        if (outs.some((r) => (r.reportId || 0) === expectedOutId)) score += 100;
        const expectedInId =
          type === 'ngenuityUniversal' ? (expectedOutId + 1) & 0xff : expectedOutId;
        if (ins.some((r) => (r.reportId || 0) === expectedInId)) score += 50;
        if (type === 'hidpp' && ins.some((r) => (r.reportId || 0) === 0x10)) score += 20;
      }
    }

    if (hidDevice.opened) score += 5;
    return score;
  }

  class WebHidDeviceManager {
    constructor(profiles, opts = {}) {
      this.profiles = profiles || [];
      this.hid =
        opts.hid !== undefined
          ? opts.hid
          : typeof navigator !== 'undefined' && navigator.hid
            ? navigator.hid
            : null;
      this.cacheStore = opts.cacheStore || null;
      this.waitOnlineMs = num(opts.waitOnlineMs, 2500);
      this.adapters = new Map(); // profileId -> { adapter, hidDevice, channel }
      this.connecting = new Set();
      this.claimedDevices = new Set();
      this._eventFn = null;
      this._refreshTimers = new Map();
      this._started = false;
      this._onConnect = null;
      this._onDisconnect = null;
      this._onBeforeUnload = null;
    }

    onEvent(fn) {
      this._eventFn = fn;
    }

    _emit(type, data) {
      if (typeof this._eventFn === 'function') {
        try {
          this._eventFn(type, data);
        } catch (e) {
          /* ignore listener errors */
        }
      }
    }

    async start() {
      if (this._started) return;
      this._started = true;
      if (this.hid && typeof this.hid.addEventListener === 'function') {
        this._onConnect = () => {
          this.reconnectGranted().catch(() => {});
        };
        this._onDisconnect = (ev) => {
          const dev = ev && ev.device;
          if (!dev) return;
          for (const [id, entry] of this.adapters.entries()) {
            if (entry.hidDevice === dev) {
              entry.channel.notifyDisconnected('USB device disconnected');
              this._cleanupEntry(id, entry);
              this._emit('status', this.statusPayload());
            }
          }
        };
        this.hid.addEventListener('connect', this._onConnect);
        this.hid.addEventListener('disconnect', this._onDisconnect);
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        this._onBeforeUnload = () => {
          for (const entry of this.adapters.values()) {
            try {
              entry.adapter.gracefulClose();
            } catch (e) {
              /* ignore */
            }
          }
        };
        window.addEventListener('beforeunload', this._onBeforeUnload);
      }

      await this.reconnectGranted().catch(() => {});
    }

    async destroy() {
      this._started = false;
      if (this.hid && typeof this.hid.removeEventListener === 'function') {
        if (this._onConnect) this.hid.removeEventListener('connect', this._onConnect);
        if (this._onDisconnect) this.hid.removeEventListener('disconnect', this._onDisconnect);
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
      }
      for (const t of this._refreshTimers.values()) clearTimeout(t);
      this._refreshTimers.clear();
      const entries = [...this.adapters.entries()];
      for (const [id, entry] of entries) {
        this.adapters.delete(id);
        this.claimedDevices.delete(entry.hidDevice);
        try {
          await entry.adapter.gracefulClose();
        } catch (e) {
          /* ignore */
        }
      }
    }

    _cleanupEntry(deviceId, entry) {
      clearTimeout(this._refreshTimers.get(deviceId));
      this._refreshTimers.delete(deviceId);
      this.adapters.delete(deviceId);
      if (entry && entry.hidDevice) this.claimedDevices.delete(entry.hidDevice);
      if (entry && entry.adapter) {
        try {
          entry.adapter.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    }

    async reconnectGranted({ targetProfileId = null } = {}) {
      if (!this.hid || typeof this.hid.getDevices !== 'function') return [];
      const devices = await this.hid.getDevices();
      const ordered = targetProfileId
        ? [
            ...this.profiles.filter((p) => p.id === targetProfileId),
            ...this.profiles.filter((p) => p.id !== targetProfileId),
          ]
        : this.profiles;
      const results = [];
      for (const p of ordered) {
        if (this.adapters.has(p.id) || this.connecting.has(p.id)) continue;
        if (!devices.some((d) => !this.claimedDevices.has(d) && matchesWebHidDevice(p, d))) continue;
        const r = await this.connectProfile(p, devices);
        results.push({ profileId: p.id, ...r });
      }
      return results;
    }

    async connectProfile(profile, availableDevices = null) {
      if (this.adapters.has(profile.id)) {
        return { ok: true, alreadyConnected: true, profileId: profile.id };
      }
      if (this.connecting.has(profile.id)) {
        return { ok: false, reason: 'connecting' };
      }

      this.connecting.add(profile.id);
      this._emit('status', this.statusPayload());
      let lastReason = null;

      try {
        const devices =
          availableDevices ||
          (this.hid && typeof this.hid.getDevices === 'function' ? await this.hid.getDevices() : []);
        const candidates = devices
          .filter((d) => !this.claimedDevices.has(d) && matchesWebHidDevice(profile, d))
          .sort((a, b) => scoreWebHidCandidate(profile, b) - scoreWebHidCandidate(profile, a));

        if (candidates.length === 0) {
          return { ok: false, reason: 'no-match' };
        }

        for (const hidDev of candidates) {
          if (this.claimedDevices.has(hidDev)) continue;
          this.claimedDevices.add(hidDev);

          try {
            if (!hidDev.opened) {
              await hidDev.open();
            }
          } catch (e) {
            this.claimedDevices.delete(hidDev);
            const isNotAllowed =
              e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
            lastReason = isNotAllowed ? 'not-allowed' : 'open-failed';
            continue;
          }

          const channel = new WebHidChannel(hidDev);
          let hit = null;
          try {
            hit = await Transport.probeChannel(channel, metaFromHidDevice(hidDev), profile);
          } catch (e) {
            if (e && (e.code === 'not-allowed' || e.name === 'NotAllowedError')) {
              lastReason = 'not-allowed';
            }
          }

          if (!hit) {
            this.claimedDevices.delete(hidDev);
            if (!lastReason) lastReason = 'no-response';
            continue;
          }

          const adapterOpts = this.cacheStore ? { cacheStore: this.cacheStore } : {};
          const adapter = new MouseAdapter(hit.transport, profile, adapterOpts);
          adapter.onEvent((type, data) => this._handleAdapterEvent(profile.id, type, data));
          const online = await adapter.initialize({
            waitOnlineMs: this.waitOnlineMs,
            onWaiting: () => this._emit('waiting', { device: profile.id }),
          });

          if (adapter.tr._closed) {
            this.claimedDevices.delete(hidDev);
            lastReason = 'disconnected';
            continue;
          }

          this.adapters.set(profile.id, { adapter, hidDevice: hidDev, channel });
          adapter.startMonitor();
          this._emit('status', this.statusPayload());
          if (adapter.config && Object.keys(adapter.config).length) {
            this._emit('config', { device: profile.id, data: adapter.config });
          }
          if (!online) this._emit('waiting', { device: profile.id });
          return { ok: true, online, profileId: profile.id };
        }

        return { ok: false, reason: lastReason || 'no-response' };
      } catch (e) {
        const entry = this.adapters.get(profile.id);
        if (entry) this._cleanupEntry(profile.id, entry);
        return { ok: false, reason: (e && e.code) || 'error', error: e && e.message };
      } finally {
        this.connecting.delete(profile.id);
        this._emit('status', this.statusPayload());
      }
    }

    async requestDevice(profileId = null) {
      if (!this.hid || typeof this.hid.requestDevice !== 'function') {
        return { ok: false, reason: 'unsupported' };
      }
      const filters = buildWebHidFilters(this.profiles, profileId);
      let picked;
      try {
        picked = await this.hid.requestDevice({ filters });
      } catch (e) {
        if (e && e.name === 'SecurityError') {
          return { ok: false, reason: 'security-error', error: e.message };
        }
        return { ok: false, reason: 'cancelled', error: e && e.message };
      }
      if (!picked || picked.length === 0) {
        return { ok: false, reason: 'cancelled' };
      }

      const existing =
        typeof this.hid.getDevices === 'function' ? await this.hid.getDevices() : [];
      const merged = [...picked];
      for (const d of existing) {
        if (!merged.includes(d)) merged.push(d);
      }

      const targetProfiles = profileId
        ? [
            ...this.profiles.filter((p) => p.id === profileId),
            ...this.profiles.filter(
              (p) => p.id !== profileId && picked.some((d) => matchesWebHidDevice(p, d))
            ),
          ]
        : this.profiles.filter((p) => merged.some((d) => matchesWebHidDevice(p, d)));

      if (targetProfiles.length === 0) {
        return { ok: false, reason: 'no-match' };
      }

      const connected = [];
      let bestFailure = null;
      for (const p of targetProfiles) {
        if (this.adapters.has(p.id)) {
          connected.push(p.id);
          continue;
        }
        const r = await this.connectProfile(p, merged);
        if (r.ok) {
          connected.push(p.id);
        } else if (!bestFailure || r.reason === 'not-allowed') {
          bestFailure = r;
        }
      }

      if (connected.length > 0) {
        return { ok: true, connected };
      }
      return {
        ok: false,
        reason: (bestFailure && bestFailure.reason) || 'no-response',
        error: bestFailure && bestFailure.error,
      };
    }

    async disconnectDevice(profileId, { forget = false } = {}) {
      const entry = this.adapters.get(profileId);
      if (!entry) return false;
      clearTimeout(this._refreshTimers.get(profileId));
      this._refreshTimers.delete(profileId);
      this.adapters.delete(profileId);
      this.claimedDevices.delete(entry.hidDevice);
      try {
        await entry.adapter.gracefulClose();
      } catch (e) {
        /* ignore */
      }
      if (forget && entry.hidDevice && typeof entry.hidDevice.forget === 'function') {
        await entry.hidDevice.forget().catch(() => {});
      }
      this._emit('status', this.statusPayload());
      return true;
    }

    _handleAdapterEvent(deviceId, type, data) {
      switch (type) {
        case 'config':
          this._emit('config', { device: deviceId, data });
          break;
        case 'battery':
          this._emit('battery', { device: deviceId, data });
          break;
        case 'online':
          this._emit('online', { device: deviceId, data });
          if (data) this.scheduleRefresh(deviceId, 300);
          else this._emit('status', this.statusPayload());
          break;
        case 'notification':
          this._emit('notification', { device: deviceId, data });
          this.scheduleRefresh(deviceId, 400);
          break;
        case 'waiting':
          this._emit('waiting', { device: deviceId });
          break;
        case 'log':
          this._emit('log', { device: deviceId, data });
          break;
        case 'disconnect': {
          const entry = this.adapters.get(deviceId);
          this._cleanupEntry(deviceId, entry);
          this._emit('status', this.statusPayload());
          break;
        }
        default:
          break;
      }
    }

    scheduleRefresh(deviceId, delayMs = 600) {
      const entry = this.adapters.get(deviceId);
      if (!entry || !entry.adapter.online) return;
      clearTimeout(this._refreshTimers.get(deviceId));
      this._refreshTimers.set(
        deviceId,
        setTimeout(async () => {
          const cur = this.adapters.get(deviceId);
          if (!cur || !cur.adapter.online) return;
          try {
            await cur.adapter.refreshConfig();
          } catch (e) {
            /* keep last known config */
          }
        }, delayMs)
      );
    }

    getAdapter(deviceId) {
      if (deviceId && this.adapters.has(deviceId)) return this.adapters.get(deviceId).adapter;
      const first = this.adapters.values().next().value;
      return first ? first.adapter : null;
    }

    requireAdapter(deviceId) {
      return this.getAdapter(deviceId) || null;
    }

    statusPayload() {
      const devices = [];
      for (const p of this.profiles) {
        const entry = this.adapters.get(p.id);
        const a = entry ? entry.adapter : null;
        devices.push({
          id: p.id,
          name: p.meta.name,
          connecting: this.connecting.has(p.id),
          ...(a
            ? { connected: true, ...a.statusInfo() }
            : { connected: false, online: false, product: null, connection: null, battery: null }),
        });
      }
      return devices;
    }

    schemaPayload(deviceId) {
      const entry = this.adapters.get(deviceId);
      const p =
        (entry && entry.adapter.profile) ||
        this.profiles.find((x) => x.id === deviceId) ||
        this.profiles[0] ||
        null;
      if (!p) return null;
      return {
        id: p.id,
        meta: p.meta,
        documentation: p._documentation || null,
        ui: p.ui,
        keepAwake: p.keepAwake || null,
      };
    }
  }

  class WebHidBackend {
    constructor(opts = {}) {
      this.mode = 'webhid';
      this.manager = null;
      this.opts = opts;
    }

    supportState() {
      const secureContext = typeof window !== 'undefined' ? !!window.isSecureContext : true;
      const hid =
        this.opts.hid !== undefined
          ? this.opts.hid
          : typeof navigator !== 'undefined'
            ? navigator.hid
            : null;
      return {
        secureContext,
        webhidSupported: !!(hid && typeof hid.requestDevice === 'function'),
      };
    }

    async init(onEvent) {
      let profiles = this.opts.profiles;
      if (!profiles) {
        const res = await fetch('/api/profiles');
        const json = await res.json();
        if (!json || !json.ok || !Array.isArray(json.profiles)) {
          throw new Error('デバイスプロファイルの取得に失敗しました');
        }
        profiles = json.profiles;
      }
      this.manager = new WebHidDeviceManager(profiles, {
        hid: this.opts.hid,
        cacheStore: this.opts.cacheStore,
        waitOnlineMs: this.opts.waitOnlineMs,
      });
      if (typeof onEvent === 'function') {
        this.manager.onEvent(onEvent);
      }
      await this.manager.start();
      return this;
    }

    async getStatus() {
      return this.manager ? this.manager.statusPayload() : [];
    }

    async getSchema(deviceId) {
      return this.manager ? this.manager.schemaPayload(deviceId) : null;
    }

    _adapterFor(deviceId) {
      if (!this.manager) return null;
      if (deviceId) {
        const entry = this.manager.adapters.get(deviceId);
        return entry ? entry.adapter : null;
      }
      return this.manager.requireAdapter(deviceId);
    }

    async getConfig(deviceId) {
      const a = this._adapterFor(deviceId);
      if (!a) throw new TransportError('デバイスに接続されていません', 'not-connected');
      if (a.config && Object.keys(a.config).length) {
        return {
          device: a.profile.id,
          config: a.config,
          devices: this.manager.statusPayload(),
        };
      }
      const cfg = await a.refreshConfig();
      return {
        device: a.profile.id,
        config: cfg,
        devices: this.manager.statusPayload(),
      };
    }

    async applySetting(deviceId, setting, args = {}) {
      const a = this._adapterFor(deviceId);
      if (!a) throw new TransportError('デバイスに接続されていません', 'not-connected');
      if (!a.online) {
        throw new TransportError(
          'マウスがオフラインです。マウスを動かしてスリープを解除してください。',
          'offline'
        );
      }
      const cfg = await a.applySetting(setting, args);
      return {
        device: a.profile.id,
        config: cfg,
        devices: this.manager.statusPayload(),
      };
    }

    async applyAction(deviceId, action, args = {}) {
      const a = this._adapterFor(deviceId);
      if (!a) throw new TransportError('デバイスに接続されていません', 'not-connected');
      if (!a.online) {
        throw new TransportError(
          'マウスがオフラインです。マウスを動かしてスリープを解除してください。',
          'offline'
        );
      }
      await a.applyAction(action, args);
      return {
        device: a.profile.id,
        config: a.config,
        devices: this.manager.statusPayload(),
      };
    }

    async refreshConfig(deviceId) {
      const a = this._adapterFor(deviceId);
      if (!a) throw new TransportError('デバイスに接続されていません', 'not-connected');
      const cfg = await a.refreshConfig();
      return {
        device: a.profile.id,
        config: cfg,
        devices: this.manager.statusPayload(),
      };
    }

    async requestDevice(profileId = null) {
      if (!this.manager) return { ok: false, reason: 'not-ready' };
      return this.manager.requestDevice(profileId);
    }

    async reconnectGranted() {
      if (!this.manager) return [];
      return this.manager.reconnectGranted();
    }

    async disconnectDevice(deviceId, opts = {}) {
      if (!this.manager) return false;
      return this.manager.disconnectDevice(deviceId, opts);
    }
  }

  return {
    WebHidChannel,
    WebHidDeviceManager,
    WebHidBackend,
    buildWebHidFilters,
    matchesWebHidDevice,
    scoreWebHidCandidate,
  };
});
