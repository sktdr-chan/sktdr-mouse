'use strict';

// =============================================================================
// core/build-info.js — shared build metadata helper used by both server.js
// (standalone/local mode) and webhid-server.js (WebHID server mode).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');

function getBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'build-info.json'), 'utf8'));
  } catch (e) {
    /* development */
  }
  const pkg = require(path.join(ROOT_DIR, 'package.json'));
  const info = {
    version: pkg.version,
    commit: '',
    shortCommit: 'dev',
    label: 'dev',
    dirty: false,
    builtAt: null,
    electron: process.versions.electron || null,
  };
  try {
    const gitOpts = { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    info.commit = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).trim();
    info.dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], gitOpts).trim() !== '';
    info.shortCommit = info.commit.slice(0, 7);
    info.label = info.dirty ? `${info.shortCommit}-dirty` : info.shortCommit;
  } catch (e) {
    /* not a git checkout */
  }
  return info;
}

const BUILD_INFO = getBuildInfo();

module.exports = { getBuildInfo, BUILD_INFO };
