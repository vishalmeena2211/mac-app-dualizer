'use strict';
//
// iconbadge.js — draw a colored badge (filled circle + white ring) in the
// bottom-right corner of every PNG in a .iconset directory, so a cloned app is
// visually distinct in the Dock and Cmd-Tab.
//
// Usage: node iconbadge.js --dir <iconset-dir> --color "#d97757"
//
// Requires the pure-JS `pngjs` package (a dependency of this project). It is
// resolved from this checkout's node_modules, from the current directory, or —
// when invoked from a bare git clone as
//   npx --yes -p pngjs node src/iconbadge.js --dir ... --color ...
// — from the npx cache. (npx only puts that cache's bin/ on PATH; its packages
// are not require()-able on their own, which used to make this step skip silently.)
//
const fs = require('node:fs');
const path = require('node:path');
const { eachBadgePixel, hexToRgb, MIN_BADGE_WIDTH } = require('./badge');

function loadPngjs() {
  const starts = [__dirname, process.cwd()];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    // "<prefix>/node_modules/.bin" -> "<prefix>", whose node_modules require() will search
    if (path.basename(dir) === '.bin' && path.basename(path.dirname(dir)) === 'node_modules') {
      starts.push(path.dirname(path.dirname(dir)));
    }
  }
  return require(require.resolve('pngjs', { paths: starts }));
}

let PNG;
try {
  ({ PNG } = loadPngjs());
} catch {
  console.error('iconbadge: pngjs not available; skipping icon badge.');
  process.exit(2);
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dir = arg('--dir');
const color = arg('--color', '#d97757');
if (!dir || !fs.existsSync(dir)) {
  console.error('iconbadge: --dir is required and must exist');
  process.exit(1);
}
const { r, g, b } = hexToRgb(color);

function badge(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width, height } = png;
  if (width < MIN_BADGE_WIDTH) return; // too small to matter
  eachBadgePixel(width, height, (x, y, isRing) => {
    const idx = (width * y + x) << 2;
    png.data[idx] = isRing ? 255 : r;
    png.data[idx + 1] = isRing ? 255 : g;
    png.data[idx + 2] = isRing ? 255 : b;
    png.data[idx + 3] = 255;
  });
  fs.writeFileSync(file, PNG.sync.write(png));
}

let n = 0;
for (const f of fs.readdirSync(dir)) {
  if (f.toLowerCase().endsWith('.png')) {
    try {
      badge(path.join(dir, f));
      n++;
    } catch (e) {
      console.error(`iconbadge: failed on ${f}: ${e.message}`);
    }
  }
}
console.log(`iconbadge: badged ${n} image(s) with ${color}`);
