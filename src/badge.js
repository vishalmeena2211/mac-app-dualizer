'use strict';
//
// badge.js — geometry for the little colored dot we stamp onto a clone's icon.
//
// Shared by the macOS path (badges PNGs inside a .iconset) and the Windows path
// (badges the frames of an .ico extracted from a .exe) so a clone looks the same
// on both platforms.
//
// The badge is a filled circle with a white ring, in the bottom-right corner,
// sized relative to the image so it reads at every icon size.
//

/** Circle placement for an image of the given size. */
function badgeGeometry(width, height) {
  const R = Math.round(width * 0.22);
  return {
    R,
    cx: width - R - Math.round(width * 0.07),
    cy: height - R - Math.round(height * 0.07),
    ring: Math.max(2, Math.round(R * 0.16)),
  };
}

/**
 * Walk every pixel covered by the badge.
 *
 * Calls cb(x, y, isRing) with image coordinates (top-left origin); `isRing` is
 * true for the white outer ring and false for the tinted interior.
 */
function eachBadgePixel(width, height, cb) {
  const { R, cx, cy, ring } = badgeGeometry(width, height);
  const y0 = Math.max(0, cy - R - ring);
  const y1 = Math.min(height, cy + R + ring);
  const x0 = Math.max(0, cx - R - ring);
  const x1 = Math.min(width, cx + R + ring);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > R) continue;
      cb(x, y, dist > R - ring);
    }
  }
}

/** Images below this width are too small for the badge to be legible. */
const MIN_BADGE_WIDTH = 32;

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) throw new Error(`invalid color: ${hex}`);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

module.exports = { badgeGeometry, eachBadgePixel, hexToRgb, MIN_BADGE_WIDTH };
