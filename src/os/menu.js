import { Widget } from '../ui/widget.js';
import { BAR_H, SHADOW } from '../gfx/skin.js';

const ITEM_H = 13;
const SEPARATOR_H = 5;

const shorten = (font, text, width) => {
  if (font.measure(text) <= width) return text;
  let value = text;
  while (value && font.measure(`${value}…`) > width) value = value.slice(0, -1);
  return `${value}…`;
};

/** The bar across the top: menu titles on the left, the clock on the right. */
export class MenuBar extends Widget {
  interactive = true;
  focusable = true;
  #open = null;
  #slots = [];
  #clock = '';

  /** menus: [{ title, sprite }]; clock: Signal<string>; onMenu(index); onContext(event) */
  constructor(ui, { menus, clock, onMenu, onContext }) {
    super(ui);
    this.menus = menus;
    this.onMenu = onMenu;
    this.onContext = onContext;
    this.watch(clock, text => {
      this.#clock = text;
      this.invalidate();
    });
  }

  /** Which menu is shown as open, or null. */
  setOpen(index) {
    if (index === this.#open) return;
    this.#open = index;
    this.invalidate();
  }

  /** The on-screen x of a menu title, for anchoring its popup. */
  slot(index) {
    return this.#slots.find(slot => slot.index === index) ?? { x: 0, w: 0 };
  }

  get overflow() { return this.menus.map((_, index) => index).filter(index => !this.#slots.some(slot => slot.index === index)); }

  paint(bitmap, theme) {
    const { font, sprites } = this.ui;
    const bar = theme.color('bar');
    const ink = theme.color('bar-ink');
    bitmap.fill(0, 0, this.w, this.h - 1, bar);
    bitmap.fill(0, this.h - 1, this.w, 1, theme.color('ink'));

    let x = 2;
    this.#slots = [];
    for (let index = 0; index < this.menus.length; index++) {
      const { title, sprite } = this.menus[index];
      const style = { bold: index === 0 };
      const picture = sprite ? sprites.get(sprite).frames[0] : null;
      const w = (picture ? picture.width + 3 : 0) + font.measure(title, style) + 8;
      const reserve = index === this.menus.length - 1 ? 0 : 28;
      if (x + w + reserve > this.w - 2 && index > 0) {
        const width = Math.max(12, Math.min(27, this.w - x - 2));
        if (this.#open === -1) bitmap.fill(x, 0, width, this.h - 1, ink);
        font.draw(bitmap, '…', x + 6, 3, this.#open === -1 ? bar : ink);
        this.#slots.push({ x, w: width, index: -1 });
        x += width;
        break;
      }
      const open = index === this.#open;
      if (open) bitmap.fill(x, 0, w, this.h - 1, ink);
      let at = x + 4;
      if (picture) {
        bitmap.blit(picture, at, (this.h - 1 - picture.height) >> 1);
        at += picture.width + 3;
      }
      font.draw(bitmap, title, at, 3, open ? bar : ink, style);
      const slot = { x, w, index };
      x += w;
      this.#slots.push(slot);
    }

    // The clock gives way when the menus need the room.
    const clockX = this.w - font.measure(this.#clock) - 4;
    if (clockX > x + 2) font.draw(bitmap, this.#clock, clockX, 3, ink);
  }

  menu(event) {
    this.onContext(event);
    return true;
  }

  pointer(type, event) {
    if (type !== 'down') return;
    const slot = this.#slots.find(slot => event.x >= slot.x && event.x < slot.x + slot.w);
    if (slot) this.onMenu(slot.index);
  }

  key(type, event) {
    if (type !== 'down') return false;
    const choices = this.#slots.map(slot => slot.index);
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const at = choices.indexOf(this.#open);
      this.onMenu(choices[(at + (event.key === 'ArrowLeft' ? -1 : 1) + choices.length) % choices.length]);
      return true;
    }
    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { this.onMenu(this.#open ?? choices[0]); return true; }
    return false;
  }
}

const ICON_W = 12;

/** Draws a menu icon centered in a 9x9 cell: a glyph takes the text's color, a mini icon keeps its own. */
export function drawIcon(bitmap, sprites, id, x, y, ink) {
  if (!id || !sprites.has(id)) return;
  const picture = sprites.get(id).frames[0];
  const at = [x + ((9 - picture.width) >> 1), y + ((9 - picture.height) >> 1)];
  if (id.startsWith('glyph-')) bitmap.stamp(picture, ...at, ink);
  else bitmap.blit(picture, ...at);
}

/**
 * A dropdown list. items: [{ text, action, checked, icon, shortcut, disabled }]
 * or { separator: true }. When any item has an icon, a column is kept for
 * icons so the labels line up.
 */
export class Popup extends Widget {
  focusMark = 'none'; // the hot item is the focus
  interactive = true;
  focusable = true;
  #hover = -1;
  #pressed = -1;
  #scroll = 0;

  constructor(ui, { items, onPick, onClose = () => {}, onNavigate = null }) {
    super(ui);
    this.items = items;
    this.onPick = onPick;
    this.onClose = onClose;
    this.onNavigate = onNavigate;
  }

  content() {
    const { font } = this.ui;
    const width = Math.max(40, ...this.items.map(item => (item.separator ? 0 : font.measure(item.text) + (item.shortcut ? font.measure(item.shortcut) + 18 : 0))));
    const height = this.items.reduce((sum, item) => sum + (item.separator ? SEPARATOR_H : ITEM_H), 0);
    return { w: width + 22 + this.#iconColumn() + SHADOW, h: height + 4 + SHADOW };
  }

  #iconColumn() {
    return this.items.some(item => item.icon) ? ICON_W : 0;
  }

  #rows() {
    let y = this.#top() - this.#scroll;
    return this.items.map((item, index) => {
      const row = { item, index, y, h: item.separator ? SEPARATOR_H : ITEM_H };
      y += row.h;
      return row;
    });
  }

  /** The middle of the item with this text, in the popup's own pixels; null when there is none. */
  locate(text) {
    const index = this.items.findIndex(item => item.text === text);
    this.#reveal(index);
    const row = this.#rows().find(({ item }) => item.text === text);
    return row ? { x: (this.w - SHADOW) >> 1, y: row.y + (row.h >> 1) } : null;
  }

  paint(bitmap, theme) {
    const { font, sprites } = this.ui;
    const w = this.w - SHADOW;
    const left = 14 + this.#iconColumn();
    const h = this.h - SHADOW;
    if (theme.has('shadow')) bitmap.fill(SHADOW, SHADOW, w, h, theme.color('shadow'));
    bitmap.fill(0, 0, w, h, theme.color('paper'));
    bitmap.frame(0, 0, w, h, theme.color('ink'));
    this.#rows().forEach(({ item, index, y, h: rowH }) => {
      if (y < this.#top() || y + rowH > this.#bottom()) return;
      if (item.separator) {
        bitmap.fill(3, y + 2, w - 6, 1, theme.color('dim'));
        return;
      }
      const hot = index === this.#hover && !item.disabled;
      if (hot) bitmap.fill(1, y, w - 2, rowH, theme.color('accent'));
      const ink = theme.color(item.disabled ? 'dim' : hot ? 'accent-ink' : 'text');
      const quiet = theme.color(hot ? 'accent-ink' : 'dim');
      if (item.checked) font.draw(bitmap, '✓', 4, y + 3, ink);
      if (item.icon) drawIcon(bitmap, sprites, item.icon, 14, y + 2, quiet);
      const shortcutWidth = item.shortcut ? font.measure(item.shortcut) + 8 : 0;
      font.draw(bitmap, shorten(font, item.text, w - left - 6 - shortcutWidth), left, y + 3, ink);
      if (item.shortcut) font.draw(bitmap, item.shortcut, w - shortcutWidth, y + 3, item.disabled ? ink : quiet);
    });
    if (this.#overflow()) {
      font.draw(bitmap, this.#scroll > 0 ? '↑' : '·', (w - 5) >> 1, 2, theme.color('dim'));
      font.draw(bitmap, this.#scroll < this.#maxScroll() ? '↓' : '·', (w - 5) >> 1, h - 10, theme.color('dim'));
    }
  }

  pointer(type, event) {
    if (this.#overflow() && type === 'down' && (event.y < this.#top() || event.y >= this.#bottom())) {
      this.#scrollBy(event.y < this.#top() ? -ITEM_H * 3 : ITEM_H * 3);
      return;
    }
    const index = this.#indexAt(event);
    if (type === 'down') this.#pressed = index;
    const hover = type === 'down' || type === 'move' ? index : -1;
    if (hover !== this.#hover) {
      this.#hover = hover;
      this.invalidate();
    }
    if (type === 'up' && index >= 0 && index === this.#pressed) this.onPick(this.items[index]);
    if (type === 'up' || type === 'cancel') this.#pressed = -1;
  }

  #total() { return this.items.reduce((sum, item) => sum + (item.separator ? SEPARATOR_H : ITEM_H), 0); }
  #overflow() { return this.#total() > this.h - SHADOW - 4; }
  #top() { return this.#overflow() ? 12 : 2; }
  #bottom() { return this.h - SHADOW - (this.#overflow() ? 12 : 2); }
  #maxScroll() { return Math.max(0, this.#total() - (this.#bottom() - this.#top())); }
  #scrollBy(amount) { this.#scroll = Math.max(0, Math.min(this.#maxScroll(), this.#scroll + amount)); this.invalidate(); }
  #indexAt(event) {
    if (!event.inside || event.y < this.#top() || event.y >= this.#bottom()) return -1;
    return this.#rows().find(row => !row.item.separator && !row.item.disabled && event.y >= row.y && event.y < row.y + row.h)?.index ?? -1;
  }
  #reveal(index) {
    const row = this.#rows()[index];
    if (!row) return;
    if (row.y < this.#top()) this.#scrollBy(row.y - this.#top());
    else if (row.y + row.h > this.#bottom()) this.#scrollBy(row.y + row.h - this.#bottom());
  }
  wheel(event) { this.#scrollBy(Math.sign(event.dy) * ITEM_H * 3); return true; }
  cursor(event) {
    const hover = this.#indexAt(event);
    if (hover !== this.#hover) { this.#hover = hover; this.invalidate(); }
    return hover >= 0 ? 'pointer' : 'default';
  }
  key(type, event) {
    if (type !== 'down') return false;
    if (event.key === 'Escape') { this.onClose(); return true; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { this.onNavigate?.(event.key === 'ArrowLeft' ? -1 : 1); return true; }
    const choices = this.items.map((item, index) => ({ item, index })).filter(({ item }) => !item.separator && !item.disabled).map(({ index }) => index);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
      if (!choices.length) return true;
      const at = choices.indexOf(this.#hover);
      const page = Math.max(1, Math.floor((this.#bottom() - this.#top()) / ITEM_H));
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[event.key] ?? 0;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (at + step + choices.length) % choices.length;
      this.#hover = choices[next]; this.#reveal(this.#hover); this.invalidate(); return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = this.items[this.#hover >= 0 ? this.#hover : choices[0]];
      if (item && !item.disabled) this.onPick(item);
      return true;
    }
    return false;
  }
}

export { BAR_H };
