import { Bitmap, bayer } from './bitmap.js';
import { parseColor } from './color.js';

/** Procedural pixel art: shaded balls, the pea logo, clouds. */

const tones = list => list.map(parseColor);

/** [outline, dark, mid, light, shine] */
export const PEA = tones(['#1d4d2b', '#2e8b3a', '#46b04a', '#8fd95a', '#f1ffd0']);
export const PLUM = tones(['#2e1740', '#6d3fa8', '#9a5fd0', '#c79bf0', '#f6ecff']);
const LEAF = tones(['#1d4d2b', '#46b04a', '#b5e35a']);

/** A small deterministic random source, so procedural art never flickers. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lit sphere with dithered shading bands: light from the upper left. */
export function paintBall(bitmap, cx, cy, r, [outline, dark, mid, light, shine]) {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const distance = Math.hypot(x, y);
      if (distance > r + 0.35) continue;
      let color = outline;
      if (distance <= r - 0.7) {
        const nx = x / r;
        const ny = y / r;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = -nx * 0.45 - ny * 0.6 + nz * 0.66 + (bayer(cx + x, cy + y) - 0.5) * 0.2;
        color = lit > 0.8 ? light : lit > 0.42 ? mid : dark;
      }
      bitmap.set(cx + x, cy + y, color);
    }
  }
  if (r >= 4) {
    const size = Math.max(1, Math.round(r / 5));
    bitmap.fill(cx - Math.round(r * 0.42), cy - Math.round(r * 0.5), size, size, shine);
  }
}

/** The Pea OS logo at any size: a pea with a little sprout. */
export function makePea(size) {
  const bitmap = new Bitmap(size, size);
  const r = Math.floor(size * 0.36);
  const cx = Math.floor(size / 2) - 1;
  const cy = size - r - 1;
  const [edge, leaf, glow] = LEAF;
  const stem = Math.max(2, Math.round(r * 0.3));
  const length = Math.max(3, Math.round(r * 0.8));
  const height = Math.max(1, Math.round(r * 0.22));
  const tipX = cx + Math.round(stem * 0.4);
  const tipY = cy - r - stem;

  // A pointed leaf growing from the stem tip, tilted slightly upward.
  for (let dx = 0; dx <= length; dx++) {
    const u = dx / length * 2 - 1;
    const half = height * (1 - u * u);
    const lift = Math.round(dx * 0.2);
    for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++) {
      if (Math.abs(dy) > half + 0.3) continue;
      const rim = Math.abs(dy) > half - 0.9 || dx === 0 || dx === length;
      bitmap.set(tipX + dx, tipY + dy - lift, rim ? edge : dy < 0 ? glow : leaf);
    }
  }
  for (let i = 0; i <= stem; i++) bitmap.fill(cx + Math.round(i * 0.4), cy - r + 1 - i, r >= 10 ? 2 : 1, 1, edge);
  paintBall(bitmap, cx, cy, r, PEA);
  return bitmap;
}

export function makeBall(r, palette) {
  const bitmap = new Bitmap(r * 2 + 1, r * 2 + 1);
  paintBall(bitmap, r, r, r, palette);
  return bitmap;
}

/** A flat-bottomed cumulus built from overlapping puffs. */
export function makeCloud(width, height, color, shade, random) {
  const bitmap = new Bitmap(width, height);
  const puffs = Math.max(3, Math.round(width / 9));
  for (let i = 0; i < puffs; i++) {
    const t = (i + 0.5) / puffs;
    const bulge = Math.sin(t * Math.PI);
    const r = Math.max(2, Math.round((height - 2) * (0.35 + 0.6 * bulge) * (0.8 + random() * 0.3)));
    const cx = Math.round(r + t * (width - 2 * r));
    bitmap.disc(cx, height - 1, Math.min(r, height - 1), color);
  }
  for (let x = 0; x < width; x++) {
    for (let y = height - 1; y >= height - 2; y--) {
      if (bitmap.get(x, y) && (y === height - 1 || (x & 1))) bitmap.px[y * width + x] = shade;
    }
  }
  return bitmap;
}
