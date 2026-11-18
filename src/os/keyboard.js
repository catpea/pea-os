import { Widget } from '../ui/widget.js';
import { button } from '../gfx/skin.js';

const ROW_H = 15;
const key = (label, value = label, span = 1) => ({ label, value, span });
const keys = text => [...text].map(ch => key(ch));

const LAYERS = {
  abc: [
    keys('qwertyuiop'),
    keys('asdfghjkl'),
    [key('↑', 'Shift', 1.5), ...keys('zxcvbnm'), key('←', 'Backspace', 1.5)],
    [key('123', 'layer:123', 2), key('space', ' ', 5), key('.'), key('Enter', 'Enter', 2)]
  ],
  123: [
    keys('1234567890'),
    keys('-/:;()&@"'),
    [key('#', '#', 1.5), ...keys(',?!\'+=*'), key('←', 'Backspace', 1.5)],
    [key('abc', 'layer:abc', 2), key('space', ' ', 5), key('.'), key('Enter', 'Enter', 2)]
  ]
};

/**
 * The on-screen keyboard. It types into the same key events a hardware
 * keyboard produces, so every app that reads keys works on a touch screen
 * without knowing which one it has.
 */
export class Keyboard extends Widget {
  static HEIGHT = 4 * ROW_H + 3;

  interactive = true;
  #layer = 'abc';
  #shift = false;
  #down = null;

  /** onKey(key): 'a', 'A', ' ', 'Backspace', 'Enter', ... */
  constructor(ui, { onKey }) {
    super(ui);
    this.onKey = onKey;
  }

  /** Every key of the current layer with its rectangle. */
  #keys() {
    const unit = Math.floor((this.w - 2) / 10);
    return LAYERS[this.#layer].flatMap((row, r) => {
      const total = row.reduce((sum, item) => sum + item.span, 0);
      let x = (this.w - total * unit) >> 1;
      return row.map(item => {
        const w = Math.round(item.span * unit);
        const rect = { ...item, x, y: 2 + r * ROW_H, w: w - 1, h: ROW_H - 1 };
        x += w;
        return rect;
      });
    });
  }

  /** The middle of a key on the current layer, in the keyboard's own pixels; null when it is not there. */
  locate(value) {
    const item = this.#keys().find(candidate => candidate.value === value);
    return item ? { x: item.x + (item.w >> 1), y: item.y + (item.h >> 1) } : null;
  }

  #at(event) {
    return this.#keys().find(({ x, y, w, h }) => event.x >= x && event.x < x + w + 1 && event.y >= y && event.y < y + h + 1) ?? null;
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    bitmap.fill(0, 1, this.w, this.h - 1, theme.color('bar'));
    bitmap.fill(0, 0, this.w, 1, theme.color('ink'));
    for (const item of this.#keys()) {
      const held = item.value === this.#down || (item.value === 'Shift' && this.#shift);
      const special = item.value.length > 1;
      const face = held ? 'accent' : special ? 'bar' : 'panel';
      const top = button(bitmap, theme, item.x, item.y, item.w, item.h, { pressed: held, face, radius: 2 });
      const label = this.#shift && !special ? item.label.toUpperCase() : item.label;
      font.draw(bitmap, label, item.x + ((item.w - font.measure(label) + 1) >> 1), item.y + top + 2, theme.color(held ? 'accent-ink' : special ? 'bar-ink' : 'panel-ink'));
    }
  }

  pointer(type, event) {
    const item = type === 'cancel' ? null : this.#at(event);
    if (type === 'down' || type === 'move') {
      const down = item?.value ?? null;
      if (down !== this.#down) {
        this.#down = down;
        this.invalidate();
      }
      return;
    }
    this.#down = null;
    this.invalidate();
    if (!item) return;
    if (item.value === 'Shift') {
      this.#shift = !this.#shift;
    } else if (item.value.startsWith('layer:')) {
      this.#layer = item.value.slice(6);
      this.#shift = false;
    } else {
      this.onKey(this.#shift && item.value.length === 1 ? item.value.toUpperCase() : item.value);
      this.#shift = false;
    }
  }
}
