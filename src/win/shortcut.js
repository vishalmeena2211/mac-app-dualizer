'use strict';
//
// shortcut.js — create Windows .lnk files.
//
// This is the Windows counterpart to `lsregister` on macOS: a shortcut in the
// Start Menu is what makes a clone appear in search, and it's the thing that
// carries the --user-data-dir argument and the badged icon.
//
// Writing the .lnk binary format by hand is possible but unpleasant, so we drive
// the WScript.Shell COM object through PowerShell. Every value is passed via the
// environment rather than interpolated into the script text, so app names
// containing quotes, backticks, or $( ) can't break out of the command.
//
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PS_CREATE = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($env:DUALIZER_LNK)
$lnk.TargetPath = $env:DUALIZER_TARGET
$lnk.Arguments = $env:DUALIZER_ARGS
$lnk.WorkingDirectory = $env:DUALIZER_WORKDIR
$lnk.Description = $env:DUALIZER_DESC
if ($env:DUALIZER_ICON) { $lnk.IconLocation = $env:DUALIZER_ICON }
$lnk.Save()
`.trim();

/** Directory holding the current user's Start Menu program shortcuts. */
function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

/**
 * Create a .lnk.
 *
 * @param {object} o
 * @param {string} o.lnkPath   Where to write the shortcut.
 * @param {string} o.target    Executable the shortcut points at.
 * @param {string} [o.args]    Command-line arguments.
 * @param {string} [o.workDir] Working directory (defaults to the target's dir).
 * @param {string} [o.icon]    Path to an .ico, or "file.exe,0" style reference.
 * @param {string} [o.description]
 * @returns {{ok: boolean, error?: string}}
 */
function createShortcut(o) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'shortcuts can only be created on Windows' };
  }
  try {
    fs.mkdirSync(path.dirname(o.lnkPath), { recursive: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_CREATE],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DUALIZER_LNK: o.lnkPath,
        DUALIZER_TARGET: o.target,
        DUALIZER_ARGS: o.args || '',
        DUALIZER_WORKDIR: o.workDir || path.dirname(o.target),
        DUALIZER_DESC: o.description || '',
        DUALIZER_ICON: o.icon || '',
      },
    }
  );

  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || '').trim() || `powershell exited ${res.status}` };
  }
  if (!fs.existsSync(o.lnkPath)) {
    return { ok: false, error: 'shortcut was not created' };
  }
  return { ok: true };
}

/**
 * Quote a path for use in a shortcut's Arguments string.
 * Windows command-line quoting only needs the surrounding double quotes here,
 * since paths cannot themselves contain a double quote.
 */
function quoteArg(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

module.exports = { createShortcut, startMenuDir, desktopDir, quoteArg, PS_CREATE };
