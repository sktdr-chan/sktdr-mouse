'use strict';

/* =============================================================================
 * マウス設定ツール — schema-driven frontend (multi-device).
 * The UI is rendered entirely from the device profile schemas served by
 * /api/schema (devices/*.json). No mouse-specific code here.
 * ========================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

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

/* ------------------------------------------------------------------ state */

let devicesStatus = []; // from /api/status: [{ id, name, connected, online, ... }]
let activeDevice = null;
const slots = {}; // deviceId -> { schema, status, config }
let busy = false;
let resetArmed = null;
let builtFor = null; // schema id the settings DOM was built for

/* ------------------------------------------------------------------ utils */

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('fade'), 2200);
  setTimeout(() => el.remove(), 2600);
}

function addLog(text, isErr = false) {
  const li = document.createElement('li');
  if (isErr) li.className = 'err';
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.innerHTML = `<span class="t">${t}</span>`;
  li.appendChild(document.createTextNode(text));
  const list = $('#logList');
  list.prepend(li);
  while (list.children.length > 40) list.lastChild.remove();
}

function rgbToHex(rgb) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function setBusy(v) {
  busy = v;
  $('#app').classList.toggle('busy', v);
}

function slot() {
  return slots[activeDevice] || {};
}

/* --------------------------------------------------------------- API glue */

async function applySetting(setting, args) {
  if (busy) return;
  setBusy(true);
  try {
    const r = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice, setting, args }),
    });
    const j = await r.json();
    if (j.ok) {
      if (j.config) slot().config = j.config;
      if (j.devices) updateDevices(j.devices);
      render();
      toast('保存しました');
      addLog(`✔ ${setting} ${JSON.stringify(args)}`);
    } else {
      toast(`エラー: ${j.error || r.status}`, 'error');
      addLog(`✖ ${setting}: ${j.error || 'failed'}`, true);
      refreshFromDevice();
    }
  } catch (e) {
    toast(`通信エラー: ${e.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------ apply mode (immediate / manual) */

let applyModeImmediate = localStorage.getItem('applyMode') !== 'manual';
const pendingMap = new Map(); // signature -> { key, args, els }

function pendingSig(key, args) {
  return key + '|' + (args.op || '') + '|' + (args.index ?? '') + '|' + (args.field ?? '');
}

function clearPending() {
  pendingMap.clear();
  $$('.pending').forEach((el) => el.classList.remove('pending'));
  updateApplyButton();
}

function updateApplyButton() {
  const btn = $('#applyAllBtn');
  if (!btn) return;
  const n = pendingMap.size;
  btn.textContent = n ? `適用 (${n})` : '適用';
  btn.classList.toggle('hidden', applyModeImmediate);
  btn.disabled = n === 0;
}

/**
 * Route a setting change: immediate mode POSTs right away; manual mode
 * records it as pending (the last value per setting wins) and waits for
 * the 適用 button.
 */
function commitSetting(key, args, els = []) {
  if (applyModeImmediate) {
    applySetting(key, args);
    return;
  }
  pendingMap.set(pendingSig(key, args), { key, args, els });
  for (const el of els) if (el && el.classList) el.classList.add('pending');
  updateApplyButton();
}

async function applyPending() {
  if (busy || !pendingMap.size) return;
  setBusy(true);
  let failed = 0;
  for (const [sig, e] of [...pendingMap]) {
    try {
      const r = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: activeDevice, setting: e.key, args: e.args }),
      });
      const j = await r.json();
      if (j.ok) {
        pendingMap.delete(sig);
        for (const el of e.els) if (el && el.classList) el.classList.remove('pending');
        if (j.config) slot().config = j.config;
        if (j.devices) updateDevices(j.devices);
        addLog(`✔ ${e.key} ${JSON.stringify(e.args)}`);
      } else {
        failed += 1;
        toast(`エラー: ${j.error || r.status}`, 'error');
        addLog(`✖ ${e.key}: ${j.error || 'failed'}`, true);
      }
    } catch (err) {
      failed += 1;
      toast(`通信エラー: ${err.message}`, 'error');
    }
  }
  setBusy(false);
  render();
  updateApplyButton();
  toast(failed ? `${failed} 件失敗しました（保留中）` : '適用しました');
}

async function applyAction(action, args) {
  if (busy) return;
  setBusy(true);
  try {
    const r = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice, action, args }),
    });
    const j = await r.json();
    if (j.ok) {
      const def = findAction(action);
      if (def && def.successMessage) toast(def.successMessage, 'info');
      else toast('実行しました', 'info');
      addLog(`⚙ ${action} 実行`);
      if (j.devices) updateDevices(j.devices);
      refreshFromDevice();
    } else {
      toast(`エラー: ${j.error || r.status}`, 'error');
      addLog(`✖ ${action}: ${j.error || 'failed'}`, true);
    }
  } catch (e) {
    toast(`通信エラー: ${e.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshFromDevice() {
  try {
    const r = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: activeDevice }),
    });
    const j = await r.json();
    if (j.ok) {
      clearPending(); // the device state wins over un-applied edits
      slot().config = j.config;
      if (j.devices) updateDevices(j.devices);
      render();
      return true;
    }
    toast(`読み出し失敗: ${j.error || r.status}`, 'error');
    return false;
  } catch (e) {
    toast(`通信エラー: ${e.message}`, 'error');
    return false;
  }
}

async function loadSchema(deviceId) {
  try {
    const r = await fetch(`/api/schema?device=${encodeURIComponent(deviceId)}`);
    const j = await r.json();
    if (j.ok && j.schema) {
      if (!slots[deviceId]) slots[deviceId] = {};
      slots[deviceId].schema = j.schema;
      if (deviceId === activeDevice) render();
    }
  } catch (e) {
    /* server unreachable — banner explains */
  }
}

async function loadConfig(deviceId) {
  try {
    const r = await fetch(`/api/config?device=${encodeURIComponent(deviceId)}`);
    if (r.ok) {
      const j = await r.json();
      if (j.ok) {
        if (!slots[deviceId]) slots[deviceId] = {};
        slots[deviceId].config = j.config;
        if (deviceId === activeDevice) render();
      }
    }
  } catch (e) {
    /* SSE will deliver config when ready */
  }
}

function findSetting(key) {
  const schema = slot().schema;
  if (!schema) return null;
  for (const sec of schema.ui.sections || []) {
    for (const s of sec.settings || []) if (s.key === key) return s;
  }
  return null;
}

function findAction(key) {
  const schema = slot().schema;
  if (!schema) return null;
  for (const sec of schema.ui.sections || []) {
    for (const a of sec.actions || []) if (a.key === key) return a;
  }
  return null;
}

/* ------------------------------------------------------------ DOM build */

function optionList(setting) {
  if (setting.options) {
    return setting.options.map((o) => ({ value: o.value, label: o.label != null ? o.label : String(o.value) }));
  }
  const codec = setting.read && setting.read.codec;
  if (codec && Array.isArray(codec.values)) {
    return codec.values.map((x) => ({ value: x.value, label: x.label != null ? x.label : String(x.value) }));
  }
  return [];
}

function buildToggleRow(label, id) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.style.minWidth = '180px';
  const t = document.createElement('label');
  t.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  const knob = document.createElement('span');
  knob.className = 'knob';
  const span = document.createElement('span');
  span.textContent = 'ON';
  t.append(input, knob, span);
  wrap.append(lab, t);
  return { wrap, input };
}

function hintEl(text, template = null, id = null) {
  const p = document.createElement('p');
  p.className = 'hint';
  if (id) p.id = id;
  if (template) {
    p.dataset.template = template;
    p.textContent = text || '';
  } else {
    p.textContent = text;
  }
  return p;
}

function parseOptionValue(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function buildUi() {
  const s = slot();
  if (!s.schema) return;
  builtFor = s.schema.id;
  $('#brandModel').textContent = s.schema.meta.name;
  document.title = `${s.schema.meta.name} 設定ツール`;
  const container = $('#sections');
  container.innerHTML = '';

  for (const sec of s.schema.ui.sections || []) {
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.section = sec.title;
    const h = document.createElement('h2');
    h.textContent = sec.title;
    card.appendChild(h);

    for (const st of sec.settings || []) {
      card.appendChild(buildSetting(st));
    }

    for (const a of sec.actions || []) {
      // keepAwake toggle: server-side special action, rendered as a toggle
      if (a.command === 'keepAwakeToggle') {
        const row = document.createElement('div');
        row.className = 'row';
        row.id = `keepawake-row`;
        const lab = document.createElement('label');
        lab.textContent = a.label || 'Keep awake';
        lab.style.minWidth = '180px';
        const t = document.createElement('label');
        t.className = 'toggle';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'keepAwakeToggle';
        const knob = document.createElement('span');
        knob.className = 'knob';
        const span = document.createElement('span');
        span.textContent = 'ON';
        t.append(input, knob, span);
        row.append(lab, t);
        if (a.hint) row.appendChild(hintEl(a.hint));
        input.addEventListener('change', async (e) => {
          const on = e.target.checked;
          try {
            const r = await fetch('/api/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ device: activeDevice, action: 'keepAwakeToggle', args: { value: on } }),
            });
            const j = await r.json();
            if (j.ok) {
              toast(on ? 'スリープ防止ON — 2秒間隔でコマンドを送り続けます' : 'スリープ防止OFF — 通常のスリープ動作に戻りました');
              addLog(`⚡ keep-awake ${on ? 'ON' : 'OFF'}`);
              if (j.config) slot().config = j.config;
              render();
            } else {
              toast(`エラー: ${j.error}`, 'error');
              e.target.checked = !on; // revert
            }
          } catch (err) {
            toast(`通信エラー: ${err.message}`, 'error');
            e.target.checked = !on;
          }
        });
        card.appendChild(row);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.style.minWidth = '180px';
      const btn = document.createElement('button');
      btn.className = 'btn' + (a.danger ? ' danger' : '');
      btn.id = `action-${a.key}`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => runAction(a));
      row.append(lab, btn);
      card.appendChild(row);
    }

    container.appendChild(card);
  }
}

function buildSetting(s) {
  switch (s.type) {
    case 'segmented': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = s.label || s.key;
      row.appendChild(lab);
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.id = `seg-${s.key}`;
      for (const o of optionList(s)) {
        const b = document.createElement('button');
        b.textContent = o.label.endsWith(s.unit || '') ? o.label : o.label + (s.unit || '');
        b.dataset.value = String(o.value);
        b.addEventListener('click', () => {
          if (!applyModeImmediate) {
            $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
          }
          commitSetting(s.key, { value: parseOptionValue(o.value) }, [seg]);
        });
        seg.appendChild(b);
      }
      row.appendChild(seg);
      if (s.hint) row.appendChild(hintEl(s.hint));
      if (s.hintFromMaxHz) row.appendChild(hintEl('', s.hintFromMaxHz, `hint-${s.key}-maxhz`));
      if (s.hintMouseMaxHz) row.appendChild(hintEl('', s.hintMouseMaxHz, `hint-${s.key}-mousemaxhz`));
      return row;
    }

    case 'select': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = s.label || s.key;
      const sel = document.createElement('select');
      sel.id = `sel-${s.key}`;
      for (const o of optionList(s)) {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', (e) => {
        const def = optionList(s).find((o) => String(o.value) === e.target.value);
        commitSetting(s.key, { value: parseOptionValue(def ? def.value : e.target.value) }, [sel]);
      });
      row.append(lab, sel);
      return row;
    }

    case 'slider': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = `${s.label || s.key} `;
      const val = document.createElement('b');
      val.className = 'num';
      val.id = `val-${s.key}`;
      lab.appendChild(val);
      if (s.unit) lab.appendChild(document.createTextNode(s.unit));
      const number = document.createElement('input');
      number.type = 'number';
      number.id = `num-${s.key}`;
      number.min = s.min != null ? s.min : 0;
      number.max = s.max != null ? s.max : 100;
      number.step = s.step != null ? s.step : 1;
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `range-${s.key}`;
      range.min = String(s.min != null ? s.min : 0);
      range.max = String(s.max != null ? s.max : 100);
      range.step = String(s.step != null ? s.step : 1);
      const clampCommit = (v) => {
        let n = Number(v);
        if (!Number.isFinite(n)) n = number.min != null ? Number(number.min) : 0;
        const lo = Number(range.min);
        const hi = Number(range.max);
        const st = Number(range.step) || 1;
        n = Math.min(hi, Math.max(lo, Math.round((n - lo) / st) * st + lo));
        number.value = String(n);
        range.value = String(n);
        const valEl = $(`#val-${s.key}`);
        if (valEl) valEl.textContent = String(n);
        commitSetting(s.key, { value: n }, [range, number]);
      };
      range.addEventListener('input', () => {
        number.value = range.value;
        const valEl = $(`#val-${s.key}`);
        if (valEl) valEl.textContent = range.value;
      });
      range.addEventListener('change', () => clampCommit(range.value));
      number.addEventListener('input', () => {
        const n = Number(number.value);
        if (Number.isFinite(n)) range.value = String(n);
      });
      number.addEventListener('change', () => clampCommit(number.value));
      row.append(lab, number, range);
      if (s.hint) row.appendChild(hintEl(s.hint));
      return row;
    }

    case 'toggle': {
      const { wrap, input } = buildToggleRow(s.label || s.key, `tog-${s.key}`);
      input.addEventListener('change', (e) => {
        commitSetting(s.key, { value: e.target.checked }, [input]);
      });
      if (s.hint) wrap.appendChild(hintEl(s.hint));
      wrap.dataset.toggleKey = s.key;
      return wrap;
    }

    case 'color': {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = s.label || s.key;
      const c = document.createElement('input');
      c.type = 'color';
      c.id = `color-${s.key}`;
      c.addEventListener('change', (e) => {
        const rgb = hexToRgb(e.target.value);
        if (rgb) commitSetting(s.key, { value: rgb }, [c]);
      });
      row.append(lab, c);
      return row;
    }

    case 'dpiStages': {
      const wrap = document.createElement('div');
      wrap.dataset.dpiKey = s.key;

      if (s.countEditable !== false) {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        lab.textContent = 'ステージ数';
        const cnt = document.createElement('select');
        cnt.id = `dpi-count-${s.key}`;
        for (let i = 1; i <= num(s.maxRecords, 8); i++) {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = `${i} 段階`;
          cnt.appendChild(o);
        }
        cnt.addEventListener('change', (e) => {
          commitSetting(s.key, { op: 'count', value: parseInt(e.target.value, 10) }, [cnt]);
        });
        const cur = document.createElement('span');
        cur.className = 'hint';
        cur.id = `dpi-current-${s.key}`;
        row.append(lab, cnt, cur);
        wrap.appendChild(row);
      } else {
        const row = document.createElement('div');
        row.className = 'row';
        const lab = document.createElement('label');
        lab.textContent = 'アクティブステージ';
        const cur = document.createElement('span');
        cur.className = 'hint';
        cur.id = `dpi-current-${s.key}`;
        row.append(lab, cur);
        wrap.appendChild(row);
      }

      const stages = document.createElement('div');
      stages.className = 'dpi-stages';
      stages.id = `dpi-stages-${s.key}`;
      const vr = s.valueRange || { min: 50, max: 26000, step: 50 };
      for (let i = 0; i < num(s.maxRecords, 8); i++) {
        const r = document.createElement('div');
        r.className = 'dpi-row';
        r.dataset.index = String(i);

        const badge = document.createElement('span');
        badge.className = 'dpi-badge';
        badge.textContent = String(i + 1);

        const flag = document.createElement('span');
        flag.className = 'cur-flag';
        flag.textContent = '● 現在';

        const controls = document.createElement('div');
        controls.className = 'dpi-controls';
        const number = document.createElement('input');
        number.type = 'number';
        number.min = String(vr.min);
        number.max = String(vr.max);
        number.step = String(vr.step);
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(vr.min);
        range.max = String(vr.max);
        range.step = String(vr.step);
        controls.append(number, range);

        const color = document.createElement('input');
        color.type = 'color';
        color.title = 'ステージの色';

        const use = document.createElement('button');
        use.className = 'btn small';
        use.textContent = '使用';
        use.title = 'このステージに切り替え';

        r.append(badge, flag, controls, color, use);
        stages.appendChild(r);

        const commit = () => {
          let dpi = parseInt(number.value, 10);
          if (!Number.isFinite(dpi)) dpi = vr.min;
          dpi = Math.min(vr.max, Math.max(vr.min, Math.round(dpi / vr.step) * vr.step));
          number.value = String(dpi);
          range.value = String(dpi);
          commitSetting(s.key, { op: 'stageValue', index: i, value: dpi }, [number, range]);
        };
        number.addEventListener('change', commit);
        range.addEventListener('input', () => {
          number.value = range.value;
        });
        range.addEventListener('change', commit);
        color.addEventListener('change', (e) => {
          const rgb = hexToRgb(e.target.value);
          if (rgb) commitSetting(s.key, { op: 'stageColor', index: i, color: rgb }, [color]);
        });
        use.addEventListener('click', () => {
          if (!applyModeImmediate) {
            $$('.dpi-row', stages).forEach((x) => x.classList.toggle('current', x === r));
            const curEl = $(`#dpi-current-${s.key}`);
            if (curEl) curEl.textContent = `現在のステージ: ${i + 1}`;
          }
          commitSetting(s.key, { op: 'current', value: i }, [r]);
        });

        // profiles without per-stage colors hide the picker
        if (s.colors === false) color.style.display = 'none';
      }
      wrap.appendChild(stages);

      if (s.hint) wrap.appendChild(hintEl(s.hint));
      return wrap;
    }

    case 'group': {
      const wrap = document.createElement('div');
      wrap.dataset.groupKey = s.key;
      for (const f of s.fields || []) {
        if (f.type === 'select') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = f.label || f.key;
          const sel = document.createElement('select');
          sel.id = `grp-${s.key}-${f.key}`;
          const codecValues = (f.read && f.read.codec && f.read.codec.values) || [];
          for (const o of codecValues) {
            const opt = document.createElement('option');
            opt.value = String(o.value);
            opt.textContent = o.label != null ? o.label : String(o.value);
            sel.appendChild(opt);
          }
          sel.addEventListener('change', (e) => {
            const hit = codecValues.find((o) => String(o.value) === e.target.value);
            commitSetting(s.key, { field: f.key, value: hit ? hit.value : e.target.value }, [sel]);
          });
          row.append(lab, sel);
          wrap.appendChild(row);
        } else if (f.type === 'color') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = f.label || f.key;
          const c = document.createElement('input');
          c.type = 'color';
          c.id = `grp-${s.key}-${f.key}`;
          c.addEventListener('change', (e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) commitSetting(s.key, { field: f.key, value: rgb }, [c]);
          });
          row.append(lab, c);
          wrap.appendChild(row);
        } else if (f.type === 'slider') {
          const row = document.createElement('div');
          row.className = 'row';
          const lab = document.createElement('label');
          lab.textContent = `${f.label || f.key} `;
          const val = document.createElement('b');
          val.className = 'num';
          val.id = `grp-${s.key}-${f.key}-val`;
          lab.appendChild(val);
          const range = document.createElement('input');
          range.type = 'range';
          range.id = `grp-${s.key}-${f.key}`;
          range.min = f.min != null ? f.min : 0;
          range.max = f.max != null ? f.max : 100;
          range.step = f.step != null ? f.step : 1;
          range.addEventListener('input', () => {
            val.textContent = range.value;
          });
          range.addEventListener('change', () => {
            commitSetting(s.key, { field: f.key, value: Number(range.value) }, [range]);
          });
          row.append(lab, range);
          if (f.hint) row.appendChild(hintEl(f.hint));
          wrap.appendChild(row);
        }
      }
      if (s.on) {
        const { wrap: trow, input } = buildToggleRow(s.on.label || 'ON', `grp-${s.key}-${s.on.key || 'on'}`);
        input.addEventListener('change', (e) => {
          commitSetting(s.key, { field: s.on.key || 'on', value: e.target.checked }, [input]);
        });
        wrap.appendChild(trow);
      }
      return wrap;
    }

    default:
      return document.createComment(`unsupported setting type: ${s.type}`);
  }
}

function runAction(a) {
  const btn = $(`#action-${a.key}`);
  if (a.doubleClickConfirm) {
    if (a.key === 'factoryReset' && !resetArmed) {
      resetArmed = setTimeout(() => {
        btn.classList.remove('armed');
        btn.textContent = a.label;
        resetArmed = null;
      }, 4000);
      btn.classList.add('armed');
      btn.textContent = '本当に実行する場合、もう一度クリック';
      return;
    }
    if (resetArmed) {
      clearTimeout(resetArmed);
      resetArmed = null;
      btn.classList.remove('armed');
      btn.textContent = a.label;
    }
    applyAction(a.key, { confirm: true });
    return;
  }
  if (a.confirm && !confirm(a.confirm)) return;
  applyAction(a.key, {});
}

/* ------------------------------------------------------------------ render */

function setChip(el, text, cls) {
  el.textContent = text;
  el.className = `chip ${cls}`;
}

function renderDeviceChips() {
  const holder = $('#deviceChips');
  holder.innerHTML = '';
  for (const d of devicesStatus) {
    const chip = document.createElement('button');
    chip.className =
      'chip device-chip' +
      (d.id === activeDevice ? ' active' : '') +
      (d.connected ? (d.online ? ' chip-ok' : ' chip-warn') : ' chip-off');
    chip.textContent = d.name + (d.connected ? '' : ' （未接続）');
    chip.title = d.id;
    chip.addEventListener('click', async () => {
      if (busy || d.id === activeDevice) return;
      clearPending(); // pending changes belong to the previous device
      activeDevice = d.id;
      render();
      await loadSchema(d.id);
      await loadConfig(d.id);
    });
    holder.appendChild(chip);
  }
}

function renderStatus() {
  const s = slot();
  const conn = $('#connChip');
  const bat = $('#batteryChip');
  const app = $('#app');
  const banner = $('#banner');

  renderDeviceChips();

  if (!devicesStatus.length || !activeDevice) {
    setChip(conn, '未接続', 'chip-off');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent = '対応デバイスが見つかりません。USB接続すると自動で認識します…';
    return;
  }

  const st = s.status || {};
  if (!st.connected) {
    setChip(conn, '未接続', 'chip-off');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent = `${s.schema ? s.schema.meta.name : activeDevice} は未接続です。USB接続すると自動で認識します…`;
    return;
  }

  if (!st.online) {
    setChip(conn, 'スリープ中', 'chip-warn');
    app.classList.add('disabled');
    banner.classList.remove('hidden', 'info');
    banner.textContent =
      'マウスがオフラインです。マウスを動かすかクリックしてスリープを解除してください（電源スイッチ・モード切替も確認してください）。';
  } else {
    setChip(conn, st.connection || '接続済み', 'chip-ok');
    app.classList.remove('disabled');
    banner.classList.add('hidden');
  }

  if (st.battery) {
    const b = st.battery;
    const cls = b.level >= 60 ? 'chip-ok' : b.level >= 20 ? 'chip-warn' : 'chip-bad';
    setChip(bat, `${b.charging ? '⚡' : '🔋'} ${b.level}%`, cls);
    bat.title = b.voltage ? `${(b.voltage / 1000).toFixed(2)} V` : '';
  } else {
    setChip(bat, '🔋 --%', 'chip-off');
  }

  // device info card (schema-driven)
  const kv = $('#deviceKv');
  kv.innerHTML = '';
  for (const info of (s.schema && s.schema.ui.deviceInfo) || []) {
    const div = document.createElement('div');
    div.className = 'kv';
    const lab = document.createElement('label');
    lab.textContent = info.label;
    const b = document.createElement('b');
    b.textContent = st[info.key] != null ? st[info.key] : '--';
    div.append(lab, b);
    kv.appendChild(div);
  }

  // per-device read/resync button (schema-driven, capability-honest)
  const actions = $('#deviceActions');
  if (actions) {
    actions.innerHTML = '';
    const rb = s.schema && s.schema.ui && s.schema.ui.readButton;
    if (rb) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = 'readDeviceBtn';
      btn.textContent = rb.label || 'デバイスから読み出し';
      btn.disabled = !(st.connected && st.online) || busy;
      btn.addEventListener('click', async () => {
        const ok = await refreshFromDevice();
        if (ok) toast(rb.successMessage || '読み出しました');
      });
      actions.appendChild(btn);
      if (rb.note) actions.appendChild(hintEl(rb.note));
    }
  }

  const src = $('#protocolSource');
  if (src) {
    src.textContent =
      s.schema && s.schema.documentation && s.schema.documentation.protocolSource
        ? `プロトコル出典: ${s.schema.documentation.protocolSource}`
        : '';
  }
}

function renderConfig() {
  const s = slot();
  if (!s.config || !s.schema) return;
  const config = s.config;
  const online = s.status ? s.status.online : false;

  for (const sec of s.schema.ui.sections || []) {
    for (const st of sec.settings || []) renderSetting(st, config, online);
  }
}

function renderSetting(s, config, online) {
  switch (s.type) {
    case 'segmented': {
      const seg = $(`#seg-${s.key}`);
      if (!seg) return;
      const segPending = seg.classList.contains('pending');
      const st = slot().status || {};
      const connMax = st.maxHz != null ? Number(st.maxHz) : null;
      const bodyMax = st.mouseMaxHz != null ? Number(st.mouseMaxHz) : null;
      $$('button', seg).forEach((b) => {
        const v = Number(b.dataset.value);
        if (!segPending) {
          b.classList.toggle('active', config[s.key] != null && v === Number(config[s.key]));
        }
        // Rates above the current dongle's capability stay selectable (the
        // device stores them; they take effect with a capable dongle) but
        // are visually marked. Rates above the body capability are disabled.
        const overDongle = connMax != null && v > connMax;
        const overBody = bodyMax != null && v > bodyMax;
        b.classList.toggle('seg-over-max', overDongle && !overBody);
        b.disabled = !online || overBody;
        if (overDongle && !overBody) {
          b.title = 'このドングルでは無効 — 設定は保存され、対応ドングル接続時に有効になります';
        } else {
          b.removeAttribute('title');
        }
      });
      const hintElm = $(`#hint-${s.key}-maxhz`);
      if (hintElm && s.hintFromMaxHz && hintElm.dataset.template) {
        hintElm.textContent = hintElm.dataset.template.replace('{maxHz}', st.maxHz != null ? String(st.maxHz) : '?');
      }
      const mouseHint = $(`#hint-${s.key}-mousemaxhz`);
      if (mouseHint && s.hintMouseMaxHz && mouseHint.dataset.template) {
        const mismatch = bodyMax != null && connMax != null && bodyMax > connMax;
        mouseHint.style.display = mismatch ? '' : 'none';
        if (mismatch) {
          mouseHint.textContent = mouseHint.dataset.template
            .replace('{mouseMaxHz}', String(bodyMax))
            .replace('{maxHz}', String(connMax));
        }
      }
      break;
    }

    case 'select': {
      const sel = $(`#sel-${s.key}`);
      if (!sel) return;
      if (!sel.classList.contains('pending') && document.activeElement !== sel && config[s.key] != null) {
        sel.value = String(config[s.key]);
      }
      sel.disabled = !online;
      break;
    }

    case 'slider': {
      const range = $(`#range-${s.key}`);
      if (!range) return;
      const number = $(`#num-${s.key}`);
      const pend = range.classList.contains('pending');
      if (!pend && document.activeElement !== range && document.activeElement !== number) {
        const v = config[s.key] != null ? config[s.key] : '';
        range.value = String(v);
        if (number) number.value = String(v);
        const val = $(`#val-${s.key}`);
        if (val) val.textContent = config[s.key] != null ? config[s.key] : '--';
      }
      range.disabled = !online;
      if (number) number.disabled = !online;
      break;
    }

    case 'toggle': {
      const input = $(`#tog-${s.key}`);
      if (!input) return;
      if (!input.classList.contains('pending') && document.activeElement !== input) {
        input.checked = !!config[s.key];
      }
      input.disabled = !online;
      break;
    }

    case 'color': {
      const c = $(`#color-${s.key}`);
      if (!c) return;
      if (!c.classList.contains('pending') && document.activeElement !== c && config[s.key]) {
        c.value = rgbToHex(config[s.key]);
      }
      c.disabled = !online;
      break;
    }

    case 'dpiStages': {
      const d = config[s.key] || { count: 0, current: 0, records: [] };
      const cnt = $(`#dpi-count-${s.key}`);
      const cntPending = cnt && cnt.classList.contains('pending');
      if (cnt) {
        if (!cntPending && document.activeElement !== cnt) cnt.value = String(d.count || 1);
        cnt.disabled = !online || s.countEditable === false;
      }
      const stages = $(`#dpi-stages-${s.key}`);
      if (stages) {
        const curPend = $$('.dpi-row.pending', stages).some((x) => true);
        const cur = $(`#dpi-current-${s.key}`);
        if (cur && !curPend) cur.textContent = d.current != null ? `現在のステージ: ${d.current + 1}` : '';
      }
      if (!stages) return;
      $$('.dpi-row', stages).forEach((row) => {
        const i = Number(row.dataset.index);
        const rec = (d.records || [])[i];
        if (!rec) return;
        const rowPending = row.classList.contains('pending');
        const disabledByCount = i >= (d.count || 0);
        if (!rowPending) {
          row.classList.toggle('disabled', disabledByCount);
          row.classList.toggle('current', i === d.current);
        }
        const number = $('input[type="number"]', row);
        const range = $('input[type="range"]', row);
        const color = $('input[type="color"]', row);
        const use = $('button', row);
        if (!rowPending) {
          if (document.activeElement !== number && String(rec.value) !== number.value) {
            number.value = String(rec.value);
          }
          if (document.activeElement !== range) range.value = String(rec.value);
          if (color && document.activeElement !== color && rec.color) color.value = rgbToHex(rec.color);
        }
        number.disabled = range.disabled = use.disabled = disabledByCount || !online;
        if (color) color.disabled = disabledByCount || !online || s.colors === false;
      });
      break;
    }

    case 'group': {
      const g = config[s.key] || {};
      for (const f of s.fields || []) {
        const key = f.key;
        const el = $(`#grp-${s.key}-${key}`);
        const pend = el && el.classList.contains('pending');
        if (f.type === 'select') {
          const sel = el;
          if (sel && !pend && document.activeElement !== sel && g[key] != null) sel.value = String(g[key]);
          if (sel) sel.disabled = !online;
        } else if (f.type === 'color') {
          const c = el;
          if (c && !pend && document.activeElement !== c && g[key]) c.value = rgbToHex(g[key]);
          if (c) c.disabled = !online;
        } else if (f.type === 'slider') {
          const r = el;
          const val = $(`#grp-${s.key}-${key}-val`);
          if (r && !pend && document.activeElement !== r && g[key] != null) {
            r.value = String(g[key]);
            if (val) val.textContent = g[key];
          }
          if (r) r.disabled = !online;
        }
      }
      if (s.on) {
        const onKey = s.on.key || 'on';
        const input = $(`#grp-${s.key}-${onKey}`);
        if (input) {
          if (!input.classList.contains('pending') && document.activeElement !== input) {
            input.checked = !!g[onKey];
          }
          input.disabled = !online;
        }
      }
      break;
    }

    default:
      break;
  }
}

/** command-read settings may be unsupported (e.g. longRange) — hide them */
function renderCommandSettingVisibility() {
  const s = slot();
  if (!s.schema || !s.config) return;
  for (const sec of s.schema.ui.sections || []) {
    for (const st of sec.settings || []) {
      if (st.read && st.read.command && st.type === 'toggle') {
        const row = $(`#tog-${st.key}`);
        const wrap = row ? row.closest('.row') : null;
        if (wrap) wrap.style.display = s.config[st.key] == null ? 'none' : '';
      }
    }
  }
}

function render() {
  renderStatus();
  if (activeDevice && slot().schema) {
    if (builtFor !== slot().schema.id || activeDevice !== builtForDevice) {
      builtForDevice = activeDevice;
      buildUi();
    }
    renderConfig();
    renderCommandSettingVisibility();
  }
}
let builtForDevice = null;

function updateDevices(devices) {
  devicesStatus = devices || [];
  for (const d of devicesStatus) {
    if (!slots[d.id]) slots[d.id] = {};
    slots[d.id].status = { ...(slots[d.id].status || {}), ...d };
  }
  if (!activeDevice) {
    const first = devicesStatus.find((d) => d.connected) || devicesStatus[0];
    if (first) {
      activeDevice = first.id;
      loadSchema(first.id);
      loadConfig(first.id);
    }
  }
  render();
}

/* -------------------------------------------------------------------- SSE */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    const { type, data } = msg;
    switch (type) {
      case 'status': {
        updateDevices(data);
        break;
      }
      case 'config': {
        const { device, data: cfg } = data;
        if (!slots[device]) slots[device] = {};
        slots[device].config = cfg;
        if (device === activeDevice) render();
        break;
      }
      case 'battery': {
        const { device, data: bat } = data;
        if (slots[device]) {
          slots[device].status = { ...(slots[device].status || {}), battery: bat };
          if (device === activeDevice) renderStatus();
        }
        break;
      }
      case 'online': {
        const { device, data: on } = data;
        if (slots[device]) {
          slots[device].status = { ...(slots[device].status || {}), online: !!on };
          render();
          if (!on && device === activeDevice) addLog('マウスがスリープ/オフラインになりました', true);
        }
        break;
      }
      case 'notification': {
        const { device } = data;
        addLog(`${device}: マウス側で設定が変更されました（再取得中…）`);
        break;
      }
      case 'waiting': {
        const device = data && data.device;
        if (device === activeDevice) {
          const st = slot().status || {};
          if (st.connected && !st.online) toast('マウスを動かしてスリープを解除してください', 'info');
        }
        break;
      }
      default:
        break;
    }
  };
}

/* -------------------------------------------------------------------- init */

async function init() {
  render();
  // apply-mode toggle (即時適用 / 保存ボタン) — persisted in localStorage
  const modeToggle = $('#applyModeToggle');
  const modeLabel = $('#applyModeLabel');
  const applyBtn = $('#applyAllBtn');
  if (modeToggle) {
    modeToggle.checked = applyModeImmediate;
    const syncModeUi = () => {
      if (modeLabel) modeLabel.textContent = modeToggle.checked ? '即時適用' : '保存ボタン';
    };
    syncModeUi();
    modeToggle.addEventListener('change', () => {
      applyModeImmediate = modeToggle.checked;
      localStorage.setItem('applyMode', applyModeImmediate ? 'immediate' : 'manual');
      syncModeUi();
      if (applyModeImmediate && pendingMap.size) applyPending(); // flush leftovers
      updateApplyButton();
    });
  }
  if (applyBtn) applyBtn.addEventListener('click', applyPending);
  updateApplyButton();
  try {
    const r = await fetch('/api/status');
    const j = await r.json();
    updateDevices(j.devices || []);
  } catch (e) {
    toast('サーバーに接続できません', 'error');
  }
  connectEvents();
}

document.addEventListener('DOMContentLoaded', init);
