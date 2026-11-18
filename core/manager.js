'use strict';

// =============================================================================
// core/manager.js — device manager (multi-device).
// Loads all device profiles, connects every profile whose device is present,
// handles hotplug reconnection per profile, and exposes per-device status.
// Two (or more) different mice can be active at the same time — e.g. a
// Scyrox V8 on its dongle and a ROCCAT Kone Pro Air over USB.
// =============================================================================

const HID = require('node-hid');
const { Transport } = require('./transport');
const { MouseAdapter } = require('./adapter');
const { matchesHidDevice } = require('./profile');

class DeviceManager {
  constructor(profiles) {
    this.profiles = profiles || [];
    this.adapters = new Map(); // profileId -> MouseAdapter
    this.connecting = new Set();
    this._eventFn = null;
    this._watchTimer = null;
    this._refreshTimers = new Map();
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

  /** Which profiles claim currently present HID devices? */
  presentProfiles() {
    let devices = [];
    try {
      devices = HID.devices();
    } catch (e) {
      return [];
    }
    return this.profiles.filter((p) => devices.some((d) => matchesHidDevice(p, d)));
  }

  /** Connect one profile's device (no-op if already connected). */
  async connectProfile(profile) {
    if (this.adapters.has(profile.id) || this.connecting.has(profile.id)) return;
    this.connecting.add(profile.id);
    this._emit('status', this.statusPayload());
    try {
      const opened = await Transport.openFirst(profile);
      if (!opened) return; // device not present
      const adapter = new MouseAdapter(opened.transport, profile);
      adapter.onEvent((type, data) => this._handleAdapterEvent(profile.id, type, data));
      const online = await adapter.initialize({
        waitOnlineMs: 15000,
        onWaiting: () => this._emit('waiting', { device: profile.id }),
      });
      if (adapter.tr._closed) return; // vanished during init
      this.adapters.set(profile.id, adapter);
      adapter.startMonitor();
      this._emit('status', this.statusPayload());
      if (adapter.config && Object.keys(adapter.config).length) {
        this._emit('config', { device: profile.id, data: adapter.config });
      }
      if (!online) this._emit('waiting', { device: profile.id });
    } catch (e) {
      console.error(`[manager] connect ${profile.id} error:`, e.message);
      try {
        if (this.adapters.has(profile.id)) {
          this.adapters.get(profile.id).destroy();
          this.adapters.delete(profile.id);
        }
      } catch (e2) {
        /* ignore */
      }
    } finally {
      this.connecting.delete(profile.id);
      this._emit('status', this.statusPayload());
    }
  }

  async connectAll() {
    for (const p of this.profiles) {
      await this.connectProfile(p);
    }
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
      case 'disconnect':
        if (this.adapters.has(deviceId)) {
          try {
            this.adapters.get(deviceId).destroy();
          } catch (e) {
            /* ignore */
          }
          this.adapters.delete(deviceId);
        }
        this._emit('status', this.statusPayload());
        break;
      default:
        break;
    }
  }

  scheduleRefresh(deviceId, delayMs = 600) {
    const a = this.adapters.get(deviceId);
    if (!a || !a.online) return;
    clearTimeout(this._refreshTimers.get(deviceId));
    this._refreshTimers.set(
      deviceId,
      setTimeout(async () => {
        const ad = this.adapters.get(deviceId);
        if (!ad || !ad.online) return;
        try {
          await ad.refreshConfig();
        } catch (e) {
          /* keep last known config */
        }
      }, delayMs)
    );
  }

  /** Hotplug watcher: (re)connect each profile when its device appears. */
  startWatcher(intervalMs = 2000) {
    if (this._watchTimer) return;
    this._watchTimer = setInterval(async () => {
      let present = [];
      try {
        present = HID.devices();
      } catch (e) {
        return;
      }
      for (const p of this.profiles) {
        if (this.adapters.has(p.id) || this.connecting.has(p.id)) continue;
        if (!present.some((d) => matchesHidDevice(p, d))) continue;
        this.connectProfile(p).catch(() => {});
      }
    }, intervalMs);
  }

  /** Adapter for a device id (falls back to the first connected device). */
  getAdapter(deviceId) {
    if (deviceId && this.adapters.has(deviceId)) return this.adapters.get(deviceId);
    return this.adapters.values().next().value || null;
  }

  requireAdapter(deviceId) {
    return this.getAdapter(deviceId) || null;
  }

  statusPayload() {
    const devices = [];
    for (const p of this.profiles) {
      const a = this.adapters.get(p.id);
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

  /** UI schema for a device id (works even before that device connects). */
  schemaPayload(deviceId) {
    const a = this.adapters.get(deviceId);
    const p =
      (a && a.profile) ||
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

module.exports = { DeviceManager };
