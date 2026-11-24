#!/usr/bin/env node
'use strict';
//
// asar-tools.js — dependency-free helpers for the `app.asar` surgery that
// clone-app.sh performs on Electron apps.
//
// Only Node built-ins are used on purpose: the CLI is meant to run straight from
// a git checkout (no `npm install`), and packages pulled in with `npx -p <pkg>`
// are NOT require()-able (npx only puts their bin/ on PATH). The old hash step
// relied on `require('@electron/asar')` and therefore silently failed in that
// setup, leaving a stale ElectronAsarIntegrity hash — which makes apps built
// with Electron's asar-integrity fuse (Claude, for one) crash at launch with
// EXC_BREAKPOINT. See https://github.com/vishalmeena2211/mac-app-dualizer/issues/1
//
// Usage:
//   node asar-tools.js header-hash <app.asar>
//       SHA-256 of the archive header: the value Electron compares against
//       Info.plist › ElectronAsarIntegrity › <path> › hash at startup.
//   node asar-tools.js unpacked-list <app.asar>
//       Files the app keeps outside the archive (in app.asar.unpacked), one per line.
//   node asar-tools.js unpack-glob <app.asar> <extract-dir>
//       `asar pack --unpack` pattern that reproduces exactly that set of files.
//       <extract-dir> must be the very same string later passed to `asar pack`.
//   node asar-tools.js unpack-dir-glob <app.asar>
//       `asar pack --unpack-dir` pattern for directories the app kept unpacked ("" if none).
//   node asar-tools.js inject <extract-dir> <clone-name>
//       Insert the data-isolation snippet into the app's main script
//       (after any shebang / "use strict", so the bundle stays in strict mode).
//   node asar-tools.js verify-unpacked <original.asar> <repacked.asar>
//       Exit 1 if a file that was unpacked in the original is packed in the clone.
//   node asar-tools.js sync-unpacked-modes <original.asar.unpacked> <repacked.asar.unpacked>
//       Copy file permissions (the executable bit) from the original's unpacked
//       files onto the repacked ones; `asar extract`/`pack` do not preserve them.
//   node asar-tools.js update-integrity <App.app>
//       Recompute every ElectronAsarIntegrity hash in Info.plist from the bundle's asar(s),
//       and the digest of that dictionary embedded in the Electron Framework binary.
//   node asar-tools.js check-integrity <App.app>
//       Exit 1 if any ElectronAsarIntegrity hash does not match its archive, or the
//       embedded digest does not match the dictionary.
//
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const MARKER = '/* mac-app-dualizer: isolated userData */';
// minimatch (used by `asar pack --unpack`) throws on patterns longer than 64 KiB.
const MAX_PATTERN_LENGTH = 60000;

// --- asar header -------------------------------------------------------------
//
// An asar file starts with two Chromium "pickles", then the raw file contents:
//   [0..4)    uint32 LE  4              payload size of the size-pickle
//   [4..8)    uint32 LE  N              byte length of the header pickle
//   [8..12)   uint32 LE  N - 4          payload size of the header pickle
//   [12..16)  uint32 LE  L              length of the header JSON string
//   [16..16+L)           header JSON    (padded to 4 bytes; file data follows)
// Electron hashes exactly those L bytes for the integrity check.

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error(`${asarPath}: too small to be an asar archive`);
    const sizePickle = head.readUInt32LE(0);
    const headerPickleLen = head.readUInt32LE(4);
    const strLen = head.readUInt32LE(12);
    if (sizePickle !== 4 || strLen === 0 || strLen + 8 > headerPickleLen) {
      throw new Error(`${asarPath}: not an asar archive (unexpected header pickle)`);
    }
    const headerBytes = Buffer.alloc(strLen);
    if (fs.readSync(fd, headerBytes, 0, strLen, 16) !== strLen) throw new Error(`${asarPath}: truncated asar header`);
    return { headerBytes, header: JSON.parse(headerBytes.toString('utf8')) };
  } finally {
    fs.closeSync(fd);
  }
}

function headerHash(asarPath, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(readHeader(asarPath).headerBytes).digest('hex');
}

function walk(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const isDir = Boolean(child.files);
    visit(rel, child, isDir);
    if (isDir) walk(child, rel, visit);
  }
}

// Files/dirs that live in app.asar.unpacked rather than inside the archive.
function listUnpacked(asarPath) {
  const files = [];
  const dirs = [];
  walk(readHeader(asarPath).header, '', (rel, node, isDir) => {
    if (node.unpacked) (isDir ? dirs : files).push(rel);
  });
  return { files, dirs };
}

// --- reproducing the unpacked layout ------------------------------------------
//
// `asar pack --unpack <glob>` matches the glob against each file's absolute path
// (minimatch, matchBase: true); `--unpack-dir <glob>` against directory paths
// relative to the source dir. We hand it an explicit brace-list of paths.

function escapeGlob(s) {
  // minimatch metacharacters, plus the comma that separates brace alternatives
  return s.replace(/[\\*?[\]{}()!+@|,]/g, '\\$&');
}

function braceList(items) {
  return items.length === 1 ? items[0] : `{${items.join(',')}}`;
}

function unpackGlobs(asarPath, extractDir) {
  const { files, dirs } = listUnpacked(asarPath);
  const root = path.normalize(extractDir);
  let unpack = files.length ? braceList(files.map((f) => escapeGlob(path.join(root, f)))) : '';
  if (unpack.length > MAX_PATTERN_LENGTH) {
    // Too many files for one pattern: fall back to basenames (matchBase). This may
    // unpack a few extra same-named files, which is harmless; verify-unpacked reports it.
    unpack = braceList([...new Set(files.map((f) => escapeGlob(path.basename(f))))]);
  }
  const unpackDir = dirs.length ? braceList(dirs.map(escapeGlob)) : '';
  return { unpack, unpackDir };
}

function verifyUnpacked(originalAsar, repackedAsar) {
  const want = new Set(listUnpacked(originalAsar).files);
  const have = new Set(listUnpacked(repackedAsar).files);
  return {
    missing: [...want].filter((f) => !have.has(f)),
    extra: [...have].filter((f) => !want.has(f)),
    count: want.size,
  };
}

// Files in app.asar.unpacked come out of `asar extract` + `asar pack` as 0644,
// whatever they were before: node-pty's spawn-helper, bundled MCP server binaries
// and native addons all lose their executable bit, so the clone can't spawn them.
// The asar header carries no mode for unpacked files, so copy it from the source.
function syncUnpackedModes(originalDir, repackedDir) {
  const result = { checked: 0, changed: 0, missing: [] };
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(from);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(originalDir, from);
      const to = path.join(repackedDir, rel);
      let toStat;
      try {
        toStat = fs.statSync(to);
      } catch {
        result.missing.push(rel);
        continue;
      }
      result.checked++;
      const mode = fs.statSync(from).mode & 0o7777;
      if ((toStat.mode & 0o7777) !== mode) {
        fs.chmodSync(to, mode);
        result.changed++;
      }
    }
  };
  if (fs.existsSync(originalDir)) visit(originalDir);
  return result;
}

// --- data-isolation snippet ------------------------------------------------------

function resolveEntry(extractDir) {
  let main = 'index.js';
  let type = 'commonjs';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extractDir, 'package.json'), 'utf8'));
    if (pkg.main) main = pkg.main;
    if (pkg.type) type = pkg.type;
  } catch {
    /* no package.json: Electron falls back to index.js */
  }
  const base = path.resolve(extractDir, main);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')];
  const file = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!file) return null;
  const isEsm = file.endsWith('.mjs') || (type === 'module' && !file.endsWith('.cjs'));
  return { file, isEsm, main };
}

function isolationSnippet(cloneName) {
  const dir = JSON.stringify(cloneName);
  return (
    `${MARKER};(function(){try{var e=require('electron'),p=require('path');var a=e.app||e;` +
    `var d=${dir};a.setPath('userData',p.join(a.getPath('appData'),d));` +
    `try{a.setAppLogsPath(p.join(a.getPath('appData'),d,'Logs'));}catch(_){}}catch(_){}})();\n`
  );
}

// Insert the snippet at the top of the entry file, but *after* a shebang and the
// "use strict" directive prologue: a directive only takes effect at the very top,
// so putting code in front of it would silently run the whole bundle in sloppy mode.
function injectIsolation(extractDir, cloneName) {
  const entry = resolveEntry(extractDir);
  if (!entry) {
    const err = new Error('could not locate the main script named by package.json');
    err.code = 'ENOENTRY';
    throw err;
  }
  if (entry.isEsm) {
    const err = new Error(`main script ${entry.main} is an ES module; only CommonJS entry points are supported for now`);
    err.code = 'EESM';
    throw err;
  }
  const src = fs.readFileSync(entry.file, 'utf8');
  if (src.includes(MARKER)) return { ...entry, status: 'already' };

  let at = 0;
  if (src.startsWith('#!')) at = src.indexOf('\n') + 1 || src.length;
  const directive = /^\s*(?:"use strict"|'use strict')\s*;?/.exec(src.slice(at));
  if (directive) at += directive[0].length;
  const head = src.slice(0, at);
  const sep = at > 0 && !head.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(entry.file, head + sep + isolationSnippet(cloneName) + src.slice(at));
  return { ...entry, status: 'injected' };
}

// --- ElectronAsarIntegrity (Info.plist) -----------------------------------------
//
// Electron (electron-builder / forge) records, per archive:
//   ElectronAsarIntegrity = { "Resources/app.asar": { algorithm: "SHA256", hash: "…" } }
// With the EnableEmbeddedAsarIntegrityValidation fuse on, a mismatch is fatal at
// startup (LOG(FATAL) → EXC_BREAKPOINT). Read the dict via PlistBuddy so binary
// plists and non-JSON-able values elsewhere in the file are no problem.

function readIntegrityEntries(plistPath) {
  let out;
  try {
    out = execFileSync(PLIST_BUDDY, ['-c', 'Print :ElectronAsarIntegrity', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // key absent (or not a plist)
  }
  const entries = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = /^(.+?) = Dict \{$/.exec(line))) {
      cur = { relPath: m[1], hash: '', algorithm: 'SHA256' };
      entries.push(cur);
    } else if (cur && (m = /^(hash|algorithm) = (\S+)$/.exec(line))) {
      cur[m[1]] = m[2];
    } else if (line === '}') {
      cur = null;
    }
  }
  return entries;
}

function nodeAlgorithm(name) {
  const n = String(name || 'SHA256').toUpperCase();
  if (n !== 'SHA256') throw new Error(`unsupported ElectronAsarIntegrity algorithm: ${name}`);
  return 'sha256';
}

// { plist, entries: null | [{ relPath, algorithm, hash, file, exists, actual, ok }] }
function bundleIntegrity(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const entries = readIntegrityEntries(plist);
  if (!entries) return { plist, entries: null };
  for (const e of entries) {
    e.file = path.join(appPath, 'Contents', e.relPath);
    e.exists = fs.existsSync(e.file);
    e.actual = e.exists ? headerHash(e.file, nodeAlgorithm(e.algorithm)) : null;
    e.ok = e.exists && e.actual === e.hash.toLowerCase();
  }
  return { plist, entries };
}

function updateIntegrity(appPath) {
  const { plist, entries } = bundleIntegrity(appPath);
  if (!entries) return { entries: null };
  for (const e of entries) {
    if (!e.exists || e.ok) continue;
    const key = `:ElectronAsarIntegrity:${e.relPath.replace(/(["\\])/g, '\\$1')}:hash`;
    execFileSync(PLIST_BUDDY, ['-c', `Set "${key}" ${e.actual}`, plist], { stdio: 'ignore' });
    e.hash = e.actual;
    e.ok = true;
    e.updated = true;
  }
  const digest = bundleIntegrityDigest(appPath, entries, { write: true });
  return { entries, digest };
}

// --- Integrity-dictionary digest (Electron Framework binary) --------------------
//
// Newer Electron (Claude's 45.x build, for one) also embeds a SHA-256 of the whole
// ElectronAsarIntegrity dictionary in the Electron Framework binary, in a slot
// that packaging tools fill in (shell/common/asar/integrity_digest.mm):
//   sentinel[32] "AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A" | used u8 | version u8 | digest[32]
// At startup Electron hashes the Info.plist dictionary and, if the slot is in use,
// refuses any dictionary whose digest differs: the app dies with
//   FATAL … Failed to get integrity for validatable asar archive: Resources/app.asar
// So changing a hash in Info.plist is not enough; the slot must be rewritten too
// (before code signing, since it changes the framework binary). See issue #5.
//
// Digest v1 = SHA-256 over, for each key in code-unit order: key, algorithm, hash.

const DIGEST_SENTINEL = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A', 'latin1');
const DIGEST_SIZE = 32;

function electronFrameworkBinary(appPath) {
  const p = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function integrityDictionaryDigest(entries) {
  const h = crypto.createHash('sha256');
  // Default sort compares UTF-16 code units, same as NSLiteralSearch in Electron.
  for (const e of [...entries].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))) {
    h.update(e.relPath, 'utf8');
    h.update(e.algorithm, 'utf8');
    h.update(e.hash, 'utf8');
  }
  return h.digest();
}

// Every slot in the binary (one per architecture slice of a universal build).
function findDigestSlots(buf) {
  const slots = [];
  for (let i = buf.indexOf(DIGEST_SENTINEL); i !== -1; i = buf.indexOf(DIGEST_SENTINEL, i + 1)) {
    const at = i + DIGEST_SENTINEL.length;
    if (at + 2 + DIGEST_SIZE > buf.length) break;
    slots.push({ offset: at + 2, used: buf[at] !== 0, version: buf[at + 1] });
  }
  return slots;
}

// { binary, slots: [{ offset, used, version, ok }], expected, ok }
// `ok` is true when there is nothing to validate (no framework, no slot, slot unused).
function bundleIntegrityDigest(appPath, entries, { write = false } = {}) {
  const binary = electronFrameworkBinary(appPath);
  if (!binary || !entries) return { binary, slots: [], expected: null, ok: true };
  const buf = fs.readFileSync(binary);
  const expected = integrityDictionaryDigest(entries);
  const slots = findDigestSlots(buf);
  let dirty = false;
  for (const s of slots) {
    if (!s.used) {
      s.ok = true;
      continue;
    }
    if (s.version !== 1) {
      throw new Error(`unsupported asar integrity digest version ${s.version} in ${path.basename(binary)}`);
    }
    s.ok = buf.compare(expected, 0, DIGEST_SIZE, s.offset, s.offset + DIGEST_SIZE) === 0;
    if (!s.ok && write) {
      expected.copy(buf, s.offset);
      s.ok = true;
      s.updated = true;
      dirty = true;
    }
  }
  if (dirty) fs.writeFileSync(binary, buf);
  return { binary, slots, expected: expected.toString('hex'), ok: slots.every((s) => s.ok) };
}

// --- CLI ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`asar-tools: ${msg}`);
  const header = fs.readFileSync(__filename, 'utf8').split('\n');
  const from = header.findIndex((l) => l.startsWith('// Usage:'));
  const to = header.findIndex((l, i) => i > from && !l.startsWith('//'));
  console.error(header.slice(from, to).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  return 2;
}

function main(argv) {
  const [cmd, ...args] = argv;
  const need = (n) => {
    if (args.length < n) throw Object.assign(new Error(`${cmd} needs ${n} argument(s)`), { code: 'EUSAGE' });
  };
  switch (cmd) {
    case 'header-hash':
      need(1);
      console.log(headerHash(args[0]));
      return 0;

    case 'unpacked-list':
      need(1);
      for (const f of listUnpacked(args[0]).files) console.log(f);
      return 0;

    case 'unpack-glob':
      need(2);
      process.stdout.write(unpackGlobs(args[0], args[1]).unpack);
      return 0;

    case 'unpack-dir-glob':
      need(1);
      process.stdout.write(unpackGlobs(args[0], '.').unpackDir);
      return 0;

    case 'inject': {
      need(2);
      const r = injectIsolation(args[0], args[1]);
      console.log(`${r.status === 'already' ? 'snippet already present in' : 'snippet injected into'} ${path.relative(args[0], r.file)}`);
      return 0;
    }

    case 'verify-unpacked': {
      need(2);
      const r = verifyUnpacked(args[0], args[1]);
      for (const f of r.extra) console.log(`note: additionally unpacked (harmless): ${f}`);
      if (r.missing.length) {
        for (const f of r.missing) console.error(`MISSING from app.asar.unpacked: ${f}`);
        return 1;
      }
      console.log(`unpacked layout preserved (${r.count} file${r.count === 1 ? '' : 's'} outside the archive)`);
      return 0;
    }

    case 'sync-unpacked-modes': {
      need(2);
      const r = syncUnpackedModes(args[0], args[1]);
      for (const f of r.missing) console.log(`note: not in repacked app.asar.unpacked: ${f}`);
      console.log(`file permissions restored on ${r.changed} of ${r.checked} unpacked file${r.checked === 1 ? '' : 's'}`);
      return 0;
    }

    case 'update-integrity': {
      need(1);
      const { entries, digest } = updateIntegrity(args[0]);
      if (!entries) {
        console.log('no ElectronAsarIntegrity key in Info.plist; nothing to update');
        return 0;
      }
      for (const e of entries) {
        if (!e.exists) console.log(`${e.relPath}: not present in bundle, left as is`);
        else console.log(`${e.relPath}: hash ${e.updated ? 'updated to' : 'already'} ${e.hash}`);
      }
      if (digest.slots.some((s) => s.used)) {
        const updated = digest.slots.some((s) => s.updated);
        console.log(`Electron Framework: integrity digest ${updated ? 'updated to' : 'already'} ${digest.expected}`);
      }
      return 0;
    }

    case 'check-integrity': {
      need(1);
      const { entries } = bundleIntegrity(args[0]);
      if (!entries) {
        console.log('no ElectronAsarIntegrity key in Info.plist; nothing to check');
        return 0;
      }
      let bad = 0;
      const digest = bundleIntegrityDigest(args[0], entries);
      if (!digest.ok) {
        bad++;
        console.error(`asar integrity digest: MISMATCH — Electron Framework does not hold ${digest.expected}`);
      } else if (digest.slots.some((s) => s.used)) {
        console.log(`asar integrity digest: ok (${digest.expected.slice(0, 12)}…)`);
      }
      for (const e of entries) {
        if (!e.exists) {
          console.log(`${e.relPath}: listed in Info.plist but not present in bundle`);
        } else if (e.ok) {
          console.log(`asar integrity ${e.relPath}: ok (${e.hash.slice(0, 12)}…)`);
        } else {
          bad++;
          console.error(`asar integrity ${e.relPath}: MISMATCH — Info.plist says ${e.hash}, archive is ${e.actual}`);
        }
      }
      return bad ? 1 : 0;
    }

    case undefined:
    case '-h':
    case '--help':
      return usage();

    default:
      return usage(`unknown command "${cmd}"`);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err.code === 'EUSAGE') process.exitCode = usage(err.message);
    else {
      console.error(`asar-tools: ${err.message}`);
      process.exitCode = err.code === 'EESM' ? 3 : 1;
    }
  }
}

module.exports = {
  MARKER,
  readHeader,
  headerHash,
  listUnpacked,
  unpackGlobs,
  verifyUnpacked,
  syncUnpackedModes,
  resolveEntry,
  injectIsolation,
  bundleIntegrity,
  updateIntegrity,
  bundleIntegrityDigest,
};
