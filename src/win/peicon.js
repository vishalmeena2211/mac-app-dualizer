'use strict';
//
// peicon.js — read the icon out of a Windows .exe, stamp a colored badge on it,
// and write it back out as a standalone .ico file.
//
// Windows keeps an executable's icons in the PE resource directory rather than
// as loose files, so there is no `iconutil` equivalent to lean on. We parse the
// resource tree directly: RT_GROUP_ICON (type 14) holds the directory of sizes,
// and each entry points at an RT_ICON (type 3) holding one image. Converting
// that pair into a .ico is mostly a matter of swapping each entry's resource id
// for a file offset.
//
// Everything here is pure buffer work with no native dependencies, so it can be
// exercised on any platform — see test/peicon.test.js.
//
const { eachBadgePixel, hexToRgb, MIN_BADGE_WIDTH } = require('../badge');
const { parsePe, collectType, RT_ICON, RT_GROUP_ICON } = require('./pe');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- Icon extraction ---------------------------------------------------------

/**
 * Extract the executable's primary icon as a list of image entries.
 *
 * Returns null when the file has no usable icon group. Each entry carries the
 * ICONDIRENTRY metadata plus the raw image payload (a PNG or a BMP DIB).
 */
function extractIconGroup(buf) {
  const pe = parsePe(buf);
  if (!pe) return null;

  const groups = collectType(buf, pe, RT_GROUP_ICON);
  const icons = collectType(buf, pe, RT_ICON);
  if (groups.size === 0 || icons.size === 0) return null;

  // Windows shows the lowest-numbered icon group as the application icon.
  const groupId = [...groups.keys()].sort((a, b) => a - b)[0];
  const group = groups.get(groupId);
  if (group.length < 6) return null;

  const count = group.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14; // GRPICONDIRENTRY is 14 bytes
    if (o + 14 > group.length) break;
    const nId = group.readUInt16LE(o + 12);
    const data = icons.get(nId);
    if (!data) continue;
    entries.push({
      width: group.readUInt8(o),
      height: group.readUInt8(o + 1),
      colorCount: group.readUInt8(o + 2),
      planes: group.readUInt16LE(o + 4),
      bitCount: group.readUInt16LE(o + 6),
      data,
    });
  }
  return entries.length ? entries : null;
}

// --- Badging -----------------------------------------------------------------

/**
 * Stamp the badge onto every frame we know how to edit.
 *
 * 32-bit DIBs and PNG frames are badged in place. Paletted DIBs (legacy 4/8-bit
 * frames) are left alone: repainting them would mean rewriting the palette for
 * very small icons Windows almost never displays on a modern desktop.
 */
function badgeEntries(entries, color, PNG) {
  const { r, g, b } = hexToRgb(color);
  let badged = 0;
  for (const entry of entries) {
    try {
      if (isPng(entry.data)) {
        if (!PNG) continue;
        entry.data = badgePng(entry.data, r, g, b, PNG);
      } else {
        const next = badgeDib(entry.data, r, g, b);
        if (!next) continue;
        entry.data = next;
      }
      badged++;
    } catch {
      // A frame we can't edit keeps its original artwork.
    }
  }
  return badged;
}

function isPng(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

function badgePng(data, r, g, b, PNG) {
  const png = PNG.sync.read(data);
  if (png.width < MIN_BADGE_WIDTH) return data;
  eachBadgePixel(png.width, png.height, (x, y, isRing) => {
    const i = (png.width * y + x) << 2;
    png.data[i] = isRing ? 255 : r;
    png.data[i + 1] = isRing ? 255 : g;
    png.data[i + 2] = isRing ? 255 : b;
    png.data[i + 3] = 255;
  });
  return PNG.sync.write(png);
}

/**
 * Badge a 32bpp BMP DIB icon frame.
 *
 * Icon DIBs store biHeight as twice the real height (the XOR color bitmap
 * followed by a 1bpp AND transparency mask) and lay rows out bottom-up. We
 * repaint the color pixels and clear the matching AND-mask bits so the badge
 * isn't masked away on the legacy rendering path.
 */
function badgeDib(data, r, g, b) {
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  if (headerSize !== 40) return null; // not a BITMAPINFOHEADER
  const width = data.readInt32LE(4);
  const height = Math.floor(data.readInt32LE(8) / 2);
  const bitCount = data.readUInt16LE(14);
  if (bitCount !== 32 || width < MIN_BADGE_WIDTH || height <= 0) return null;

  const xorSize = width * height * 4;
  if (headerSize + xorSize > data.length) return null;

  const out = Buffer.from(data);
  const andStride = Math.ceil(width / 32) * 4; // 1bpp rows pad to 4 bytes
  const andStart = headerSize + xorSize;
  const hasAndMask = andStart + andStride * height <= out.length;

  eachBadgePixel(width, height, (x, y, isRing) => {
    const row = height - 1 - y; // rows run bottom-up
    const i = headerSize + (row * width + x) * 4;
    out[i] = isRing ? 255 : b; // DIB pixels are BGRA
    out[i + 1] = isRing ? 255 : g;
    out[i + 2] = isRing ? 255 : r;
    out[i + 3] = 255;
    if (hasAndMask) {
      const mi = andStart + row * andStride + (x >> 3);
      out[mi] &= ~(0x80 >> (x & 7)) & 0xff; // 0 = opaque
    }
  });
  return out;
}

// --- .ico output -------------------------------------------------------------

/** Assemble entries into a .ico file. */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(count, 4);

  let offset = header.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(e.width & 0xff, o); // 0 means 256
    header.writeUInt8(e.height & 0xff, o + 1);
    header.writeUInt8(e.colorCount & 0xff, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(e.planes, o + 4);
    header.writeUInt16LE(e.bitCount, o + 6);
    header.writeUInt32LE(e.data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

/**
 * Full pipeline: .exe bytes in, badged .ico bytes out.
 * Returns null when the executable has no icon we can read.
 */
function badgedIcoFromExe(exeBuffer, color, PNG) {
  const entries = extractIconGroup(exeBuffer);
  if (!entries) return null;
  if (color) badgeEntries(entries, color, PNG);
  return buildIco(entries);
}

module.exports = {
  parsePe,
  extractIconGroup,
  badgeEntries,
  buildIco,
  badgedIcoFromExe,
  isPng,
  badgeDib,
};
