'use strict';

// =============================================================================
// core/profile.js — device profile loader.
// Device profiles are plain JSON files in devices/. Drop a new file there and
// the application picks it up at startup — no code changes required.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { num } = require('./codec');

const DEVICES_DIR = path.join(__dirname, '..', 'devices');

class ProfileError extends Error {
  constructor(message, file) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'ProfileError';
  }
}

function validateProfile(p, file) {
  if (!p || typeof p !== 'object') throw new ProfileError('プロファイルが不正です', file);
  if (!p.id) throw new ProfileError('id がありません', file);
  if (!p.meta || !p.meta.name) throw new ProfileError('meta.name がありません', file);
  if (!p.usb) throw new ProfileError('usb セクションがありません', file);
  if (p.usb.vendorId == null) throw new ProfileError('usb.vendorId がありません', file);
  if (!Array.isArray(p.usb.productIds)) {
    throw new ProfileError('usb.productIds (配列) がありません', file);
  }
  // Empty productIds = match any PID on this VID (generic profiles)
  if (!p.transport) throw new ProfileError('transport セクションがありません', file);
  if (p.transport.reportId == null) throw new ProfileError('transport.reportId がありません', file);
  const isMoji = p.transport.type === 'moji64';
  const isHidpp = p.transport.type === 'hidpp';
  const isRazer = p.transport.type === 'razer';
  const isCommandFrame = isMoji || isHidpp || isRazer;
  // sequence-style profiles (ROCCAT Swarm), MOJI (Darmoshark), HID++
  // (Logitech) and Razer feature-report profiles don't use the hid16 layout
  if (!p.applySequence && !isCommandFrame && !p.transport.layout) {
    throw new ProfileError('transport.layout がありません', file);
  }
  if (!p.commands) throw new ProfileError('commands セクションがありません', file);
  const probeName = p.usb.probeCommand || 'dongleVersion';
  if (!p.commands[probeName]) {
    throw new ProfileError(`probe コマンド '${probeName}' が commands に定義されていません`, file);
  }
  for (const name of ['readFlash', 'writeFlash']) {
    // only flash-mapped (hid16) profiles need direct flash commands;
    // sequence-style profiles (ROCCAT Swarm) use applySequence, MOJI
    // profiles read whole frames via commandImages, HID++ and Razer
    // profiles call per-setting commands/features instead.
    if (p.applySequence || isCommandFrame) continue;
    if (!p.commands[name] || p.commands[name].id == null) {
      throw new ProfileError(`commands.${name}.id がありません`, file);
    }
  }
  if (p.applySequence) {
    if (!p.applySequence.settingsPacket) {
      throw new ProfileError('applySequence.settingsPacket がありません', file);
    }
    if (!p.applySequence.defaults || typeof p.applySequence.defaults !== 'object') {
      throw new ProfileError('applySequence.defaults (オブジェクト) がありません', file);
    }
    if (!p.commands.battery || !p.commands.battery.data) {
      throw new ProfileError('commands.battery.data がありません（Swarm形式の必須コマンド）', file);
    }
  }
  if (!p.ui || !Array.isArray(p.ui.sections)) {
    throw new ProfileError('ui.sections (配列) がありません', file);
  }
  // settings sanity check
  for (const sec of p.ui.sections) {
    for (const s of sec.settings || []) {
      if (!s.key) throw new ProfileError(`セクション '${sec.title}' に key のない設定があります`, file);
    }
    for (const a of sec.actions || []) {
      if (!a.key || !a.command) {
        throw new ProfileError(`セクション '${sec.title}' のアクションに key/command がありません`, file);
      }
      // keepAwakeToggle is a server-side special action, not a device command
      if (a.command === 'keepAwakeToggle') continue;
      if (!p.commands[a.command]) {
        throw new ProfileError(`アクション '${a.key}' のコマンド '${a.command}' が定義されていません`, file);
      }
    }
  }
  return true;
}

/** Load every *.json device profile in dir (default: devices/). */
function loadProfiles(dir = DEVICES_DIR) {
  const profiles = [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return profiles;
  }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const full = path.join(dir, f);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      validateProfile(raw, f);
      raw._file = f;
      profiles.push(raw);
      console.log(`[profile] 読み込み: ${raw.meta.name} (${raw.id}) — ${f}`);
    } catch (e) {
      console.error(`[profile] ${f} を読み込めません: ${e.message}`);
    }
  }
  return profiles;
}

/** Match a HID device descriptor (from node-hid) against a profile. */
function matchesHidDevice(profile, hidDevice) {
  const usb = profile.usb;
  if (num(usb.vendorId) !== hidDevice.vendorId) return false;
  // Empty productIds = match any PID on this VID (generic profiles)
  if (!usb.productIds || usb.productIds.length === 0) return true;
  return usb.productIds.some((pid) => num(pid) === hidDevice.productId);
}

module.exports = { loadProfiles, validateProfile, matchesHidDevice, DEVICES_DIR };
