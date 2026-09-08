'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const registry = require('./registry');
const { IS_WINDOWS, IS_MAC, dataDir } = require('./platform');

const SCRIPT = path.join(__dirname, '..', 'clone-app.sh');

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 600,
    title: 'App Dualizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---------------------------------------------------------------------

ipcMain.handle('get-platform', () => ({
  platform: process.platform,
  isWindows: IS_WINDOWS,
  isMac: IS_MAC,
  extension: IS_WINDOWS ? '.exe' : '.app',
}));

// Let the user pick an app to clone.
ipcMain.handle('pick-app', async () => {
  const options = IS_WINDOWS
    ? {
        title: 'Choose an app to clone',
        defaultPath: path.join(
          process.env.LOCALAPPDATA || app.getPath('appData'),
          'Programs'
        ),
        properties: ['openFile'],
        filters: [{ name: 'Programs', extensions: ['exe'] }],
      }
    : {
        title: 'Choose an app to clone',
        defaultPath: '/Applications',
        properties: ['openFile'],
        filters: [{ name: 'Applications', extensions: ['app'] }],
      };

  const res = await dialog.showOpenDialog(options);
  if (res.canceled || res.filePaths.length === 0) return null;
  return inspectApp(res.filePaths[0]);
});

// Inspect an app path (used by Browse and by drag-and-drop).
ipcMain.handle('inspect-app', async (_e, appPath) => {
  if (!appPath || !fs.existsSync(appPath)) return null;
  const wanted = IS_WINDOWS ? '.exe' : '.app';
  if (!appPath.toLowerCase().endsWith(wanted)) return null;
  return inspectApp(appPath);
});

async function inspectApp(appPath) {
  const info = IS_WINDOWS
    ? require('./win/appinfo').inspectApp(appPath)
    : { path: appPath, ...readMacAppInfo(appPath) };
  if (!info) return null;

  let icon = null;
  try {
    const img = await app.getFileIcon(info.path || appPath, { size: 'large' });
    if (img && !img.isEmpty()) icon = img.toDataURL();
  } catch {
    /* icon is optional */
  }
  return { ...info, path: info.path || appPath, icon };
}

// Run the clone, streaming progress back to the renderer.
ipcMain.handle('clone-app', async (event, opts) => {
  const send = (line) => event.sender.send('clone-log', line);

  if (IS_WINDOWS) {
    try {
      const { cloneWindowsApp } = require('./win/clone');
      const result = await cloneWindowsApp(
        {
          source: opts.source,
          name: opts.name,
          destDir: opts.dest,
          mode: opts.mode || 'clone',
          isolate: opts.isolate,
          desktop: opts.desktop,
        },
        (line) => send(line + '\n')
      );
      if (!result.ok) {
        send(`\nerror: ${result.error}\n`);
        return { ok: false, code: 1, error: result.error };
      }
      registry.add({
        name: opts.name,
        source: result.source,
        exe: result.exe,
        dest: result.dest,
        mode: result.mode,
        isolate: opts.isolate !== false,
        desktop: !!opts.desktop,
        tint: result.tint,
        icon: result.icon,
        shortcuts: result.shortcuts,
        aumid: result.aumid,
      });
      for (const w of result.warnings) send(`Note: ${w}\n`);
      return { ok: true, code: 0, warnings: result.warnings, dest: result.dest };
    } catch (e) {
      send(`\nerror: ${e.message}\n`);
      return { ok: false, code: 1, error: e.message };
    }
  }

  return new Promise((resolve) => {
    if (!fs.existsSync(SCRIPT)) {
      resolve({ ok: false, code: 1, error: `clone-app.sh missing at ${SCRIPT}` });
      return;
    }
    const args = [SCRIPT, '--source', opts.source, '--name', opts.name];
    if (opts.dest) args.push('--dest-dir', opts.dest);
    if (!opts.isolate) args.push('--no-isolate');
    if (opts.stripSchemes) args.push('--strip-schemes');

    const child = spawn('bash', args, { env: process.env });
    child.stdout.on('data', (d) => send(d.toString()));
    child.stderr.on('data', (d) => send(d.toString()));
    child.on('error', (err) => resolve({ ok: false, code: 1, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
});

ipcMain.handle('launch-app', async (_e, name) => {
  if (IS_WINDOWS) {
    // Launch via the shortcut so the clone gets its --user-data-dir and icon.
    const entry = registry.get(name);
    const lnk = (entry && entry.shortcuts && entry.shortcuts[0]) || null;
    if (lnk && fs.existsSync(lnk)) {
      const err = await shell.openPath(lnk);
      return !err;
    }
    if (entry && entry.exe && fs.existsSync(entry.exe)) {
      spawn(entry.exe, [`--user-data-dir=${dataDir(name, 'win32')}`], { detached: true });
      return true;
    }
    return false;
  }
  const child = spawn('open', ['-a', name]);
  return new Promise((r) => child.on('close', (c) => r(c === 0)));
});

ipcMain.handle('reveal-app', async (_e, appPath) => {
  if (appPath && fs.existsSync(appPath)) shell.showItemInFolder(appPath);
});

function readMacAppInfo(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const read = (key) => {
    try {
      return require('node:child_process')
        .execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
        .toString()
        .trim();
    } catch {
      return '';
    }
  };
  const isElectron = fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
  return {
    name: read('CFBundleName') || path.basename(appPath, '.app'),
    bundleId: read('CFBundleIdentifier'),
    isElectron,
    hasAsarIntegrity: false,
  };
}
