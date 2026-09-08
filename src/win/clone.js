'use strict';
//
// clone.js — the Windows equivalent of clone-app.sh.
//
// Windows needs a different playbook than macOS. There is no bundle identifier
// to rewrite, no helper apps to rename, and no code signature to repair — but
// there is also no editable Info.plist, so an app that enforces ASAR integrity
// cannot be patched at all. To stay useful in both cases the tool isolates a
// clone two ways at once:
//
//   1. by injecting app.setPath('userData', ...) into app.asar, which covers
//      launching the cloned .exe directly, and
//   2. by putting --user-data-dir on the generated shortcuts, which needs no
//      modification to the app and therefore survives integrity enforcement.
//
// `--mode link` keeps only the second mechanism and skips the copy entirely, so
// the clone can never be reverted by an auto-update.
//
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { slug, tintFor, dataDir, validateName, rmrf } = require('../platform');
const { inspectApp } = require('./appinfo');
const { badgedIcoFromExe } = require('./peicon');
const shortcut = require('./shortcut');

/** Native modules must stay on disk rather than inside the archive. */
const UNPACK_GLOB = '{*.node,*.dll,*.exe}';

/** Where link-mode keeps generated icons (clone mode puts them in the copy). */
function iconStoreDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'mac-app-dualizer', 'icons');
}

function defaultDestDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs');
}

// --- data isolation ----------------------------------------------------------

/**
 * Build the snippet prepended to the app's entry point.
 *
 * Beyond pointing userData at our own directory, this wraps `setPath` so an app
 * that later sets its own userData path can't undo the isolation — a hardening
 * step the macOS script doesn't currently take.
 */
function isolationSnippet(cloneName, aumid, esm) {
  const name = JSON.stringify(cloneName);
  const id = JSON.stringify(aumid);
  const head = esm
    ? `import { app as __dualizerApp } from 'electron';\nimport __dualizerPath from 'path';\n`
    : '';
  const get = esm
    ? 'var __e = { app: __dualizerApp }, __p = __dualizerPath;'
    : "var __e = require('electron'), __p = require('path');";
  return `${head};(function(){try{
${get}
var a = __e.app || __e;
var target = __p.join(a.getPath('appData'), ${name});
var orig = a.setPath.bind(a);
a.setPath = function(n, v){ return n === 'userData' ? orig('userData', target) : orig(n, v); };
orig('userData', target);
try { a.setAppLogsPath(__p.join(target, 'Logs')); } catch (_) {}
try { a.setAppUserModelId(${id}); } catch (_) {}
}catch(_){}})();
`;
}

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch {
    return null;
  }
}

/** Drop a cached archive header. Older releases only expose uncacheAll(). */
function uncache(asar, asarPath) {
  try {
    if (typeof asar.uncache === 'function') asar.uncache(asarPath);
    else if (typeof asar.uncacheAll === 'function') asar.uncacheAll();
  } catch {
    /* the cache is an optimisation; failing to clear it is not fatal */
  }
}

/**
 * Unpack app.asar, prepend the isolation snippet to the entry point, repack.
 * Returns { ok, error } — never throws.
 */
async function injectIsolation(asarPath, cloneName, aumid, log) {
  const asar = loadAsar();
  if (!asar) return { ok: false, error: '@electron/asar not installed (run: npm install)' };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dualizer-'));
  const appDir = path.join(work, 'app');
  const unpackedDir = `${asarPath}.unpacked`;
  const savedUnpacked = `${asarPath}.unpacked.orig`;

  try {
    // @electron/asar memoises an archive's header by path. We are about to
    // rewrite this path in place, so drop any cached copy before reading and
    // again after packing — otherwise a long-lived process (the GUI) would go
    // on serving the old header and read file contents at stale offsets.
    uncache(asar, asarPath);
    asar.extractAll(asarPath, appDir);

    let entry = 'index.js';
    let esm = false;
    let pkgError = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      entry = pkg.main || 'index.js';
      esm = pkg.type === 'module' || entry.endsWith('.mjs');
    } catch (e) {
      // Not fatal on its own — some apps really do rely on the index.js default
      // — but if the entry then turns out to be missing, this is why.
      pkgError = e.message;
    }

    const entryFile = path.join(appDir, entry);
    if (!fs.existsSync(entryFile)) {
      const listing = safeList(appDir);
      return {
        ok: false,
        error:
          `entry point not found inside app.asar (${entry})` +
          (pkgError ? `; could not read package.json: ${pkgError}` : '') +
          `; extracted: ${listing}`,
      };
    }
    if (esm) log(`      entry point is an ES module (${entry})`);

    const original = fs.readFileSync(entryFile, 'utf8');
    fs.writeFileSync(entryFile, isolationSnippet(cloneName, aumid, esm) + original);

    // Build the replacement off to the side and prove it is readable before
    // touching the real one. A half-written app.asar is not a degraded clone,
    // it is an app that cannot start at all, so the original stays put until
    // there is a verified archive to swap in.
    const stagedAsar = path.join(work, 'app.asar');
    await asar.createPackageWithOptions(appDir, stagedAsar, { unpack: UNPACK_GLOB });

    if (!(await verifyArchive(asar, stagedAsar, entry))) {
      return {
        ok: false,
        error: 'the repacked app.asar could not be read back; the original was left untouched',
      };
    }

    // Swap in. The original unpacked payload is kept aside so anything the
    // repack's glob does not reproduce can be restored afterwards.
    if (fs.existsSync(unpackedDir)) fs.renameSync(unpackedDir, savedUnpacked);
    rmrf(asarPath);
    fs.copyFileSync(stagedAsar, asarPath); // copy, not rename: temp may be another volume
    uncache(asar, asarPath);

    const stagedUnpacked = `${stagedAsar}.unpacked`;
    if (fs.existsSync(stagedUnpacked)) {
      fs.cpSync(stagedUnpacked, unpackedDir, { recursive: true });
    }
    if (fs.existsSync(savedUnpacked)) {
      const restored = mergeMissing(savedUnpacked, unpackedDir);
      rmrf(savedUnpacked);
      if (restored) log(`      restored ${restored} unpacked file(s)`);
    }
    return { ok: true };
  } catch (e) {
    // Put the original unpacked payload back if we failed mid-flight.
    try {
      if (fs.existsSync(savedUnpacked)) {
        rmrf(unpackedDir);
        fs.renameSync(savedUnpacked, unpackedDir);
      }
    } catch {
      /* best effort */
    }
    return { ok: false, error: e.message };
  } finally {
    // Release the staged archive before deleting: reading it leaves a handle in
    // asar's cache, and Windows will not remove a directory that still has one
    // open. Even then the delete is best-effort — a leftover scratch directory
    // in the OS temp area must never turn a completed injection into a failure.
    uncache(asar, path.join(work, 'app.asar'));
    try {
      rmrf(work);
    } catch {
      /* the OS reclaims its own temp directory */
    }
  }
}

/**
 * Confirm a freshly written archive can be read back and still contains the
 * entry point.
 *
 * Windows has been observed to hand back a not-yet-complete file immediately
 * after the packer resolves, so this retries briefly before giving up rather
 * than treating the first read as final.
 */
async function verifyArchive(asar, archivePath, entry) {
  const want = normalizeAsarPath(entry);
  for (let attempt = 0; attempt < 3; attempt++) {
    uncache(asar, archivePath);
    try {
      const listed = asar.listPackage(archivePath).map(normalizeAsarPath);
      if (listed.includes(want)) return true;
    } catch {
      // Not readable yet — fall through to the retry.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** listPackage yields paths like "/main.js" or "\main.js" depending on host. */
function normalizeAsarPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.?\//, '');
}

/** A short directory listing, for putting real detail in an error message. */
function safeList(dir) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length === 0) return '(empty)';
    return names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '');
  } catch (e) {
    return `(unreadable: ${e.message})`;
  }
}

/** Copy files present in `from` but missing in `to`. Returns the count. */
function mergeMissing(from, to) {
  let n = 0;
  const walk = (rel) => {
    const src = path.join(from, rel);
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      const childRel = path.join(rel, item.name);
      const dstPath = path.join(to, childRel);
      if (item.isDirectory()) {
        walk(childRel);
      } else if (!fs.existsSync(dstPath)) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(path.join(from, childRel), dstPath);
        n++;
      }
    }
  };
  try {
    walk('');
  } catch {
    /* best effort */
  }
  return n;
}

// --- copying -----------------------------------------------------------------

/** Copy an install directory, preferring robocopy for speed and long paths. */
function copyTree(src, dest, log) {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'robocopy',
      [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
      { encoding: 'utf8' }
    );
    // robocopy signals success with codes 0-7; 8 and above are real failures.
    if (!r.error && r.status !== null && r.status < 8) return { ok: true };
    log('      robocopy unavailable or failed; falling back to a plain copy');
  }
  try {
    fs.cpSync(src, dest, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- icon --------------------------------------------------------------------

/** Extract the exe's icon, badge it, and write an .ico. Returns its path or null. */
function writeBadgedIcon(exePath, icoPath, tint, log) {
  let PNG = null;
  try {
    ({ PNG } = require('pngjs'));
  } catch {
    log('      pngjs not installed; large icon sizes will keep their original art');
  }
  try {
    const ico = badgedIcoFromExe(fs.readFileSync(exePath), tint, PNG);
    if (!ico) {
      log('      no icon found in the executable; the clone keeps the default icon');
      return null;
    }
    fs.mkdirSync(path.dirname(icoPath), { recursive: true });
    fs.writeFileSync(icoPath, ico);
    return icoPath;
  } catch (e) {
    log(`      could not build the badged icon (${e.message}); keeping the original`);
    return null;
  }
}

// --- health ------------------------------------------------------------------

const SENTINEL = '.dualizer.json';

/** Record what we patched so `dualize list` can spot an auto-update later. */
function writeSentinel(destDir, info) {
  try {
    fs.writeFileSync(path.join(destDir, SENTINEL), JSON.stringify(info, null, 2) + '\n');
  } catch {
    /* non-fatal */
  }
}

/**
 * Health of a recorded clone: 'ok', 'needs repair', or 'missing'.
 *
 * Windows has no signature to verify, so instead we compare app.asar against
 * the size and mtime captured at clone time. An auto-update rewrites the
 * archive, which reverts our injection and shows up here as a mismatch.
 */
function healthOf(entry) {
  if (entry.mode === 'link') {
    return fs.existsSync(entry.source) ? 'ok' : 'missing';
  }
  if (!entry.dest || !fs.existsSync(entry.dest)) return 'missing';
  const sentinelPath = path.join(entry.dest, SENTINEL);
  if (!fs.existsSync(sentinelPath)) return 'needs repair';
  try {
    const s = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    if (!s.asar) return 'ok'; // nothing was injected, so nothing can drift
    if (!fs.existsSync(s.asar)) return 'needs repair';
    const st = fs.statSync(s.asar);
    if (st.size !== s.asarSize) return 'needs repair';
    if (Math.abs(st.mtimeMs - s.asarMtime) > 2000) return 'needs repair';
    return 'ok';
  } catch {
    return 'needs repair';
  }
}

// --- main entry point --------------------------------------------------------

/**
 * Create a Windows clone.
 *
 * @param {object} opts
 * @param {string} opts.source   Path to the app's .exe (or its install folder).
 * @param {string} opts.name     Display name for the clone.
 * @param {string} [opts.destDir]
 * @param {'clone'|'link'} [opts.mode]
 * @param {boolean} [opts.isolate]  Inject into app.asar (clone mode only).
 * @param {boolean} [opts.desktop]  Also drop a Desktop shortcut.
 * @param {string}  [opts.tint]     Badge color, or '' to skip badging.
 * @param {function} [log]
 */
async function cloneWindowsApp(opts, log = () => {}) {
  const warnings = [];
  const mode = opts.mode === 'link' ? 'link' : 'clone';
  const isolate = opts.isolate !== false;

  const nameError = validateName(opts.name);
  if (nameError) return { ok: false, error: nameError };

  const app = inspectApp(opts.source);
  if (!app) {
    return { ok: false, error: `could not find an executable at: ${opts.source}` };
  }

  const cloneName = opts.name.trim();
  const cloneSlug = slug(cloneName);
  const aumid = `com.dualizer.${cloneSlug}`;
  const tint = opts.tint === '' ? '' : opts.tint || tintFor(cloneName);
  const data = dataDir(cloneName, 'win32');

  log(`Cloning '${app.name}'  ->  '${cloneName}'`);
  log(`  mode   : ${mode}`);
  log(`  source : ${app.exe}`);
  log(`  data   : ${data}`);
  if (tint) log(`  tint   : ${tint}`);
  log('');

  let targetExe = app.exe;
  let destDir = null;
  let icoPath;
  // Tracks whether the executable itself was patched. When it wasn't, the
  // shortcut's --user-data-dir is the only thing keeping the clone separate.
  let injected = false;

  if (mode === 'clone') {
    destDir = path.join(opts.destDir || defaultDestDir(), cloneName);
    if (fs.existsSync(destDir)) {
      return { ok: false, error: `destination already exists: ${destDir}` };
    }
    log(`  dest   : ${destDir}`);
    log('');

    log('[1/6] Copying application files...');
    const copied = copyTree(app.dir, destDir, log);
    if (!copied.ok) {
      rmrf(destDir);
      return { ok: false, error: `copy failed: ${copied.error}` };
    }

    log('[2/6] Renaming the executable...');
    const cloneExe = path.join(destDir, `${cloneName}.exe`);
    const copiedExe = path.join(destDir, path.basename(app.exe));
    try {
      if (copiedExe.toLowerCase() !== cloneExe.toLowerCase()) {
        fs.renameSync(copiedExe, cloneExe);
      }
      targetExe = cloneExe;
    } catch (e) {
      targetExe = copiedExe;
      warnings.push(`could not rename the executable: ${e.message}`);
      log(`      ! ${e.message}; keeping ${path.basename(copiedExe)}`);
    }

    const clonedAsar = path.join(destDir, 'resources', 'app.asar');
    if (!app.isElectron) {
      log('[3/6] Not an Electron app — copied without data isolation.');
      warnings.push(
        'this is not an Electron app, so its data directory could not be isolated'
      );
    } else if (!isolate) {
      log('[3/6] Data isolation skipped (--no-isolate).');
    } else if (app.hasAsarIntegrity) {
      log('[3/6] ASAR integrity is enforced — skipping injection.');
      log('      Isolation will come from the shortcut instead; launch the clone');
      log('      from its Start Menu entry rather than the .exe directly.');
      warnings.push(
        'ASAR integrity is enforced by this app, so isolation relies on the shortcut — ' +
          'launch the clone from the Start Menu, not by double-clicking the .exe'
      );
    } else {
      log('[3/6] Injecting an isolated data directory...');
      const injection = await injectIsolation(clonedAsar, cloneName, aumid, log);
      if (!injection.ok) {
        log(`      ! ${injection.error}`);
        warnings.push(`asar injection failed (${injection.error}); the shortcut still isolates data`);
      } else {
        injected = true;
        log('      app.asar repacked');
      }
    }

    log('[4/6] Building a distinct icon...');
    icoPath = tint
      ? writeBadgedIcon(targetExe, path.join(destDir, `${cloneName}.ico`), tint, log)
      : null;
  } else {
    log('[1/3] Link mode — the original app is left untouched.');
    log('[2/3] Building a distinct icon...');
    icoPath = tint
      ? writeBadgedIcon(app.exe, path.join(iconStoreDir(), `${cloneSlug}.ico`), tint, log)
      : null;
    if (!app.isElectron) {
      warnings.push(
        'link mode passes --user-data-dir, which only Electron and Chromium apps understand'
      );
    }
  }

  // Shortcuts carry the isolation flag, so a clone stays separate even when the
  // executable itself could not be patched.
  log(mode === 'clone' ? '[5/6] Creating shortcuts...' : '[3/3] Creating shortcuts...');
  const args = `--user-data-dir=${shortcut.quoteArg(data)}`;
  const lnkName = `${cloneName}.lnk`;
  const targets = [path.join(shortcut.startMenuDir(), lnkName)];
  if (opts.desktop) targets.push(path.join(shortcut.desktopDir(), lnkName));

  const shortcuts = [];
  for (const lnkPath of targets) {
    const r = shortcut.createShortcut({
      lnkPath,
      target: targetExe,
      args,
      workDir: path.dirname(targetExe),
      icon: icoPath || undefined,
      description: `${cloneName} — an isolated instance of ${app.name}`,
    });
    if (r.ok) {
      shortcuts.push(lnkPath);
      log(`      ${lnkPath}`);
    } else {
      warnings.push(`could not create ${lnkPath}: ${r.error}`);
      log(`      ! ${lnkPath}: ${r.error}`);
    }
  }

  // Isolation has to come from somewhere. If the executable wasn't patched and
  // no shortcut carries --user-data-dir, the "clone" would quietly share the
  // original's data — worse than failing, because the user would trust it.
  if (shortcuts.length === 0 && !injected) {
    const why =
      'nothing isolates this clone: app.asar was not patched and no shortcut could be created';
    if (mode === 'link') {
      return { ok: false, error: why };
    }
    log(`      ! ${why}`);
    warnings.push(`${why} — it will share the original app's data until a shortcut exists`);
  }

  if (mode === 'clone') {
    log('[6/6] Recording the clone...');
    const clonedAsar = path.join(destDir, 'resources', 'app.asar');
    let asarStat = null;
    try {
      asarStat = fs.statSync(clonedAsar);
    } catch {
      /* not an Electron app */
    }
    writeSentinel(destDir, {
      name: cloneName,
      source: app.exe,
      createdAt: new Date().toISOString(),
      asar: asarStat ? clonedAsar : null,
      asarSize: asarStat ? asarStat.size : 0,
      asarMtime: asarStat ? asarStat.mtimeMs : 0,
    });
  }

  return {
    ok: true,
    mode,
    dest: destDir,
    // `source` is the app we cloned from — repair re-runs against it — while
    // `exe` is what the shortcut launches. In link mode they are the same file.
    source: app.exe,
    exe: targetExe,
    dataDir: data,
    icon: icoPath || null,
    shortcuts,
    aumid,
    tint,
    warnings,
  };
}

module.exports = {
  cloneWindowsApp,
  healthOf,
  isolationSnippet,
  injectIsolation,
  verifyArchive,
  mergeMissing,
  defaultDestDir,
  iconStoreDir,
  SENTINEL,
};
