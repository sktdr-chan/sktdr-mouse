'use strict';

// =============================================================================
// core/codec.js — declarative value codecs used by device profiles.
// A profile JSON references these by name (e.g. "codec": "bool") or with
// parameters (e.g. { "type": "dpi", "step": 50, "min": 50, "max": 26000 }).
// Adding support for a new mouse family usually means at most adding one
// codec implementation here; everything else stays declarative.
// =============================================================================

/** Accepts 42, "42", "0x2A" and returns a number (or fallback). */
function num(v, fallback = 0) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x/i.test(s)) {
      const n = parseInt(s.slice(2), 16);
      return Number.isNaN(n) ? fallback : n;
    }
    const n = Number(s);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

function requireRgb(v) {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number' || x < 0 || x > 255)) {
    throw new CodecError('色は [r, g, b] (0-255) 配列で指定してください');
  }
  return [v[0] & 0xff, v[1] & 0xff, v[2] & 0xff];
}

/**
 * Build a codec instance from a spec (string name or {type, ...params}).
 * A codec exposes:
 *   bytes  — how many image bytes it consumes
 *   decode(buffer) -> UI value
 *   encode(value)  -> array of bytes to write
 *   options?       — [{value, label}] for enum-like codecs
 */
function makeCodec(spec) {
  const type = typeof spec === 'string' ? spec : (spec && spec.type) || 'byte';
  const params = typeof spec === 'string' || spec == null ? {} : spec;

  switch (type) {
    case 'byte':
      return {
        bytes: 1,
        decode: (b) => b[0],
        encode: (v) => [num(v) & 0xff],
      };

    case 'bool':
      return {
        bytes: 1,
        decode: (b) => b[0] === 1,
        encode: (v) => [v ? 1 : 0],
      };

    case 'enum': {
      const values = params.values || [];
      const byCode = new Map(values.map((x) => [num(x.code), x]));
      const byValue = new Map(values.map((x) => [String(x.value), x]));
      return {
        bytes: 1,
        decode: (b) => {
          const hit = byCode.get(b[0]);
          return hit ? hit.value : null; // null = device stores an unknown code
        },
        encode: (v) => {
          const hit = byValue.get(String(v));
          if (!hit) throw new CodecError(`未定義の値: ${JSON.stringify(v)}`);
          return [num(hit.code) & 0xff];
        },
        options: values.map((x) => ({ value: x.value, label: x.label != null ? x.label : String(x.value) })),
      };
    }

    case 'rgb':
      return {
        bytes: num(params.bytes, 3),
        decode: (b) => [b[0], b[1], b[2]],
        encode: (v) => requireRgb(v),
      };

    // RGB + complement checksum byte: [r, g, b, (base - (r+g+b)) & 0xFF]
    // Used by Scyrox/Compx DPI stage colors (record size 4).
    case 'rgbComplement': {
      const base = num(params.base != null ? params.base : params.complementBase, 0x55);
      return {
        bytes: 4,
        decode: (b) => [b[0], b[1], b[2]],
        encode: (v) => {
          const [r, g, bl] = requireRgb(v);
          return [r, g, bl, (base - ((r + g + bl) & 0xff)) & 0xff];
        },
      };
    }

    // Scyrox/Compx packed DPI record (4 bytes):
    //   enc = dpi/step - 1
    //   [0] = enc & 0xFF, [1] = same, [2] = ((enc>>8)&3)<<2 | ((enc>>8)&3)<<6,
    //   [3] = (base - (b0+b1+b2)) & 0xFF
    case 'dpi': {
      const step = num(params.step, 50);
      const min = num(params.min, 50);
      const max = num(params.max, 26000);
      const base = num(params.base, 0x55);
      return {
        bytes: 4,
        decode: (b) => {
          const high = (b[2] & 0x0c) >> 2;
          const val = (b[0] | (high << 8)) & 0xffff;
          return (val + 1) * step;
        },
        encode: (v) => {
          const dpi = Math.round(num(v, NaN));
          if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % step !== 0) {
            throw new CodecError(`DPIは${min}〜${max}の範囲で${step}刻みです (got ${JSON.stringify(v)})`);
          }
          const enc = dpi / step - 1;
          const low = enc & 0xff;
          const high = (enc >> 8) & 0x03;
          const byte2 = (high << 2) | (high << 6);
          return [low, low, byte2, (base - ((low + low + byte2) & 0xff)) & 0xff];
        },
      };
    }

    // VXE MAD R / MAD R Major DPI record (4 bytes): X/Y independent.
    //   [xLow, yLow, hi, ck] with hi = (yHigh << 6) | (xHigh << 2) and
    //   ck = 0x55 - xLow - yLow - hi. decode returns the X value;
    //   encode writes Y = X (same default as the reference madr CLI).
    case 'dpiXY': {
      const step = num(params.step, 50);
      const min = num(params.min, 50);
      const max = num(params.max, 30000);
      const base = num(params.base, 0x55);
      return {
        bytes: 4,
        decode: (b) => {
          const xHigh = (b[2] >> 2) & 0x0f;
          const yHigh = (b[2] >> 6) & 0x03;
          const x = (((xHigh << 8) | b[0]) + 1) * step;
          void yHigh;
          return Math.min(x, max);
        },
        encode: (v) => {
          const dpi = Math.round(num(v, NaN));
          if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % step !== 0) {
            throw new CodecError(`DPIは${min}〜${max}の範囲で${step}刻みです (got ${JSON.stringify(v)})`);
          }
          const xv = dpi / step - 1;
          const yv = xv; // Y = X
          const xl = xv & 0xff;
          const yl = yv & 0xff;
          const hi = (((yv >> 8) & 0x03) << 6) | (((xv >> 8) & 0x0f) << 2);
          return [xl, yl, hi, (base - ((xl + yl + hi) & 0xff)) & 0xff];
        },
      };
    }

    // Darmoshark (MOJI) plain little-endian 16-bit value (e.g. sleep seconds).
    case 'le16':
      return {
        bytes: 2,
        decode: (b) => b[0] | (b[1] << 8),
        encode: (v) => {
          const n = num(v);
          return [n & 0xff, (n >> 8) & 0xff];
        },
      };

    // Darmoshark (MOJI) DPI stage record (4 bytes): raw little-endian
    // X/Y pair [xLo, xHi, yLo, yHi]. decode returns X; encode writes Y = X.
    case 'dpiLeXY': {
      const step = num(params.step, 50);
      const min = num(params.min, 50);
      const max = num(params.max, 26000);
      return {
        bytes: 4,
        decode: (b) => b[0] | (b[1] << 8),
        encode: (v) => {
          const dpi = Math.round(num(v, NaN));
          if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % step !== 0) {
            throw new CodecError(`DPIは${min}〜${max}の範囲で${step}刻みです`);
          }
          return [dpi & 0xff, (dpi >> 8) & 0xff, dpi & 0xff, (dpi >> 8) & 0xff];
        },
      };
    }

    // Darmoshark (MOJI) enabled-stage count: the config byte is a bitmask
    // (1 stage = 0b1, 2 = 0b11, … 5 = 0b11111).
    case 'stagesMask': {
      const max = num(params.max, 5);
      const masks = [];
      for (let i = 1; i <= max; i++) masks.push((1 << i) - 1);
      return {
        bytes: 1,
        decode: (b) => {
          let c = 0;
          for (let bit = 0; bit < 8; bit++) c += (b[0] >> bit) & 1;
          return Math.max(1, Math.min(c, max));
        },
        encode: (v) => {
          const n = num(v);
          if (!Number.isInteger(n) || n < 1 || n > max) {
            throw new CodecError(`ステージ数は1〜${max}です`);
          }
          return [masks[n - 1]];
        },
      };
    }

    // Razer DPI stage record: [idx(1-based), X BE16, Y BE16, 0, 0].
    // decode returns X; encode writes Y = X. Used with stride 7.
    case 'dpiBeXY4': {
      const step = num(params.step, 50);
      const min = num(params.min, 100);
      const max = num(params.max, 35000);
      return {
        bytes: 4,
        decode: (b) => (b[0] << 8) | b[1],
        encode: (v) => {
          const dpi = Math.round(num(v, NaN));
          if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % step !== 0) {
            throw new CodecError(`DPIは${min}〜${max}の範囲で${step}刻みです`);
          }
          return [(dpi >> 8) & 0xff, dpi & 0xff, (dpi >> 8) & 0xff, dpi & 0xff];
        },
      };
    }

    // 1-based stage index (Razer active stage): decode v->v-1, encode v->v+1.
    case 'oneBased': {
      return {
        bytes: 1,
        decode: (b) => (b[0] > 0 ? b[0] - 1 : 0),
        encode: (v) => [(num(v) + 1) & 0xff],
      };
    }

    // Single bit within a flag byte (e.g. the MOJI sys-flags nibble).
    case 'bit': {
      const bit = num(params.bit, 0);
      return {
        bytes: 1,
        decode: (b) => ((b[0] >> bit) & 1) === 1,
        encode: (v) => [v ? 1 : 0],
      };
    }

    default:
      throw new CodecError(`未知のコーデック: ${type}`);
  }
}

module.exports = { makeCodec, num, CodecError };
