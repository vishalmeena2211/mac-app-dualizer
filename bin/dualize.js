#!/usr/bin/env node
//
// dualize — manage macOS app clones.
//
//   dualize clone --source "/Applications/Slack.app" --name "Slack Work"
//   dualize list
//   dualize repair "Slack Work"        # re-apply after an app auto-update
//   dualize repair --all
//   dualize remove "Slack Work" [--purge]   # --purge also deletes its data dir
//
// Back-compat: `dualize --source ... --name ...` is treated as `clone`.
//
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'clone-app.sh');
const REGISTRY = path.join(ROOT, 'src', 'registry.js');
const asarTools = require(path.join(ROOT, 'src', 'asar-tools.js'));

if (process.platform !== 'darwin') {
  console.error('dualize only works on macOS.');
  process.exit(1);
}

const argv = process.argv.slice(2);
let cmd = argv[0];
if (!cmd || cmd.startsWith('-')) cmd = 'clone'; // back-compat / default
else argv.shift();

const commands = { clone, list, remove, repair, help };
(commands[cmd] || help)();

// ---------------------------------------------------------------------------

function clone() {
  const r = spawnSync('bash', [SCRIPT, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function readRegistry() {
  const r = spawnSync('node', [REGISTRY, 'list'], { encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout || '[]');
  } catch {
    return [];
  }
}

function getEntry(name) {
  return readRegistry().find((e) => e.name === name);
}

// CFBundleShortVersionString (falling back to CFBundleVersion), or null.
function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' });
    const v = r.status === 0 ? r.stdout.trim() : '';
    if (v) return v;
  }
  return null;
}

// 'missing' | 'ok' | 'needs repair (<why>)'
//
// Besides the code signature, check the ElectronAsarIntegrity hash: an app
// auto-update (or an older version of this tool) can leave Info.plist pointing
// at a hash that no longer matches app.asar, which makes fuse-protected apps
// such as Claude crash the instant they launch.
//
// Finally, compare the clone's version with the source app's. A clone is
// ad-hoc signed, so its own built-in updater can never install an update:
// Claude, for one, then sits on "needs the latest desktop app … Updating…"
// forever. The source app keeps updating itself, so a version mismatch means
// the clone must be rebuilt from it.
function health(appPath, sourcePath) {
  if (!fs.existsSync(appPath)) return 'missing';
  if (spawnSync('codesign', ['--verify', '--deep', appPath]).status !== 0) return 'needs repair (code signature)';
  try {
    const { entries } = asarTools.bundleIntegrity(appPath);
    if (entries && entries.some((e) => e.exists && !e.ok)) return 'needs repair (asar integrity hash)';
  } catch {
    /* not an Electron app, or unreadable asar: nothing more to check */
  }
  if (sourcePath && fs.existsSync(sourcePath)) {
    const cloneV = bundleVersion(appPath);
    const sourceV = bundleVersion(sourcePath);
    if (cloneV && sourceV && cloneV !== sourceV) return `needs repair (outdated: clone ${cloneV}, app ${sourceV})`;
  }
  return 'ok';
}

function list() {
  const entries = readRegistry();
  if (entries.length === 0) {
    console.log('No clones recorded yet. Create one with:  dualize clone --source <app> --name <name>');
    return;
  }
  console.log('');
  for (const e of entries) {
    console.log(`  ${e.name}`);
    console.log(`    status : ${health(e.dest, e.source)}`);
    console.log(`    from   : ${e.source}`);
    console.log(`    app    : ${e.dest}`);
    console.log(`    data   : ${dataDir(e.name)}`);
    console.log('');
  }
}

function dataDir(name) {
  return path.join(os.homedir(), 'Library', 'Application Support', name);
}

function remove() {
  const purge = argv.includes('--purge');
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) return fail('usage: dualize remove "<name>" [--purge]');
  const e = getEntry(name);
  const dest = e ? e.dest : `/Applications/${name}.app`;

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`Removed ${dest}`);
  } else {
    console.log(`App not found (already gone?): ${dest}`);
  }
  if (purge) {
    const dd = dataDir(name);
    if (fs.existsSync(dd)) {
      fs.rmSync(dd, { recursive: true, force: true });
      console.log(`Removed data dir ${dd}`);
    }
  } else {
    console.log(`Kept data dir ${dataDir(name)} (use --purge to delete it too).`);
  }
  spawnSync('node', [REGISTRY, 'remove', name]);
}

function repair() {
  const all = argv.includes('--all');
  const targets = all
    ? readRegistry()
    : [getEntry(argv.find((a) => !a.startsWith('-')))].filter(Boolean);

  if (targets.length === 0) {
    return fail('Nothing to repair. Usage: dualize repair "<name>"  |  dualize repair --all');
  }

  for (const e of targets) {
    if (all && health(e.dest, e.source) === 'ok') {
      console.log(`✓ ${e.name}: healthy, skipping`);
      continue;
    }
    if (!fs.existsSync(e.source)) {
      console.log(`✗ ${e.name}: source app missing (${e.source}), skipping`);
      continue;
    }
    console.log(`↻ Repairing ${e.name} ...`);
    if (fs.existsSync(e.dest)) fs.rmSync(e.dest, { recursive: true, force: true }); // data dir is untouched
    const args = [SCRIPT, '--source', e.source, '--name', e.name, '--dest-dir', path.dirname(e.dest)];
    if (!e.isolate) args.push('--no-isolate');
    if (e.stripSchemes) args.push('--strip-schemes');
    if (e.tint) args.push('--tint', e.tint);
    else args.push('--no-tint');
    const r = spawnSync('bash', args, { stdio: 'inherit' });
    if (r.status !== 0) console.log(`✗ ${e.name}: repair failed`);
  }
}

function help() {
  console.log(`dualize — manage macOS app clones

  dualize clone --source <app> --name <name> [options]   Create a clone
  dualize list                                            Show recorded clones + health (signature, asar hash, version)
  dualize repair "<name>"                                 Re-apply after an auto-update
  dualize repair --all                                    Repair every unhealthy clone
  dualize remove "<name>" [--purge]                       Delete a clone (--purge = its data too)

Clone options are passed through to clone-app.sh:
  --dest-dir DIR  --no-isolate  --strip-schemes  --tint "#RRGGBB"  --no-tint`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
