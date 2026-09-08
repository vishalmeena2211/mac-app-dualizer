'use strict';
//
// platform.js — small helpers shared by the macOS and Windows code paths.
//
// Kept dependency-free and side-effect-free so it can be required from the CLI,
// the Electron main process, and the test suite alike.
//
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Badge colors, in the same order as the palette in clone-app.sh so a given
// clone name gets the same color on both platforms.
const PALETTE = [
  '#d97757',
  '#4f8ef7',
  '#56b877',
  '#e5686a',
  '#b06ff2',
  '#e0a83b',
  '#2bb3c0',
  '#e267a5',
];

/**
 * Lowercase, dash-separated, alphanumeric slug — used for bundle ids (macOS),
 * AppUserModelIDs (Windows), and file names.
 */
function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Deterministic badge color for a clone name.
 *
 * Mirrors `cksum` (CRC-32 with length terminator) from clone-app.sh so the same
 * name yields the same color on macOS and Windows.
 */
function tintFor(name) {
  return PALETTE[cksum(Buffer.from(String(name), 'utf8')) % PALETTE.length];
}

// POSIX cksum: CRC-32/CKSUM over the bytes, then over the length, big-endian.
function cksum(buf) {
  let crc = 0;
  const step = (byte) => {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    crc >>>= 0;
  };
  for (const b of buf) step(b);
  for (let len = buf.length; len > 0; len >>>= 8) step(len & 0xff);
  return (~crc) >>> 0;
}

/**
 * Where a clone with this name keeps its data.
 *
 * Matches Electron's default userData location on each platform, which is what
 * the injected snippet computes at runtime via app.getPath('appData').
 */
function dataDir(name, platform = process.platform) {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, name);
  }
  return path.join(os.homedir(), 'Library', 'Application Support', name);
}

/** Reject names that would break quoting or produce an invalid path. */
function validateName(name) {
  if (!name || !name.trim()) return 'clone name is required';
  if (/["'\\]/.test(name)) return 'clone name must not contain quotes or backslashes';
  if (/[<>:|?*/]/.test(name)) return 'clone name must not contain < > : | ? * or /';
  if (/[\x00-\x1f]/.test(name)) return 'clone name must not contain control characters';
  if (name !== name.trim()) return 'clone name must not start or end with whitespace';
  if (/[. ]$/.test(name)) return 'clone name must not end with a dot or space';
  // Reserved DOS device names — invalid as a directory name on Windows.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    return `"${name}" is a reserved Windows device name`;
  }
  if (slug(name).length === 0) return 'clone name must contain at least one letter or digit';
  return null;
}

/**
 * Delete a file or directory tree.
 *
 * Windows routinely fails a recursive delete with EBUSY/ENOTEMPTY/EPERM when a
 * virus scanner or a just-closed handle still holds a file open, so retries are
 * not optional there — an un-retried rmSync will intermittently blow up mid
 * clone, repair, or cleanup. Node only retries when asked.
 */
function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

module.exports = {
  IS_WINDOWS,
  IS_MAC,
  PALETTE,
  slug,
  tintFor,
  cksum,
  dataDir,
  validateName,
  rmrf,
};
