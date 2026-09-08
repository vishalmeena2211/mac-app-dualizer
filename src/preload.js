'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dualizer', {
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  pickApp: () => ipcRenderer.invoke('pick-app'),
  inspectApp: (appPath) => ipcRenderer.invoke('inspect-app', appPath),
  cloneApp: (opts) => ipcRenderer.invoke('clone-app', opts),
  launchApp: (name) => ipcRenderer.invoke('launch-app', name),
  revealApp: (appPath) => ipcRenderer.invoke('reveal-app', appPath),
  onLog: (cb) => ipcRenderer.on('clone-log', (_e, line) => cb(line)),
});
