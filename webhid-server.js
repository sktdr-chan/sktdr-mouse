'use strict';

// =============================================================================
// sktdr-mouse — WebHID static & profile metadata server (no node-hid required)
//
// Serves the schema-driven UI (public/) plus browser-compatible core modules
// (/core/codec.js, /core/transport.js, /core/adapter.js) and device profiles
// (/api/profiles) so any visitor can configure their own mouse over WebHID
// directly from their browser without installing native drivers on the server.
//
// Usage:
//   node webhid-server.js [--port 3554] [--host 0.0.0.0] [--cert cert.pem --key key.pem]
// =============================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadProfiles } = require('./core/profile');
const { BUILD_INFO } = require('./core/build-info');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CORE_DIR = path.join(ROOT_DIR, 'core');

// Only browser-compatible core modules are exposed; node-hid / fs modules
// (manager.js, profile.js, build-info.js) are intentionally never served.
const CORE_WHITELIST = new Map([
  ['/core/codec.js', 'codec.js'],
  ['/core/transport.js', 'transport.js'],
  ['/core/adapter.js', 'adapter.js'],
]);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function printUsage() {
  console.log(`sktdr-mouse WebHID server

Usage:
  node webhid-server.js [options]

Options:
  --port, -p <number>    Listen port (default: env PORT or 3554)
  --host, -H <address>   Bind address (default: env HOST or 0.0.0.0)
  --cert <path>          TLS certificate PEM path (also env TLS_CERT / HTTPS_CERT)
  --key <path>           TLS private key PEM path (also env TLS_KEY / HTTPS_KEY)
  --ca <path>            Optional TLS CA bundle PEM path (also env TLS_CA)
  --devices-dir <path>   Custom device profiles directory (also env SKTDR_DEVICES_DIR)
  --help, -h             Show this help message`);
}

function parseCliArgs(argv = [], env = process.env) {
  const opts = {
    port: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 3554,
    host: env.HOST || '0.0.0.0',
    cert: env.TLS_CERT || env.HTTPS_CERT || null,
    key: env.TLS_KEY || env.HTTPS_KEY || null,
    ca: env.TLS_CA || null,
    devicesDir: env.SKTDR_DEVICES_DIR || null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--webhid') continue;

    let flag = arg;
    let val = null;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flag = arg.slice(0, eq);
      val = arg.slice(eq + 1);
    }

    const readNext = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length) throw new Error(`${flag} に値が必要です`);
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '--port':
      case '-p':
        opts.port = Number(readNext());
        break;
      case '--host':
      case '-H':
        opts.host = readNext();
        break;
      case '--cert':
        opts.cert = readNext();
        break;
      case '--key':
        opts.key = readNext();
        break;
      case '--ca':
        opts.ca = readNext();
        break;
      case '--devices-dir':
        opts.devicesDir = readNext();
        break;
      case '--mode':
        readNext();
        break;
      default:
        throw new Error(`不明なオプション: ${arg}`);
    }
  }

  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`ポート番号が不正です: ${opts.port}`);
  }
  if ((opts.cert && !opts.key) || (!opts.cert && opts.key)) {
    throw new Error('HTTPS を有効にするには --cert と --key の両方を指定してください');
  }
  return opts;
}

function sanitizeProfile(profile) {
  const copy = { ...profile };
  delete copy._file;
  return copy;
}

function buildSchemaPayload(profiles, deviceId) {
  const p = profiles.find((x) => x.id === deviceId) || profiles[0] || null;
  if (!p) return null;
  return {
    id: p.id,
    meta: p.meta,
    documentation: p._documentation || null,
    ui: p.ui,
    keepAwake: p.keepAwake || null,
  };
}

function securityHeaders() {
  return {
    'Permissions-Policy': 'hid=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

function sendJSON(res, code, obj, method = 'GET') {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

function serveFile(req, res, filePath, cacheControl = 'no-cache') {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, {
        ...securityHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(req.method === 'HEAD' ? undefined : 'not found');
      return;
    }

    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const reqIfNoneMatch = req.headers['if-none-match'];
    const baseHeaders = {
      ...securityHeaders(),
      'Content-Type': STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
    };

    if (reqIfNoneMatch && reqIfNoneMatch === etag) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, {
          ...securityHeaders(),
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end(req.method === 'HEAD' ? undefined : 'internal error');
        return;
      }
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

function startWebHidServer(options = {}) {
  const port = options.port !== undefined ? Number(options.port) : 3554;
  const host = options.host || '0.0.0.0';
  const devicesDir = options.devicesDir || undefined;
  const rawProfiles = loadProfiles(devicesDir);
  if (rawProfiles.length === 0) {
    console.error('[起動エラー] devices/ に有効なデバイスプロファイル (JSON) がありません。');
    if (options.exitOnError !== false && require.main === module) {
      process.exit(1);
    }
    throw new Error('有効なデバイスプロファイルがありません');
  }
  const publicProfiles = rawProfiles.map(sanitizeProfile);

  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        ...securityHeaders(),
        Allow: 'GET, HEAD',
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
      return;
    }

    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'Bad Request' }, req.method);
    }

    let pathname;
    try {
      pathname = decodeURIComponent(u.pathname);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'Bad Request' }, req.method);
    }

    if (pathname === '/api/build-info') {
      return sendJSON(res, 200, { ok: true, mode: 'webhid', build: BUILD_INFO }, req.method);
    }
    if (pathname === '/api/profiles') {
      return sendJSON(res, 200, { ok: true, profiles: publicProfiles }, req.method);
    }
    if (pathname === '/api/schema') {
      const schema = buildSchemaPayload(rawProfiles, u.searchParams.get('device'));
      return sendJSON(res, 200, { ok: true, schema }, req.method);
    }
    if (pathname === '/api/health') {
      return sendJSON(
        res,
        200,
        {
          ok: true,
          mode: 'webhid',
          profiles: rawProfiles.length,
          uptime: Math.floor(process.uptime()),
        },
        req.method
      );
    }

    if (pathname.startsWith('/core/')) {
      const file = CORE_WHITELIST.get(pathname);
      if (!file) {
        res.writeHead(404, {
          ...securityHeaders(),
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end(req.method === 'HEAD' ? undefined : 'not found');
        return;
      }
      return serveFile(req, res, path.join(CORE_DIR, file), 'no-cache');
    }

    if (pathname === '/favicon.ico') {
      const fav = path.join(PUBLIC_DIR, 'favicon.ico');
      return fs.stat(fav, (err, st) => {
        if (!err && st.isFile()) return serveFile(req, res, fav);
        res.writeHead(204, securityHeaders());
        res.end();
      });
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, {
        ...securityHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(req.method === 'HEAD' ? undefined : 'forbidden');
      return;
    }

    return serveFile(req, res, resolved, 'no-cache');
  };

  let isHttps = false;
  let server;
  if (options.cert && options.key) {
    isHttps = true;
    const tlsOpts = {
      cert: fs.readFileSync(options.cert),
      key: fs.readFileSync(options.key),
    };
    if (options.ca) tlsOpts.ca = fs.readFileSync(options.ca);
    server = https.createServer(tlsOpts, handler);
  } else {
    server = http.createServer(handler);
  }

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`ポート ${port} が使用中です。別のポートを --port または PORT で指定してください。`);
    } else {
      console.error('webhid-server error:', e);
    }
    if (options.exitOnError !== false && require.main === module) {
      process.exit(1);
    }
  });

  server.listen(port, host, () => {
    if (options.quiet) return;
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    const proto = isHttps ? 'https' : 'http';
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log('===========================================================');
    console.log('  sktdr-mouse WebHID Server (クライアント側 WebHID 接続)');
    console.log(`  待ち受け: ${proto}://${host}:${actualPort}`);
    console.log(`  アクセスURL: ${proto}://${displayHost}:${actualPort}`);
    console.log(`  対応プロファイル (${rawProfiles.length}): ${rawProfiles.map((p) => p.meta.name).join(', ')}`);
    if (!isHttps) {
      console.log('  [注意] WebHID はセキュアコンテキストが必須です。');
      console.log('         localhost 以外からアクセスする場合は HTTPS リバースプロキシ');
      console.log('         または --cert / --key オプションを使用してください。');
    }
    console.log('===========================================================');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  if (options.installSignalHandlers !== false && require.main === module) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  return { server, profiles: rawProfiles, port, host, isHttps };
}

if (require.main === module) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(`[起動エラー] ${e.message}`);
    process.exit(1);
  }
  if (opts.help) {
    printUsage();
    process.exit(0);
  }
  startWebHidServer(opts);
}

module.exports = { startWebHidServer, parseCliArgs, sanitizeProfile, buildSchemaPayload, printUsage };
