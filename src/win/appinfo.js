'use strict';
//
// appinfo.js — work out what a Windows app is before we clone it.
//
// A Windows install has no Info.plist, so the equivalent metadata (product name,
// version, publisher) lives in the executable's VS_VERSIONINFO resource. We read
// it straight out of the PE rather than shelling out to PowerShell, which keeps
// this testable off-Windows and avoids a process launch per inspection.
//
const fs = require('node:fs');
const path = require('node:path');
const { parsePe, collectType, RT_VERSION } = require('./pe');

// Bundled helpers that ship alongside an Electron app but are never the app.
const NOT_THE_APP = [
  /^update\.exe$/i,
  /^squirrel\.exe$/i,
  /^unins.*\.exe$/i,
  /^vcredist.*\.exe$/i,
  /^elevate\.exe$/i,
  /^notification_helper\.exe$/i,
  /_helper\.exe$/i,
];

/**
 * Parse a VS_VERSIONINFO tree into { key: value } strings.
 *
 * The format is a recursively nested set of length-prefixed nodes with
 * UTF-16 keys, each padded to a 4-byte boundary. Returns {} if anything looks
 * malformed — version strings are cosmetic, never worth throwing over.
 */
function parseVersionInfo(buf) {
  const out = {};
  const align4 = (n) => (n + 3) & ~3;

  const readNode = (off, end) => {
    if (off + 6 > end) return null;
    const wLength = buf.readUInt16LE(off);
    const wValueLength = buf.readUInt16LE(off + 2);
    const wType = buf.readUInt16LE(off + 4);
    if (wLength < 6 || off + wLength > end) return null;

    let p = off + 6;
    let key = '';
    while (p + 1 < end) {
      const c = buf.readUInt16LE(p);
      p += 2;
      if (c === 0) break;
      key += String.fromCharCode(c);
    }
    p = align4(p);
    // For text nodes wValueLength counts UTF-16 words, not bytes.
    const valueBytes = wType === 1 ? wValueLength * 2 : wValueLength;
    let value = '';
    if (valueBytes > 0 && p + valueBytes <= end) {
      value =
        wType === 1
          ? buf.toString('utf16le', p, p + valueBytes).replace(/\0+$/, '')
          : '';
    }
    return { key, value, childrenStart: align4(p + valueBytes), end: off + wLength };
  };

  const walk = (off, end, depth) => {
    if (depth > 4) return;
    let p = off;
    while (p + 6 <= end) {
      const node = readNode(p, end);
      if (!node) break;
      if (node.value) out[node.key] = node.value;
      walk(node.childrenStart, node.end, depth + 1);
      p = align4(node.end);
      if (node.end <= off) break; // malformed: refuse to loop forever
    }
  };

  try {
    walk(0, buf.length, 0);
  } catch {
    return {};
  }
  return out;
}

/** Read version strings from a .exe. Returns {} when unavailable. */
function readVersionStrings(exeBuffer) {
  try {
    const pe = parsePe(exeBuffer);
    if (!pe) return {};
    const versions = collectType(exeBuffer, pe, RT_VERSION);
    if (versions.size === 0) return {};
    return parseVersionInfo([...versions.values()][0]);
  } catch {
    return {};
  }
}

/**
 * Heuristic: does this executable enforce ASAR integrity?
 *
 * Unlike macOS — where the hash sits in an editable Info.plist key — Electron on
 * Windows embeds the integrity config inside the executable itself, and we have
 * no way to recompute it after repacking app.asar. So we look for the marker
 * string (stored as either ASCII or UTF-16 depending on toolchain) and, when we
 * find it, skip asar injection and isolate via --user-data-dir instead.
 *
 * A false positive costs nothing but the injection; a false negative surfaces as
 * an app that refuses to start, which `--mode link` then fixes.
 */
function detectAsarIntegrity(exeBuffer) {
  const marker = 'ElectronAsarIntegrity';
  if (exeBuffer.includes(Buffer.from(marker, 'ascii'))) return true;
  if (exeBuffer.includes(Buffer.from(marker, 'utf16le'))) return true;
  return false;
}

/** Pick the app's main executable out of an install directory. */
function findMainExe(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.exe'));
  } catch {
    return null;
  }
  const candidates = names.filter((n) => !NOT_THE_APP.some((re) => re.test(n)));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return path.join(dir, candidates[0]);

  // Prefer the executable named after its folder (Slack/Slack.exe), then the
  // largest one — the main binary dwarfs bundled utilities.
  const folder = path.basename(dir).toLowerCase();
  const named = candidates.find((n) => path.basename(n, '.exe').toLowerCase() === folder);
  if (named) return path.join(dir, named);

  const biggest = candidates
    .map((n) => ({ n, size: safeSize(path.join(dir, n)) }))
    .sort((a, b) => b.size - a.size)[0];
  return path.join(dir, biggest.n);
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Inspect a Windows app.
 *
 * `target` may be the .exe itself or the install directory containing it.
 * Returns null when no executable can be found.
 */
function inspectApp(target) {
  if (!target) return null;
  let exe = target;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    exe = findMainExe(target);
    if (!exe) return null;
  } else if (!target.toLowerCase().endsWith('.exe')) {
    return null;
  }

  const dir = path.dirname(exe);
  const asarPath = path.join(dir, 'resources', 'app.asar');
  const isElectron = fs.existsSync(asarPath);

  let strings = {};
  let hasAsarIntegrity = false;
  try {
    const buf = fs.readFileSync(exe);
    strings = readVersionStrings(buf);
    hasAsarIntegrity = isElectron && detectAsarIntegrity(buf);
  } catch {
    // Unreadable executable: fall back to filename-derived metadata.
  }

  const name =
    strings.ProductName || strings.FileDescription || path.basename(exe, '.exe');

  return {
    path: exe,
    exe,
    dir,
    name: name.trim(),
    productName: strings.ProductName || '',
    company: strings.CompanyName || '',
    version: strings.ProductVersion || strings.FileVersion || '',
    // Windows has no bundle identifier; show the publisher instead so the GUI
    // has a meaningful secondary line.
    bundleId: strings.CompanyName || path.basename(dir),
    isElectron,
    asarPath: isElectron ? asarPath : null,
    hasAsarIntegrity,
  };
}

module.exports = {
  inspectApp,
  findMainExe,
  readVersionStrings,
  parseVersionInfo,
  detectAsarIntegrity,
};
