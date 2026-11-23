(function (root, factory) {
  'use strict';
  const codec =
    typeof module === 'object' && module.exports ? require('./codec') : root.SktdrCore || {};
  const api = factory(codec);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SktdrCore = Object.assign(root.SktdrCore || {}, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (codec) {
  'use strict';

// =============================================================================
// core/transport.js — generic HID transport, fully parameterized by the
// device profile's "transport" section (report id, packet layout, checksum,
// write modes, unsolicited notifications).
//
// Works in both Node.js (via node-hid / NodeHidChannel) and browsers (via
// WebHID / WebHidChannel). Everything below is protocol-agnostic: the device
// specifics live in devices/*.json only.
// =============================================================================

const { num } = codec;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function allocBytes(n) {
  return new Uint8Array(Math.max(0, n | 0));
}

function toBytes(data) {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined') {
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
  }
  if (Array.isArray(data)) return Uint8Array.from(data);
  return Uint8Array.from(data);
}

function concatBytes(...parts) {
  const arrays = parts.map(toBytes);
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toHex(data) {
  const bytes = toBytes(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function nextMicrotask(fn) {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(fn);
  } else {
    Promise.resolve().then(fn);
  }
}

function nextTickRead(fn) {
  if (typeof setImmediate === 'function') {
    setImmediate(fn);
  } else {
    setTimeout(fn, 0);
  }
}

function randomBytes(n) {
  const len = Math.max(0, n | 0);
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const out = new Uint8Array(len);
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  if (typeof require === 'function') {
    return toBytes(require('crypto').randomBytes(len));
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (Math.random() * 256) & 0xff;
  return out;
}

function getNodeHid() {
  if (typeof require !== 'function') {
    throw new TransportError('node-hid は Node.js 環境でのみ利用できます', 'unsupported-env');
  }
  return require('node-hid');
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

/**
 * Channel adapter wrapping a node-hid HID instance to match the abstract
 * HID channel contract used by Transport:
 *   - startRead(onData, onDisconnect)
 *   - sendReport(reportId, payload)
 *   - sendFeatureReport(reportId, payload)
 *   - receiveFeatureReport(reportId, bodyLength)
 *   - close()
 */
class NodeHidChannel {
  constructor(dev) {
    this.dev = dev;
    this._closed = false;
    this._readErrors = 0;
  }

  startRead(onData, onDisconnect) {
    const step = () => {
      if (this._closed || !this.dev) return;
      try {
        this.dev.read((err, data) => {
          if (this._closed) return;
          if (err || !data || data.length === 0) {
            this._readErrors += 1;
            if (this._readErrors >= 5) {
              if (onDisconnect) onDisconnect(String((err && err.message) || err));
              return;
            }
            setTimeout(step, 120);
            return;
          }
          this._readErrors = 0;
          onData(toBytes(data));
          nextTickRead(step);
        });
      } catch (e) {
        this._readErrors += 1;
        if (this._readErrors >= 5) {
          if (onDisconnect) onDisconnect(e.message);
          return;
        }
        setTimeout(step, 120);
      }
    };
    step();
  }

  sendReport(reportId, payload) {
    const wire = concatBytes([reportId & 0xff], payload);
    this.dev.write(typeof Buffer !== 'undefined' ? Buffer.from(wire) : Array.from(wire));
  }

  sendFeatureReport(reportId, payload) {
    const wire = concatBytes([reportId & 0xff], payload);
    this.dev.sendFeatureReport(typeof Buffer !== 'undefined' ? Buffer.from(wire) : Array.from(wire));
  }

  receiveFeatureReport(reportId, bodyLength) {
    const raw = toBytes(this.dev.getFeatureReport(reportId & 0xff, bodyLength + 1));
    if (raw.length < bodyLength) return null;
    if (raw.length >= bodyLength + 1) return raw.slice(1, 1 + bodyLength);
    return raw.slice(0, bodyLength);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.dev.close();
    } catch (e) {
      /* ignore */
    }
  }
}

function isChannel(obj) {
  return !!(obj && typeof obj.sendReport === 'function' && typeof obj.startRead === 'function');
}

class Transport {
  /**
   * @param {HID.HID|object} dev opened HID device or HID channel adapter
   * @param {object} meta HID device descriptor (path/product/usagePage…)
   * @param {object} profile validated device profile
   */
  constructor(dev, meta, profile) {
    this.channel = isChannel(dev) ? dev : new NodeHidChannel(dev);
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

    if (this.type === 'swarmEcho64') {
      // ROCCAT Swarm-era transport: unnumbered 64-byte output reports,
      // response = echo of the first two payload bytes + status byte
      // (0x03 for 10-xx commands, 0x04 for 90-xx diagnostic commands).
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.writePrefix = new Uint8Array([0x00]); // unnumbered report id byte
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
      // No interrupt read loop: everything is request/response.
      this.reportId = 0x00;
      this.packetLength = 90;
      this.transactionId = num(t.transactionId, 0x1f);
      this.L = null;
      this._skipReadLoop = true;
    } else if (this.type === 'ngenuityUniversal') {
      // HyperX NGENUITY 3.x "universal" protocol (Pulsefire Haste 2 Wireless):
      // 64-byte packets whose report ID *is* the command byte, sub-command in
      // byte 1. Replies use report ID command+1; every command is also ACKed
      // by the dongle with FF 01 <device id 12B> <cmd> <sub> <status>.
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.L = { command: 0, sub: 1 };
      this.commandAsReportId = true;
      this.ckBase = 0;
      this.ckSubtractReportId = false;
    } else if (this.type === 'ngenuity64') {
      // HyperX NGenuity2 (Pulsefire Dart/Haste Wireless family): 64-byte
      // request/response reports on the vendor collection. The wire report is
      // 65 bytes (report ID 0x00 + 64-byte payload); replies come back as
      // 64-byte payloads whose first byte echoes the command. There is no
      // checksum and no fixed layout: the profile/adaptor builds the payload.
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.L = { command: 0, status: 1 };
      this.ckBase = 0;
      this.ckSubtractReportId = false;
    } else if (this.type === 'moji64') {
      // Darmoshark (MOJI) transport: report id 0x00 + 64-byte frames.
      //   [0]=type (bit6 = 2.4GHz work mode, baked into command ids),
      //   [1]=index, [2]=opcode, [3]=sub, [4..62]=payload,
      //   [63]=checksum: whole frame sums to 0xA1 mod 256.
      // Responses echo (type & ~0x40, sub). Type 0x1F/0x5F frames are NACKs
      // (sub = error code); the dongle answers even while the mouse sleeps.
      this.reportId = 0;
      this.packetLength = num(t.packetLength, 64);
      this.writePrefix = new Uint8Array([0x00]);
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
  /** All HID top-level collections that may carry this profile's protocol (Node.js). */
  static findCollections(profile) {
    const usb = profile.usb || {};
    const vid = num(usb.vendorId);
    const pids = (usb.productIds || []).map(num);
    const usagePageMin = num(usb.vendorUsagePageMin, 0xff00);
    try {
      const HID = getNodeHid();
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
   * Probe an opened HID channel with the profile's probeCommand (and optional
   * expectedMid handshake). Destroys the transport if the device doesn't match.
   * Shared between Node.js (openFirst) and browser (WebHidDeviceManager).
   */
  static async probeChannel(channel, meta, profile) {
    const tr = new Transport(channel, meta, profile);
    try {
      const usb = profile.usb || {};
      const probeName = usb.probeCommand || 'dongleVersion';
      const res = await tr.commandByName(probeName, { timeout: 250, retries: 1 });
      const expectedMid = usb.expectedMid != null ? num(usb.expectedMid) : null;
      if (expectedMid != null) {
        const rnd = randomBytes(4);
        const hs = await tr.commandByName(
          'handshake',
          { timeout: 300, retries: 1 },
          { data: [...rnd, 0, 0, 0, 0] }
        );
        const mid = hs[10];
        if (mid !== expectedMid) {
          try {
            tr.destroy();
          } catch (e2) {
            /* ignore */
          }
          return null; // a different model answered — keep looking
        }
      }
      return { transport: tr, probeResponse: res };
    } catch (e) {
      try {
        tr.destroy();
      } catch (e2) {
        /* ignore */
      }
      if (e && e.code === 'not-allowed') throw e;
      return null;
    }
  }

  /**
   * Open the first collection that answers the profile's probe command (Node.js).
   * Profiles that specify usb.expectedMid additionally perform the handshake
   * and skip collections whose model ID (MID) doesn't match — e.g. the
   * Scyrox V6 and V8 share VID/PID 3554:F5F6/F5F7 but report MID 2 / MID 1.
   */
  static async openFirst(profile) {
    const HID = getNodeHid();
    for (const meta of Transport.findCollections(profile)) {
      let dev = null;
      try {
        dev = new HID.HID(meta.path);
      } catch (e) {
        continue; // protected (mouse/keyboard collection) or busy
      }
      const hit = await Transport.probeChannel(new NodeHidChannel(dev), meta, profile).catch(() => null);
      if (hit) return hit;
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
    const p = allocBytes(this.packetLength);
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
      const raw = data.length ? data : parseHexString(c.data || '');
      const p = allocBytes(this.packetLength);
      for (let i = 0; i < Math.min(raw.length, this.packetLength); i++) p[i] = raw[i] & 0xff;
      return p;
    }
    if (this.type === 'moji64') {
      return this.buildMojiPacket(num(c.id), num(c.opcode), num(c.sub, 0), data);
    }
    if (this.type === 'ngenuityUniversal') {
      const p = allocBytes(this.packetLength);
      p[0] = num(c.id);
      p[1] = num(c.sub, 0) & 0x3f;
      const raw = data.length ? data : parseHexString(c.data || '');
      for (let i = 0; i < Math.min(raw.length, this.packetLength - 2); i++) {
        p[2 + i] = raw[i] & 0xff;
      }
      return p;
    }
    if (this.type === 'ngenuity64') {
      const p = allocBytes(this.packetLength);
      p[0] = num(c.id);
      const raw = data.length ? data : parseHexString(c.data || '');
      for (let i = 0; i < Math.min(raw.length, this.packetLength - 1); i++) {
        p[1 + i] = raw[i] & 0xff;
      }
      return p;
    }
    const len = lenOverride != null ? lenOverride : num(c.dataLength, data.length);
    return this.buildPacket(num(c.id), { addr, len, data });
  }

  /** MOJI frame: [type, index, opcode, sub, payload…, checksum@63]. */
  buildMojiPacket(type, opcode, sub, payload = []) {
    const p = allocBytes(this.packetLength);
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
    const r = allocBytes(this.packetLength);
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

  /** One feature-report transaction; returns the 90-byte body. */
  async razerTransact(packet) {
    const pkt = toBytes(packet);
    await this.channel.sendFeatureReport(0x00, pkt);
    const raw = await this.channel.receiveFeatureReport(0x00, this.packetLength);
    if (!raw) return null;
    const body = toBytes(raw);
    if (body.length < this.packetLength) return null;
    return body.slice(0, this.packetLength);
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
    const p = allocBytes(20);
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

  /** Split a protocol packet into { reportId, payload } for the HID channel. */
  _packetToReport(packet) {
    const pkt = toBytes(packet);
    if (this.type === 'ngenuityUniversal' || this.type === 'hidpp') {
      return {
        reportId: pkt.length > 0 ? pkt[0] & 0xff : 0,
        payload: pkt.slice(1),
      };
    }
    return {
      reportId: this.reportId & 0xff,
      payload: pkt,
    };
  }

  // ---------------------------------------------------------- IO core -----
  _readLoop() {
    this.channel.startRead(
      (data) => {
        if (this._closed) return;
        this._onPacket(toBytes(data));
      },
      (reason) => {
        if (this._closed) return;
        this.emit('disconnect', { reason: String(reason || 'disconnected') });
        this.destroy();
      }
    );
  }

  _onPacket(buf) {
    let pkt;
    if (this.type === 'ngenuityUniversal') {
      // unnumbered 64-byte report: byte 0 is the report ID (= command / reply)
      pkt = buf.length >= this.packetLength ? buf.slice(0, this.packetLength) : buf;
    } else if (this.type === 'swarmEcho64') {
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
      this.emit('log', { level: 'warn', message: `checksum mismatch: ${toHex(pkt)}` });
      return;
    }
    if (this.type === 'moji64' && !this.verifyChecksum(pkt)) {
      this.emit('log', { level: 'warn', message: `checksum mismatch: ${toHex(pkt)}` });
      return;
    }

    // HyperX NGenuity2 async state event: FF 03 <profile> <cable> <wake> …
    if (this.type === 'ngenuity64' && pkt[0] === 0xff) {
      this.emit('ngenuityState', {
        profile: pkt[2],
        charging: pkt[3] === 1,
        wake: pkt[4] === 1,
      });
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
        nextMicrotask(() => this._pump());
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
        nextMicrotask(() => this._pump());
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
      nextMicrotask(() => this._pump());
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
    if (this.type === 'ngenuityUniversal') {
      if (!request || !response || response.length < 16) return false;
      const sub = request[1] & 0x3f;
      if (this._inflight && this._inflight.expectReply) {
        // real reply: [cmd+1, sub, payload…]
        return response[0] === ((request[0] + 1) & 0xff) && response[1] === sub;
      }
      // dongle ACK: ff 01 <12-byte device id> <cmd> <sub> <status>
      return (
        response[0] === 0xff &&
        response[1] === 0x01 &&
        response[14] === request[0] &&
        response[15] === sub
      );
    }
    if (this.type === 'moji64') {
      if (!request || !response || response.length < 4) return false;
      // responses echo the type (with or without the 0x40 work-mode bit)
      // and the sub-command byte; the opcode byte differs by design.
      return (response[0] & 0x3f) === (request[0] & 0x3f) && response[3] === request[3];
    }
    if (this.type === 'ngenuity64') {
      // NGenuity2 replies echo the command byte (first byte).
      if (!request || !response || response.length < 1) return false;
      return response[0] === request[0];
    }
    if (!request || !response || response.length < this.packetLength) return false;
    // readFlash responses echo command + address + length (bytes 0-4)
    if (num(request[this.L.command]) === this.cmdId('readFlash')) {
      for (let i = 0; i < 5; i++) if (request[i] !== response[i]) return false;
      return true;
    }
    return response[this.L.command] === request[this.L.command];
  }

  command(packet, { timeout = 300, retries = 3, expectReply = false } = {}) {
    if (this._closed) {
      return Promise.reject(new TransportError('デバイスは閉じられています', 'closed'));
    }
    if (this.minTimeoutMs && timeout < this.minTimeoutMs) timeout = this.minTimeoutMs;
    const pkt = toBytes(packet);
    return new Promise((resolve, reject) => {
      this._queue.push({ packet: pkt, timeout, retries, expectReply, attempt: 0, resolve, reject });
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
    const c = (this.profile.commands || {})[name] || {};
    return this.command(this.buildByName(name, { addr, lenOverride, data }), {
      ...opts,
      expectReply: !!c.expectReply,
    });
  }

  _pump() {
    if (this._closed || this._inflight) return;
    const item = this._queue.shift();
    if (!item) return;
    this._inflight = item;
    this._sendInflight();
  }

  _classifyWriteError(e) {
    const isNotAllowed =
      e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.code === 'not-allowed');
    const code = isNotAllowed ? 'not-allowed' : 'write-failed';
    const msg = isNotAllowed
      ? 'ブラウザのセキュリティ制限 (Protected Collection) によりこのHID機能へアクセスできません: ' +
        (e && e.message ? e.message : String(e))
      : 'HID送信に失敗しました: ' + (e && e.message ? e.message : String(e));
    return new TransportError(msg, code);
  }

  _sendInflight() {
    const item = this._inflight;
    if (!item) return;

    if (this.type === 'razer') {
      // feature-report transaction with status validation (sync on node-hid, async on WebHID)
      Promise.resolve()
        .then(() => this.razerTransact(item.packet))
        .then((resp) => {
          if (this._closed || this._inflight !== item) return;
          if (
            resp &&
            (resp[0] === 0x02 || resp[0] === 0x01) &&
            resp[6] === item.packet[6] &&
            resp[7] === item.packet[7]
          ) {
            clearTimeout(item.timer);
            this._inflight = null;
            item.resolve(resp);
            nextMicrotask(() => this._pump());
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
            nextMicrotask(() => this._pump());
            return;
          }
          item.attempt += 1;
          setTimeout(() => {
            if (!this._closed && this._inflight === item) this._sendInflight();
          }, 25);
        })
        .catch((e) => {
          if (this._closed || this._inflight !== item) return;
          clearTimeout(item.timer);
          this._inflight = null;
          item.reject(this._classifyWriteError(e));
          nextMicrotask(() => this._pump());
        });
      return;
    }

    const { reportId, payload } = this._packetToReport(item.packet);
    const failWrite = (e) => {
      if (this._closed || this._inflight !== item) return;
      clearTimeout(item.timer);
      this._inflight = null;
      item.reject(this._classifyWriteError(e));
      nextMicrotask(() => this._pump());
    };

    item.timer = setTimeout(() => this._expire(item), item.timeout);
    try {
      const res = this.channel.sendReport(reportId, payload);
      if (res && typeof res.then === 'function') {
        res.catch(failWrite);
      }
    } catch (e) {
      failWrite(e);
    }
  }

  _expire(item) {
    if (this._inflight !== item) return;
    item.attempt += 1;
    if (item.attempt > item.retries) {
      this._inflight = null;
      item.reject(new TransportError('デバイスから応答がありません', 'timeout'));
      nextMicrotask(() => this._pump());
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
      const r = this.channel.close();
      if (r && typeof r.catch === 'function') r.catch(() => {});
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
        const { reportId, payload } = this._packetToReport(cmd);
        const res = this.channel.sendReport(reportId, payload);
        if (res && typeof res.then === 'function') {
          return Promise.race([res.catch(() => {}), sleep(150)]).then(() => this.destroy());
        }
      } catch (e) {
        /* ignore */
      }
    }
    this.destroy();
  }
}

  return { Transport, TransportError, NodeHidChannel, parseHexString, randomBytes, toHex };
});
