'use strict';
//
// Tests for the PE icon reader.
//
// These build a real (if minimal) PE image in memory — DOS stub, COFF header,
// optional header, and a .rsrc section holding a proper three-level resource
// tree — so the parser is exercised against the actual on-disk format rather
// than a mock. That keeps the Windows icon path testable on any platform.
//
const test = require('node:test');
const assert = require('node:assert');
const { PNG } = require('pngjs');

const {
  parsePe,
  extractIconGroup,
  badgeEntries,
  buildIco,
  badgedIcoFromExe,
  isPng,
} = require('../src/win/peicon');
const { badgeGeometry } = require('../src/badge');
const {
  makeDib,
  makeGroup,
  buildRsrc,
  buildExe,
  sampleExe,
  RT_ICON,
  RT_GROUP_ICON,
} = require('../tools/pe-fixture');

// --- tests -------------------------------------------------------------------

test('parsePe rejects things that are not PE images', () => {
  assert.strictEqual(parsePe(Buffer.alloc(0)), null);
  assert.strictEqual(parsePe(Buffer.from('not an executable at all')), null);
  assert.strictEqual(parsePe(Buffer.alloc(4096)), null); // zeroed: no MZ
  const truncated = sampleExe().subarray(0, 64);
  assert.strictEqual(parsePe(truncated), null);
});

test('parsePe locates the resource directory in PE32 and PE32+', () => {
  for (const magic of [0x10b, 0x20b]) {
    const pe = parsePe(sampleExe({ magic }));
    assert.ok(pe, `magic ${magic.toString(16)} should parse`);
    assert.strictEqual(typeof pe.resBase, 'number');
  }
});

test('extractIconGroup returns every frame in the group', () => {
  const entries = extractIconGroup(sampleExe());
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].width, 48);
  assert.strictEqual(entries[0].bitCount, 32);
  assert.strictEqual(entries[1].width, 0); // 256px is encoded as 0
  assert.ok(isPng(entries[1].data), 'the 256px frame should be a PNG');
  assert.ok(!isPng(entries[0].data), 'the 48px frame should be a DIB');
});

test('extractIconGroup returns null when there is no icon', () => {
  const noIcons = buildExe(buildRsrc([{ type: 24, id: 1, data: Buffer.from('<manifest/>') }]));
  assert.strictEqual(extractIconGroup(noIcons), null);
});

test('badging paints the tint into the DIB, bottom-up and in BGRA order', () => {
  const entries = extractIconGroup(sampleExe());
  const badged = badgeEntries(entries, '#d97757', PNG);
  assert.strictEqual(badged, 2, 'both the DIB and the PNG frame should be badged');

  const dib = entries[0].data;
  const { cx, cy } = badgeGeometry(48, 48);
  const row = 48 - 1 - cy; // DIB rows run bottom-up
  const o = 40 + (row * 48 + cx) * 4;
  assert.strictEqual(dib[o], 0x57, 'blue channel first');
  assert.strictEqual(dib[o + 1], 0x77, 'then green');
  assert.strictEqual(dib[o + 2], 0xd9, 'then red');
  assert.strictEqual(dib[o + 3], 255, 'and fully opaque');

  // A pixel far from the badge keeps the original artwork.
  const far = 40 + (5 * 48 + 2) * 4;
  assert.strictEqual(dib[far + 2], 10, 'untouched pixel keeps its red value');
});

test('badging clears the AND mask so the badge is not masked away', () => {
  const entries = extractIconGroup(sampleExe());
  badgeEntries(entries, '#4f8ef7', PNG);
  const dib = entries[0].data;
  const { cx, cy } = badgeGeometry(48, 48);
  const row = 48 - 1 - cy;
  const andStride = Math.ceil(48 / 32) * 4;
  const andStart = 40 + 48 * 48 * 4;
  const bit = dib[andStart + row * andStride + (cx >> 3)] & (0x80 >> (cx & 7));
  assert.strictEqual(bit, 0, 'AND-mask bit under the badge must be opaque');
});

test('badging recolors the PNG frame', () => {
  const entries = extractIconGroup(sampleExe());
  badgeEntries(entries, '#56b877', PNG);
  const png = PNG.sync.read(entries[1].data);
  const { cx, cy } = badgeGeometry(256, 256);
  const i = (256 * cy + cx) << 2;
  assert.deepStrictEqual([png.data[i], png.data[i + 1], png.data[i + 2]], [0x56, 0xb8, 0x77]);
});

test('buildIco writes a valid header with correct offsets', () => {
  const entries = extractIconGroup(sampleExe());
  const ico = buildIco(entries);

  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type 1 = icon');
  assert.strictEqual(ico.readUInt16LE(4), 2, 'two frames');

  let expected = 6 + 2 * 16;
  for (let i = 0; i < 2; i++) {
    const o = 6 + i * 16;
    const size = ico.readUInt32LE(o + 8);
    const offset = ico.readUInt32LE(o + 12);
    assert.strictEqual(size, entries[i].data.length, `frame ${i} size`);
    assert.strictEqual(offset, expected, `frame ${i} offset`);
    assert.ok(offset + size <= ico.length, `frame ${i} stays in bounds`);
    assert.deepStrictEqual(
      ico.subarray(offset, offset + size),
      entries[i].data,
      `frame ${i} payload round-trips`
    );
    expected += size;
  }
  assert.strictEqual(ico.length, expected, 'no trailing slack');
});

test('badgedIcoFromExe produces a complete .ico end to end', () => {
  const ico = badgedIcoFromExe(sampleExe(), '#e0a83b', PNG);
  assert.ok(Buffer.isBuffer(ico));
  assert.strictEqual(ico.readUInt16LE(2), 1);
  assert.strictEqual(ico.readUInt16LE(4), 2);
  assert.strictEqual(badgedIcoFromExe(Buffer.from('junk'), '#e0a83b', PNG), null);
});

test('a group entry pointing at a missing RT_ICON is skipped, not fatal', () => {
  const dib = makeDib(48, 48);
  const group = makeGroup([
    { width: 48, height: 48, bitCount: 32, size: dib.length, id: 1 },
    { width: 32, height: 32, bitCount: 32, size: 999, id: 77 }, // no such RT_ICON
  ]);
  const exe = buildExe(
    buildRsrc([
      { type: RT_ICON, id: 1, data: dib },
      { type: RT_GROUP_ICON, id: 1, data: group },
    ])
  );
  const entries = extractIconGroup(exe);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].width, 48);
});
