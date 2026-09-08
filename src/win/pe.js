'use strict';
//
// pe.js — just enough of the PE/COFF format to read an executable's resource
// directory. Used to pull out an app's icon (peicon.js) and its version strings
// (appinfo.js).
//
// Pure buffer arithmetic, no native dependencies, so it runs and can be tested
// on any platform.
//

/** Standard resource type ids. */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

/**
 * Locate the resource directory and build an RVA -> file offset mapper.
 * Returns null if the buffer is not a PE image or carries no resources.
 */
function parsePe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null;
  if (buf.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"

  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null; // "PE\0\0"

  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  if (optSize === 0 || optOff + optSize > buf.length) return null;

  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  // The data directories follow the optional header's fixed part: 96 bytes for
  // PE32, 112 for PE32+ (the difference is the 64-bit-widened address fields).
  const dirOff = optOff + (magic === 0x20b ? 112 : 96);
  if (dirOff + 24 > buf.length) return null;

  const resRva = buf.readUInt32LE(dirOff + 16); // directory entry 2 = resources
  const resSize = buf.readUInt32LE(dirOff + 20);
  if (!resRva || !resSize) return null;

  const sections = [];
  const secOff = optOff + optSize;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    if (o + 40 > buf.length) break;
    sections.push({
      virtualAddress: buf.readUInt32LE(o + 12),
      virtualSize: buf.readUInt32LE(o + 8),
      rawSize: buf.readUInt32LE(o + 16),
      rawPointer: buf.readUInt32LE(o + 20),
    });
  }

  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        const off = rva - s.virtualAddress + s.rawPointer;
        return off < buf.length ? off : null;
      }
    }
    return null;
  };

  const resBase = rvaToOffset(resRva);
  if (resBase === null) return null;
  return { resBase, rvaToOffset, magic };
}

/**
 * Read one IMAGE_RESOURCE_DIRECTORY.
 * Returns [{ id, isDir, offset }] where `id` is null for name-keyed entries.
 */
function readDirEntries(buf, resBase, dirOffset) {
  const base = resBase + dirOffset;
  if (base < 0 || base + 16 > buf.length) return [];
  const named = buf.readUInt16LE(base + 12);
  const ids = buf.readUInt16LE(base + 14);
  const out = [];
  for (let i = 0; i < named + ids; i++) {
    const e = base + 16 + i * 8;
    if (e + 8 > buf.length) break;
    const name = buf.readUInt32LE(e);
    const off = buf.readUInt32LE(e + 4);
    out.push({
      id: name & 0x80000000 ? null : name, // high bit set => string-named
      isDir: !!(off & 0x80000000),
      offset: off & 0x7fffffff,
    });
  }
  return out;
}

/** Follow an IMAGE_RESOURCE_DATA_ENTRY to the bytes it describes. */
function readLeaf(buf, pe, dirOffset) {
  const o = pe.resBase + dirOffset;
  if (o < 0 || o + 16 > buf.length) return null;
  const dataRva = buf.readUInt32LE(o);
  const size = buf.readUInt32LE(o + 4);
  const start = pe.rvaToOffset(dataRva);
  if (start === null || size === 0 || start + size > buf.length) return null;
  return buf.subarray(start, start + size);
}

/**
 * Descend Type -> Name -> Language and collect every leaf under `type`,
 * keyed by its resource id. Takes the first language of each entry, since the
 * resources we care about rarely vary by locale.
 */
function collectType(buf, pe, type) {
  const found = new Map();
  for (const t of readDirEntries(buf, pe.resBase, 0)) {
    if (t.id !== type || !t.isDir) continue;
    for (const n of readDirEntries(buf, pe.resBase, t.offset)) {
      if (!n.isDir || n.id === null) continue;
      for (const l of readDirEntries(buf, pe.resBase, n.offset)) {
        if (l.isDir) continue;
        const data = readLeaf(buf, pe, l.offset);
        if (data && !found.has(n.id)) found.set(n.id, data);
        break;
      }
    }
  }
  return found;
}

module.exports = {
  parsePe,
  readDirEntries,
  readLeaf,
  collectType,
  RT_ICON,
  RT_GROUP_ICON,
  RT_VERSION,
};
