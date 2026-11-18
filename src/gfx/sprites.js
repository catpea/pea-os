import { Bitmap } from './bitmap.js';
import { parseColor } from './color.js';
import { ROLES } from './theme.js';

/**
 * Sprite sheets are XML pixel maps. Each character of a row is a palette key;
 * "." is transparent. A key maps to a fixed color or to a theme role, so art
 * can follow the active theme.
 *
 *   <sprites version="1">
 *     <color key="g" value="#46b04a"/>
 *     <color key="a" role="accent"/>
 *     <sprite id="dot">
 *       .g.
 *       gag
 *       .g.
 *     </sprite>
 *   </sprites>
 *
 * Animated sprites use <frame> children and an fps attribute.
 */
export class Sprites {
  #sheets = [];
  #makers = new Map();
  #built = new Map();
  #ids = new Set();

  /** Registers a parsed <sprites> document. */
  add(node) {
    node.expect({ attrs: ['version'], children: ['color', 'sprite'] });
    const palette = new Map();
    for (const color of node.all('color')) {
      color.expect({ attrs: ['key', 'value', 'role'] });
      const key = color.need('key');
      if (key.length !== 1 || key === '.') color.fail(`key="${key}" must be one character other than "."`);
      if (palette.has(key)) color.fail(`key="${key}" is defined twice`);
      if (color.has('value') === color.has('role')) color.fail('needs exactly one of "value" or "role"');
      if (color.has('role') && !(color.attr('role') in ROLES)) color.fail(`role="${color.attr('role')}" is unknown`);
      try {
        palette.set(key, color.has('role') ? { role: color.attr('role') } : { value: parseColor(color.attr('value')) });
      } catch (error) {
        color.fail(error.message);
      }
    }

    const sprites = node.all('sprite').map(sprite => {
      sprite.expect({ attrs: ['id', 'fps'], children: ['frame'], text: true });
      const id = sprite.need('id');
      this.#claim(id, sprite);
      const sources = sprite.all('frame').length ? sprite.all('frame') : [sprite];
      const frames = sources.map(source => {
        if (source !== sprite) source.expect({ text: true });
        const rows = source.rows();
        if (!rows.length) source.fail('has no pixel rows');
        const width = rows[0].length;
        for (const row of rows) {
          if (row.length !== width) source.fail(`row "${row}" is ${row.length} wide; expected ${width}`);
          for (const key of row) if (key !== '.' && !palette.has(key)) source.fail(`uses palette key "${key}" with no <color>`);
        }
        return rows;
      });
      const [first] = frames;
      if (frames.some(rows => rows.length !== first.length || rows[0].length !== first[0].length)) {
        sprite.fail('frames must all be the same size');
      }
      return { id, fps: sprite.num('fps', 8), frames };
    });
    this.#sheets.push({ palette, sprites });
  }

  /** Registers procedural art: make(theme) returns a Bitmap or an array of frames. */
  define(id, make, fps = 8) {
    this.#claim(id);
    this.#makers.set(id, { make, fps });
  }

  has(id) {
    return this.#ids.has(id);
  }

  ids() {
    return [...this.#ids];
  }

  /** Renders every sprite for a theme. Call again when the theme changes. */
  build(theme) {
    this.#built.clear();
    for (const { palette, sprites } of this.#sheets) {
      const color = key => {
        const entry = palette.get(key);
        return entry.role ? theme.color(entry.role) : theme.lock(entry.value);
      };
      for (const { id, fps, frames } of sprites) {
        this.#store(id, fps, frames.map(rows => {
          const bitmap = new Bitmap(rows[0].length, rows.length);
          rows.forEach((row, y) => [...row].forEach((key, x) => {
            if (key !== '.') bitmap.px[y * bitmap.width + x] = color(key);
          }));
          return bitmap;
        }));
      }
    }
    for (const [id, { make, fps }] of this.#makers) {
      const frames = [make(theme)].flat();
      if (theme.palette) for (const frame of frames) frame.remap(pixel => theme.lock(pixel));
      this.#store(id, fps, frames);
    }
  }

  get(id) {
    const sprite = this.#built.get(id);
    if (!sprite) throw new Error(`Unknown sprite "${id}". Known: ${this.ids().join(', ')}`);
    return sprite;
  }

  #claim(id, node) {
    if (this.#ids.has(id)) {
      if (node) node.fail(`id="${id}" is already used by another sprite`);
      throw new Error(`Sprite "${id}" is already defined`);
    }
    this.#ids.add(id);
  }

  #store(id, fps, frames) {
    this.#built.set(id, { id, fps, frames, width: frames[0].width, height: frames[0].height });
  }
}
