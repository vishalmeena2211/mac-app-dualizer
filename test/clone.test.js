'use strict';
//
// Tests for the Windows clone engine's platform-independent pieces.
//
// The asar surgery is the riskiest part of the Windows path and it is pure Node,
// so it can be exercised here on any OS against a real archive built with the
// same library the tool uses at runtime.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const {
  isolationSnippet,
  injectIsolation,
  verifyArchive,
  mergeMissing,
  healthOf,
  SENTINEL,
} = require('../src/win/clone');
const { validateName, dataDir, slug, tintFor, rmrf } = require('../src/platform');

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

const ENTRY_BODY = "const { app } = require('electron');\napp.whenReady().then(() => {});\n";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dualizer-test-'));
}

/** Build a throwaway app.asar that looks like a packaged Electron app. */
async function makeAsar(dir, { type, main = 'main.js', unpacked = {} } = {}) {
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const pkg = { name: 'demo', version: '1.0.0', main };
  if (type) pkg.type = type;
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(appDir, main), ENTRY_BODY);
  fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'assets', 'logo.txt'), 'logo');

  const asarPath = path.join(dir, 'app.asar');
  await asar.createPackageWithOptions(appDir, asarPath, { unpack: '{*.node,*.dll}' });
  // The packer resolves before Windows has necessarily flushed the file, and
  // reading too early yields a zero-filled archive. Wait for it to settle.
  if (!(await verifyArchive(asar, asarPath, main))) {
    throw new Error(`fixture archive never became readable: ${asarPath}`);
  }

  for (const [rel, body] of Object.entries(unpacked)) {
    const p = path.join(`${asarPath}.unpacked`, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return asarPath;
}

// --- snippet -----------------------------------------------------------------

test('the CommonJS isolation snippet is syntactically valid', () => {
  const src = isolationSnippet('Slack Work', 'com.dualizer.slack-work', false);
  assert.doesNotThrow(() => new vm.Script(src));
});

test('the ES module isolation snippet is syntactically valid', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'snippet.mjs');
  fs.writeFileSync(file, isolationSnippet('Slack Work', 'com.dualizer.slack-work', true));
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  cleanup(dir);
});

test('the snippet escapes names that would otherwise break out of the string', () => {
  const nasty = 'Weiřd " \\ Name\n; process.exit(1); //';
  const src = isolationSnippet(nasty, 'com.dualizer.x', false);
  assert.doesNotThrow(() => new vm.Script(src));
  // The name must survive as data, never as executable code.
  assert.ok(src.includes(JSON.stringify(nasty)));
  assert.ok(!src.includes('\n; process.exit(1)'));
});

test('the snippet pins userData against a later setPath call', () => {
  const src = isolationSnippet('Clone A', 'com.dualizer.clone-a', false);
  const calls = [];
  const fakeApp = {
    getPath: (k) => (k === 'appData' ? '/APPDATA' : '/other'),
    setPath: (k, v) => calls.push([k, v]),
    setAppLogsPath: () => {},
    setAppUserModelId: (id) => calls.push(['aumid', id]),
  };
  const require_ = (m) => (m === 'electron' ? { app: fakeApp } : require(m));
  vm.runInNewContext(src, { require: require_, console });

  assert.deepStrictEqual(calls[0], ['userData', path.join('/APPDATA', 'Clone A')]);
  assert.deepStrictEqual(calls.at(-1), ['aumid', 'com.dualizer.clone-a']);

  // An app that sets its own userData afterwards must be redirected back.
  calls.length = 0;
  fakeApp.setPath('userData', '/somewhere/else');
  assert.deepStrictEqual(calls, [['userData', path.join('/APPDATA', 'Clone A')]]);

  // Other paths still pass through untouched.
  calls.length = 0;
  fakeApp.setPath('cache', '/tmp/cache');
  assert.deepStrictEqual(calls, [['cache', '/tmp/cache']]);
});

// --- injection ---------------------------------------------------------------

test('injectIsolation rewrites the entry point and keeps the archive readable', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir);

  const res = await injectIsolation(asarPath, 'Slack Work', 'com.dualizer.slack-work', () => {});
  assert.strictEqual(res.ok, true, res.error);

  const out = path.join(dir, 'extracted');
  asar.extractAll(asarPath, out);
  const entry = fs.readFileSync(path.join(out, 'main.js'), 'utf8');

  assert.ok(entry.includes("orig('userData', target)"), 'snippet was prepended');
  assert.ok(entry.endsWith(ENTRY_BODY), 'original entry code is preserved verbatim');
  assert.ok(entry.indexOf('userData') < entry.indexOf('app.whenReady'), 'snippet runs first');
  assert.strictEqual(
    fs.readFileSync(path.join(out, 'assets', 'logo.txt'), 'utf8'),
    'logo',
    'other files survive the repack'
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).main, 'main.js');

  cleanup(dir);
});

test('injectIsolation honours an ES module entry point', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir, { type: 'module' });
  const logs = [];
  const res = await injectIsolation(asarPath, 'Notion Two', 'com.dualizer.notion-two', (l) =>
    logs.push(l)
  );
  assert.strictEqual(res.ok, true, res.error);

  const out = path.join(dir, 'extracted');
  asar.extractAll(asarPath, out);
  const entry = fs.readFileSync(path.join(out, 'main.js'), 'utf8');
  assert.ok(entry.startsWith('import '), 'ESM entry uses import, not require');
  assert.ok(logs.some((l) => l.includes('ES module')), 'the ESM path is reported');

  cleanup(dir);
});

test('injectIsolation restores unpacked files the repack would have dropped', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir, { unpacked: { 'extra/keep.dat': 'important' } });

  const res = await injectIsolation(asarPath, 'Clone', 'com.dualizer.clone', () => {});
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(
    fs.readFileSync(path.join(`${asarPath}.unpacked`, 'extra', 'keep.dat'), 'utf8'),
    'important',
    'a file outside the unpack glob is preserved'
  );
  assert.ok(!fs.existsSync(`${asarPath}.unpacked.orig`), 'the scratch copy is cleaned up');

  cleanup(dir);
});

test('injectIsolation reports a missing entry point instead of throwing', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir, { main: 'main.js' });
  // Repack with package.json pointing at a file that isn't there.
  const appDir = path.join(dir, 'broken');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'x', main: 'nope.js' })
  );
  const broken = path.join(dir, 'broken.asar');
  await asar.createPackageWithOptions(appDir, broken, {});

  const res = await injectIsolation(broken, 'X', 'com.dualizer.x', () => {});
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /entry point not found/);
  assert.ok(fs.existsSync(broken), 'the archive is left in place on failure');

  cleanup(dir);
});

test('verifyArchive rejects an unreadable or incomplete archive', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir);
  assert.strictEqual(await verifyArchive(asar, asarPath, 'main.js'), true);
  assert.strictEqual(
    await verifyArchive(asar, asarPath, 'not-in-there.js'),
    false,
    'an archive missing the entry point is not acceptable'
  );

  const garbage = path.join(dir, 'truncated.asar');
  fs.writeFileSync(garbage, fs.readFileSync(asarPath).subarray(0, 12));
  assert.strictEqual(await verifyArchive(asar, garbage, 'main.js'), false);

  assert.strictEqual(await verifyArchive(asar, path.join(dir, 'missing.asar'), 'main.js'), false);
  cleanup(dir);
});

test('a failed repack leaves the original app.asar intact', async () => {
  const dir = tmpdir();
  const asarPath = await makeAsar(dir);
  const before = fs.readFileSync(asarPath);

  // Force the pack step to fail after the entry point has been rewritten.
  const original = asar.createPackageWithOptions;
  asar.createPackageWithOptions = async () => {
    throw new Error('simulated packer failure');
  };
  try {
    const res = await injectIsolation(asarPath, 'Clone', 'com.dualizer.clone', () => {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /simulated packer failure/);
  } finally {
    asar.createPackageWithOptions = original;
  }

  assert.ok(fs.existsSync(asarPath), 'the archive still exists');
  assert.ok(fs.readFileSync(asarPath).equals(before), 'and is byte-for-byte the original');
  cleanup(dir);
});

// --- helpers -----------------------------------------------------------------

test('mergeMissing copies only files the destination lacks', () => {
  const dir = tmpdir();
  const from = path.join(dir, 'from');
  const to = path.join(dir, 'to');
  fs.mkdirSync(path.join(from, 'nested'), { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(from, 'a.txt'), 'from-a');
  fs.writeFileSync(path.join(from, 'nested', 'b.txt'), 'from-b');
  fs.writeFileSync(path.join(to, 'a.txt'), 'to-a');

  assert.strictEqual(mergeMissing(from, to), 1);
  assert.strictEqual(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), 'to-a', 'existing file kept');
  assert.strictEqual(fs.readFileSync(path.join(to, 'nested', 'b.txt'), 'utf8'), 'from-b');

  cleanup(dir);
});

test('healthOf detects an app.asar replaced by an auto-update', () => {
  const dir = tmpdir();
  const dest = path.join(dir, 'Clone');
  fs.mkdirSync(path.join(dest, 'resources'), { recursive: true });
  const asarPath = path.join(dest, 'resources', 'app.asar');
  fs.writeFileSync(asarPath, 'x'.repeat(100));
  const st = fs.statSync(asarPath);
  fs.writeFileSync(
    path.join(dest, SENTINEL),
    JSON.stringify({ asar: asarPath, asarSize: st.size, asarMtime: st.mtimeMs })
  );

  const entry = { name: 'Clone', dest, mode: 'clone' };
  assert.strictEqual(healthOf(entry), 'ok');

  fs.writeFileSync(asarPath, 'y'.repeat(500)); // stand-in for an auto-update
  assert.strictEqual(healthOf(entry), 'needs repair');

  rmrf(dest);
  assert.strictEqual(healthOf(entry), 'missing');
  cleanup(dir);
});

test('healthOf treats a link clone as healthy while its source exists', () => {
  const dir = tmpdir();
  const exe = path.join(dir, 'App.exe');
  fs.writeFileSync(exe, 'MZ');
  assert.strictEqual(healthOf({ mode: 'link', source: exe }), 'ok');
  assert.strictEqual(healthOf({ mode: 'link', source: path.join(dir, 'gone.exe') }), 'missing');
  cleanup(dir);
});

test('healthOf flags a clone with no sentinel as needing repair', () => {
  const dir = tmpdir();
  assert.strictEqual(healthOf({ mode: 'clone', dest: dir }), 'needs repair');
  cleanup(dir);
});

// --- naming ------------------------------------------------------------------

test('validateName rejects names Windows or the shell would choke on', () => {
  assert.strictEqual(validateName('Slack Work'), null);
  assert.strictEqual(validateName('Claude 2'), null);
  assert.ok(validateName(''));
  assert.ok(validateName('   '));
  assert.ok(validateName('has "quotes"'));
  assert.ok(validateName('back\\slash'));
  assert.ok(validateName('colon:name'));
  assert.ok(validateName('pipe|name'));
  assert.ok(validateName('star*'));
  assert.ok(validateName('slash/name'));
  assert.ok(validateName('trailing '));
  assert.ok(validateName('trailing.'));
  assert.ok(validateName('CON'), 'reserved DOS device name');
  assert.ok(validateName('lpt1.txt'), 'reserved device name with extension');
  assert.ok(validateName('!!!'), 'must contain something sluggable');
});

test('slug and tint are stable and shared across platforms', () => {
  assert.strictEqual(slug('Slack Work'), 'slack-work');
  assert.strictEqual(slug('Claude 2'), 'claude-2');
  assert.strictEqual(tintFor('Claude 2'), tintFor('Claude 2'));
  assert.match(tintFor('Slack Work'), /^#[0-9a-f]{6}$/);
});

test('dataDir points at the platform-native location', () => {
  const win = dataDir('Slack Work', 'win32');
  assert.ok(win.endsWith(path.join('Roaming', 'Slack Work')) || win.includes('Slack Work'));
  const mac = dataDir('Slack Work', 'darwin');
  assert.ok(mac.includes(path.join('Library', 'Application Support', 'Slack Work')));
});
