import { Signal, EventEmitter } from '../core/reactive.js';
import { button, field } from '../gfx/skin.js';
import { Widget } from './widget.js';

const model = value => value instanceof Signal ? value : new Signal(value ?? null);
const same = (a, b) => String(a) === String(b);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const INDENT = 10;

/**
 * For a tree, which levels carry a branch line past each row: level L runs
 * on below row i when a later row at depth L follows before the tree climbs
 * above L. Row i's own level is its link to the next sibling.
 */
function rails(items) {
  return items.map((item, i) => {
    const runs = new Set();
    for (let level = 1; level <= item.depth; level++) {
      for (let j = i + 1; j < items.length && items[j].depth >= level; j++) {
        if (items[j].depth === level) { runs.add(level); break; }
      }
    }
    return runs;
  });
}

const fit = (font, text, width) => {
  let label = String(text ?? '');
  while (label.length && font.measure(label) > width) label = label.length <= 1 ? '' : `${label.slice(0, -2)}…`;
  return label;
};

/**
 * Selectable, scrolling rows. Enter or a double tap activates the selected
 * item. Items are { value, text, detail, sprite, disabled, depth }; a depth
 * makes the list a tree, each row indented under the one it belongs to.
 */
export class List extends Widget {
  static attrs = { ...Widget.attrs, value: 'model', options: 'list', action: 'action', activate: 'action', 'row-height': 'number', empty: 'text', drag: 'string' };
  interactive = true;
  focusable = true;
  events = new EventEmitter();
  scrollY = 0;
  #items = [];
  #rails = [];
  #pressed = -1;
  #from = null;
  #last = { index: -1, time: -Infinity };
  #drag = false;
  #prefix = '';
  #typed = 0;

  constructor(ui, props = {}) {
    super(ui, props);
    this.model = model(props.value);
    this.watch(props.options ?? props.items ?? [], items => { this.items = items; });
    this.watch(this.model, () => { this.revealSelection(); this.invalidate(); });
    this.watch(props.empty ?? 'No items', text => { this.empty = String(text); this.invalidate(); });
  }
  get items() { return this.#items; }
  set items(items) {
    if (!Array.isArray(items)) throw new TypeError('list options must be an array');
    this.#items = items.map(item => typeof item === 'object' && item !== null
      ? { ...item, text: String(item.text ?? item.value ?? ''), depth: Math.max(0, Math.floor(item.depth ?? 0)) }
      : { value: item, text: String(item), depth: 0 });
    this.#rails = rails(this.#items);
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    this.revealSelection(); this.invalidate(); this.ui.requestLayout();
  }
  setItems(items) { this.items = items; }
  get rowHeight() { return Math.max(13, this.props['row-height'] ?? (this.items.some(item => item.detail) ? 24 : 16)); }
  get maxScroll() { return Math.max(0, this.items.length * this.rowHeight - Math.max(0, this.h - 2)); }
  get selectedIndex() { return this.items.findIndex(item => same(item.value, this.model.value)); }
  get selectedItem() { return this.items[this.selectedIndex] ?? null; }
  content() { return { w: 140, h: Math.max(30, Math.min(7, this.items.length) * this.rowHeight + 2) }; }

  select(index) {
    const item = this.items[index];
    if (!this.enabled || !item || item.disabled) return false;
    if (this.model.set(item.value)) {
      this.events.emit('change', { value: item.value, item });
      this.props.onChange?.(item.value, this);
      if (this.props.action) this.context?.run(this.props.action, this);
    }
    this.revealSelection(); return true;
  }
  activate() {
    const item = this.selectedItem;
    if (!item || item.disabled || !this.enabled) return;
    this.events.emit('activate', { value: item.value, item });
    this.props.onActivate?.(item.value, item);
    if (this.props.activate) this.context?.run(this.props.activate, this);
  }
  revealSelection() {
    const index = this.selectedIndex;
    if (index < 0 || !this.h) return;
    const top = index * this.rowHeight;
    if (top < this.scrollY) this.scrollY = top;
    if (top + this.rowHeight > this.scrollY + this.h - 2) this.scrollY = top + this.rowHeight - (this.h - 2);
    this.scrollY = clamp(this.scrollY, 0, this.maxScroll);
  }
  resized() { this.revealSelection(); this.scrollY = clamp(this.scrollY, 0, this.maxScroll); }

  locate(value) {
    const index = this.items.findIndex(item => same(item.value, value));
    return index < 0 ? null : { x: Math.max(2, (this.w - 8) >> 1), y: 1 + index * this.rowHeight - this.scrollY + (this.rowHeight >> 1) };
  }

  paint(bitmap, theme) {
    field(bitmap, theme, 0, 0, this.w, this.h);
    const { font, sprites } = this.ui;
    const gutter = this.maxScroll > 0 ? 7 : 1;
    if (!this.items.length) font.draw(bitmap, fit(font, this.empty, this.w - 8), 4, 6, theme.color('dim'));
    const first = Math.max(0, Math.floor(this.scrollY / this.rowHeight));
    const last = Math.min(this.items.length, Math.ceil((this.scrollY + this.h) / this.rowHeight));
    for (let i = first; i < last; i++) {
      const item = this.items[i];
      const y = 1 + i * this.rowHeight - this.scrollY;
      const selected = same(item.value, this.model.value);
      if (selected) bitmap.fill(1, y, this.w - gutter - 1, this.rowHeight, theme.color('accent'));
      if (item.depth) this.#branch(bitmap, i, y, theme.color(selected ? 'accent-ink' : 'dim'));
      let x = 5 + item.depth * INDENT;
      const picture = item.sprite && sprites.has(item.sprite) ? sprites.get(item.sprite).frames[0] : null;
      // Centered on the first line of text: a 9-pixel icon fills it, a 5-pixel mark sits in its middle.
      if (picture) { bitmap.blit(picture, x, y + 3 + Math.max(0, (9 - picture.height) >> 1)); x += picture.width + 4; }
      const ink = theme.color(item.disabled ? 'dim' : selected ? 'accent-ink' : 'field-ink');
      font.draw(bitmap, fit(font, item.text, this.w - x - gutter - 4), x, y + 4, ink);
      if (item.detail) font.draw(bitmap, fit(font, item.detail, this.w - x - gutter - 4), x, y + 14, theme.color(selected ? 'accent-ink' : 'dim'));
    }
    bitmap.frame(0, 0, this.w, this.h, theme.color('ink'));
    if (this.maxScroll > 0) {
      const track = Math.max(1, this.h - 4);
      const knob = Math.max(4, Math.round(track * (this.h - 2) / (this.items.length * this.rowHeight)));
      bitmap.fill(this.w - 7, 1, 6, this.h - 2, theme.color('panel'));
      bitmap.fill(this.w - 6, 2 + Math.round((track - knob) * this.scrollY / this.maxScroll), 4, knob, theme.color('dim'));
    }
  }

  /** Dotted lines from a tree row up to the row it belongs to, and on past it to later siblings. */
  #branch(bitmap, index, y, ink) {
    const { depth } = this.items[index];
    const runs = this.#rails[index];
    const middle = y + 8;
    const dots = (x, from, to) => { for (let at = from; at < to; at++) if ((x + at) % 2 === 0) bitmap.fill(x, at, 1, 1, ink); };
    for (let level = 1; level <= depth; level++) {
      const x = 5 + (level - 1) * INDENT + 2;
      if (level < depth) { if (runs.has(level)) dots(x, y, y + this.rowHeight); continue; }
      dots(x, y, runs.has(level) ? y + this.rowHeight : middle + 1);
      for (let at = x + 1; at < x + INDENT - 3; at++) if ((at + middle) % 2 === 0) bitmap.fill(at, middle, 1, 1, ink);
    }
  }

  pointer(type, event) {
    if (!this.enabled) return;
    if (type === 'down' && this.maxScroll > 0 && event.x >= this.w - 7) this.#drag = true;
    if (this.#drag) {
      if (type === 'up' || type === 'cancel') { this.#drag = false; return; }
      this.scrollY = clamp(Math.round((event.y - 2) / Math.max(1, this.h - 4) * this.maxScroll), 0, this.maxScroll);
      this.invalidate(); return;
    }
    const index = Math.floor((event.y - 1 + this.scrollY) / this.rowHeight);
    if (type === 'down') { this.#pressed = index; this.#from = { x: event.gx, y: event.gy }; return; }
    if (type === 'move' && this.#dragOut(event)) return;
    if (type !== 'up') { if (type === 'cancel') this.#pressed = -1; return; }
    const pressed = this.#pressed; this.#pressed = -1;
    if (!event.inside || index !== pressed || !this.select(index)) return;
    this.props.onPick?.(this.items[index].value, this.items[index]);
    if (this.disposed) return;
    const now = this.ui.stage.time;
    if (this.#last.index === index && now - this.#last.time < 400) { this.#last = { index: -1, time: -Infinity }; this.activate(); }
    else this.#last = { index, time: now };
  }

  /**
   * With drag="kind", a row pressed and pulled away is dragged out as
   * { kind, value, item }, for a drop target elsewhere (see ui/drag.js).
   */
  #dragOut(event) {
    const item = this.items[this.#pressed];
    if (!this.props.drag || !item || item.disabled || !this.#from) return false;
    if (Math.abs(event.gx - this.#from.x) + Math.abs(event.gy - this.#from.y) < 6) return false;
    this.#pressed = -1;
    this.#from = null;
    this.select(this.items.indexOf(item));
    this.ui.drag({ kind: this.props.drag, value: item.value, item }, { label: item.text, sprite: item.sprite, zoom: this.magnification });
    return true;
  }

  wheel(event) {
    const next = clamp(this.scrollY + Math.round(event.dy), 0, this.maxScroll);
    if (next === this.scrollY) return false;
    this.scrollY = next; this.invalidate(); return true;
  }

  key(type, event) {
    if (event.ctrl || event.alt) return false;
    if (event.key === 'Enter') { if (type === 'down') this.activate(); return true; }
    const moves = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    if (moves.includes(event.key)) {
      if (type !== 'down') return true;
      const choices = this.items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
      if (!choices.length) return true;
      let current = choices.findIndex(({ index }) => index === this.selectedIndex);
      const direction = event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1;
      const amount = event.key.startsWith('Page') ? Math.max(1, Math.floor(this.h / this.rowHeight)) : 1;
      current = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : current < 0 ? 0 : clamp(current + direction * amount, 0, choices.length - 1);
      this.select(choices[current].index); return true;
    }
    if (type === 'down' && [...event.key].length === 1 && event.key !== ' ') {
      const now = this.ui.stage.time;
      this.#prefix = (now - this.#typed > 700 ? '' : this.#prefix) + event.key.toLowerCase();
      this.#typed = now;
      const index = this.items.findIndex(item => !item.disabled && item.text.toLowerCase().startsWith(this.#prefix));
      if (index >= 0) this.select(index);
      return true;
    }
    return false;
  }
  dispose() { this.events.dispose(); super.dispose(); }
}

/** Compact selector backed by the same list and keyboard behavior. */
export class Select extends Widget {
  static attrs = { ...List.attrs };
  interactive = true;
  focusable = true;
  events = new EventEmitter();
  #items = [];
  #popup = null;

  constructor(ui, props = {}) {
    super(ui, props);
    this.model = model(props.value);
    this.watch(props.options ?? props.items ?? [], items => { this.items = items; });
    this.watch(this.model, () => this.invalidate());
  }
  get items() { return this.#items; }
  set items(items) { if (!Array.isArray(items)) throw new TypeError('select options must be an array'); this.#items = items; this.invalidate(); this.ui.requestLayout(); }
  setItems(items) { this.items = items; }
  content() { return { w: Math.max(75, ...this.items.map(item => this.ui.font.measure(String(item.text ?? item.value)) + 22)), h: 19 }; }
  paint(bitmap, theme) {
    button(bitmap, theme, 0, 0, this.w, this.h, { pressed: Boolean(this.#popup), face: 'field' });
    const item = this.items.find(candidate => same(candidate.value, this.model.value));
    this.ui.font.draw(bitmap, fit(this.ui.font, item?.text ?? item?.value ?? 'Choose…', this.w - 22), 5, 5, theme.color('field-ink'));
    for (let y = 0; y < 3; y++) bitmap.fill(this.w - 11 + y, 8 + y, 5 - y * 2, 1, theme.color('field-ink'));
  }
  #choose(value) {
    const changed = this.model.set(value);
    this.close();
    if (changed) {
      this.events.emit('change', { value });
      this.props.onChange?.(value, this);
      if (this.props.action) this.context?.run(this.props.action, this);
    }
  }
  open() {
    if (!this.enabled || this.#popup || !this.ui.root) return;
    const owner = this;
    class Popup extends Widget {
      interactive = true;
      pointer(type) { if (type === 'down') owner.close(); }
      key(type, event) { if (event.key !== 'Escape') return false; if (type === 'down') owner.close(); return true; }
    }
    const layer = this.ui.root.add(new Popup(this.ui));
    layer.place(0, 0, this.ui.root.w, this.ui.root.h);
    const list = layer.add(new List(this.ui, { items: this.items, value: this.model.value, onPick: value => this.#choose(value), onActivate: value => this.#choose(value) }));
    list.zoom = this.magnification;
    const top = this.toScreen(0, 0);
    const below = this.toScreen(0, this.h);
    const room = Math.max(below.y < layer.h / 2 ? layer.h - below.y : top.y, 20);
    const height = Math.max(16, Math.min(list.measure().h, Math.floor(room / list.zoom) - 2));
    const width = Math.min(Math.max(this.w, list.measure().w), Math.floor(layer.w / list.zoom));
    list.place(clamp(top.x, 0, Math.max(0, layer.w - width * list.zoom)), below.y + height * list.zoom <= layer.h ? below.y : Math.max(0, top.y - height * list.zoom), width, height);
    const release = this.ui.focusWithin(layer, { trap: true });
    this.#popup = { layer, release };
    list.focus();
    this.invalidate();
  }
  close() {
    if (!this.#popup) return;
    const { layer, release } = this.#popup;
    this.#popup = null;
    layer.dispose(); release(); this.invalidate();
  }
  pointer(type, event) { if (type === 'up' && event.inside) this.#popup ? this.close() : this.open(); }
  key(type, event) {
    if (![' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return false;
    if (type === 'down') this.open();
    return true;
  }
  dispose() { this.close(); this.events.dispose(); super.dispose(); }
}
