'use strict';

// =============================================================================
// Build the folder distribution of sktdr-mouse (Electron binary + app.asar).
//
// Rationale: electron-builder's generated exe is a *modified* copy of
// electron.exe, so on machines with Smart App Control enabled
// (HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy → VerifiedAndReputablePolicyState = 1)
// it loses the known-good reputation and is blocked with
// "アプリケーション制御ポリシーによってブロックされました".
//
// This script instead reuses the pristine electron.exe from node_modules
// (byte-identical to the official build) and drops the app next to it as
// resources/app.asar — exactly the layout Electron expects. The only change is
// the file name, which does not affect SAC's hash-based reputation check.
//
// Output:
//   dist/sktdr-mouse-<version>-win64/      (run sktdr-mouse.exe)
//   dist/sktdr-mouse-<version>-win64.zip   (distribution archive)
//
// Run via `npm run dist` (which first packages dist/win-unpacked with
// `electron-builder --win --dir`).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const unpacked = path.join(root, 'dist', 'win-unpacked');
const outDir = path.join(root, 'dist', `sktdr-mouse-${pkg.version}-win64`);
const zipPath = path.join(root, 'dist', `sktdr-mouse-${pkg.version}-win64.zip`);
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const VERSION = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;

function fail(msg) {
  console.error(`[folder-build] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) fail('node_modules/electron/dist is missing — run npm install');
if (!fs.existsSync(path.join(unpacked, 'resources', 'app.asar'))) {
  fail('dist/win-unpacked/resources/app.asar is missing — run: npx electron-builder --win --dir');
}

console.log(`[folder-build] copying Electron runtime → ${path.relative(root, outDir)}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(electronDist, outDir, { recursive: true });

// The app itself (asar + unpacked native module). Electron looks for
// resources/app.asar automatically, so electron.exe is not patched at all.
const res = path.join(outDir, 'resources');
fs.copyFileSync(path.join(unpacked, 'resources', 'app.asar'), path.join(res, 'app.asar'));
fs.cpSync(
  path.join(unpacked, 'resources', 'app.asar.unpacked'),
  path.join(res, 'app.asar.unpacked'),
  { recursive: true }
);

// Rename only — the bytes stay identical to the official electron.exe, so the
// SAC reputation check still matches.
fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'sktdr-mouse.exe'));

// ---------------------------------------------------------------- licenses --
// MIT redistribution requires keeping copyright + permission notices. Electron
// already ships LICENSE and LICENSES.chromium.html in its dist; add the
// project license and the licenses of the bundled Node modules.
const licDir = path.join(outDir, 'licenses');
fs.mkdirSync(licDir, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(licDir, 'sktdr-mouse-LICENSE.txt'));

function copyLic(moduleName, file, targetName) {
  const src = path.join(root, 'node_modules', moduleName, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(licDir, targetName));
}
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
    'https://github.com/sktdr/sktdr-mouse',
    '',
    `Electron ${VERSION}`,
    'License: MIT',
    'https://github.com/electron/electron/blob/main/LICENSE',
    'The full license text is included as ../LICENSE.electron.txt (Electron dist).',
    '',
    'Chromium and other third-party libraries bundled with Electron',
    'Licenses: see ../LICENSES.chromium.html (shipped by Electron).',
    '',
    'node-hid 3.4.0',
    'License: MIT OR X11 (bundles hidapi, dual-licensed BSD-3-Clause / GPL-3.0)',
    'https://github.com/node-hid/node-hid',
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

// Electron's dist ships its license under the name "LICENSE". Keep the
// project's own LICENSE at the root, and preserve Electron's text separately.
const electronLicense = path.join(outDir, 'LICENSE');
if (fs.existsSync(electronLicense)) {
  fs.renameSync(electronLicense, path.join(outDir, 'LICENSE.electron.txt'));
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));

fs.writeFileSync(
  path.join(outDir, '起動方法.txt'),
  [
    'sktdr-mouse — フォルダ版（Smart App Control 対応）',
    '',
    '1. このフォルダを任意の場所に置きます（インストール不要）。',
    '2.「sktdr-mouse.exe」をダブルクリックして起動します。',
    '   ※ electron.exe を改名しただけのファイルなので、署名状態は公式 Electron と同一です。',
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

console.log('[folder-build] creating zip…');
fs.rmSync(zipPath, { force: true });
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', zipPath, '.'], {
  cwd: outDir,
  stdio: 'inherit',
});

// Keep dist/ limited to the two deliverables (folder + zip).
fs.rmSync(unpacked, { recursive: true, force: true });
fs.rmSync(path.join(root, 'dist', 'builder-debug.yml'), { force: true });

const zipMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`[folder-build] done: ${path.relative(root, zipPath)} (${zipMb} MB)`);
