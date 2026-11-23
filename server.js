'use strict';

// =============================================================================
// 汎用マウス設定ツール — local web server (profile-driven core, multi-device)
//
//   http://localhost:3554  → UI (public/)
//   /api/status            → connected devices list
//   /api/build-info        → app build metadata (commit id / build time)
//   /api/schema?device=ID  → device profile UI schema (from JSON)
//   /api/config?device=ID  → parsed device config
//   /api/apply  (POST)     → generic setting write: { device, setting, args }
//   /api/action (POST)    → generic action:      { device, action, args }
//   /api/events (GET)     → SSE stream (status/config/battery/online/…, per device)
//
// Mouse-specific knowledge lives ONLY in devices/*.json (device profiles).
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { loadProfiles } = require('./core/profile');
const { BUILD_INFO } = require('./core/build-info');

const PORT = Number(process.env.PORT || 3554);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Everything below is wrapped in startServer() so the Electron shell can boot
// the same server in-process (and so tests can spin it up on any port).
function startServer(port = PORT, options = {}) {
const { DeviceManager } = require('./core/manager');
const profiles = loadProfiles();
if (profiles.length === 0) {
  console.error('[起動エラー] devices/ に有効なデバイスプロファイル (JSON) がありません。');
  process.exit(1);
}
const manager = new DeviceManager(profiles);

// ------------------------------------------------------------------- SSE ---

const sseClients = new Set();

function sseSend(res, type, data) {
  try {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  } catch (e) {
    sseClients.delete(res);
  }
}

function broadcast(type, data) {
  for (const res of sseClients) sseSend(res, type, data);
}

// --------------------------------------------------------------- manager ---

manager.onEvent((type, data) => {
  switch (type) {
    case 'status':
      broadcast('status', manager.statusPayload());
      break;
    case 'config':
      broadcast('config', data); // { device, data }
      break;
    case 'battery':
      broadcast('battery', data); // { device, data }
      break;
    case 'online':
      broadcast('online', data); // { device, data }
      break;
    case 'notification':
      broadcast('notification', data); // { device, data }
      break;
    case 'waiting':
      broadcast('waiting', data); // { device }
      break;
    default:
      break;
  }
});

// ------------------------------------------------------------------- HTTP --

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) {
        req.destroy();
        reject(new Error('リクエストボディが大きすぎます'));
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('リクエストボディが不正なJSONです'));
      }
    });
    req.on('error', reject);
  });
}

function deviceFrom(u, body) {
  return (body && body.device) || u.searchParams.get('device') || null;
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    res.end(data);
  });
}

  const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // ------------------------------------------------------------- SSE ---
    if (u.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      sseSend(res, 'status', manager.statusPayload());
      for (const [id, a] of manager.adapters) {
        if (a.config && Object.keys(a.config).length) {
          sseSend(res, 'config', { device: id, data: a.config });
        }
      }
      sseClients.add(res);
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          clearInterval(hb);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(hb);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET') {
      if (u.pathname === '/api/build-info') {
        return sendJSON(res, 200, { ok: true, mode: 'local', build: BUILD_INFO });
      }
      if (u.pathname === '/api/status') {
        return sendJSON(res, 200, { ok: true, devices: manager.statusPayload() });
      }
      if (u.pathname === '/api/schema') {
        const schema = manager.schemaPayload(deviceFrom(u, null));
        return sendJSON(res, 200, { ok: true, schema });
      }
      if (u.pathname === '/api/config') {
        const a = manager.requireAdapter(deviceFrom(u, null));
        if (!a) return sendJSON(res, 503, { ok: false, error: 'デバイスに接続されていません' });
        if (a.config && Object.keys(a.config).length) {
          return sendJSON(res, 200, {
            ok: true,
            device: a.profile.id,
            config: a.config,
            devices: manager.statusPayload(),
          });
        }
        try {
          const cfg = await a.refreshConfig();
          return sendJSON(res, 200, { ok: true, device: a.profile.id, config: cfg, devices: manager.statusPayload() });
        } catch (e) {
          return sendJSON(res, 503, { ok: false, error: e.message });
        }
      }
      if (u.pathname === '/api/battery') {
        const a = manager.requireAdapter(deviceFrom(u, null));
        if (!a) return sendJSON(res, 503, { ok: false, error: 'デバイスに接続されていません' });
        try {
          const bat = await a.getBattery();
          return sendJSON(res, 200, { ok: true, battery: bat });
        } catch (e) {
          return sendJSON(res, 503, { ok: false, error: e.message });
        }
      }
      return serveStatic(res, u.pathname);
    }

    if (req.method === 'POST') {
      if (u.pathname === '/api/action') {
        const body = await readBody(req);
        const a = manager.requireAdapter(body.device);
        if (!a) return sendJSON(res, 503, { ok: false, error: 'デバイスに接続されていません' });
        if (!a.online) {
          return sendJSON(res, 503, {
            ok: false,
            error: 'マウスがオフラインです。マウスを動かしてスリープを解除してください。',
          });
        }
        try {
          await a.applyAction(body.action, body.args || {});
          return sendJSON(res, 200, { ok: true, device: a.profile.id, config: a.config, devices: manager.statusPayload() });
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: e.message });
        }
      }
      if (u.pathname === '/api/apply') {
        const body = await readBody(req);
        const a = manager.requireAdapter(body.device);
        if (!a) return sendJSON(res, 503, { ok: false, error: 'デバイスに接続されていません' });
        if (!a.online) {
          return sendJSON(res, 503, {
            ok: false,
            error: 'マウスがオフラインです。マウスを動かしてスリープを解除してください。',
          });
        }
        try {
          const cfg = await a.applySetting(body.setting, body.args || {});
          return sendJSON(res, 200, {
            ok: true,
            device: a.profile.id,
            config: cfg,
            devices: manager.statusPayload(),
          });
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: e.message });
        }
      }
      if (u.pathname === '/api/refresh') {
        const body = await readBody(req);
        const a = manager.requireAdapter(body.device);
        if (!a) return sendJSON(res, 503, { ok: false, error: 'デバイスに接続されていません' });
        try {
          const cfg = await a.refreshConfig();
          return sendJSON(res, 200, { ok: true, device: a.profile.id, config: cfg, devices: manager.statusPayload() });
        } catch (e) {
          return sendJSON(res, 503, { ok: false, error: e.message });
        }
      }
      if (u.pathname === '/api/reconnect') {
        const body = await readBody(req);
        const id = body.device;
        const a = id ? manager.adapters.get(id) : null;
        if (a) {
          a.gracefulClose();
          manager.adapters.delete(id);
        }
        const p = manager.profiles.find((x) => x.id === id);
        if (p) manager.connectProfile(p).catch(() => {});
        return sendJSON(res, 200, { ok: true, devices: manager.statusPayload() });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    try {
      sendJSON(res, 500, { ok: false, error: e.message });
    } catch (e2) {
      /* socket gone */
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${port} が使用中です。既に起動していませんか？ http://localhost:${port}`);
    if (!process.versions.electron) process.exit(1);
    return; // Electron: an existing instance/dev server keeps serving the UI
  }
  console.error('server error:', e);
});

server.listen(port, HOST, () => {
  if (!options.quiet) {
    console.log('===========================================================');
    console.log('  sktdr-mouse (プロファイル駆動・マルチデバイス)');
    console.log(`  対応プロファイル: ${profiles.map((p) => p.meta.name).join(', ')}`);
    console.log(`  ブラウザで http://localhost:${port} を開いてください`);
    console.log('===========================================================');
  }
  if (options.autoConnect !== false) {
    manager.connectAll().catch(() => {});
    manager.startWatcher();
  }
  if (!process.env.NO_BROWSER && !process.versions.electron && !options.quiet) {
    exec(`start "" "http://localhost:${port}"`, () => {});
  }
});

const onSignal = async () => {
  for (const a of manager.adapters.values()) {
    a.gracefulClose();
  }
  process.exit(0);
};
if (options.installSignalHandlers !== false && require.main === module) {
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

return { server, manager, port };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const modeIdx = argv.indexOf('--mode');
  const cliMode = modeIdx !== -1 ? argv[modeIdx + 1] : null;
  const isWebHid =
    argv.includes('--webhid') ||
    argv.includes('--mode=webhid') ||
    cliMode === 'webhid' ||
    process.env.SKTDR_MODE === 'webhid';
  if (isWebHid) {
    const { startWebHidServer, parseCliArgs, printUsage } = require('./webhid-server');
    let opts;
    try {
      opts = parseCliArgs(argv, process.env);
    } catch (e) {
      console.error(`[起動エラー] ${e.message}`);
      process.exit(1);
    }
    if (opts.help) {
      printUsage();
      process.exit(0);
    }
    startWebHidServer(opts);
  } else {
    startServer();
  }
}

module.exports = { startServer };
