/**
 * Colors are packed 32-bit integers in the byte order of a little-endian RGBA
 * buffer (0xAABBGGRR) with premultiplied alpha, so one Uint32 write is a pixel.
 */

export const TRANSPARENT = 0;

export const rgba = (r, g, b, a = 255) => {
  const k = a / 255;
  return ((a << 24) | (Math.round(b * k) << 16) | (Math.round(g * k) << 8) | Math.round(r * k)) >>> 0;
};

export const channels = color => [color & 255, (color >>> 8) & 255, (color >>> 16) & 255, color >>> 24];

/** "#rgb", "#rrggbb" or "#rrggbbaa". */
export function parseColor(text) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim())?.[1];
  if (!hex) throw new Error(`"${text}" is not a color; use #rgb, #rrggbb or #rrggbbaa`);
  const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex;
  const n = parseInt(full.padEnd(8, 'f'), 16);
  return rgba(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function mix(a, b, t) {
  const ca = channels(a);
  const cb = channels(b);
  const at = i => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return ((at(3) << 24) | (at(2) << 16) | (at(1) << 8) | at(0)) >>> 0;
}

const WHITE = rgba(255, 255, 255);
const BLACK = rgba(0, 0, 0);

export const lighten = (color, t) => mix(color, WHITE, t);
export const darken = (color, t) => mix(color, BLACK, t);

/** Source-over for premultiplied colors. */
export function over(dst, src) {
  const a = src >>> 24;
  if (a === 255) return src;
  if (a === 0) return dst;
  const k = 255 - a;
  const blend = shift => ((src >>> shift) & 255) + ((((dst >>> shift) & 255) * k + 127) / 255 | 0);
  return ((Math.min(255, blend(24)) << 24) | (blend(16) << 16) | (blend(8) << 8) | blend(0)) >>> 0;
}

export const toHex = color => `#${channels(color).slice(0, 3).map(c => c.toString(16).padStart(2, '0')).join('')}`;
