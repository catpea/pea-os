import { over } from './color.js';

/**
 * A software pixel surface. Every piece of Pea OS art is painted here, one
 * integer pixel at a time, and then handed to the compositor as a texture.
 * Painting never touches a DOM or a GPU, so it is identical on every platform.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Ordered-dither threshold in (0, 1) for a pixel position. */
export const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

/** Row insets of a pixel-art rounded corner, by radius. */
const CORNERS = [[], [1], [2, 1], [3, 2, 1], [4, 2, 1, 1], [5, 3, 2, 1, 1]];

export class Bitmap {
  constructor(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.data = new Uint8Array(this.width * this.height * 4);
    this.px = new Uint32Array(this.data.buffer);
  }

  clear(color = 0) {
    this.px.fill(color);
    return this;
  }

  get(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.px[y * this.width + x] : 0;
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y | 0) * this.width + (x | 0);
    this.px[i] = over(this.px[i], color);
  }

  fill(x, y, w, h, color) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.width, (x | 0) + (w | 0));
    const y1 = Math.min(this.height, (y | 0) + (h | 0));
    if (x1 <= x0 || y1 <= y0 || color >>> 24 === 0) return;
    const opaque = color >>> 24 === 255;
    for (let row = y0; row < y1; row++) {
      const start = row * this.width + x0;
      if (opaque) this.px.fill(color, start, start + x1 - x0);
      else for (let i = start; i < start + x1 - x0; i++) this.px[i] = over(this.px[i], color);
    }
  }

  /** Makes a rectangle transparent again. */
  erase(x, y, w, h) {
    const x0 = Math.max(0, x | 0);
    const x1 = Math.min(this.width, (x | 0) + (w | 0));
    for (let row = Math.max(0, y | 0); row < Math.min(this.height, (y | 0) + (h | 0)); row++) {
      if (x1 > x0) this.px.fill(0, row * this.width + x0, row * this.width + x1);
    }
  }

  frame(x, y, w, h, color) {
    this.fill(x, y, w, 1, color);
    this.fill(x, y + h - 1, w, 1, color);
    this.fill(x, y + 1, 1, h - 2, color);
    this.fill(x + w - 1, y + 1, 1, h - 2, color);
  }

  /** Inset of row `j` in a rounded rectangle `h` rows tall. */
  static inset(radius, j, h) {
    const corner = CORNERS[Math.max(0, Math.min(radius, CORNERS.length - 1, h >> 1))];
    const k = Math.min(j, h - 1 - j);
    return k < corner.length ? corner[k] : 0;
  }

  roundFill(x, y, w, h, radius, color) {
    for (let j = 0; j < h; j++) {
      const inset = Bitmap.inset(radius, j, h);
      this.fill(x + inset, y + j, w - 2 * inset, 1, color);
    }
  }

  roundFrame(x, y, w, h, radius, color) {
    for (let j = 0; j < h; j++) {
      const inset = Bitmap.inset(radius, j, h);
      if (j === 0 || j === h - 1) {
        this.fill(x + inset, y + j, w - 2 * inset, 1, color);
        continue;
      }
      const outer = Bitmap.inset(radius, j < h / 2 ? j - 1 : j + 1, h);
      const span = Math.max(1, outer - inset);
      this.fill(x + inset, y + j, span, 1, color);
      this.fill(x + w - inset - span, y + j, span, 1, color);
    }
  }

  /** Two-color checkerboard: the classic 50% desktop dither. */
  checker(x, y, w, h, a, b) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) this.set(col, row, (col + row) & 1 ? b : a);
    }
  }

  /** Vertical gradient through `stops`, banded with ordered dithering. */
  gradient(x, y, w, h, stops) {
    const last = stops.length - 1;
    for (let j = 0; j < h; j++) {
      const t = h > 1 ? (j / (h - 1)) * last : 0;
      const index = Math.min(last, Math.floor(t));
      const next = Math.min(last, index + 1);
      const fraction = t - index;
      for (let i = 0; i < w; i++) {
        this.set(x + i, y + j, bayer(x + i, y + j) < fraction ? stops[next] : stops[index]);
      }
    }
  }

  disc(cx, cy, r, color, { dither = false } = {}) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r + r * 0.8) continue;
        if (dither && ((cx + x + cy + y) & 1)) continue;
        this.set(cx + x, cy + y, color);
      }
    }
  }

  line(x0, y0, x1, y1, color) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    for (let error = dx + dy; ;) {
      this.set(x0, y0, color);
      if (x0 === x1 && y0 === y1) return;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x0 += sx; }
      if (twice <= dx) { error += dx; y0 += sy; }
    }
  }

  /** Draws `src` with nearest-neighbor scaling and premultiplied blending. */
  blit(src, dx, dy, { sx = 0, sy = 0, sw = src.width - sx, sh = src.height - sy, scale = 1, flipX = false, alpha = 1 } = {}) {
    dx = Math.round(dx);
    dy = Math.round(dy);
    const fade = alpha < 1 ? Math.round(alpha * 255) : 255;
    if (fade <= 0) return;
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    for (let j = Math.max(0, -dy); j < h && dy + j < this.height; j++) {
      const row = sy + Math.min(sh - 1, Math.floor(j / scale));
      for (let i = Math.max(0, -dx); i < w && dx + i < this.width; i++) {
        const col = Math.min(sw - 1, Math.floor(i / scale));
        let color = src.px[row * src.width + sx + (flipX ? sw - 1 - col : col)];
        if (color >>> 24 === 0) continue;
        if (fade < 255) color = scaleAlpha(color, fade);
        const at = (dy + j) * this.width + dx + i;
        this.px[at] = over(this.px[at], color);
      }
    }
  }

  /** Draws the shape of `src` in one color: every pixel it covers becomes `color`. Glyph icons follow the text this way. */
  stamp(src, dx, dy, color) {
    dx = Math.round(dx);
    dy = Math.round(dy);
    for (let j = Math.max(0, -dy); j < src.height && dy + j < this.height; j++) {
      for (let i = Math.max(0, -dx); i < src.width && dx + i < this.width; i++) {
        if (src.px[j * src.width + i] >>> 24 === 0) continue;
        const at = (dy + j) * this.width + dx + i;
        this.px[at] = over(this.px[at], color);
      }
    }
  }

  /** Replaces every opaque pixel through `map(color)`: palette-locked themes. */
  remap(map) {
    const { px } = this;
    for (let i = 0; i < px.length; i++) if (px[i] >>> 24 === 255) px[i] = map(px[i]);
  }

  clone() {
    const copy = new Bitmap(this.width, this.height);
    copy.px.set(this.px);
    return copy;
  }
}

function scaleAlpha(color, fade) {
  const part = shift => ((((color >>> shift) & 255) * fade + 127) / 255 | 0);
  return ((part(24) << 24) | (part(16) << 16) | (part(8) << 8) | part(0)) >>> 0;
}
