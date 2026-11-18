import { Signal } from '../core/reactive.js';
import { Widget } from './widget.js';
import { Column } from './layout.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const model = (value, fallback) => value instanceof Signal ? value : new Signal(value ?? fallback);

/** A rectangular sprite mask is the only additional Pixi primitive scrolling needs. */
export class Viewport extends Widget {
  constructor(ui, props = {}) {
    super(ui, props);
    this.clip = new ui.PIXI.Sprite(ui.solid(0xffffffff));
    this.clip.peaClip = true; // the software compositor recognizes the same rectangle
    this.view.addChild(this.clip);
    this.view.mask = this.clip;
  }
  arrange() { this.clip.position.set(0, 0); this.clip.scale.set(this.w, this.h); }
  dispose() { this.view.mask = null; this.clip.destroy(); super.dispose(); }
}

/** One child, clipped in both rendering and hit-testing. */
export class Scroll extends Widget {
  static attrs = { ...Widget.attrs, axis: 'string' };
  static container = true;
  interactive = true;
  focusable = true;
  scrollX = 0;
  scrollY = 0;
  maxX = 0;
  maxY = 0;
  #drag = null;

  constructor(ui, props = {}) {
    super(ui, props);
    this.axis = props.axis ?? 'vertical';
    if (!['vertical', 'horizontal', 'both'].includes(this.axis)) throw new Error('scroll axis must be vertical, horizontal or both');
    this.viewport = super.add(new Viewport(ui));
  }
  add(child) {
    if (!this.viewport) return super.add(child);
    if (this.viewport.children.length) throw new Error('<scroll> takes exactly one child');
    return this.viewport.add(child);
  }
  get contentWidget() { return this.viewport.children[0] ?? null; }
  content(maxW = 160) {
    const natural = this.contentWidget?.measure(maxW, Infinity) ?? { w: 80, h: 60 };
    return { w: Math.min(160, natural.w), h: Math.min(100, natural.h) };
  }
  arrange() {
    if (!this.viewport) return;
    const child = this.contentWidget;
    let width = this.w;
    let height = this.h;
    let natural = { w: width, h: height };
    for (let pass = 0; pass < 3; pass++) {
      natural = child?.measure(this.axis === 'vertical' ? width : Infinity, this.axis === 'horizontal' ? height : Infinity) ?? natural;
      width = Math.max(0, this.w - (this.axis !== 'horizontal' && natural.h > height ? 7 : 0));
      height = Math.max(0, this.h - (this.axis !== 'vertical' && natural.w > width ? 7 : 0));
    }
    const contentW = this.axis === 'vertical' ? width : Math.max(width, natural.w);
    const contentH = this.axis === 'horizontal' ? height : Math.max(height, natural.h);
    this.maxX = Math.max(0, contentW - width);
    this.maxY = Math.max(0, contentH - height);
    this.scrollX = clamp(this.scrollX, 0, this.maxX);
    this.scrollY = clamp(this.scrollY, 0, this.maxY);
    this.viewport.place(0, 0, width, height);
    child?.place(-this.scrollX, -this.scrollY, contentW, contentH);
    this.invalidate();
  }
  scrollTo(x = this.scrollX, y = this.scrollY) {
    const nextX = clamp(Math.round(x), 0, this.maxX);
    const nextY = clamp(Math.round(y), 0, this.maxY);
    if (nextX === this.scrollX && nextY === this.scrollY) return false;
    this.scrollX = nextX; this.scrollY = nextY; this.arrange(); return true;
  }
  revealChild(child) {
    if (!this.viewport.contains(child)) return;
    const origin = child.toScreen();
    const local = this.viewport.toLocal(origin.x, origin.y);
    const scale = child.magnification / this.viewport.magnification;
    let x = this.scrollX; let y = this.scrollY;
    if (local.x < 0) x += local.x;
    else if (local.x + child.w * scale > this.viewport.w) x += local.x + child.w * scale - this.viewport.w;
    if (local.y < 0) y += local.y;
    else if (local.y + child.h * scale > this.viewport.h) y += local.y + child.h * scale - this.viewport.h;
    this.scrollTo(x, y);
  }
  paint(bitmap, theme) {
    if (this.maxY) {
      const track = this.viewport.h;
      const knob = Math.max(5, Math.round(track * track / (track + this.maxY)));
      bitmap.fill(this.w - 7, 0, 7, track, theme.color('panel'));
      bitmap.fill(this.w - 5, Math.round((track - knob) * this.scrollY / this.maxY), 3, knob, theme.color('dim'));
    }
    if (this.maxX) {
      const track = this.viewport.w;
      const knob = Math.max(5, Math.round(track * track / (track + this.maxX)));
      bitmap.fill(0, this.h - 7, track, 7, theme.color('panel'));
      bitmap.fill(Math.round((track - knob) * this.scrollX / this.maxX), this.h - 5, knob, 3, theme.color('dim'));
    }
  }
  wheel(event) {
    let dx = event.dx; let dy = event.dy;
    if ((!this.maxY || event.shift) && !dx) { dx = dy; dy = 0; }
    return this.scrollTo(this.scrollX + dx, this.scrollY + dy);
  }
  pointer(type, event) {
    if (type === 'down') this.#drag = this.maxY && event.x >= this.viewport.w ? 'y' : this.maxX && event.y >= this.viewport.h ? 'x' : null;
    if (type === 'up' || type === 'cancel') { this.#drag = null; return; }
    if (this.#drag === 'y') this.scrollTo(this.scrollX, event.y / Math.max(1, this.viewport.h) * this.maxY);
    if (this.#drag === 'x') this.scrollTo(event.x / Math.max(1, this.viewport.w) * this.maxX, this.scrollY);
  }
  key(type, event) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return false;
    if (type !== 'down') return true;
    const moves = { ArrowUp: [0, -12], ArrowDown: [0, 12], ArrowLeft: [-12, 0], ArrowRight: [12, 0], PageUp: [0, -this.viewport.h], PageDown: [0, this.viewport.h] };
    if (event.key === 'Home') this.scrollTo(0, 0);
    else if (event.key === 'End') this.scrollTo(this.maxX, this.maxY);
    else this.scrollTo(this.scrollX + moves[event.key][0], this.scrollY + moves[event.key][1]);
    return true;
  }
}

/** Two panes and one keyboard-accessible divider. ratio is a 0..1 model. */
export class Split extends Widget {
  static attrs = { ...Widget.attrs, direction: 'string', ratio: 'model', min: 'number' };
  static container = true;
  interactive = true;
  focusable = true;
  focusMark = 'none'; // its divider lights up instead of a ring around both panes
  #drag = null;
  constructor(ui, props = {}) {
    super(ui, props);
    this.direction = props.direction ?? 'horizontal';
    if (!['horizontal', 'vertical'].includes(this.direction)) throw new Error('split direction must be horizontal or vertical');
    this.model = model(props.ratio, 0.5);
    this.watch(this.model, () => { this.arrange(); this.invalidate(); });
  }
  add(child) { if (this.children.length >= 2) throw new Error('<split> takes two children'); return super.add(child); }
  get horizontal() { return this.direction === 'horizontal'; }
  content(maxW, maxH) {
    const sizes = this.children.map(child => child.measure(maxW, maxH));
    return { w: this.horizontal ? sizes.reduce((n, size) => n + size.w, 5) : Math.max(0, ...sizes.map(size => size.w)), h: this.horizontal ? Math.max(0, ...sizes.map(size => size.h)) : sizes.reduce((n, size) => n + size.h, 5) };
  }
  arrange() {
    const visible = this.children.filter(child => child.visible);
    if (visible.length < 2) { this.divider = -1; visible[0]?.place(0, 0, this.w, this.h); return; }
    const span = Math.max(0, (this.horizontal ? this.w : this.h) - 5);
    const min = Math.min(this.props.min ?? 20, span / 2);
    this.divider = Math.round(clamp(span * (this.#drag?.ratio ?? Number(this.model?.value ?? 0.5)), min, span - min));
    const [first, second] = visible;
    if (this.horizontal) { first?.place(0, 0, this.divider, this.h); second?.place(this.divider + 5, 0, span - this.divider, this.h); }
    else { first?.place(0, 0, this.w, this.divider); second?.place(0, this.divider + 5, this.w, span - this.divider); }
  }
  paint(bitmap, theme) {
    if (this.divider < 0) return;
    const line = theme.color(this.focused ? 'accent' : 'dim');
    if (this.horizontal) { bitmap.fill(this.divider, 0, 5, this.h, theme.color('panel')); bitmap.fill(this.divider + 2, 3, 1, this.h - 6, line); }
    else { bitmap.fill(0, this.divider, this.w, 5, theme.color('panel')); bitmap.fill(3, this.divider + 2, this.w - 6, 1, line); }
  }
  hit(px, py) {
    const x = (px - this.x) / this.zoom; const y = (py - this.y) / this.zoom;
    const at = this.horizontal ? x : y;
    if (this.visible && x >= 0 && y >= 0 && x < this.w && y < this.h && at >= this.divider && at < this.divider + 5) return this;
    return super.hit(px, py);
  }
  cursor() { return this.divider < 0 ? 'default' : this.horizontal ? 'col-resize' : 'row-resize'; }
  pointer(type, event) {
    if (type === 'down') this.#drag = { ratio: Number(this.model.value) };
    if (!this.#drag) return;
    if (type === 'move') {
      this.#drag.ratio = clamp((this.horizontal ? event.x : event.y) / Math.max(1, (this.horizontal ? this.w : this.h) - 5), 0, 1);
      this.arrange(); this.invalidate();
    } else if (type === 'up' || type === 'cancel') {
      const ratio = this.#drag.ratio; this.#drag = null;
      if (type === 'up') this.model.set(ratio);
      this.arrange(); this.invalidate();
    }
  }
  key(type, event) {
    if (this.divider < 0) return false;
    const keys = this.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return false;
    if (type === 'down') this.model.set(clamp(Number(this.model.value) + (event.key === keys[0] ? -.05 : .05), .05, .95));
    return true;
  }
}

export class Tab extends Column {
  static attrs = { ...Column.attrs, name: 'string', title: 'text' };
  constructor(ui, props = {}) { super(ui, props); this.name = props.name ?? props.id; if (!this.name) throw new Error('<tab> needs name'); this.watch(props.title ?? this.name, text => { this.title = String(text); ui.requestLayout(); }); }
}

/** Tab headers wrap at narrow widths; one selected pane remains mounted. */
export class Tabs extends Widget {
  static attrs = { ...Widget.attrs, value: 'model', action: 'action' };
  static container = true;
  interactive = true;
  focusable = true;
  #slots = [];
  constructor(ui, props = {}) { super(ui, props); this.model = model(props.value, null); this.watch(this.model, () => { this.arrange(); this.invalidate(); }); }
  add(child) {
    if (!(child instanceof Tab)) throw new Error('<tabs> takes <tab> children');
    if (this.children.some(tab => tab.name === child.name)) throw new Error(`duplicate tab name "${child.name}"`);
    super.add(child);
    if (this.model.value === null) this.model.set(child.name);
    return child;
  }
  content(maxW, maxH) {
    const sizes = this.children.map(child => child.measure(maxW, maxH));
    return { w: Math.max(100, ...sizes.map(size => size.w)), h: 20 + Math.max(0, ...sizes.map(size => size.h)) };
  }
  arrange() {
    let x = 0; let y = 0;
    this.#slots = this.children.map(tab => {
      const w = Math.min(this.w, this.ui.font.measure(tab.title ?? tab.name) + 12);
      if (x && x + w > this.w) { x = 0; y += 19; }
      const slot = { tab, x, y, w }; x += w + 2; return slot;
    });
    this.headerHeight = this.children.length ? y + 20 : 0;
    for (const tab of this.children) { tab.visible = String(tab.name) === String(this.model?.value); if (tab.visible) tab.place(0, this.headerHeight, this.w, Math.max(0, this.h - this.headerHeight)); }
  }
  paint(bitmap, theme) {
    for (const { tab, x, y, w } of this.#slots) {
      const selected = tab.visible;
      bitmap.fill(x, y, w, 18, theme.color(selected ? 'accent' : 'panel'));
      this.ui.font.draw(bitmap, tab.title ?? tab.name, x + 5, y + 5, theme.color(selected ? 'accent-ink' : 'panel-ink'));
    }
  }
  select(name) { if (this.model.set(name) && this.props.action) this.context?.run(this.props.action, this); }
  pointer(type, event) { if (type !== 'up') return; const slot = this.#slots.find(slot => event.x >= slot.x && event.x < slot.x + slot.w && event.y >= slot.y && event.y < slot.y + 18); if (slot) this.select(slot.tab.name); }
  key(type, event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    if (type !== 'down' || !this.children.length) return true;
    const current = this.children.findIndex(tab => tab.visible);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? this.children.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + this.children.length) % this.children.length;
    this.select(this.children[index].name); return true;
  }
}
