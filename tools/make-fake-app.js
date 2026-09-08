#!/usr/bin/env node
'use strict';
//
// make-fake-app.js — build a directory that looks like an installed Electron
// app: a real PE executable carrying icon and version resources, plus a genuine
// app.asar.
//
// Used by CI to exercise a full clone on a real Windows runner without needing
// to install Slack or Claude first.
//
//   node tools/make-fake-app.js <output-dir> [app name]
//
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { sampleExe } = require('./pe-fixture');
const { verifyArchive } = require('../src/win/clone');

async function main() {
  const outDir = process.argv[2];
  const appName = process.argv[3] || 'Fake App';
  if (!outDir) {
    console.error('usage: node tools/make-fake-app.js <output-dir> [app name]');
    process.exit(1);
  }

  const dir = path.resolve(outDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, `${appName}.exe`),
    sampleExe({
      strings: {
        ProductName: appName,
        CompanyName: 'Fake Corp',
        ProductVersion: '1.2.3',
      },
    })
  );
  // A bundled updater the tool must not mistake for the app itself.
  fs.writeFileSync(path.join(dir, 'Update.exe'), sampleExe());

  const src = path.join(dir, '_asar-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'package.json'),
    JSON.stringify({ name: 'fake-app', version: '1.2.3', main: 'main.js' })
  );
  fs.writeFileSync(
    path.join(src, 'main.js'),
    "'use strict';\n// pretend Electron entry point\nmodule.exports = {};\n"
  );
  const asarPath = path.join(dir, 'resources', 'app.asar');
  await asar.createPackageWithOptions(src, asarPath, {});
  if (!(await verifyArchive(asar, asarPath, 'main.js'))) {
    throw new Error(`generated app.asar never became readable: ${asarPath}`);
  }
  fs.rmSync(src, { recursive: true, force: true });

  console.log(path.join(dir, `${appName}.exe`));
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
