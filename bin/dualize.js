#!/usr/bin/env node
//
// dualize — manage app clones on macOS and Windows.
//
//   dualize clone --source "/Applications/Slack.app" --name "Slack Work"
//   dualize clone --source "C:\...\Slack\slack.exe" --name "Slack Work"
//   dualize list
//   dualize repair "Slack Work"        # re-apply after an app auto-update
//   dualize repair --all
//   dualize remove "Slack Work" [--purge]   # --purge also deletes its data dir
//
// macOS work is delegated to clone-app.sh; Windows work runs in src/win/clone.js.
//
// Back-compat: `dualize --source ... --name ...` is treated as `clone`.
//
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const registry = require('../src/registry');
const { IS_WINDOWS, IS_MAC, dataDir, rmrf } = require('../src/platform');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'clone-app.sh');
const asarTools = require(path.join(ROOT, 'src', 'asar-tools.js'));

if (!IS_MAC && !IS_WINDOWS) {
  console.error(`dualize supports macOS and Windows; this is ${process.platform}.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let cmd = argv[0];
if (!cmd || cmd.startsWith('-')) cmd = 'clone'; // back-compat / default
else argv.shift();

const commands = { clone, list, remove, repair, help };
const run = commands[cmd] || help;

Promise.resolve(run()).catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});

// --- argument helpers --------------------------------------------------------

function flag(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
function has(name) {
  return argv.includes(name);
}
function positional() {
  // The first bare word that isn't the value of a preceding --flag.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) continue;
    if (i > 0 && argv[i - 1].startsWith('--') && takesValue(argv[i - 1])) continue;
    return argv[i];
  }
  return undefined;
}
function takesValue(f) {
  return ['--source', '--name', '--dest-dir', '--tint', '--mode'].includes(f);
}

// --- clone -------------------------------------------------------------------

async function clone() {
  if (IS_MAC) {
    const r = spawnSync('bash', [SCRIPT, ...argv], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  const source = flag('--source');
  const name = flag('--name');
  if (!source || !name) {
    return fail('error: --source and --name are required\n\n' + usageText());
  }

  const { cloneWindowsApp } = require('../src/win/clone');
  const result = await cloneWindowsApp(
    {
      source,
      name,
      destDir: flag('--dest-dir'),
      mode: flag('--mode', 'clone'),
      isolate: !has('--no-isolate'),
      desktop: has('--desktop'),
      tint: has('--no-tint') ? '' : flag('--tint'),
    },
    (line) => console.log(line)
  );

  if (!result.ok) return fail(`\nerror: ${result.error}`);

  registry.add({
    name,
    source: result.source,
    exe: result.exe,
    dest: result.dest,
    mode: result.mode,
    isolate: !has('--no-isolate'),
    desktop: has('--desktop'),
    tint: result.tint,
    icon: result.icon,
    shortcuts: result.shortcuts,
    aumid: result.aumid,
  });

  console.log('\nDone.');
  console.log(`Launch:  Start Menu -> "${name}"`);
  console.log(`Data:    ${result.dataDir}`);
  for (const w of result.warnings) console.log(`Note:    ${w}`);
}

// --- list --------------------------------------------------------------------

// 'missing' | 'ok' | 'needs repair (<why>)' | 'unknown (…)'
//
// On macOS, besides the code signature, check the ElectronAsarIntegrity hash: an
// app auto-update (or an older version of this tool) can leave Info.plist
// pointing at a hash that no longer matches app.asar, which makes fuse-protected
// apps such as Claude crash the instant they launch.
function healthOf(entry) {
  // Entries written before platforms were recorded are assumed to belong to the
  // machine reading them.
  const platform = entry.platform || process.platform;
  if (platform === 'win32') return require('../src/win/clone').healthOf(entry);
  if (!IS_MAC) return 'unknown (created on another platform)';
  if (!entry.dest || !fs.existsSync(entry.dest)) return 'missing';
  if (spawnSync('codesign', ['--verify', '--deep', entry.dest]).status !== 0) {
    return 'needs repair (code signature)';
  }
  try {
    const { entries } = asarTools.bundleIntegrity(entry.dest);
    if (entries && entries.some((e) => e.exists && !e.ok)) return 'needs repair (asar integrity hash)';
  } catch {
    /* not an Electron app, or unreadable asar: nothing more to check */
  }
  return 'ok';
}

function list() {
  const entries = registry.load();
  if (entries.length === 0) {
    console.log(
      'No clones recorded yet. Create one with:  dualize clone --source <app> --name <name>'
    );
    return;
  }
  console.log('');
  for (const e of entries) {
    console.log(`  ${e.name}`);
    console.log(`    status : ${healthOf(e)}`);
    if (e.mode === 'link') console.log('    mode   : link (shortcut only)');
    console.log(`    from   : ${e.source}`);
    if (e.dest) console.log(`    app    : ${e.dest}`);
    console.log(`    data   : ${dataDir(e.name, e.platform || process.platform)}`);
    console.log('');
  }
}

// --- remove ------------------------------------------------------------------

function remove() {
  const purge = has('--purge');
  const name = positional();
  if (!name) return fail('usage: dualize remove "<name>" [--purge]');

  const entry = registry.get(name);
  const dest = entry ? entry.dest : IS_MAC ? `/Applications/${name}.app` : null;

  if (dest && fs.existsSync(dest)) {
    try {
      rmrf(dest);
      console.log(`Removed ${dest}`);
    } catch (e) {
      // Almost always because the clone is still running and Windows keeps a
      // lock on its executable.
      return fail(
        `Could not remove ${dest}: ${e.message}\n` +
          'Quit the clone if it is running, then try again.'
      );
    }
  } else if (entry && entry.mode === 'link') {
    console.log('Link clone: the original app is left untouched.');
  } else {
    console.log(`App not found (already gone?): ${dest || name}`);
  }

  // Shortcuts and generated icons live outside the app folder on Windows.
  for (const lnk of (entry && entry.shortcuts) || []) {
    if (fs.existsSync(lnk)) {
      rmrf(lnk);
      console.log(`Removed ${lnk}`);
    }
  }
  if (entry && entry.icon && entry.mode === 'link' && fs.existsSync(entry.icon)) {
    rmrf(entry.icon);
  }

  const dd = dataDir(name, (entry && entry.platform) || process.platform);
  if (purge) {
    if (fs.existsSync(dd)) {
      rmrf(dd);
      console.log(`Removed data dir ${dd}`);
    }
  } else {
    console.log(`Kept data dir ${dd} (use --purge to delete it too).`);
  }
  registry.remove(name);
}

// --- repair ------------------------------------------------------------------

async function repair() {
  const all = has('--all');
  const targets = all ? registry.load() : [registry.get(positional())].filter(Boolean);

  if (targets.length === 0) {
    return fail('Nothing to repair. Usage: dualize repair "<name>"  |  dualize repair --all');
  }

  for (const e of targets) {
    if (all && healthOf(e) === 'ok') {
      console.log(`✓ ${e.name}: healthy, skipping`);
      continue;
    }
    if (e.mode === 'link') {
      console.log(`✓ ${e.name}: link clone, nothing to repair`);
      continue;
    }
    if (!fs.existsSync(e.source)) {
      console.log(`✗ ${e.name}: source app missing (${e.source}), skipping`);
      continue;
    }
    console.log(`↻ Repairing ${e.name} ...`);
    // The data directory lives outside the app folder, so the login survives.
    if (e.dest && fs.existsSync(e.dest)) rmrf(e.dest);

    if (IS_WINDOWS) {
      const { cloneWindowsApp } = require('../src/win/clone');
      const r = await cloneWindowsApp(
        {
          source: e.source,
          name: e.name,
          destDir: e.dest ? path.dirname(e.dest) : undefined,
          mode: e.mode,
          isolate: e.isolate !== false,
          desktop: e.desktop,
          tint: e.tint,
        },
        (line) => console.log(line)
      );
      if (!r.ok) console.log(`✗ ${e.name}: repair failed — ${r.error}`);
      else registry.add({ ...e, shortcuts: r.shortcuts, icon: r.icon });
    } else {
      const args = [SCRIPT, '--source', e.source, '--name', e.name, '--dest-dir', path.dirname(e.dest)];
      if (!e.isolate) args.push('--no-isolate');
      if (e.stripSchemes) args.push('--strip-schemes');
      if (e.tint) args.push('--tint', e.tint);
      else args.push('--no-tint');
      const r = spawnSync('bash', args, { stdio: 'inherit' });
      if (r.status !== 0) console.log(`✗ ${e.name}: repair failed`);
    }
  }
}

// --- help --------------------------------------------------------------------

function usageText() {
  const common = `  dualize clone --source <app> --name <name> [options]   Create a clone
  dualize list                                            Show recorded clones + health
  dualize repair "<name>"                                 Re-apply after an auto-update
  dualize repair --all                                    Repair every unhealthy clone
  dualize remove "<name>" [--purge]                       Delete a clone (--purge = its data too)`;

  const opts = IS_WINDOWS
    ? `Clone options (Windows):
  --dest-dir DIR    Where to write the clone (default: %LOCALAPPDATA%\\Programs)
  --mode clone|link clone = copy the app (default); link = shortcut only, survives updates
  --no-isolate      Don't inject a separate data directory into app.asar
  --desktop         Also create a Desktop shortcut
  --tint "#RRGGBB"  Icon badge color        --no-tint  Skip the icon badge`
    : `Clone options are passed through to clone-app.sh:
  --dest-dir DIR  --no-isolate  --strip-schemes  --tint "#RRGGBB"  --no-tint`;

  return `${common}\n\n${opts}`;
}

function help() {
  console.log(
    `dualize — manage app clones (${IS_WINDOWS ? 'Windows' : 'macOS'})\n\n${usageText()}`
  );
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
