'use strict';

// =============================================================================
// Build the Windows "folder" distribution of sktdr-mouse.
//
//   dist/sktdr-mouse-<version>-win64/           folder to run (sktdr-mouse.exe)
//   dist/sktdr-mouse-<version>-win64.zip        distribution archive
//   dist/sktdr-mouse-<version>-win64.zip.sha256 checksum
//
// The exe is the official electron.exe, byte-for-byte unmodified (only the
// file name changes), so Smart App Control's hash-based reputation still
// matches and the app is not blocked. The application itself is packed into
// resources/app.asar, exactly like Electron expects.
//
// This intentionally does NOT use electron-builder:
//   * electron-builder's exe is a modified electron.exe → blocked by SAC
//   * building on Linux then needs wine; here we only download the official
//     win32-x64 Electron zip and reuse it as-is (CI-friendly)
//
// Usage: npm run dist
//   On Windows the local node_modules/electron/dist is reused.
//   On Linux/macOS the win32-x64 zip is downloaded via @electron/get.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;

// The 7zip-bin npm tarball ships the Linux binary with mode 0644 (no execute
// bit), so spawning it fails with EACCES on Linux. Fix the mode, and if the
// binary still cannot run (e.g. a noexec mount), use an executable copy in /tmp.
let sevenZip = require('7zip-bin').path7za;
if (process.platform !== 'win32') {
  try {
    fs.chmodSync(sevenZip, 0o755);
  } catch (e) {
    /* read-only node_modules: the copy below will be used */
  }
  try {
    execFileSync(sevenZip, ['i'], { stdio: 'ignore' });
  } catch (e) {
    const tmp = path.join(os.tmpdir(), `sktdr-mouse-7za-${process.pid}-${Date.now()}`);
    fs.copyFileSync(sevenZip, tmp);
    fs.chmodSync(tmp, 0o755);
    sevenZip = tmp;
  }
}

const distDir = path.join(root, 'dist');

// Use the source commit as the build version (package.json's 1.0.0 is just a
// base version). In CI GITHUB_SHA identifies the checkout; locally we ask git.
function gitOut(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    return '';
  }
}
const envCommit = (process.env.GITHUB_SHA || process.env.FORGEJO_SHA || '').trim();
const fullCommit = envCommit || gitOut(['rev-parse', 'HEAD']) || '';
const shortCommit = fullCommit ? fullCommit.slice(0, 7) : 'nocommit';
// A local build with uncommitted changes gets a -dirty marker; CI is clean.
const dirty = !envCommit && gitOut(['status', '--porcelain', '--untracked-files=no']) !== '';
const buildLabel = dirty ? `${shortCommit}-dirty` : shortCommit;

const folderName = `sktdr-mouse-${buildLabel}-win64`;
const outDir = path.join(distDir, folderName);
const zipPath = path.join(distDir, `${folderName}.zip`);
const shaPath = zipPath + '.sha256';
const buildInfoPath = path.join(distDir, 'build-info.json');
const stagingDir = path.join(distDir, '.staging');

// application files (same set the app needs at runtime)
const APP_FILES = ['server.js', 'package.json', 'core', 'devices', 'public', 'electron'];
// production dependencies required at runtime by node-hid
const APP_MODULES = ['node-hid', 'pkg-prebuilds', 'node-addon-api'];

function log(msg) {
  console.log(`[dist] ${msg}`);
}
function fail(msg) {
  console.error(`[dist] ${msg}`);
  process.exit(1);
}

async function resolveElectronDist() {
  const local = path.join(root, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(path.join(local, 'electron.exe'))) {
    log(`using local Electron runtime (${electronVersion})`);
    return local;
  }

  // Cache outside dist/ so the distribution folder stays clean.
  const cacheDir = path.join(
    root,
    'node_modules',
    '.cache',
    'sktdr-mouse',
    `electron-v${electronVersion}-win32-x64`
  );
  if (fs.existsSync(path.join(cacheDir, 'electron.exe'))) {
    log(`using cached Electron ${electronVersion} (win32-x64)`);
    return cacheDir;
  }

  log(`downloading Electron ${electronVersion} for win32-x64…`);
  const { downloadArtifact } = require('@electron/get');
  const zip = await downloadArtifact({
    version: electronVersion,
    platform: 'win32',
    arch: 'x64',
    artifactName: 'electron',
  });
  log(`extracting ${path.basename(zip)}`);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  execFileSync(sevenZip, ['x', zip, `-o${cacheDir}`, '-y', '-bd'], { stdio: 'inherit' });
  return cacheDir;
}

function stageApp() {
  log('staging application files…');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const name of APP_FILES) {
    const src = path.join(root, name);
    if (!fs.existsSync(src)) fail(`missing application file: ${name}`);
    fs.cpSync(src, path.join(stagingDir, name), { recursive: true });
  }

  const nm = path.join(stagingDir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  for (const dep of APP_MODULES) {
    const src = path.join(root, 'node_modules', dep);
    if (!fs.existsSync(src)) fail(`missing dependency: ${dep} (run npm install)`);
    fs.cpSync(src, path.join(nm, dep), { recursive: true });
  }
}

function writeLicenses() {
  // Electron's own LICENSE arrives with the runtime copy; keep it under a
  // distinct name so the project's LICENSE can live at the root.
  const electronLicense = path.join(outDir, 'LICENSE');
  if (fs.existsSync(electronLicense)) {
    fs.renameSync(electronLicense, path.join(outDir, 'LICENSE.electron.txt'));
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));

  const licDir = path.join(outDir, 'licenses');
  fs.mkdirSync(licDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(licDir, 'sktdr-mouse-LICENSE.txt'));

  const copyLic = (mod, file, target) => {
    const src = path.join(root, 'node_modules', mod, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(licDir, target));
  };
  copyLic('node-hid', 'LICENSE-bsd.txt', 'node-hid-LICENSE-bsd.txt');
  copyLic('pkg-prebuilds', 'LICENSE', 'pkg-prebuilds-LICENSE.txt');
  copyLic('node-addon-api', 'LICENSE.md', 'node-addon-api-LICENSE.md');

  fs.writeFileSync(
    path.join(licDir, 'THIRD_PARTY_NOTICES.txt'),
    [
      'sktdr-mouse — third-party components',
      '=====================================',
      '',
      `sktdr-mouse ${pkg.version}`,
      'License: MIT (see ../LICENSE)',
      '',
      `Electron ${electronVersion}`,
      'License: MIT',
      'The full license text is included as ../LICENSE.electron.txt.',
      '',
      'Chromium and other third-party libraries bundled with Electron',
      'Licenses: see ../LICENSES.chromium.html (shipped by Electron).',
      '',
      'node-hid 3.4.0',
      'License: MIT OR X11 (bundles hidapi, dual-licensed BSD-3-Clause / GPL-3.0)',
      'See node-hid-LICENSE-bsd.txt; hidapi license files are also shipped under',
      'resources/app.asar.unpacked/node_modules/node-hid/hidapi/.',
      '',
      'pkg-prebuilds 1.1.0 — License: MIT (see pkg-prebuilds-LICENSE.txt)',
      'node-addon-api 8.9.2 — License: MIT (see node-addon-api-LICENSE.md)',
      '',
      'Note: "Electron" is a trademark of the Electron contributors / GitHub Inc.',
      'This application is an independent project and is not endorsed by or',
      'affiliated with the Electron project, OpenJS Foundation, or GitHub.',
      '',
    ].join('\r\n')
  );

  fs.writeFileSync(
    path.join(outDir, '起動方法.txt'),
    [
      'sktdr-mouse — フォルダ版（Smart App Control 対応）',
      '',
      '1. このフォルダを任意の場所に置きます（インストール不要）。',
      '2.「sktdr-mouse.exe」をダブルクリックして起動します。',
      '',
      '・設定キャッシュ: %APPDATA%\\sktdr-mouse\\data',
      '・使用ポート: http://localhost:3554（起動中は内部サーバーが動きます）',
      '・アンインストール: このフォルダを丸ごと削除してください。',
      '・ライセンス: LICENSE（本アプリ, MIT） / LICENSE.electron.txt /',
      '  LICENSES.chromium.html / licenses\\（依存ライブラリ）',
      '',
      '注意: このフォルダ内のファイルを個別に改変・再署名すると Smart App Control に',
      'ブロックされる可能性があります。更新する場合はフォルダごと差し替えてください。',
      '',
    ].join('\r\n')
  );
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function main() {
  const electronDist = await resolveElectronDist();

  log(`building ${path.relative(root, outDir)}`);
  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(electronDist, outDir, { recursive: true });

  stageApp();

  // Pack the app, unpacking node-hid (its native .node must live on disk).
  const asarPath = path.join(outDir, 'resources', 'app.asar');
  log('packing app.asar…');
  await asar.createPackageWithOptions(stagingDir, asarPath, {
    // platform-specific separators: asar compares this against relative paths
    unpackDir: path.join('node_modules', 'node-hid'),
  });
  if (!fs.existsSync(path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-hid'))) {
    fail('app.asar.unpacked/node_modules/node-hid was not created');
  }

  // Rename only: keeps the official electron.exe bytes (SAC reputation).
  fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'sktdr-mouse.exe'));

  writeLicenses();

  log('creating zip…');
  fs.rmSync(zipPath, { force: true });
  // Windows Defender occasionally holds a freshly written app.asar open for a
  // moment; retry instead of failing the whole build.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(sevenZip, ['a', '-tzip', '-mx=5', zipPath, '.'], {
        cwd: outDir,
        stdio: 'inherit',
      });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`zip failed (attempt ${attempt}/3), retrying…`);
      fs.rmSync(zipPath, { force: true }); // don't keep a partial archive
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const hash = await sha256(zipPath);
  fs.writeFileSync(shaPath, `${hash}  ${path.basename(zipPath)}\r\n`);

  // Metadata consumed by scripts/publish-release.js (commit id, asset names).
  fs.writeFileSync(
    buildInfoPath,
    JSON.stringify(
      {
        version: pkg.version,
        commit: fullCommit,
        shortCommit,
        dirty,
        label: buildLabel,
        builtAt: new Date().toISOString(),
        folder: folderName,
        zip: path.basename(zipPath),
        sha256: hash,
      },
      null,
      2
    ) + '\n'
  );

  fs.rmSync(stagingDir, { recursive: true, force: true });
  // left over from older electron-builder builds
  fs.rmSync(path.join(distDir, 'win-unpacked'), { recursive: true, force: true });

  // keep only the current build (old commit-named folders/zips would pile up)
  const keep = new Set([
    folderName,
    path.basename(zipPath),
    path.basename(shaPath),
    path.basename(buildInfoPath),
  ]);
  for (const name of fs.readdirSync(distDir)) {
    if (keep.has(name)) continue;
    if (/^sktdr-mouse-.*-win64(?:\.zip(?:\.sha256)?)?$/.test(name)) {
      fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
    }
  }

  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  log(`build: ${buildLabel}${fullCommit ? ` (${fullCommit.slice(0, 12)})` : ''}`);
  log(`done: ${path.relative(root, zipPath)} (${mb} MB)`);
  log(`sha256: ${hash}`);
}

main().catch((e) => {
  console.error('[dist] failed:', e);
  process.exit(1);
});
