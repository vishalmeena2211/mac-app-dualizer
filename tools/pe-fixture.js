'use strict';
//
// Builders for synthetic Windows binaries.
//
// These produce structurally real PE images — DOS stub, COFF header, optional
// header, and a .rsrc section holding a proper three-level resource tree — so
// the Windows code paths can be exercised against the actual on-disk format
// from any platform.
//
const { PNG } = require('pngjs');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
const RSRC_RVA = 0x2000;

/** A 32bpp icon DIB: BITMAPINFOHEADER + bottom-up BGRA pixels + 1bpp AND mask. */
function makeDib(width, height, fill = [10, 20, 30, 255]) {
  const andStride = Math.ceil(width / 32) * 4;
  const buf = Buffer.alloc(40 + width * height * 4 + andStride * height);
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8); // XOR + AND stacked
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bpp
  for (let i = 0; i < width * height; i++) {
    const o = 40 + i * 4;
    buf[o] = fill[2]; // B
    buf[o + 1] = fill[1]; // G
    buf[o + 2] = fill[0]; // R
    buf[o + 3] = fill[3];
  }
  buf.fill(0xff, 40 + width * height * 4); // AND mask starts fully transparent
  return buf;
}

function makePng(size) {
  const png = new PNG({ width: size, height: size });
  png.data.fill(0x40);
  return PNG.sync.write(png);
}

/** GRPICONDIR describing the icons, as stored in an RT_GROUP_ICON resource. */
function makeGroup(entries) {
  const buf = Buffer.alloc(6 + entries.length * 14);
  buf.writeUInt16LE(1, 2); // type: icon
  buf.writeUInt16LE(entries.length, 4);
  entries.forEach((e, i) => {
    const o = 6 + i * 14;
    buf.writeUInt8(e.width & 0xff, o);
    buf.writeUInt8(e.height & 0xff, o + 1);
    buf.writeUInt16LE(1, o + 4); // planes
    buf.writeUInt16LE(e.bitCount, o + 6);
    buf.writeUInt32LE(e.size, o + 8);
    buf.writeUInt16LE(e.id, o + 12);
  });
  return buf;
}

/** Encode a VS_VERSIONINFO node (length-prefixed, UTF-16 key, 4-byte aligned). */
function versionNode(key, value, children = [], type = 1) {
  const align4 = (n) => (n + 3) & ~3;
  const keyBuf = Buffer.from(key + '\0', 'utf16le');
  const valBuf = value ? Buffer.from(value + '\0', 'utf16le') : Buffer.alloc(0);
  const headerLen = align4(6 + keyBuf.length);
  const valueLen = align4(valBuf.length);
  const kids = Buffer.concat(children);
  const total = headerLen + valueLen + kids.length;

  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(total, 0);
  buf.writeUInt16LE(type === 1 ? valBuf.length / 2 : valBuf.length, 2);
  buf.writeUInt16LE(type, 4);
  keyBuf.copy(buf, 6);
  valBuf.copy(buf, headerLen);
  kids.copy(buf, headerLen + valueLen);
  return buf;
}

/** A VS_VERSIONINFO resource carrying the given string pairs. */
function makeVersionInfo(strings) {
  const entries = Object.entries(strings).map(([k, v]) => versionNode(k, v));
  const table = versionNode('040904b0', '', entries, 0);
  const sfi = versionNode('StringFileInfo', '', [table], 0);
  return versionNode('VS_VERSION_INFO', '', [sfi], 0);
}

/**
 * Lay out a .rsrc section containing a three-level resource tree.
 * `resources` is [{ type, id, data }].
 */
function buildRsrc(resources) {
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b);
  const dirSize = (n) => 16 + n * 8;

  // Walk the layout once to assign offsets, then write.
  let cursor = dirSize(types.length);
  const nameDirOff = new Map();
  for (const t of types) {
    nameDirOff.set(t, cursor);
    cursor += dirSize(resources.filter((r) => r.type === t).length);
  }
  const langDirOff = new Map();
  for (const r of resources) {
    langDirOff.set(r, cursor);
    cursor += dirSize(1);
  }
  const dataEntryOff = new Map();
  for (const r of resources) {
    dataEntryOff.set(r, cursor);
    cursor += 16;
  }
  const payloadOff = new Map();
  for (const r of resources) {
    payloadOff.set(r, cursor);
    cursor += r.data.length;
    cursor = (cursor + 3) & ~3; // keep payloads 4-byte aligned
  }

  const buf = Buffer.alloc(cursor);
  const writeDir = (off, entries) => {
    buf.writeUInt16LE(0, off + 12); // named entries
    buf.writeUInt16LE(entries.length, off + 14); // id entries
    entries.forEach((e, i) => {
      const o = off + 16 + i * 8;
      buf.writeUInt32LE(e.id, o);
      buf.writeUInt32LE(e.isDir ? (e.offset | 0x80000000) >>> 0 : e.offset, o + 4);
    });
  };

  writeDir(
    0,
    types.map((t) => ({ id: t, isDir: true, offset: nameDirOff.get(t) }))
  );
  for (const t of types) {
    writeDir(
      nameDirOff.get(t),
      resources
        .filter((r) => r.type === t)
        .map((r) => ({ id: r.id, isDir: true, offset: langDirOff.get(r) }))
    );
  }
  for (const r of resources) {
    writeDir(langDirOff.get(r), [{ id: 1033, isDir: false, offset: dataEntryOff.get(r) }]);
    const d = dataEntryOff.get(r);
    buf.writeUInt32LE(RSRC_RVA + payloadOff.get(r), d); // OffsetToData is an RVA
    buf.writeUInt32LE(r.data.length, d + 4);
    r.data.copy(buf, payloadOff.get(r));
  }
  return buf;
}

/** Wrap a .rsrc section in a minimal but structurally valid PE image. */
function buildExe(rsrc, { magic = 0x10b, trailer = null } = {}) {
  const optSize = magic === 0x20b ? 240 : 224;
  const peOff = 0x80;
  const headerSize = peOff + 24 + optSize + 40;
  const rawStart = (headerSize + 0x1ff) & ~0x1ff;
  const extra = trailer ? trailer.length : 0;
  const buf = Buffer.alloc(rawStart + rsrc.length + extra);

  buf.writeUInt16LE(0x5a4d, 0); // MZ
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x00004550, peOff); // PE\0\0
  buf.writeUInt16LE(0x8664, peOff + 4); // machine
  buf.writeUInt16LE(1, peOff + 6); // one section
  buf.writeUInt16LE(optSize, peOff + 20);

  const optOff = peOff + 24;
  buf.writeUInt16LE(magic, optOff);
  const dirOff = optOff + (magic === 0x20b ? 112 : 96);
  buf.writeUInt32LE(RSRC_RVA, dirOff + 16); // data directory 2 = resources
  buf.writeUInt32LE(rsrc.length, dirOff + 20);

  const secOff = optOff + optSize;
  buf.write('.rsrc\0\0\0', secOff, 8, 'ascii');
  buf.writeUInt32LE(rsrc.length, secOff + 8); // virtual size
  buf.writeUInt32LE(RSRC_RVA, secOff + 12); // virtual address
  buf.writeUInt32LE(rsrc.length, secOff + 16); // raw size
  buf.writeUInt32LE(rawStart, secOff + 20); // raw pointer

  rsrc.copy(buf, rawStart);
  if (trailer) trailer.copy(buf, rawStart + rsrc.length);
  return buf;
}

/**
 * A stand-in for a real Electron app's .exe: one 48px DIB frame, one 256px PNG
 * frame, and optional version strings.
 */
function sampleExe(opts = {}) {
  const dib = makeDib(48, 48);
  const png = makePng(256);
  const group = makeGroup([
    { width: 48, height: 48, bitCount: 32, size: dib.length, id: 1 },
    { width: 0, height: 0, bitCount: 32, size: png.length, id: 2 }, // 0 means 256
  ]);
  const resources = [
    { type: RT_ICON, id: 1, data: dib },
    { type: RT_ICON, id: 2, data: png },
    { type: RT_GROUP_ICON, id: 1, data: group },
  ];
  if (opts.strings) {
    resources.push({ type: RT_VERSION, id: 1, data: makeVersionInfo(opts.strings) });
  }
  const trailer = opts.asarIntegrity
    ? Buffer.from('ElectronAsarIntegrity', 'utf16le')
    : null;
  return buildExe(buildRsrc(resources), { magic: opts.magic, trailer });
}

module.exports = {
  makeDib,
  makePng,
  makeGroup,
  makeVersionInfo,
  buildRsrc,
  buildExe,
  sampleExe,
  RT_ICON,
  RT_GROUP_ICON,
  RT_VERSION,
};
