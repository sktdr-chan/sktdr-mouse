'use strict';

// =============================================================================
// core/adapter.js — profile-driven mouse adapter.
// Implements the full device lifecycle (initialize / read config / write
// settings / monitor) generically, driven only by the device profile JSON:
//   - settings are located via profile "read"/"write" descriptors
//   - values are encoded/decoded via core/codec
//   - commands (battery, versions, profiles, reset, pairing…) are built
//     from the profile "commands" table
// No mouse-specific code lives here.
// =============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeCodec, num, CodecError } = require('./codec');
const { parseHexString } = require('./transport');

const DATA_DIR = path.join(__dirname, '..', 'data');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Render a swarm settings-packet template:
 *   "10 50 14 00 01 {activeStage:u8} {dpi1:le16x50} …"
 * Formats: u8, le16, le16x50 (value/50 as little-endian 16 bit).
 * Unresolved cache fields raise a descriptive error.
 */
function renderSwarmTemplate(template, cache) {
  const out = [];
  for (const tok of String(template).split(/\s+/)) {
    if (!tok) continue;
    const m = /^\{(\w+)(?::(\w+))?\}$/.exec(tok);
    if (!m) {
      const b = parseInt(tok, 16);
      if (!Number.isInteger(b)) throw new AdapterError(`テンプレートのトークンが不正: ${tok}`, 'bad-template');
      out.push(b & 0xff);
      continue;
    }
    const name = m[1];
    const fmt = m[2] || 'u8';
    const v = cache[name];
    if (v == null) {
      throw new AdapterError(`テンプレートフィールド ${name} がキャッシュにありません`, 'bad-template');
    }
    if (fmt === 'u8') {
      out.push(num(v) & 0xff);
    } else if (fmt === 'le16x50') {
      const n = Math.max(0, Math.round(Number(v) / 50));
      out.push(n & 0xff, (n >> 8) & 0xff);
    } else if (fmt === 'le16') {
      const n = num(v);
      out.push(n & 0xff, (n >> 8) & 0xff);
    } else {
      throw new AdapterError(`未知のテンプレート書式: ${fmt}`, 'bad-template');
    }
  }
  return out;
}

class AdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdapterError';
    this.code = code || 'generic';
  }
}

class MouseAdapter {
  constructor(transport, profile) {
    this.tr = transport;
    this.profile = profile;
    this.meta = transport.meta;

    this.online = false;
    this.cid = null;
    this.mid = null;
    this.connectionType = null;
    this.mouseVersion = null;
    this.dongleVersion = null;
    this.battery = null;
    this.image = Buffer.alloc(num((profile.transport.configImage || {}).length, 256), 0);
    this.config = {};
    this.commandValues = {}; // command-read settings (profile index, long range…)
    this._monTimer = null;
    this._monTick = 0;
    this._eventFn = null;

    // ROCCAT Swarm-style devices keep their configuration in the mouse and
    // cannot be read back — the adapter maintains a host-side cache instead,
    // seeded from the profile defaults and persisted to data/<id>.json.
    if (profile.applySequence) {
      this.cache = this._loadCache();
    }

    // flatten settings/actions for dispatch + prebuild codecs
    this.settingsByKey = {};
    this.actionsByKey = {};
    this._codecs = new Map();
    for (const sec of (this.profile.ui && this.profile.ui.sections) || []) {
      for (const s of sec.settings || []) {
        this.settingsByKey[s.key] = s;
        this._buildSettingCodecs(s);
      }
      for (const a of sec.actions || []) {
        this.actionsByKey[a.key] = a;
      }
    }
  }

  _buildSettingCodecs(s) {
    const put = (name, spec) => this._codecs.set(name, makeCodec(spec));
    if (s.type === 'dpiStages') {
      if (s.count) put(`${s.key}:count`, s.count.read.codec);
      if (s.current) put(`${s.key}:current`, s.current.read.codec);
      if (s.value) put(`${s.key}:value`, s.value.read.codec);
      if (s.color) put(`${s.key}:color`, s.color.read.codec);
    } else if (s.type === 'group') {
      for (const f of s.fields || []) put(`${s.key}:${f.key}`, f.read.codec);
      if (s.on) put(`${s.key}:${s.on.key || 'on'}`, s.on.read.codec);
    } else if (s.read && s.read.codec != null) {
      put(s.key, s.read.codec);
    }
  }

  codec(name) {
    return this._codecs.get(name);
  }

  // ------------------------------------------------------------- events ---
  onEvent(fn) {
    this._eventFn = fn;
  }

  emit(type, data) {
    if (typeof this._eventFn === 'function') {
      try {
        this._eventFn(type, data);
      } catch (e) {
        /* ignore listener errors */
      }
    }
  }

  // -------------------------------------------------------- command I/O ---
  _cmd(name, opts = {}, { addr = 0, data = [], lenOverride = null } = {}) {
    return this.tr.commandByName(name, opts, { addr, data, lenOverride });
  }

  _ok(pkt) {
    if (this.tr.type === 'swarmEcho64') {
      if (!pkt || pkt.length < 3) return false;
      return pkt[2] === (pkt[0] === 0x90 ? 0x04 : 0x03);
    }
    if (this.tr.type === 'moji64' || this.tr.type === 'hidpp' || this.tr.type === 'razer') {
      // responses are matched/validated at the transport layer (type+sub,
      // feature+fn, or status+class+cmd); error frames never reach here.
      return !!pkt;
    }
    return pkt && pkt[this.tr.L.status] === 0;
  }

  _requireOk(pkt, what) {
    if (!this._ok(pkt)) {
      throw new AdapterError(`${what}に失敗しました (デバイスが拒否/非対応)`, 'rejected');
    }
  }

  /** Optional status-sync command sent before every write (per profile). */
  async _statusSync() {
    const name = this.profile.transport && this.profile.transport.statusSyncBeforeWrite;
    if (!name) return;
    await this._cmd(name, { timeout: 250, retries: 1 }).catch(() => {});
  }

  async _writeSingleByte(addr, value) {
    await this._statusSync();
    const res = await this.tr.command(this.tr.singleByteWritePacket(addr, value), {
      timeout: 300,
      retries: 3,
    });
    this._requireOk(res, `書き込み (0x${addr.toString(16).padStart(4, '0')})`);
    this.image[addr] = value & 0xff;
  }

  async _writeBytes(addr, data) {
    await this._statusSync();
    const res = await this.tr.command(this.tr.flashWritePacket(addr, data), {
      timeout: 300,
      retries: 3,
    });
    this._requireOk(res, `書き込み (0x${addr.toString(16).padStart(4, '0')})`);
    for (let i = 0; i < data.length; i++) this.image[addr + i] = data[i] & 0xff;
  }

  // ------------------------------------------------------- initialization --
  /**
   * Full init sequence per profile commands.
   * Returns true when the mouse is awake and fully read; false when the
   * mouse stayed asleep (dongle remains usable; the monitor keeps polling).
   */
  async initialize({ waitOnlineMs = 15000, onWaiting = null } = {}) {
    // ROCCAT Swarm-style: wired, no sleep protocol, no handshake — verify the
    // channel with a battery poll, then use the host-side cache.
    if (this.profile.applySequence) {
      this.online = true;
      await this.getBattery();
      this.parseAll();
      return true;
    }

    // announce the driver so the mouse keeps its radio link active
    // (only when the device supports the command)
    if (this.profile.commands.pcDriverStatus) {
      await this._cmd('pcDriverStatus', { timeout: 300, retries: 1 }, { data: [0x01] }).catch(() => {});
    }

    // Devices without a DeviceOnLine command (e.g. VXE MAD R) talk to the
    // mouse directly through the dongle — treat them as always online.
    if (!this.profile.commands.deviceOnline) {
      this.online = true;
      await this._afterOnlineInit();
      return true;
    }

    const deadline = Date.now() + waitOnlineMs;
    let warned = false;
    for (;;) {
      const res = await this._cmd('deviceOnline', { timeout: 300, retries: 1 });
      const off = num((this.profile.commands.deviceOnline.response || {}).online, 5);
      if (res[off] === 1) {
        this.online = true;
        break;
      }
      if (Date.now() >= deadline) {
        this.online = false;
        return false;
      }
      if (!warned) {
        warned = true;
        this.emit('waiting', {});
        if (onWaiting) onWaiting();
      }
      await sleep(1500);
    }

    await this._afterOnlineInit();
    return true;
  }

  async _afterOnlineInit() {
    // handshake identifies CID/MID/connection type — optional per family
    if (this.profile.commands.handshake) {
      const rnd = crypto.randomBytes(num((this.profile.commands.handshake || {}).randomDataLength, 4));
      const hsData = [...rnd, 0, 0, 0, 0];
      const hs = await this._cmd('handshake', { timeout: 300, retries: 2 }, { data: hsData });
      const hsr = this.profile.commands.handshake.response || {};
      this.cid = hs[num(hsr.cid, 9)];
      this.mid = hs[num(hsr.mid, 10)];
      this.connectionType = hs[num(hsr.connectionType, 11)];
    }

    // versions — optional per family
    for (const [name, slot] of [
      ['dongleVersion', 'dongleVersion'],
      ['mouseVersion', 'mouseVersion'],
    ]) {
      if (!this.profile.commands[name]) continue;
      try {
        const res = await this._cmd(name, { timeout: 300, retries: 1 });
        if (this._ok(res)) {
          const r = this.profile.commands[name].response || {};
          this[slot] = this.formatVersion(res[num(r.versionMajor, 5)], res[num(r.versionMinor, 6)]);
        }
      } catch (e) {
        /* optional */
      }
    }

    await this.refreshConfig();

    // command-read settings (profile index, long range, …)
    for (const s of Object.values(this.settingsByKey)) {
      if (s.read && s.read.command && s.type !== 'group' && s.type !== 'dpiStages') {
        await this._refreshCommandSetting(s).catch(() => {});
      }
    }
    // fold the freshly read command values into the cached config
    this.parseAll();

    try {
      await this.getBattery();
    } catch (e) {
      /* offline battery is fine */
    }
  }

  async _refreshCommandSetting(s) {
    const res = await this._cmd(s.read.command, { timeout: 300, retries: 2 });
    const cmdDef = this.profile.commands[s.read.command] || {};
    const off = num((cmdDef.response || {})[s.read.field], 5);
    if (s.type === 'toggle') {
      if (s.read.command === 'getLongRange' && !this._ok(res)) {
        // firmware without long-range support answers with status != 0
        this.commandValues[s.key] = null;
      } else {
        this.commandValues[s.key] = res[off] === 1;
      }
    } else if (num(s.read.bytes, 1) === 2) {
      // 16-bit big-endian value (e.g. HID++ adjustable DPI)
      let v = (res[off] << 8) | res[off + 1];
      if (v === 0 && s.read.fallbackField) {
        const fb = num((cmdDef.response || {})[s.read.fallbackField], off + 2);
        v = (res[fb] << 8) | res[fb + 1];
      }
      this.commandValues[s.key] = v;
    } else {
      // numeric / raw value (e.g. profile index); optionally run it through
      // the setting's codec so raw codes become UI values (e.g. rate ms → Hz)
      let v = res[off];
      if (s.read.codec) {
        const c = this.codec(s.key);
        if (c) v = c.decode(Buffer.from([v & 0xff]));
      }
      this.commandValues[s.key] = v;
    }
  }

  formatVersion(major, minor) {
    const f = this.profile.versionFormat || 'v{major}.{minorHex2}';
    return String(f)
      .replace('{major}', String(major))
      .replace('{minorHex2}', (minor & 0xff).toString(16).padStart(2, '0'))
      .replace('{minorHi}', String(((minor & 0xff) >> 4) & 0x0f))
      .replace('{minorLo}', String((minor & 0xff) & 0x0f))
      .replace('{minor}', String(minor));
  }

  // ------------------------------------------------------ config image ----
  async refreshConfig() {
    // Swarm-style devices cannot be read back — poll the battery to confirm
    // the device is alive, then serve the host cache as the truth.
    if (this.profile.applySequence) {
      await this.getBattery(); // 失敗すれば上位へエラー伝播（デバイス不在等）
      this.parseAll();
      this.emit('config', this.config);
      return this.config;
    }
    // MOJI/Razer command-frame devices (Darmoshark, Razer): each declared
    // command returns one frame that becomes a slice of the config image.
    if (this.tr.type === 'moji64' || this.tr.type === 'razer') {
      const imgs = (this.profile.transport.commandImages || []).filter(
        (im) => this.profile.commands[im.command]
      );
      for (const im of imgs) {
        const res = await this.tr.commandByName(im.command, { timeout: 300, retries: 3 });
        if (!this._ok(res)) throw new AdapterError('設定の読み出しに失敗しました', 'read-failed');
        this.image.set(res.slice(0, this.tr.packetLength), num(im.base, 0));
      }
      this.parseAll();
      this.emit('config', this.config);
      return this.config;
    }
    // HID++ feature devices (Logitech): every setting is a feature call —
    // re-read the command-backed settings and reparse.
    if (this.tr.type === 'hidpp') {
      for (const s of Object.values(this.settingsByKey)) {
        if (s.read && s.read.command && s.type !== 'group' && s.type !== 'dpiStages') {
          await this._refreshCommandSetting(s).catch(() => {});
        }
      }
      this.parseAll();
      this.emit('config', this.config);
      return this.config;
    }
    const t = this.profile.transport;
    const ci = t.configImage || {};

    // Page-mapped devices (VXE MAD R style): "addresses" are page IDs, each
    // with its own length — read every listed page into the sparse image.
    if (ci.mode === 'pages') {
      for (const pg of ci.pages || []) {
        const page = num(pg.address);
        const len = Math.min(num(pg.len, 8), 10);
        const res = await this.tr.command(this.tr.readFlashPacket(page, len), {
          timeout: 250,
          retries: 3,
        });
        if (!this._ok(res)) throw new AdapterError('設定の読み出しに失敗しました', 'read-failed');
        const dataAt = this.tr.L.data;
        this.image.set(res.slice(dataAt, dataAt + len), page);
      }
      this.parseAll();
      this.emit('config', this.config);
      return this.config;
    }

    const start = num(ci.start, 0);
    const length = num((t.configImage || {}).length, 256);
    const chunk = Math.min(num(t.readChunk, 10), 10);
    for (let off = 0; off < length; off += chunk) {
      const len = Math.min(chunk, length - off);
      const res = await this.tr.command(this.tr.readFlashPacket(start + off, len), {
        timeout: 250,
        retries: 3,
      });
      if (!this._ok(res)) throw new AdapterError('設定の読み出しに失敗しました', 'read-failed');
      const dataAt = this.tr.L.data;
      this.image.set(res.slice(dataAt, dataAt + len), start + off);
    }
    this.parseAll();
    this.emit('config', this.config);
    return this.config;
  }

  /** Parse this.image (or the host cache) into this.config using profile descriptors (no IO). */
  parseAll() {
    const cfg = {};
    for (const sec of (this.profile.ui && this.profile.ui.sections) || []) {
      for (const s of sec.settings || []) {
        try {
          this._parseSettingInto(cfg, s);
        } catch (e) {
          this.emit('log', { level: 'warn', message: `設定 ${s.key} の解析に失敗: ${e.message}` });
        }
      }
    }
    this.config = cfg;
  }

  _parseSettingInto(cfg, s) {
    // ---- host-cache backed settings (ROCCAT Swarm-style profiles) ----
    if (this.cache) {
      if (s.type === 'dpiStages') {
        const n = num(s.maxRecords, 8);
        const records = [];
        for (let i = 1; i <= n; i++) {
          const v = num(this.cache[`dpi${i}`], 0);
          records.push({ value: v });
        }
        const count = records.filter((r) => r.value > 0).length;
        cfg[s.key] = {
          count: count || n,
          current: num(this.cache.activeStage, 0),
          records,
        };
        return;
      }
      if (s.read && s.read.cache != null) {
        let v = this.cache[s.read.cache];
        if (s.read.codec) {
          const c = this.codec(s.key);
          v = c ? c.decode(Buffer.from([num(v, 0)])) : v;
        }
        cfg[s.key] = v;
        return;
      }
      cfg[s.key] = this.cache[s.key] !== undefined ? this.cache[s.key] : null;
      return;
    }

    switch (s.type) {
      case 'dpiStages': {
        const countC = this.codec(`${s.key}:count`);
        const curC = this.codec(`${s.key}:current`);
        const valC = this.codec(`${s.key}:value`);
        const colC = s.color ? this.codec(`${s.key}:color`) : null;
        const vAddr = num(s.value.read.address);
        const vStride = num(s.value.read.stride, 4);
        const cAddr = s.color ? num(s.color.read.address) : 0;
        const cStride = s.color ? num(s.color.read.stride, 4) : 4;
        const n = num(s.maxRecords, 8);
        const records = [];
        for (let i = 0; i < n; i++) {
          const vo = vAddr + i * vStride;
          const co = cAddr + i * cStride;
          records.push({
            value: valC.decode(this.image.slice(vo, vo + valC.bytes)),
            ...(colC ? { color: colC.decode(this.image.slice(co, co + colC.bytes)) } : {}),
          });
        }
        const cntAddr = num(s.count.read.address);
        const curAddr = num(s.current.read.address);
        cfg[s.key] = {
          count: countC.decode(this.image.slice(cntAddr, cntAddr + countC.bytes)),
          current: curC.decode(this.image.slice(curAddr, curAddr + curC.bytes)),
          records,
        };
        break;
      }
      case 'group': {
        const blockAddr = num(s.block.address);
        const blockLen = num(s.block.length);
        const block = this.image.slice(blockAddr, blockAddr + blockLen);
        const obj = {};
        for (const f of s.fields || []) {
          const c = this.codec(`${s.key}:${f.key}`);
          const off = num(f.read.offset);
          const bytes = num(f.read.bytes, c.bytes);
          obj[f.key] = c.decode(block.slice(off, off + bytes));
        }
        if (s.on) {
          const c = this.codec(`${s.key}:${s.on.key || 'on'}`);
          const addr = num(s.on.read.address);
          obj[s.on.key || 'on'] = c.decode(this.image.slice(addr, addr + c.bytes));
        }
        cfg[s.key] = obj;
        break;
      }
      default: {
        if (s.read && s.read.command) {
          cfg[s.key] = this.commandValues[s.key] !== undefined ? this.commandValues[s.key] : null;
        } else if (s.read && s.read.address != null) {
          const c = this.codec(s.key);
          const addr = num(s.read.address);
          cfg[s.key] = c.decode(this.image.slice(addr, addr + num(s.read.bytes, c.bytes)));
        }
      }
    }
  }

  // ---------------------------------------------------------- apply ops ---
  /**
   * Generic entry point used by POST /api/apply.
   * args shapes per setting type:
   *   simple      -> { value }
   *   dpiStages   -> { op: 'count'|'current'|'stageValue'|'stageColor', index?, value|color }
   *   group       -> { field, value }
   *   command     -> { value }
   */
  async applySetting(key, args = {}) {
    const s = this.settingsByKey[key];
    if (!s) throw new AdapterError(`未知の設定: ${key}`, 'unknown-setting');
    if (!this.online) {
      throw new AdapterError('マウスがオフラインです。マウスを動かしてスリープを解除してください。', 'offline');
    }

    // ROCCAT Swarm-style: update the host cache, then replay the full
    // fixed command sequence from the profile (preamble → settings block →
    // postfix), byte-identical to what the official driver sends.
    if (this.profile.applySequence) {
      return this._applySwarmSetting(s, args);
    }

    // MOJI/HID++ command-frame devices (Darmoshark, Logitech): mutate the
    // config image (if any), then send the setting's command frame with a
    // payload built from image bytes / the value itself.
    if (s.write && (s.write.mode === 'mojiCommand' || s.write.mode === 'commandFrame')) {
      return this._applyMojiCommand(s, args);
    }

    switch (s.type) {
      case 'dpiStages':
        await this._applyDpi(s, args);
        break;
      case 'group':
        await this._applyGroup(s, args);
        break;
      default: {
        if (s.write && s.write.command) {
          await this._applyCommandSetting(s, args.value);
        } else if (s.write && s.write.mode === 'bytes') {
          const c = this.codec(s.key);
          const data = c.encode(args.value);
          await this._writeBytes(num(s.read.address), data);
        } else {
          const c = this.codec(s.key);
          const data = c.encode(args.value);
          await this._writeSingleByte(num(s.read.address), data[0]);
          // Some settings need a confirmation write on another page
          // (e.g. VXE MAD R sleep → the 0xB5 confirmation block).
          // followUp entries: "raw" = the value byte, "rawComp" = 0x55 - value.
          for (const fu of (s.write && s.write.followUp) || []) {
            const raw = data[0];
            const payload = (fu.data || []).map((entry) => {
              if (entry === 'raw') return raw & 0xff;
              if (entry === 'rawComp') return (0x55 - raw) & 0xff;
              return num(entry) & 0xff;
            });
            await this._writeBytes(num(fu.address), payload);
          }
        }
      }
    }

    this.parseAll();
    this.emit('config', this.config);
    return this.config;
  }

  // ------------------------------------------------- moji-style writes ---
  /**
   * Darmoshark (MOJI) write engine, driven by the profile:
   *   1. mutate this.image (bit / byte / le16 / rgb at the setting address,
   *      or the dpiStages sub-ops),
   *   2. render the command frame payload from image bytes + literals
   *      ("payload" tokens: number | {image} | {imageLe16} | {imageBytes}
   *      | {value:"u8"}),
   *   3. send it, persist with saveData, and re-read the config.
   */
  async _applyMojiCommand(s, args = {}) {
    const w = s.write;
    const upd = w.updateImage || { type: 'byte' };

    // ---- 1. mutate the image ----
    if (s.type === 'dpiStages') {
      const n = num(s.maxRecords, 5);
      const vAddr = num(s.value.read.address);
      const vStride = num(s.value.read.stride, 4);
      switch (args.op) {
        case 'count': {
          const v = num(args.value, -1);
          if (!Number.isInteger(v) || v < 1 || v > n) {
            throw new AdapterError(`ステージ数は1〜${n}です`, 'bad-args');
          }
          this.image[num(s.count.read.address)] = this.codec(`${s.key}:count`).encode(v)[0];
          if (w.normalizeDpiStages) this._normalizeDpiStages(s);
          break;
        }
        case 'current': {
          const v = num(args.value, -1);
          if (!Number.isInteger(v) || v < 0 || v > n - 1) {
            throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
          }
          this.image[num(s.current.read.address)] = this.codec(`${s.key}:current`).encode(v)[0];
          break;
        }
        case 'stageValue': {
          const idx = num(args.index, -1);
          if (!Number.isInteger(idx) || idx < 0 || idx > n - 1) {
            throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
          }
          const enc = this.codec(`${s.key}:value`).encode(args.value);
          for (let i = 0; i < enc.length; i++) {
            this.image[vAddr + idx * vStride + i] = enc[i] & 0xff;
          }
          break;
        }
        case 'stageColor':
          throw new AdapterError('この機種ではステージカラーは変更できません', 'unsupported');
        default:
          throw new AdapterError(`不明なDPI操作: ${args.op}`, 'bad-args');
      }
    } else if (s.type === 'group' && args.field != null) {
      const f = (s.fields || []).find((x) => x.key === args.field);
      if (!f) throw new AdapterError(`未知のフィールド: ${args.field}`, 'bad-args');
      const c = this.codec(`${s.key}:${f.key}`);
      const enc = c.encode(args.value);
      const blockAddr = num(s.block.address);
      const wo = blockAddr + num(f.writeOffset, num(f.read.offset));
      for (let i = 0; i < enc.length; i++) this.image[wo + i] = enc[i] & 0xff;
    } else if (s.read && s.read.address != null) {
      // simple image-backed setting
      const addr = num(s.read.address);
      if (upd.type === 'bit') {
        const bit = num(upd.bit);
        this.image[addr] = args.value
          ? (this.image[addr] | (1 << bit)) & 0xff
          : (this.image[addr] & ~(1 << bit)) & 0xff;
      } else {
        const enc = this.codec(s.key).encode(args.value);
        for (let i = 0; i < enc.length; i++) this.image[addr + i] = enc[i] & 0xff;
      }
    }

    // ---- 2. render the frame payload ----
    const bytes = [];
    for (const tok of w.payload || []) {
      if (typeof tok === 'number') {
        bytes.push(tok & 0xff);
      } else if (tok && tok.image != null) {
        bytes.push(this.image[num(tok.image)] & 0xff);
      } else if (tok && tok.imageLe16 != null) {
        const o = num(tok.imageLe16);
        bytes.push(this.image[o] & 0xff, this.image[o + 1] & 0xff);
      } else if (tok && Array.isArray(tok.imageBytes)) {
        const [start, len] = tok.imageBytes.map(num);
        for (let i = 0; i < len; i++) bytes.push(this.image[start + i] & 0xff);
      } else if (tok && tok.value === 'u8') {
        bytes.push(num(args.value) & 0xff);
      } else if (tok && tok.value === 'enumCode') {
        // run the UI value through the setting's enum codec (value → code)
        const c = this.codec(s.key);
        if (!c) throw new AdapterError(`設定 ${s.key} にコーデックがありません`, 'bad-template');
        bytes.push(c.encode(args.value)[0] & 0xff);
      } else if (tok && tok.value === 'be16') {
        const v = num(args.value);
        bytes.push((v >> 8) & 0xff, v & 0xff);
      } else {
        throw new AdapterError(`不正なペイロードトークン: ${JSON.stringify(tok)}`, 'bad-template');
      }
    }

    // ---- 3. send, persist, re-read ----
    await this._statusSync(); // e.g. HID++: ensure host mode before writing
    const res = await this._cmd(w.command, { timeout: 400, retries: 3 }, { data: bytes });
    this._requireOk(res, `設定の書き込み (${s.key})`);
    if (this.profile.commands.saveData) {
      await this._cmd('saveData', { timeout: 400, retries: 2 }).catch(() => {});
    }
    if (s.read && s.read.command && s.type !== 'group' && s.type !== 'dpiStages') {
      // command-read settings (e.g. active profile) have no image slot —
      // remember the new value directly.
      this.commandValues[s.key] = num(args.value, 0);
    }
    await this.refreshConfig();
    return this.config;
  }

  /**
   * Razer-style DPI stage tables store 1-based stage numbers and BE16 X/Y
   * pairs per record; when the stage count grows, the newly enabled records
   * are still zeroed — fill them with valid stage numbers and a sane DPI so
   * the device never sees an empty active stage.
   */
  _normalizeDpiStages(s) {
    const n = num(s.maxRecords, 5);
    const countAddr = num(s.count.read.address);
    const count = Math.max(1, Math.min(this.image[countAddr] || 1, n));
    const vAddr = num(s.value.read.address);
    const vStride = num(s.value.read.stride, 4);
    for (let i = 0; i < count; i++) {
      const rec = vAddr + i * vStride - 1; // record starts 1 byte before X
      const x = (this.image[rec + 1] << 8) | this.image[rec + 2];
      if (x === 0) {
        this.image[rec] = i + 1; // 1-based stage number
        const def = num(s.valueRange && s.valueRange.min, 800) || 800;
        this.image[rec + 1] = (def >> 8) & 0xff;
        this.image[rec + 2] = def & 0xff;
        this.image[rec + 3] = (def >> 8) & 0xff;
        this.image[rec + 4] = def & 0xff;
      }
    }
  }

  async _applyDpi(s, args) {
    const n = num(s.maxRecords, 8);
    const vAddr = num(s.value.read.address);
    const vStride = num(s.value.read.stride, 4);
    const cAddr = num(s.color.read.address);
    const cStride = num(s.color.read.stride, 4);

    switch (args.op) {
      case 'count': {
        const v = num(args.value, -1);
        if (!Number.isInteger(v) || v < 1 || v > n) {
          throw new AdapterError(`ステージ数は1〜${n}です`, 'bad-args');
        }
        await this._writeSingleByte(num(s.count.read.address), v);
        break;
      }
      case 'current': {
        const v = num(args.value, -1);
        if (!Number.isInteger(v) || v < 0 || v > n - 1) {
          throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
        }
        await this._writeSingleByte(num(s.current.read.address), v);
        break;
      }
      case 'stageValue': {
        const idx = num(args.index, -1);
        if (!Number.isInteger(idx) || idx < 0 || idx > n - 1) {
          throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
        }
        const data = this.codec(`${s.key}:value`).encode(args.value);
        await this._writeBytes(vAddr + idx * vStride, data);
        break;
      }
      case 'stageColor': {
        const idx = num(args.index, -1);
        if (!Number.isInteger(idx) || idx < 0 || idx > n - 1) {
          throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
        }
        const data = this.codec(`${s.key}:color`).encode(args.color);
        await this._writeBytes(cAddr + idx * cStride, data);
        break;
      }
      default:
        throw new AdapterError(`不明なDPI操作: ${args.op}`, 'bad-args');
    }
  }

  // ------------------------------------------------- swarm-style writes ---
  /**
   * Update the host cache from UI args, then replay the profile's fixed
   * apply sequence (preamble → settings block → postfix) exactly like the
   * official driver does.
   */
  async _applySwarmSetting(s, args) {
    if (s.type === 'dpiStages') {
      const n = num(s.maxRecords, 8);
      switch (args.op) {
        case 'stageValue': {
          const idx = num(args.index, -1);
          if (!Number.isInteger(idx) || idx < 0 || idx > n - 1) {
            throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
          }
          const dpi = num(args.value, NaN);
          if (!Number.isInteger(dpi) || dpi < 50 || dpi > 19000 || dpi % 50 !== 0) {
            throw new AdapterError('DPIは50〜19000の範囲で50刻みです', 'bad-args');
          }
          this.cache[`dpi${idx + 1}`] = dpi;
          break;
        }
        case 'current': {
          const idx = num(args.value, -1);
          if (!Number.isInteger(idx) || idx < 0 || idx > n - 1) {
            throw new AdapterError(`ステージ番号は0〜${n - 1}です`, 'bad-args');
          }
          this.cache.activeStage = idx;
          break;
        }
        case 'count':
        case 'stageColor':
          throw new AdapterError('この機種ではサポートされていない操作です', 'unsupported');
        default:
          throw new AdapterError(`不明なDPI操作: ${args.op}`, 'bad-args');
      }
    } else if (s.write && s.write.cache != null) {
      let v = args.value;
      const c = this.codec(s.key);
      if (c) v = c.encode(args.value)[0];
      this.cache[s.write.cache] = num(v, 0);
    } else {
      throw new AdapterError(`設定 ${s.key} の書き込み方法が定義されていません`, 'bad-args');
    }

    await this.runApplySequence();
    this.parseAll();
    this._saveCache();
    this.emit('config', this.config);
    return this.config;
  }

  /** Replay the profile's fixed apply sequence, byte-identical to the driver.
   *  Preamble/postfix entries may also carry {field} template tokens — e.g.
   *  the Eco-mode byte inside the 10 72 command. */
  async runApplySequence() {
    const seq = this.profile.applySequence;
    const render = (p) => (Array.isArray(p) ? p : renderSwarmTemplate(p, this.cache));
    const payloads = [
      ...(seq.preamble || []).map(render),
      render(seq.settingsPacket),
      ...(seq.postfix || []).map(render),
    ];
    for (const p of payloads) {
      const bytes = Array.isArray(p) ? p : parseHexString(p);
      const pkt = Buffer.alloc(this.tr.packetLength, 0);
      for (let i = 0; i < Math.min(bytes.length, pkt.length); i++) pkt[i] = bytes[i] & 0xff;
      const res = await this.tr.command(pkt, { timeout: 400, retries: 3 });
      this._requireOk(res, '設定の書き込み');
      await sleep(num(seq.commandDelayMs, 100));
    }
  }

  // -------------------------------------------------------- host cache ----
  _cachePath() {
    return path.join(DATA_DIR, `${this.profile.id}.json`);
  }

  _loadCache() {
    const defaults = (this.profile.applySequence && this.profile.applySequence.defaults) || {};
    try {
      const raw = JSON.parse(fs.readFileSync(this._cachePath(), 'utf8'));
      return { ...defaults, ...raw };
    } catch (e) {
      const cache = { ...defaults };
      this._saveCacheTo(cache);
      return cache;
    }
  }

  _saveCache() {
    this._saveCacheTo(this.cache);
  }

  _saveCacheTo(cache) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this._cachePath(), JSON.stringify(cache, null, 2) + '\n');
    } catch (e) {
      this.emit('log', { level: 'warn', message: `キャッシュの保存に失敗: ${e.message}` });
    }
  }

  async _applyGroup(s, args) {
    const onKey = s.on ? s.on.key || 'on' : null;
    if (args.field === onKey) {
      const c = this.codec(`${s.key}:${onKey}`);
      const data = c.encode(args.value);
      await this._writeSingleByte(num(s.on.read.address), data[0]);
      return;
    }
    const f = (s.fields || []).find((x) => x.key === args.field);
    if (!f) throw new AdapterError(`未知のフィールド: ${args.field}`, 'bad-args');
    const c = this.codec(`${s.key}:${f.key}`);
    const enc = c.encode(args.value);
    const blockAddr = num(s.block.address);
    const blockLen = num(s.block.length);
    const block = Buffer.from(this.image.slice(blockAddr, blockAddr + blockLen));
    const wo = num(f.writeOffset, num(f.read.offset));
    for (let i = 0; i < enc.length; i++) block[wo + i] = enc[i] & 0xff;
    await this._writeBytes(blockAddr, [...block]);
  }

  async _applyCommandSetting(s, value) {
    const cmdName = s.write.command;
    switch (cmdName) {
      case 'setProfile': {
        const v = num(value, -1);
        if (!Number.isInteger(v) || v < 0 || v > 3) throw new AdapterError('プロファイルは0〜3です', 'bad-args');
        const res = await this._cmd('setProfile', { timeout: 300, retries: 2 }, { data: [v] });
        this._requireOk(res, 'プロファイル切替');
        this.commandValues[s.key] = v;
        await this.refreshConfig();
        return;
      }
      case 'setLongRange': {
        const res = await this._cmd('setLongRange', { timeout: 300, retries: 2 }, { data: [value ? 1 : 0] });
        this._requireOk(res, 'ロングレンジ設定');
        this.commandValues[s.key] = !!value;
        return;
      }
      default:
        throw new AdapterError(`未実装のコマンド設定: ${cmdName}`, 'not-implemented');
    }
  }

  /** Action buttons (pairing, factory reset, …). */
  async applyAction(key, args = {}) {
    const a = this.actionsByKey[key];
    if (!a) throw new AdapterError(`未知のアクション: ${key}`, 'unknown-action');
    const def = this.profile.commands[a.command] || {};
    switch (a.command) {
      case 'enterPair': {
        const data = (def.data || []).map(num);
        const res = await this._cmd('enterPair', { timeout: 300, retries: 2 }, { data });
        this._requireOk(res, 'ペアリングモード');
        return true;
      }
      case 'factoryReset': {
        if (args.confirm !== true) {
          throw new AdapterError('confirmパラメータが必要です', 'confirm-required');
        }
        const res = await this._cmd('factoryReset', { timeout: 400, retries: 1 });
        this._requireOk(res, '工場リセット');
        await sleep(num(def.settleMs, 1300));
        try {
          if (this.profile.commands.pcDriverStatus) {
            await this._cmd('pcDriverStatus', { timeout: 300, retries: 2 }, { data: [0x01] }).catch(() => {});
          }
          if (this.profile.commands.deviceOnline) {
            const deadline = Date.now() + 10000;
            for (;;) {
              const on = await this._cmd('deviceOnline', { timeout: 300, retries: 1 });
              const off = num((this.profile.commands.deviceOnline.response || {}).online, 5);
              if (on[off] === 1) break;
              if (Date.now() > deadline) break;
              await sleep(1500);
            }
          }
          if (this.profile.commands.saveData) {
            await this._cmd('saveData', { timeout: 400, retries: 2 }).catch(() => {});
          }
          await this._afterOnlineInit();
        } catch (e) {
          /* monitor / hotplug will resync */
        }
        return true;
      }
      case 'backToOnboard': {
        // Logitech HID++: return the mouse to its onboard profile
        // (live host-mode settings stop being applied).
        const res = await this._cmd('backToOnboard', { timeout: 400, retries: 2 }, { data: [1] });
        this._requireOk(res, 'オンボードプロファイルへの復帰');
        await this.refreshConfig().catch(() => {});
        return true;
      }
      default:
        throw new AdapterError(`未実装のアクション: ${a.command}`, 'not-implemented');
    }
  }

  // ------------------------------------------------------------ getters ---
  async getBattery() {
    const res = await this._cmd('battery', { timeout: 300, retries: 2 });
    this._requireOk(res, 'バッテリー情報の取得');
    const def = this.profile.commands.battery || {};
    const r = def.response || {};
    const scale = num(def.scale, 0);
    const rawLevel = res[num(r.level, 5)];
    let charging = res[num(r.charging, 6)] === 1;
    // Some devices report charging on a separate command (e.g. Razer 0x07/0x84)
    if (this.profile.commands.chargingStatus) {
      try {
        const c = await this._cmd('chargingStatus', { timeout: 300, retries: 1 });
        charging = this._ok(c) ? c[num((this.profile.commands.chargingStatus.response || {}).charging, 9)] === 1 : false;
      } catch (e) {
        /* optional */
      }
    }
    this.battery = {
      level: scale ? Math.round((rawLevel * 100) / scale) : rawLevel,
      charging,
      voltage: r.voltageHi != null ? (res[num(r.voltageHi)] << 8) | res[num(r.voltageLo)] : null,
    };
    return this.battery;
  }

  // ------------------------------------------------------------- monitor ---
  startMonitor({ intervalMs = 5000 } = {}) {
    if (this._monTimer) return;
    // Swarm-style: wired connection, no sleep protocol — battery only.
    if (this.profile.applySequence) {
      this._monTimer = setInterval(async () => {
        if (this.tr._closed) return;
        try {
          const bat = await this.getBattery();
          this.emit('battery', bat);
        } catch (e) {
          /* device gone — the watcher handles reconnect */
        }
      }, 10000);
      return;
    }
    // Devices without a DeviceOnLine command (VXE MAD R style): use the
    // battery poll as the liveness check.
    if (!this.profile.commands.deviceOnline) {
      this._monTimer = setInterval(async () => {
        if (this.tr._closed) return;
        try {
          const bat = await this.getBattery();
          if (!this.online) {
            this.online = true;
            this.emit('online', true);
            try {
              await this._afterOnlineInit();
            } catch (e) {
              /* retry next tick */
            }
          }
          this.emit('battery', bat);
        } catch (e) {
          if (this.online) {
            this.online = false;
            this.emit('online', false);
          }
        }
      }, 10000);
      return;
    }
    if (this._monTimer) return;
    this._monTimer = setInterval(async () => {
      if (this.tr._closed) return;
      this._monTick += 1;
      try {
        const res = await this._cmd('deviceOnline', { timeout: 300, retries: 1 });
        const off = num((this.profile.commands.deviceOnline.response || {}).online, 5);
        const online = res[off] === 1;
        if (online !== this.online) {
          this.online = online;
          this.emit('online', online);
          if (online) {
            try {
              await this._afterOnlineInit();
            } catch (e) {
              /* retry next tick */
            }
          }
        }
      } catch (e) {
        /* dongle busy or gone */
      }
      if (this._monTick % 2 === 0) {
        try {
          const bat = await this.getBattery();
          this.emit('battery', bat);
        } catch (e) {
          /* offline */
        }
      }
    }, intervalMs);
  }

  stopMonitor() {
    if (this._monTimer) {
      clearInterval(this._monTimer);
      this._monTimer = null;
    }
  }

  /** UI-facing status payload. */
  statusInfo() {
    if (this.profile.applySequence) {
      return {
        profileId: this.profile.id,
        productName: this.profile.meta.name,
        product: (this.meta && this.meta.product) || this.profile.meta.name,
        connectionType: null,
        connection: this.profile.meta.connectionLabel || '有線接続',
        maxHz: null,
        cid: null,
        mid: null,
        dongleVersion: null,
        mouseVersion: null,
        battery: this.battery,
        voltage: this.battery ? `${(this.battery.voltage / 1000).toFixed(2)} V` : null,
        profileIndex: null,
        profile: null,
        longRange: null,
        online: this.online,
      };
    }
    const ct =
      (this.profile.connectionTypes || {})[String(this.connectionType)] || null;
    const maxHz = ct ? num(ct.maxHz) : null;
    // Use the model name from midNames if available (generic profiles),
    // otherwise fall back to the profile's meta.name
    const midName = (this.profile.midNames || {})[String(this.mid)] || null;
    const displayName = midName || this.profile.meta.name;
    const connection = this.online
      ? this.connectionType == null
        ? this.profile.meta.connectionLabel || '接続済み'
        : `${ct ? ct.label : `type ${this.connectionType}`}${maxHz ? `（最大 ${maxHz} Hz）` : ''}`
      : 'スリープ中';
    const idx = this.commandValues.profileIndex;
    return {
      profileId: this.profile.id,
      productName: displayName,
      product: (this.meta && this.meta.product) || displayName,
      connectionType: this.connectionType,
      connection,
      maxHz,
      // Body-side capability (per-model table in the profile) — lets the UI
      // explain dongle-limited polling rates (e.g. an 8K-capable mouse
      // behind a 1K receiver: higher rates are stored but inert until a
      // capable dongle is attached).
      mouseMaxHz:
        (this.profile.modelMaxHz || {})[String(this.mid)] != null
          ? num(this.profile.modelMaxHz[String(this.mid)])
          : null,
      cid: this.cid,
      mid: this.mid,
      dongleVersion: this.dongleVersion,
      mouseVersion: this.mouseVersion,
      battery: this.battery,
      voltage:
        this.battery && this.battery.voltage != null
          ? `${(this.battery.voltage / 1000).toFixed(2)} V`
          : null,
      profileIndex: idx != null ? idx : null,
      profile: idx != null ? `プロファイル ${idx + 1}` : null,
      longRange: this.commandValues.longRange !== undefined ? this.commandValues.longRange : null,
      online: this.online,
    };
  }

  destroy() {
    this.stopMonitor();
    this.tr.destroy();
  }

  gracefulClose() {
    this.stopMonitor();
    this.tr.gracefulClose();
  }
}

module.exports = { MouseAdapter, AdapterError };
