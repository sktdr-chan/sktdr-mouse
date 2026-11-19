'use strict';

// =============================================================================
// Publish the built Windows distribution to a Forgejo release.
//
// Local usage (no CI):
//   set FORGEJO_TOKEN=<personal access token with write:repository>
//   npm run dist
//   node scripts/publish-release.js --tag v1.0.0
//
// In Forgejo Actions the automatic token is available as GITHUB_TOKEN and the
// repository/server/commit come from GITHUB_REPOSITORY / GITHUB_SERVER_URL /
// GITHUB_SHA, so the workflow only has to choose the tag.
//
// Behaviour:
//   * creates the release if missing, otherwise updates its name/body
//   * replaces assets with the same name (idempotent re-runs)
//   * uploads the zip + .sha256 via curl (streams the file, no 100MB in RAM)
//   * for the rolling "latest" channel the asset name is fixed so the
//     download URL never changes
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const distDir = path.join(root, 'dist');

// Written by scripts/build-dist.js: commit id + generated file names.
let buildInfo = null;
try {
  buildInfo = JSON.parse(fs.readFileSync(path.join(distDir, 'build-info.json'), 'utf8'));
} catch (e) {
  /* older builds have no build-info.json */
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dryRun = !!arg('dry-run');

function git(cmd) {
  try {
    return execFileSync('git', cmd, { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

function inferRepo() {
  const envRepo = process.env.FORGEJO_REPOSITORY || process.env.GITHUB_REPOSITORY;
  if (envRepo) return envRepo;
  const remote = git(['remote', 'get-url', 'origin']);
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return m ? m[1] : '';
}

const server = String(
  arg('server') || process.env.FORGEJO_SERVER_URL || process.env.GITHUB_SERVER_URL || 'https://forgejo.pw2.org'
).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const repo = String(arg('repo') || inferRepo());
const token = String(arg('token') || process.env.FORGEJO_TOKEN || process.env.GITHUB_TOKEN || '');
const commit =
  String(arg('commit') || process.env.GITHUB_SHA || process.env.FORGEJO_SHA || '') || git(['rev-parse', 'HEAD']);
const refType = process.env.GITHUB_REF_TYPE || process.env.FORGEJO_REF_TYPE || '';
const refName = process.env.GITHUB_REF_NAME || process.env.FORGEJO_REF_NAME || '';
const tag = String(arg('tag') || (refType === 'tag' ? refName : 'latest'));

const zipPath = String(
  arg('zip') ||
    (buildInfo && buildInfo.zip
      ? path.join(distDir, buildInfo.zip)
      : path.join(distDir, `sktdr-mouse-${pkg.version}-win64.zip`))
);
const shaPath = zipPath + '.sha256';

function die(msg) {
  console.error(`[publish] ${msg}`);
  process.exit(1);
}

if (!repo) die('repository not specified (--repo owner/name or GITHUB_REPOSITORY)');
if (!fs.existsSync(zipPath)) die(`build not found: ${path.relative(root, zipPath)} — run: npm run dist`);
if (!dryRun && !token) {
  die(
    'FORGEJO_TOKEN is required.\n' +
      '  Forgejo: Settings → Applications → Generate token (scope: write:repository)\n' +
      '  Then:    $env:FORGEJO_TOKEN="..." ; node scripts/publish-release.js --tag v' +
      pkg.version
  );
}

const api = `${server}/api/v1/repos/${repo}`;
const zipSize = fs.statSync(zipPath).size;
const shortSha = (buildInfo && buildInfo.shortCommit) || (commit ? commit.slice(0, 7) : 'unknown');
const buildLabel = (buildInfo && buildInfo.label) || shortSha;
const isLatest = tag === 'latest';

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

const hash = sha256(zipPath);
// Commit id is part of the file name; the tag release also carries its tag.
const assetName = isLatest
  ? (buildInfo && buildInfo.zip) || path.basename(zipPath)
  : `sktdr-mouse-${tag}-${buildLabel}-win64.zip`;
const shaName = `${assetName}.sha256`;

const commitUrl = commit ? `${server}/${repo}/commit/${commit}` : '';
const body = [
  isLatest
    ? `## sktdr-mouse 最新ビルド（main / ${shortSha}）`
    : `## sktdr-mouse ${tag}（${shortSha}）`,
  '',
  commitUrl ? `- コミット: [\`${shortSha}\`](${commitUrl})` : `- コミット: \`${shortSha}\``,
  ...(isLatest ? [] : [`- タグ: ${tag}`]),
  `- ビルド日時: ${(buildInfo && buildInfo.builtAt) || new Date().toISOString()}`,
  '- 対象: Windows 10/11 x64（インストール不要）',
  '',
  '### 使い方',
  '1. `' + assetName + '` をダウンロード',
  '2. ZIPを展開',
  '3. `sktdr-mouse.exe` をダブルクリック',
  '',
  '### チェックサム',
  '```',
  `${hash}  ${assetName}`,
  '```',
  '',
  '### 免責事項',
  '本ソフトは非公式・無保証です。Razer / VXE / Compx / Scyrox / Lamzu / Logitech / ROCCAT / Darmoshark 等の各社とは関係ありません。',
  '設定の書き込みは自己責任で行ってください。詳細はZIP内の `DISCLAIMER.md` を参照してください。',
  '',
  '> 署名はしていません。SmartScreenの警告が出る場合は「詳細情報」→「実行」を選択してください。',
  '> 展開先のEXEを改変・再署名すると Smart App Control にブロックされる場合があります。',
  '',
].join('\n');

const releaseName = isLatest
  ? `Latest build (main / ${shortSha})`
  : `sktdr-mouse ${tag} (${shortSha})`;

async function apiCall(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/json',
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function upload(assetUrl, file) {
  const args = [
    '--fail',
    '--silent',
    '--show-error',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '-X',
    'POST',
    assetUrl,
    '-H',
    `Authorization: token ${token}`,
    '-F',
    `attachment=@${file}`,
  ];
  try {
    execFileSync('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    if (/413|too large|request entity/i.test(stderr)) {
      die(
        `upload rejected (probably the instance attachment size limit).\n${stderr}\n` +
          'Raise [attachment] MAX_SIZE in app.ini (Forgejo administrator), or host the ZIP elsewhere.'
      );
    }
    die(`upload failed: ${stderr || e.message}`);
  }
}

async function main() {
  console.log(`[publish] ${repo} @ ${tag} (commit ${shortSha}, ${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[publish] asset: ${assetName}`);
  console.log(`[publish] sha256: ${hash}`);

  if (dryRun) {
    console.log('[publish] dry-run: no API calls performed');
    return;
  }

  let release = null;
  try {
    release = await apiCall('GET', `${api}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  if (!release) {
    console.log('[publish] creating release…');
    release = await apiCall('POST', `${api}/releases`, {
      tag_name: tag,
      name: releaseName,
      body,
      draft: false,
      prerelease: false,
      target_commitish: commit || undefined,
    });
  } else {
    console.log(`[publish] updating existing release (id ${release.id})…`);
    release = await apiCall('PATCH', `${api}/releases/${release.id}`, {
      name: releaseName,
      body,
    });
  }

  const assets = await apiCall('GET', `${api}/releases/${release.id}/assets`);
  // Asset names contain the commit, so also remove assets from older builds.
  const isOurAsset = (name) =>
    name === assetName ||
    name === shaName ||
    /^sktdr-mouse-.*-win64\.zip(?:\.sha256)?$/.test(name) ||
    name === 'sktdr-mouse-win64.zip' ||
    name === 'sktdr-mouse-win64.zip.sha256';
  for (const a of assets || []) {
    if (isOurAsset(a.name)) {
      console.log(`[publish] replacing old asset: ${a.name}`);
      await apiCall('DELETE', `${api}/releases/${release.id}/assets/${a.id}`);
    }
  }

  // Recreate the checksum file with the published (possibly renamed) asset name.
  fs.writeFileSync(shaPath, `${hash}  ${assetName}\n`);

  console.log('[publish] uploading zip…');
  upload(`${api}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, zipPath);
  console.log('[publish] uploading checksum…');
  upload(`${api}/releases/${release.id}/assets?name=${encodeURIComponent(shaName)}`, shaPath);

  console.log(`[publish] done: ${server}/${repo}/releases/tag/${encodeURIComponent(tag)}`);
}

main().catch((e) => {
  console.error('[publish] failed:', e.message || e);
  process.exit(1);
});
