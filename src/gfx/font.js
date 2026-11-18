/**
 * A proportional pixel font described in XML: one <glyph> per character,
 * drawn with "#" for ink and "." for paper.
 */
export class PixelFont {
  constructor(node) {
    node.expect({ attrs: ['version', 'id', 'height', 'cap', 'spacing', 'space', 'line-height'], children: ['glyph'] });
    this.id = node.need('id');
    this.height = node.num('height', 9);
    this.cap = node.num('cap', 7);
    this.spacing = node.num('spacing', 1);
    this.lineHeight = node.num('line-height', this.height + 2);
    this.glyphs = new Map([[' ', { w: node.num('space', 3), rows: [] }]]);

    for (const glyph of node.all('glyph')) {
      glyph.expect({ attrs: ['ch'], text: true });
      const ch = glyph.need('ch');
      const rows = glyph.rows();
      if ([...ch].length !== 1) glyph.fail(`ch="${ch}" must be exactly one character`);
      if (this.glyphs.has(ch)) glyph.fail(`"${ch}" is defined twice`);
      if (rows.length > this.height) glyph.fail(`"${ch}" has ${rows.length} rows; the font height is ${this.height}`);
      if (rows.some(row => /[^#.]/.test(row))) glyph.fail(`"${ch}" may only use "#" and "."`);
      this.glyphs.set(ch, {
        w: Math.max(...rows.map(row => row.length)),
        rows: rows.map(row => [...row].reduce((bits, cell, i) => (cell === '#' ? bits | (1 << i) : bits), 0))
      });
    }
    this.missing = this.glyphs.get('?') ?? { w: 3, rows: [] };
  }

  glyph(ch) {
    return this.glyphs.get(ch) ?? this.missing;
  }

  measure(text, { scale = 1, bold = false } = {}) {
    let width = 0;
    for (const ch of text) width += this.glyph(ch).w + this.spacing + (bold ? 1 : 0);
    return Math.max(0, width - this.spacing) * scale;
  }

  /** Draws one line with its top-left corner at (x, y); returns the next x. */
  draw(bitmap, text, x, y, color, { scale = 1, bold = false } = {}) {
    for (const ch of text) {
      const { w, rows } = this.glyph(ch);
      for (let row = 0; row < rows.length; row++) {
        for (let col = 0; col < w; col++) {
          if (!(rows[row] & (1 << col))) continue;
          // Bold thickens a stroke to the right, unless that would close a one-pixel gap.
          const gap = !(rows[row] & (2 << col)) && rows[row] & (4 << col);
          bitmap.fill(x + col * scale, y + row * scale, scale * (bold && !gap ? 2 : 1), scale, color);
        }
      }
      x += (w + this.spacing + (bold ? 1 : 0)) * scale;
    }
    return x;
  }

  /** Text with a one-pixel outline, readable on any wallpaper. */
  drawOutlined(bitmap, text, x, y, color, edge, options) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (dx || dy) this.draw(bitmap, text, x + dx, y + dy, edge, options);
    }
    return this.draw(bitmap, text, x, y, color, options);
  }

  /** Greedy word wrap; explicit newlines are kept. */
  wrap(text, maxWidth, options) {
    const lines = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && this.measure(candidate, options) > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  }
}
