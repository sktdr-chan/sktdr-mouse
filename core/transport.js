'use strict';

// =============================================================================
// core/transport.js — generic HID transport, fully parameterized by the
// device profile's "transport" section (report id, packet layout, checksum,
// write modes, unsolicited notifications).
//
// Everything below is protocol-agnostic: the Scyrox specifics (report ID 8,
// 16-byte packets, checksum 0x55-…) live in devices/*.json only.
// =============================================================================

const HID = require('node-hid');
const crypto = require('crypto');
const { num } = require('./codec');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse a hex byte string ("10 50 14 00 …") into an array of numbers. */
function parseHexString(s) {
  if (!s) return [];
  return String(s)
    .split(/[\s,]+/)
    .filter((x) => x.length > 0)
    .map((x) => (x.startsWith('0x') ? parseInt(x.slice(2), 16) : parseInt(x, 16)))
    .filter((x) => Number.isInteger(x));
}

class TransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransportError';
    this.code = code || 'generic';
  }
}

class Transport {
  /**
   * @param {HID.HID} dev opened HID device
   * @param {object} meta HID device descriptor (path/product/usagePage…)
   * @param {object} profile validated device profile
   */
  constructor(dev, meta, profile) {
    this.dev = dev;
    this.meta = meta;
    this.profile = profile;

    const t = profile.transport || {};
    const L = t.layout || {};
    this.type = t.type || 'hid16'; // 'hid16' (Scyrox-style) | 'swarmEcho64' (ROCCAT) | 'moji64' (Darmoshark)

    this._queue = [];
    this._inflight = null;
    this._closed = false;
    this._eventFn = null;
    this._readErrors = 0;

    if (this.type === 'swarmEcho64') {
      // ROCCAT Swarm-era transport: unnumbered 64-byte output reports,
      // response = echo of the first two payload bytes + status byte
      // (0x03 for 10-xx commands, 0x04 for 90-xx diagnostic commands).
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.writePrefix = Buffer.from([0x00]); // unnumbered report id byte
      this.L = null; // no fixed layout
    } else if (this.type === 'hidpp') {
      // Logitech HID++ 2.0: 20-byte long reports on the 0xFF00/usage-2
      // collection (requests go out with report id 0x11 on modern
      // Lightspeed receivers). Frame:
      //   [0x11, deviceIndex, featureIndex, (fn<<4)|swId, params…]
      // Commands in the profile declare FEATURE ids; the transport resolves
      // them to per-device indices via ROOT (feature 0x0000, fn 0) and
      // caches the mapping. Replies match devIdx+featureIdx+fnByte; error
      // frames use feature slot 0xFF (HID++ 2.0) or 0x8F (HID++ 1.0).
      const usb = profile.usb || {};
      this.reportId = 0x11;
      this.packetLength = 20;
      this.deviceIndex = num(usb.deviceIndex, 1);
      this.swId = num(t.swId, 0x0a);
      this.minTimeoutMs = num(t.minTimeoutMs, 1500); // sleeping mice answer slowly
      this._featureIdx = new Map();
      this.L = null;
    } else if (this.type === 'razer') {
      // Razer (openrazer protocol): 90-byte feature reports with report id
      // 0x00 on the mouse interface. Frame:
      //   [status 0x00, transaction, remPackets BE 0x0000, proto 0x00,
      //    dataSize, class, cmd, args[80], crc@88 XOR(2..87), 0x00]
      // Transaction = sendFeatureReport → getFeatureReport; response status
      // 0x02=OK, 0x01=busy-OK, 0x03=failure, 0x04=timeout, 0x05=unsupported.
      // No interrupt read loop: everything is synchronous request/response.
      this.reportId = 0x00;
      this.packetLength = 90;
      this.transactionId = num(t.transactionId, 0x1f);
      this.L = null;
      this._skipReadLoop = true;
    } else if (this.type === 'moji64') {
      // Darmoshark (MOJI) transport: report id 0x00 + 64-byte frames.
      //   [0]=type (bit6 = 2.4GHz work mode, baked into command ids),
      //   [1]=index, [2]=opcode, [3]=sub, [4..62]=payload,
      //   [63]=checksum: whole frame sums to 0xA1 mod 256.
      // Responses echo (type & ~0x40, sub). Type 0x1F/0x5F frames are NACKs
      // (sub = error code); the dongle answers even while the mouse sleeps.
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.writePrefix = Buffer.from([0x00]);
      this.L = { status: num(L.status, 1), checksum: num(L.checksum, 63) };
      const ck = t.checksum || {};
      this.ckBase = num(ck.base, 0xa1);
      this.ckSubtractReportId = false;
    } else {
      this.reportId = num(t.reportId, 0);
      this.packetLength = num(t.packetLength, 16);
      this.L = {
        command: num(L.command, 0),
        status: num(L.status, 1),
        addressHi: num(L.addressHi, 2),
        addressLo: num(L.addressLo, 3),
        length: num(L.length, 4),
        data: num(L.data, 5),
        dataMax: num(L.dataMax, 10),
        checksum: num(L.checksum, 15),
      };
      const ck = t.checksum || {};
      this.ckBase = num(ck.base, 0x55);
      this.ckSubtractReportId = !!ck.subtractReportId;
      const sbw = t.singleByteWrite || {};
      this.singleByteDataLength = num(sbw.dataLength, 2);
      this.singleByteComplementBase = num(sbw.complementBase, 0x55);
    }

    if (!this._skipReadLoop) this._readLoop();
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
        /* listener errors must not break the IO loop */
      }
    }
  }

  // -------------------------------------------------------- discovery ----
  /** All HID top-level collections that may carry this profile's protocol. */
  static findCollections(profile) {
    const usb = profile.usb || {};
    const vid = num(usb.vendorId);
    const pids = (usb.productIds || []).map(num);
    const usagePageMin = num(usb.vendorUsagePageMin, 0xff00);
    try {
      return HID.devices().filter(
        (d) =>
          d.vendorId === vid &&
          (pids.length === 0 || pids.includes(d.productId)) &&
          (d.usagePage || 0) >= usagePageMin
      );
    } catch (e) {
      return [];
    }
  }

  /** Command id by profile command name. */
  cmdId(name) {
    const c = (this.profile.commands || {})[name];
    if (!c || c.id == null) throw new TransportError(`コマンドが定義されていません: ${name}`, 'no-command');
    return num(c.id);
  }

  /**
   * Open the first collection that answers the profile's probe command.
   * Profiles that specify usb.expectedMid additionally perform the handshake
   * and skip collections whose model ID (MID) doesn't match — e.g. the
   * Scyrox V6 and V8 share VID/PID 3554:F5F6/F5F7 but report MID 2 / MID 1.
   * That lets two profiles claim the same PIDs and each attach to its own
   * device when both are plugged in.
   */
  static async openFirst(profile) {
    for (const meta of Transport.findCollections(profile)) {
      let dev = null;
      try {
        dev = new HID.HID(meta.path);
      } catch (e) {
        continue; // protected (mouse/keyboard collection) or busy
      }
      const tr = new Transport(dev, meta, profile);
      try {
        const probeName = profile.usb.probeCommand || 'dongleVersion';
        const res = await tr.commandByName(probeName, { timeout: 250, retries: 1 });
        const expectedMid = profile.usb.expectedMid != null ? num(profile.usb.expectedMid) : null;
        if (expectedMid != null) {
          const rnd = crypto.randomBytes(4);
          const hs = await tr.commandByName('handshake', { timeout: 300, retries: 1 }, { data: [...rnd, 0, 0, 0, 0] });
          const mid = hs[10];
          if (mid !== expectedMid) {
            try {
              tr.destroy();
            } catch (e2) {
              /* ignore */
            }
            continue; // a different model answered — keep looking
          }
        }
        return { transport: tr, probeResponse: res };
      } catch (e) {
        try {
          tr.destroy();
        } catch (e2) {
          /* ignore */
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------- packets -----
  checksum(p) {
    let sum = 0;
    for (let i = 0; i < this.packetLength - 1; i++) sum += p[i];
    const sub = this.ckSubtractReportId ? this.reportId : 0;
    return (((this.ckBase - (sum & 0xff) - sub) % 256) + 256) % 256;
  }

  verifyChecksum(pkt) {
    if (!pkt || pkt.length < this.packetLength) return false;
    return pkt[this.L.checksum] === this.checksum(pkt);
  }

  buildPacket(cmdId, { addr = 0, len = 0, data = [] } = {}) {
    const p = Buffer.alloc(this.packetLength, 0);
    p[this.L.command] = cmdId & 0xff;
    p[this.L.addressHi] = (addr >> 8) & 0xff;
    p[this.L.addressLo] = addr & 0xff;
    p[this.L.length] = len & 0xff;
    for (let i = 0; i < Math.min(data.length, this.L.dataMax); i++) {
      p[this.L.data + i] = data[i] & 0xff;
    }
    p[this.L.checksum] = this.checksum(p);
    return p;
  }

  buildByName(name, { addr = 0, lenOverride = null, data = [] } = {}) {
    const c = (this.profile.commands || {})[name] || {};
    if (this.type === 'swarmEcho64') {
      // static command template from the profile ("data": "90 0a 00 …")
      const raw = data.length
        ? data
        : parseHexString(c.data || '');
      const p = Buffer.alloc(this.packetLength, 0);
      for (let i = 0; i < Math.min(raw.length, this.packetLength); i++) p[i] = raw[i] & 0xff;
      return p;
    }
    if (this.type === 'moji64') {
      return this.buildMojiPacket(num(c.id), num(c.opcode), num(c.sub, 0), data);
    }
    const len = lenOverride != null ? lenOverride : num(c.dataLength, data.length);
    return this.buildPacket(num(c.id), { addr, len, data });
  }

  /** MOJI frame: [type, index, opcode, sub, payload…, checksum@63]. */
  buildMojiPacket(type, opcode, sub, payload = []) {
    const p = Buffer.alloc(this.packetLength, 0);
    p[0] = type & 0xff;
    p[2] = opcode & 0xff;
    p[3] = sub & 0xff;
    for (let i = 0; i < Math.min(payload.length, this.packetLength - 5); i++) {
      p[4 + i] = payload[i] & 0xff;
    }
    p[this.L.checksum] = this.checksum(p);
    return p;
  }

  // --------------------------------------------------------- razer --------
  /** Razer 90-byte report: [status, trans, remBE, proto, size, class, cmd, args…, crc@88]. */
  buildRazerPacket(cls, cmd, dataSize, args = []) {
    const r = Buffer.alloc(this.packetLength, 0);
    r[0] = 0x00; // status
    r[1] = this.transactionId;
    // [2..3] remaining packets (BE) = 0, [4] protocol = 0
    r[5] = dataSize & 0xff;
    r[6] = cls & 0xff;
    r[7] = cmd & 0xff;
    for (let i = 0; i < Math.min(args.length, this.packetLength - 8); i++) {
      r[8 + i] = args[i] & 0xff;
    }
    let c = 0;
    for (let i = 2; i < 88; i++) c ^= r[i];
    r[88] = c & 0xff;
    r[89] = 0x00;
    return r;
  }

  /** One synchronous feature-report transaction; returns the 90-byte body. */
  razerTransact(packet) {
    this.dev.sendFeatureReport(Buffer.concat([Buffer.from([0x00]), packet]));
    const raw = Buffer.from(this.dev.getFeatureReport(0x00, this.packetLength + 1));
    if (raw.length < this.packetLength) return null;
    return raw.slice(1, 1 + this.packetLength);
  }

  // --------------------------------------------------------- hidpp --------
  /** Resolve a HID++ feature id to the device's feature index (cached). */
  async resolveFeatureIndex(featureId) {
    const key = featureId & 0xffff;
    if (key === 0x0000) return 0; // ROOT always lives at index 0
    if (this._featureIdx.has(key)) return this._featureIdx.get(key);
    const q = this.buildHidppPacket(0x00, 0, [(key >> 8) & 0xff, key & 0xff]);
    const res = await this.command(q, { timeout: Math.max(1200, this.minTimeoutMs), retries: 2 });
    const idx = res[4] & 0xff;
    if (idx === 0) {
      throw new TransportError(`機能 0x${key.toString(16)} はこのデバイスではサポートされていません`, 'no-feature');
    }
    this._featureIdx.set(key, idx);
    return idx;
  }

  /** HID++ long report: [0x11, devIdx, featureIdx, (fn<<4)|swId, params…]. */
  buildHidppPacket(featureIdx, fn, params = []) {
    const p = Buffer.alloc(20, 0);
    p[0] = this.reportId;
    p[1] = this.deviceIndex;
    p[2] = featureIdx & 0xff;
    p[3] = ((fn & 0x0f) << 4) | (this.swId & 0x0f);
    for (let i = 0; i < Math.min(params.length, 16); i++) p[4 + i] = params[i] & 0xff;
    return p;
  }

  readFlashPacket(addr, len) {
    return this.buildPacket(this.cmdId('readFlash'), { addr, len });
  }

  flashWritePacket(addr, data) {
    return this.buildPacket(this.cmdId('writeFlash'), { addr, len: data.length, data });
  }

  /** Single config byte write: [value, (base - value)] with declared length. */
  singleByteWritePacket(addr, value) {
    const complement = (this.singleByteComplementBase - (value & 0xff)) & 0xff;
    return this.flashWritePacket(addr, [value & 0xff, complement]);
  }

  // ---------------------------------------------------------- IO core -----
  _readLoop() {
    const step = () => {
      if (this._closed || !this.dev) return;
      try {
        this.dev.read((err, data) => {
          if (this._closed) return;
          if (err || !data || data.length === 0) {
            this._readErrors += 1;
            if (this._readErrors >= 5) {
              this.emit('disconnect', { reason: String((err && err.message) || err) });
              this.destroy();
              return;
            }
            setTimeout(step, 120);
            return;
          }
          this._readErrors = 0;
          this._onPacket(Buffer.from(data));
          setImmediate(step);
        });
      } catch (e) {
        this._readErrors += 1;
        if (this._readErrors >= 5) {
          this.emit('disconnect', { reason: e.message });
          this.destroy();
          return;
        }
        setTimeout(step, 120);
      }
    };
    step();
  }

  _onPacket(buf) {
    let pkt;
    if (this.type === 'swarmEcho64') {
      // unnumbered reports: payload only, no report-id prefix on the wire data
      pkt = buf.length >= this.packetLength ? buf.slice(0, this.packetLength) : buf;
    } else if (this.type === 'hidpp') {
      // 7-byte short or 20-byte long report, report id included
      pkt = buf;
    } else if (this.type === 'moji64') {
      pkt = buf.length >= this.packetLength ? buf.slice(0, this.packetLength) : buf;
    } else if (buf.length >= this.packetLength + 1 && buf[0] === this.reportId) {
      pkt = buf.slice(1, 1 + this.packetLength);
    } else if (buf.length >= this.packetLength) {
      pkt = buf.slice(0, this.packetLength);
    } else {
      return;
    }
    if (this.type === 'hid16' && !this.verifyChecksum(pkt)) {
      this.emit('log', { level: 'warn', message: `checksum mismatch: ${pkt.toString('hex')}` });
      return;
    }
    if (this.type === 'moji64' && !this.verifyChecksum(pkt)) {
      this.emit('log', { level: 'warn', message: `checksum mismatch: ${pkt.toString('hex')}` });
      return;
    }

    // HID++ error frames: feature slot 0xFF (2.0) or 0x8F (1.0) echo the
    // request's feature index + function byte, followed by the error code.
    if (this.type === 'hidpp' && pkt.length >= 6) {
      const inflight = this._inflight;
      if (
        inflight &&
        (pkt[2] === 0xff || pkt[2] === 0x8f) &&
        pkt[3] === inflight.packet[2] &&
        pkt[4] === inflight.packet[3]
      ) {
        clearTimeout(inflight.timer);
        this._inflight = null;
        inflight.reject(new TransportError(`デバイスがコマンドを拒否しました (HID++ エラー ${pkt[5]})`, 'hidpp-error'));
        process.nextTick(() => this._pump());
        return;
      }
    }

    // MOJI NACK frames (type 0x1F / 0x5F, sub = error code): fail the pending
    // command immediately instead of waiting for the timeout.
    if (this.type === 'moji64' && (pkt[0] & 0x3f) === 0x1f) {
      const inflight = this._inflight;
      if (inflight) {
        clearTimeout(inflight.timer);
        this._inflight = null;
        inflight.reject(
          new TransportError(`デバイスがコマンドを拒否しました (エラーコード ${pkt[3]})`, 'nack')
        );
        process.nextTick(() => this._pump());
      }
      return;
    }

    // unsolicited device notification?
    if (this.type === 'hid16') {
      const uns = this.profile.transport && this.profile.transport.unsolicited;
      if (uns && this.profile.commands[uns.command]) {
        const unsId = num(this.profile.commands[uns.command].id);
        if (pkt[this.L.command] === unsId) {
          this.emit('notification', pkt[num(uns.flagsOffset, 5)]);
          return;
        }
      }
    }
    // (hidpp: broadcast events like 0x1D4B don't match any pending request
    //  and fall through to the no-match path below — safe to ignore.)

    const inflight = this._inflight;
    if (inflight && this.responseMatches(inflight.packet, pkt)) {
      clearTimeout(inflight.timer);
      this._inflight = null;
      inflight.resolve(pkt);
      process.nextTick(() => this._pump());
    }
    // anything else: unsolicited packet we didn't ask for — ignore
  }

  responseMatches(request, response) {
    if (this.type === 'hidpp') {
      if (!request || !response || response.length < 7) return false;
      // replies echo devIdx + featureIdx + fn/swId byte; short (7B) and
      // long (20B) replies are both accepted
      return (
        response[1] === request[1] &&
        response[2] === request[2] &&
        response[3] === request[3]
      );
    }
    if (this.type === 'swarmEcho64') {
      if (!request || !response || response.length < 3) return false;
      // response echoes the first two bytes, then a status byte:
      // 0x03 for 10-xx commands, 0x04 for 90-xx diagnostics
      const statusOk = request[0] === 0x90 ? 0x04 : 0x03;
      return response[0] === request[0] && response[1] === request[1] && response[2] === statusOk;
    }
    if (this.type === 'moji64') {
      if (!request || !response || response.length < 4) return false;
      // responses echo the type (with or without the 0x40 work-mode bit)
      // and the sub-command byte; the opcode byte differs by design.
      return (response[0] & 0x3f) === (request[0] & 0x3f) && response[3] === request[3];
    }
    if (!request || !response || response.length < this.packetLength) return false;
    // readFlash responses echo command + address + length (bytes 0-4)
    if (num(request[this.L.command]) === this.cmdId('readFlash')) {
      for (let i = 0; i < 5; i++) if (request[i] !== response[i]) return false;
      return true;
    }
    return response[this.L.command] === request[this.L.command];
  }

  command(packet, { timeout = 300, retries = 3 } = {}) {
    if (this._closed) {
      return Promise.reject(new TransportError('デバイスは閉じられています', 'closed'));
    }
    if (this.minTimeoutMs && timeout < this.minTimeoutMs) timeout = this.minTimeoutMs;
    return new Promise((resolve, reject) => {
      this._queue.push({ packet, timeout, retries, attempt: 0, resolve, reject });
      this._pump();
    });
  }

  commandByName(name, opts = {}, { addr = 0, lenOverride = null, data = [] } = {}) {
    if (this.type === 'razer') {
      const c = (this.profile.commands || {})[name] || {};
      if (c.cls == null || c.cmd == null) {
        return Promise.reject(new TransportError(`コマンド ${name} に cls/cmd がありません`, 'no-command'));
      }
      const args = [...(Array.isArray(c.args) ? c.args.map(num) : []), ...data];
      return this.command(this.buildRazerPacket(num(c.cls), num(c.cmd), num(c.size, args.length), args), opts);
    }
    if (this.type === 'hidpp') {
      // resolve the feature index first (one cached roundtrip), then send
      const c = (this.profile.commands || {})[name] || {};
      if (c.feature == null) {
        return Promise.reject(new TransportError(`コマンド ${name} に feature がありません`, 'no-command'));
      }
      const fn = num(c.function, 0);
      const params = [...(Array.isArray(c.params) ? c.params.map(num) : []), ...data];
      return this.resolveFeatureIndex(num(c.feature))
        .then((idx) => this.command(this.buildHidppPacket(idx, fn, params), opts));
    }
    return this.command(this.buildByName(name, { addr, lenOverride, data }), opts);
  }

  _pump() {
    if (this._closed || this._inflight) return;
    const item = this._queue.shift();
    if (!item) return;
    this._inflight = item;
    this._sendInflight();
  }

  _sendInflight() {
    const item = this._inflight;
    if (!item) return;

    if (this.type === 'razer') {
      // synchronous feature-report transaction with status validation
      try {
        const resp = this.razerTransact(item.packet);
        item.attempt += 0;
        if (resp && (resp[0] === 0x02 || resp[0] === 0x01) && resp[6] === item.packet[6] && resp[7] === item.packet[7]) {
          clearTimeout(item.timer);
          this._inflight = null;
          item.resolve(resp);
          process.nextTick(() => this._pump());
          return;
        }
        const code = resp ? resp[0] : 0xff;
        if (item.attempt >= item.retries) {
          clearTimeout(item.timer);
          this._inflight = null;
          const msg =
            code === 0x05
              ? 'このコマンドはデバイスではサポートされていません'
              : `デバイスがコマンドを拒否しました (status=${code})`;
          item.reject(new TransportError(msg, 'razer-error'));
          process.nextTick(() => this._pump());
          return;
        }
        item.attempt += 1;
        setTimeout(() => this._sendInflight(), 25);
      } catch (e) {
        this._inflight = null;
        item.reject(new TransportError('HID送信に失敗しました: ' + e.message, 'write-failed'));
        process.nextTick(() => this._pump());
      }
      return;
    }

    let out;
    if (this.type === 'hidpp') {
      // packet already carries its report id (0x11) at byte 0
      out = item.packet;
    } else if (this.type === 'swarmEcho64' || this.type === 'moji64') {
      out = Buffer.concat([this.writePrefix, item.packet]);
    } else {
      out = Buffer.from([this.reportId, ...item.packet]);
    }
    try {
      this.dev.write(out);
    } catch (e) {
      this._inflight = null;
      item.reject(new TransportError('HID送信に失敗しました: ' + e.message, 'write-failed'));
      process.nextTick(() => this._pump());
      return;
    }
    item.timer = setTimeout(() => this._expire(item), item.timeout);
  }

  _expire(item) {
    if (this._inflight !== item) return;
    item.attempt += 1;
    if (item.attempt > item.retries) {
      this._inflight = null;
      item.reject(new TransportError('デバイスから応答がありません', 'timeout'));
      process.nextTick(() => this._pump());
      return;
    }
    this._sendInflight();
  }

  // ------------------------------------------------------- lifecycle ------
  destroy() {
    if (this._closed) return;
    this._closed = true;
    const err = new TransportError('切断されました', 'closed');
    if (this._inflight) {
      clearTimeout(this._inflight.timer);
      this._inflight.reject(err);
      this._inflight = null;
    }
    for (const item of this._queue) item.reject(err);
    this._queue = [];
    try {
      this.dev.close();
    } catch (e) {
      /* ignore */
    }
  }

  /** Tell the device the driver is going away (best-effort), then close. */
  gracefulClose() {
    if (this._closed) return;
    if (this.profile.commands && this.profile.commands.pcDriverStatus) {
      try {
        const cmd = this.buildByName('pcDriverStatus', { data: [0x00] });
        this.dev.write(
          this.type === 'swarmEcho64' || this.type === 'moji64'
            ? Buffer.concat([this.writePrefix, cmd])
            : Buffer.from([this.reportId, ...cmd])
        );
      } catch (e) {
        /* ignore */
      }
    }
    this.destroy();
  }
}

module.exports = { Transport, TransportError, parseHexString };
