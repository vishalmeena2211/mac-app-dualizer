'use strict';
//
// Tests for inspecting a Windows app, plus an end-to-end run of the clone
// engine against a synthetic install directory.
//
// The engine is pure Node apart from shortcut creation, so the whole pipeline —
// copy, rename, asar injection, icon generation — runs here on any platform.
// Shortcut creation is expected to decline off-Windows, and the test asserts
// that it degrades into a warning rather than failing the clone.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

const {
  inspectApp,
  findMainExe,
  readVersionStrings,
  detectAsarIntegrity,
} = require('../src/win/appinfo');
const { cloneWindowsApp, healthOf, verifyArchive, SENTINEL } = require('../src/win/clone');
const { sampleExe } = require('../tools/pe-fixture');
const { rmrf } = require('../src/platform');

/**
 * Best-effort temp cleanup.
 *
 * @electron/asar caches an archive's parsed header along with the open file
 * handle behind it, and Windows refuses to delete a directory while any handle
 * inside it is open. Dropping the cache first releases the archive; if the
 * delete still fails we let it go, since these live in the OS temp directory.
 */
function cleanup(target) {
  try {
    asar.uncacheAll();
  } catch {
    /* older releases may not expose it */
  }
  try {
    rmrf(target);
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
}

const IS_WINDOWS = process.platform === 'win32';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dualizer-win-'));
}

/** Build a directory that looks like an installed Electron app. */
async function makeInstall(root, name = 'Demo App', opts = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, `${name}.exe`),
    sampleExe({
      strings: { ProductName: name, CompanyName: 'Demo Corp', ProductVersion: '3.2.1' },
      asarIntegrity: opts.asarIntegrity,
    })
  );
  // Bundled helpers that must not be mistaken for the app itself.
  fs.writeFileSync(path.join(dir, 'Update.exe'), sampleExe());
  fs.writeFileSync(path.join(dir, 'chrome_100_percent.pak'), 'pak');

  if (opts.electron !== false) {
    const src = path.join(root, '_src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: 'demo', main: 'main.js' })
    );
    fs.writeFileSync(path.join(src, 'main.js'), "require('electron');\n// app code\n");
    const asarPath = path.join(dir, 'resources', 'app.asar');
    await asar.createPackageWithOptions(src, asarPath, {});
    if (!(await verifyArchive(asar, asarPath, 'main.js'))) {
      throw new Error(`fixture archive never became readable: ${asarPath}`);
    }
    rmrf(src);
  }
  return dir;
}

// --- version info ------------------------------------------------------------

test('readVersionStrings pulls product metadata out of the PE', () => {
  const exe = sampleExe({
    strings: { ProductName: 'Slack', CompanyName: 'Slack Technologies', ProductVersion: '4.35.126' },
  });
  const strings = readVersionStrings(exe);
  assert.strictEqual(strings.ProductName, 'Slack');
  assert.strictEqual(strings.CompanyName, 'Slack Technologies');
  assert.strictEqual(strings.ProductVersion, '4.35.126');
});

test('readVersionStrings returns an empty object rather than throwing', () => {
  assert.deepStrictEqual(readVersionStrings(Buffer.from('not a pe')), {});
  assert.deepStrictEqual(readVersionStrings(sampleExe()), {}); // no RT_VERSION
});

test('detectAsarIntegrity spots the marker in either encoding', () => {
  assert.strictEqual(detectAsarIntegrity(sampleExe()), false);
  assert.strictEqual(detectAsarIntegrity(sampleExe({ asarIntegrity: true })), true);
  assert.strictEqual(detectAsarIntegrity(Buffer.from('ElectronAsarIntegrity', 'ascii')), true);
});

// --- inspection --------------------------------------------------------------

test('findMainExe ignores bundled updaters and uninstallers', async () => {
  const root = tmpdir();
  const dir = await makeInstall(root, 'Demo App');
  fs.writeFileSync(path.join(dir, 'Uninstall Demo App.exe'), 'x');
  assert.strictEqual(path.basename(findMainExe(dir)), 'Demo App.exe');
  cleanup(root);
});

test('inspectApp reads an install directory or the exe directly', async () => {
  const root = tmpdir();
  const dir = await makeInstall(root, 'Demo App');

  for (const target of [dir, path.join(dir, 'Demo App.exe')]) {
    const info = inspectApp(target);
    assert.ok(info, `should inspect ${target}`);
    assert.strictEqual(info.name, 'Demo App');
    assert.strictEqual(info.company, 'Demo Corp');
    assert.strictEqual(info.version, '3.2.1');
    assert.strictEqual(info.isElectron, true);
    assert.strictEqual(info.hasAsarIntegrity, false);
    assert.strictEqual(path.basename(info.exe), 'Demo App.exe');
  }
  cleanup(root);
});

test('inspectApp flags an app that enforces asar integrity', async () => {
  const root = tmpdir();
  const dir = await makeInstall(root, 'Locked App', { asarIntegrity: true });
  assert.strictEqual(inspectApp(dir).hasAsarIntegrity, true);
  cleanup(root);
});

test('inspectApp reports non-Electron installs without an asar', async () => {
  const root = tmpdir();
  const dir = await makeInstall(root, 'Plain App', { electron: false });
  const info = inspectApp(dir);
  assert.strictEqual(info.isElectron, false);
  assert.strictEqual(info.asarPath, null);
  cleanup(root);
});

test('inspectApp declines things that are not apps', () => {
  assert.strictEqual(inspectApp(null), null);
  assert.strictEqual(inspectApp('/definitely/not/here.exe'), null);
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hi');
  assert.strictEqual(inspectApp(path.join(root, 'readme.txt')), null);
  assert.strictEqual(inspectApp(root), null, 'a directory with no exe');
  cleanup(root);
});

// --- full clone --------------------------------------------------------------

test('cloneWindowsApp copies, renames, injects, and badges', async () => {
  const root = tmpdir();
  const src = await makeInstall(root, 'Demo App');
  const dest = path.join(root, 'out');
  const logs = [];

  const res = await cloneWindowsApp(
    { source: src, name: 'Demo Two', destDir: dest, mode: 'clone' },
    (l) => logs.push(l)
  );
  assert.strictEqual(res.ok, true, res.error);

  const cloneDir = path.join(dest, 'Demo Two');
  assert.ok(fs.existsSync(path.join(cloneDir, 'Demo Two.exe')), 'exe was renamed');
  assert.ok(!fs.existsSync(path.join(cloneDir, 'Demo App.exe')), 'old exe name is gone');
  assert.ok(fs.existsSync(path.join(cloneDir, 'Update.exe')), 'bundled files came along');
  assert.ok(fs.existsSync(path.join(cloneDir, 'Demo Two.ico')), 'badged icon was written');

  const out = path.join(root, 'extracted');
  asar.extractAll(path.join(cloneDir, 'resources', 'app.asar'), out);
  const entry = fs.readFileSync(path.join(out, 'main.js'), 'utf8');
  assert.ok(entry.includes(JSON.stringify('Demo Two')), 'isolation targets the clone name');
  assert.ok(entry.includes('com.dualizer.demo-two'), 'a distinct AppUserModelID is set');
  assert.ok(entry.trimEnd().endsWith('// app code'), 'original entry code is preserved');

  // The .ico must be a real icon file, not a stub.
  const ico = fs.readFileSync(path.join(cloneDir, 'Demo Two.ico'));
  assert.strictEqual(ico.readUInt16LE(2), 1, 'ICONDIR type');
  assert.strictEqual(ico.readUInt16LE(4), 2, 'two frames carried over');

  assert.ok(fs.existsSync(path.join(cloneDir, SENTINEL)), 'sentinel recorded');
  assert.strictEqual(healthOf({ mode: 'clone', dest: cloneDir }), 'ok');

  // `repair` re-runs against `source`, so it must stay the ORIGINAL app — not
  // the copy, which repair deletes before rebuilding.
  assert.strictEqual(res.source, path.join(src, 'Demo App.exe'), 'source is the original');
  assert.strictEqual(res.exe, path.join(cloneDir, 'Demo Two.exe'), 'exe is the copy');
  assert.notStrictEqual(res.source, res.exe);

  if (IS_WINDOWS) {
    assert.ok(res.shortcuts.length >= 1, 'a Start Menu shortcut was created');
    for (const lnk of res.shortcuts) rmrf(lnk); // don't litter the runner
  } else {
    // Off-Windows the shortcut step declines; that must not fail the clone.
    assert.strictEqual(res.shortcuts.length, 0);
    assert.ok(
      res.warnings.some((w) => w.includes('only be created on Windows')),
      'the shortcut limitation is surfaced as a warning'
    );
  }

  cleanup(root);
});

test('cloneWindowsApp skips injection when asar integrity is enforced', async () => {
  const root = tmpdir();
  const src = await makeInstall(root, 'Locked App', { asarIntegrity: true });
  const dest = path.join(root, 'out');
  const logs = [];

  const res = await cloneWindowsApp(
    { source: src, name: 'Locked Two', destDir: dest, mode: 'clone' },
    (l) => logs.push(l)
  );
  assert.strictEqual(res.ok, true, res.error);
  assert.ok(
    res.warnings.some((w) => w.includes('ASAR integrity')),
    'the user is told isolation relies on the shortcut'
  );
  if (IS_WINDOWS) {
    for (const lnk of res.shortcuts) rmrf(lnk);
  } else {
    // Neither mechanism could be applied here, and that must be stated plainly
    // rather than reported as a working clone.
    assert.ok(
      res.warnings.some((w) => w.includes('nothing isolates this clone')),
      'an unisolated clone is called out'
    );
  }

  // The archive must be left byte-identical, or the app would refuse to launch.
  const before = fs.readFileSync(path.join(src, 'resources', 'app.asar'));
  const after = fs.readFileSync(path.join(dest, 'Locked Two', 'resources', 'app.asar'));
  assert.ok(before.equals(after), 'app.asar was not modified');

  cleanup(root);
});

test('cloneWindowsApp in link mode copies nothing', async () => {
  const root = tmpdir();
  const src = await makeInstall(root, 'Demo App');
  const before = fs.readFileSync(path.join(src, 'resources', 'app.asar'));

  const res = await cloneWindowsApp({ source: src, name: 'Demo Link', mode: 'link' }, () => {});

  if (IS_WINDOWS) {
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.mode, 'link');
    assert.strictEqual(res.dest, null, 'nothing is copied in link mode');
    assert.strictEqual(res.exe, path.join(src, 'Demo App.exe'), 'points at the original');
    assert.strictEqual(res.source, res.exe, 'source and target are the same file');
    if (res.icon) rmrf(res.icon);
    for (const lnk of res.shortcuts) rmrf(lnk);
  } else {
    // Link mode's only mechanism is the shortcut, which cannot exist here — so
    // it must report failure rather than claim an isolation it didn't deliver.
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /nothing isolates this clone/);
  }

  assert.ok(
    fs.readFileSync(path.join(src, 'resources', 'app.asar')).equals(before),
    'the original app is untouched either way'
  );
  cleanup(root);
});

test('cloneWindowsApp rejects a bad name before touching the disk', async () => {
  const root = tmpdir();
  const src = await makeInstall(root, 'Demo App');
  const dest = path.join(root, 'out');

  for (const bad of ['', 'has "quotes"', 'CON', 'star*']) {
    const res = await cloneWindowsApp({ source: src, name: bad, destDir: dest }, () => {});
    assert.strictEqual(res.ok, false, `"${bad}" should be rejected`);
  }
  assert.ok(!fs.existsSync(dest), 'nothing was written');
  cleanup(root);
});

test('cloneWindowsApp refuses to overwrite an existing clone', async () => {
  const root = tmpdir();
  const src = await makeInstall(root, 'Demo App');
  const dest = path.join(root, 'out');
  fs.mkdirSync(path.join(dest, 'Demo Two'), { recursive: true });

  const res = await cloneWindowsApp(
    { source: src, name: 'Demo Two', destDir: dest },
    () => {}
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already exists/);
  cleanup(root);
});

test('cloneWindowsApp reports a source that does not exist', async () => {
  const res = await cloneWindowsApp(
    { source: '/no/such/app.exe', name: 'Ghost' },
    () => {}
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /could not find an executable/);
});
