'use strict';
//
// registry.js — tiny JSON registry of clones created by this tool.
//
//   macOS   ~/.config/mac-app-dualizer/clones.json
//   Windows %APPDATA%\mac-app-dualizer\clones.json
//
// Usable two ways: as a module (the Windows engine and the GUI import it) and as
// a CLI, which is how clone-app.sh records a clone from bash.
//
//   node registry.js add --name N --source S --dest D --isolate 1 --strip 0 --tint "#hex"
//   node registry.js list           -> prints JSON array
//   node registry.js get <name>     -> prints one entry as JSON (empty if none)
//   node registry.js remove <name>
//
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'mac-app-dualizer');
  }
  return path.join(os.homedir(), '.config', 'mac-app-dualizer');
}

function file() {
  return path.join(configDir(), 'clones.json');
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2) + '\n');
}

/** Insert or replace an entry, keyed by name. */
function add(entry) {
  if (!entry || !entry.name) throw new Error('registry add: name is required');
  const record = {
    platform: process.platform,
    mode: 'clone',
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  const list = load().filter((x) => x.name !== record.name);
  list.push(record);
  save(list);
  return record;
}

function get(name) {
  return load().find((x) => x.name === name);
}

function remove(name) {
  const list = load();
  const next = list.filter((x) => x.name !== name);
  save(next);
  return next.length !== list.length;
}

module.exports = { load, save, add, get, remove, configDir, file };

// --- CLI ---------------------------------------------------------------------

if (require.main === module) {
  const flag = (name, def) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
  };
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'add') {
    try {
      add({
        name: flag('--name'),
        source: flag('--source'),
        dest: flag('--dest'),
        isolate: flag('--isolate', '1') === '1',
        stripSchemes: flag('--strip', '0') === '1',
        tint: flag('--tint', ''),
        mode: flag('--mode', 'clone'),
      });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else if (cmd === 'list') {
    process.stdout.write(JSON.stringify(load(), null, 2));
  } else if (cmd === 'get') {
    const e = get(rest[0]);
    process.stdout.write(e ? JSON.stringify(e) : '');
  } else if (cmd === 'remove') {
    remove(rest[0]);
  } else {
    console.error(`registry: unknown command "${cmd}"`);
    process.exit(1);
  }
}
