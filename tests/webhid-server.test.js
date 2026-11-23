'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startWebHidServer, parseCliArgs } = require('../webhid-server');

/**
 * Dispatch an HTTP request directly to the live http.Server's 'request'
 * listener so tests verify real routing, headers, ETag/304, and static file
 * serving even inside network-isolated sandboxes where loopback connect() is
 * blocked with EACCES.
 */
function dispatchRequest(server, reqPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: reqPath,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      ),
    };
    let status = 200;
    const resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, hdrs = {}) {
        status = code;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
        return res;
      },
      write(chunk) {
        if (chunk != null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        return true;
      },
      end(chunk) {
        if (chunk != null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        resolve({
          status,
          headers: resHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      },
    };
    server.emit('request', req, res);
  });
}

test('webhid-server does not require or load node-hid', () => {
  const loadedKeys = Object.keys(require.cache);
  assert.equal(
    loadedKeys.some((k) => k.includes(`${path.sep}node-hid${path.sep}`)),
    false,
    'node-hid must not be loaded by webhid-server'
  );
});

test('parseCliArgs handles options and validates TLS/port inputs', () => {
  const def = parseCliArgs([], {});
  assert.equal(def.port, 3554);
  assert.equal(def.host, '0.0.0.0');

  const custom = parseCliArgs(
    ['--port', '8443', '--host=127.0.0.1', '--cert', 'cert.pem', '--key', 'key.pem'],
    {}
  );
  assert.equal(custom.port, 8443);
  assert.equal(custom.host, '127.0.0.1');
  assert.equal(custom.cert, 'cert.pem');
  assert.equal(custom.key, 'key.pem');

  assert.throws(() => parseCliArgs(['--cert', 'only.pem'], {}), /--cert.*--key/);
  assert.throws(() => parseCliArgs(['--port', '99999'], {}), /ポート/);
});

test('webhid-server serves UI, whitelisted core modules, and profile APIs with security headers', async (t) => {
  const { server } = startWebHidServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    installSignalHandlers: false,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.ok(server.address().port > 0);

  // Root HTML + WebHID permissions policy
  const rootRes = await dispatchRequest(server, '/');
  assert.equal(rootRes.status, 200);
  assert.equal(rootRes.headers['permissions-policy'], 'hid=(self)');
  assert.equal(rootRes.headers['x-content-type-options'], 'nosniff');
  assert.equal(rootRes.headers['referrer-policy'], 'same-origin');
  assert.equal(rootRes.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(rootRes.body, /sktdr-mouse/);

  // HEAD request
  const headRes = await dispatchRequest(server, '/', { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.body, '');

  // ETag 304
  const etag = rootRes.headers.etag;
  assert.ok(etag);
  const notMod = await dispatchRequest(server, '/', { headers: { 'If-None-Match': etag } });
  assert.equal(notMod.status, 304);

  // /api/build-info -> mode: webhid
  const buildRes = await dispatchRequest(server, '/api/build-info');
  assert.equal(buildRes.status, 200);
  assert.equal(buildRes.headers['cache-control'], 'no-store');
  const buildJson = JSON.parse(buildRes.body);
  assert.equal(buildJson.ok, true);
  assert.equal(buildJson.mode, 'webhid');
  assert.ok(buildJson.build && buildJson.build.version);

  // /api/profiles
  const profRes = await dispatchRequest(server, '/api/profiles');
  assert.equal(profRes.status, 200);
  const profJson = JSON.parse(profRes.body);
  assert.equal(profJson.ok, true);
  assert.ok(Array.isArray(profJson.profiles));
  assert.ok(profJson.profiles.length >= 8);
  assert.equal(profJson.profiles[0]._file, undefined);

  // /api/schema
  const schemaRes = await dispatchRequest(server, '/api/schema?device=darmoshark-m5');
  assert.equal(schemaRes.status, 200);
  const schemaJson = JSON.parse(schemaRes.body);
  assert.equal(schemaJson.ok, true);
  assert.equal(schemaJson.schema.id, 'darmoshark-m5');

  // /api/health
  const healthRes = await dispatchRequest(server, '/api/health');
  assert.equal(healthRes.status, 200);
  const healthJson = JSON.parse(healthRes.body);
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.mode, 'webhid');

  // Whitelisted core files + public/webhid.js
  for (const p of ['/core/codec.js', '/core/transport.js', '/core/adapter.js', '/webhid.js', '/app.js']) {
    const r = await dispatchRequest(server, p);
    assert.equal(r.status, 200, `${p} should return 200`);
    assert.match(r.headers['content-type'], /javascript/);
  }

  // Non-whitelisted core files and path traversal must be blocked
  for (const blocked of [
    '/core/manager.js',
    '/core/profile.js',
    '/core/build-info.js',
    '/package.json',
    '/../package.json',
    '/%2e%2e/package.json',
  ]) {
    const r = await dispatchRequest(server, blocked);
    assert.ok(r.status === 403 || r.status === 404, `${blocked} must be blocked, got ${r.status}`);
  }

  // Unsupported HTTP method
  const postRes = await dispatchRequest(server, '/api/apply', { method: 'POST' });
  assert.equal(postRes.status, 405);
});

test('standalone server.js remains backward-compatible and exposes mode=local', async (t) => {
  process.env.NO_BROWSER = '1';
  const { startServer } = require('../server');
  const { server, manager } = startServer(0, {
    autoConnect: false,
    quiet: true,
    installSignalHandlers: false,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    if (manager._watchTimer) clearInterval(manager._watchTimer);
    for (const a of manager.adapters.values()) a.gracefulClose();
    await new Promise((resolve) => server.close(resolve));
  });

  assert.ok(server.address().port > 0);
  const buildRes = await dispatchRequest(server, '/api/build-info');
  assert.equal(buildRes.status, 200);
  const buildJson = JSON.parse(buildRes.body);
  assert.equal(buildJson.ok, true);
  assert.equal(buildJson.mode, 'local');

  const statusRes = await dispatchRequest(server, '/api/status');
  assert.equal(statusRes.status, 200);
  const statusJson = JSON.parse(statusRes.body);
  assert.equal(statusJson.ok, true);
  assert.ok(Array.isArray(statusJson.devices));
});
