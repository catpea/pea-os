import { Signal, DisposableScope, SignalBinder } from '../core/reactive.js';
import { Bitmap } from '../gfx/bitmap.js';

/**
 * The base of everything on screen.
 *
 * A widget has a rectangle in its parent's art-pixel space, a Pixi container
 * that mirrors it, and a scope that owns its subscriptions. A widget that
 * defines paint(bitmap, theme) also owns one bitmap-backed sprite, repainted
 * only when the widget is invalidated: there is no per-frame redraw of chrome.
 *
 * `zoom` magnifies a widget and everything inside it by a whole number. Its
 * position stays in the parent's pixels; its size is in its own.
 */
export class Widget {
  /** XML attributes every widget accepts, with their value types. */
  static attrs = { id: 'string', width: 'number', height: 'number', grow: 'number', self: 'string', disabled: 'model', enabled: 'model', visible: 'model', label: 'text', tooltip: 'text' };
  /** Whether child widgets may be nested inside this one in XML. */
  static container = false;

  x = 0;
  y = 0;
  w = 0;
  h = 0;
  parent = null;
  children = [];
  /** Interactive widgets receive pointer events; others let them fall through. */
  interactive = false;
  focusable = false;
  focused = false;
  hovered = false;
  disposed = false;
  #disabled = false;
  bitmap = null;
  #texture = null;
  #sprite = null;
  #zoom = 1;

  constructor(ui, props = {}) {
    this.ui = ui;
    this.props = props;
    this.scope = new DisposableScope();
    this.view = new ui.PIXI.Container();
    this.watch(props.disabled ?? false, value => { this.disabled = Boolean(value); });
    if (props.enabled !== undefined) this.watch(props.enabled, value => { this.disabled = !Boolean(value); });
    if (props.visible !== undefined) this.watch(props.visible, value => { this.visible = Boolean(value); });
  }

  get visible() {
    return this.view.visible;
  }

  set visible(value) {
    value = Boolean(value);
    if (this.view.visible === value) return;
    this.view.visible = value;
    if (!value && this.contains(this.ui.focused)) this.ui.focus(null);
    this.ui.requestLayout();
  }

  get disabled() { return this.#disabled; }
  set disabled(value) {
    this.#disabled = Boolean(value);
    this.view.alpha = this.#disabled ? 0.5 : 1;
    if (this.#disabled && this.contains(this.ui.focused)) this.ui.focus(null);
    this.invalidate();
  }

  /** A disabled/hidden ancestor applies to its whole subtree. */
  get enabled() {
    for (let node = this; node; node = node.parent) if (node.disabled || node.disposed) return false;
    return true;
  }
  get shown() {
    for (let node = this; node; node = node.parent) if (!node.visible || node.disposed) return false;
    return true;
  }
  focus() { return this.ui.focus(this); }
  key() { return false; }
  hover(inside) {
    if (this.hovered === inside) return;
    this.hovered = inside;
    this.invalidate();
  }

  /**
   * How keyboard focus shows on this widget:
   *   'ring'   a dotted ring two pixels in; buttons, fields, checks
   *   'frame'  dots over the widget's own outermost pixels, so a pane's
   *            content is never crossed; shown only when focus came from
   *            the keyboard, as a browser's :focus-visible
   *   'none'   the widget shows focus itself (a selection, a divider)
   * Small widgets ring and large ones frame unless a class says otherwise.
   */
  get focusMark() {
    return this.w <= 160 && this.h <= 40 ? 'ring' : 'frame';
  }

  get zoom() {
    return this.#zoom;
  }

  set zoom(value) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`zoom must be a whole number of at least 1, got ${value}`);
    this.#zoom = value;
    this.view.scale.set(value);
  }

  add(child, index = this.children.length) {
    child.parent = this;
    this.children.splice(index, 0, child);
    this.view.addChildAt(child.view, index + (this.#sprite ? 1 : 0));
    return child;
  }

  remove(child) {
    const index = this.children.indexOf(child);
    if (index < 0) return;
    this.children.splice(index, 1);
    this.view.removeChild(child.view);
    child.parent = null;
  }

  /** Moves a child to the top of the stacking order. */
  raise(child) {
    if (this.children.at(-1) === child) return;
    this.remove(child);
    this.add(child);
  }

  /** Calls apply(value) now and on every change when `source` is a Signal. */
  watch(source, apply) {
    if (source instanceof Signal) this.scope.add(new SignalBinder(this, source, (_, value) => apply(value)));
    else apply(source);
  }

  /** Natural content size; containers and controls override this. */
  content() {
    return { w: 0, h: 0 };
  }

  /** Preferred size: explicit width/height win over the natural size. */
  measure(maxW = Infinity, maxH = Infinity) {
    const natural = this.content(this.props.width ?? maxW, this.props.height ?? maxH);
    return { w: this.props.width ?? natural.w, h: this.props.height ?? natural.h };
  }

  /** Assigns the rectangle, then lays out children. */
  place(x, y, w, h) {
    w = Math.max(0, Math.round(w));
    h = Math.max(0, Math.round(h));
    const resized = w !== this.w || h !== this.h;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.w = w;
    this.h = h;
    this.view.position.set(this.x, this.y);
    if (resized) {
      this.resized();
      this.props.onResize?.({ w, h }, this);
      this.invalidate();
    }
    this.arrange();
  }

  resized() {}

  arrange() {}

  /** Requests a repaint before the next frame is composed. */
  invalidate() {
    if (this.paint && !this.disposed) this.ui.dirty.add(this);
  }

  invalidateTree() {
    this.invalidate();
    for (const child of this.children) child.invalidateTree();
  }

  repaint() {
    if (this.disposed || this.w < 1 || this.h < 1) return;
    this.surface(this.w, this.h).clear();
    this.paint(this.bitmap, this.ui.theme.value);
    const mark = this.focused && this.enabled && this.w > 4 && this.h > 4 ? this.focusMark : 'none';
    if (mark === 'ring' || (mark === 'frame' && this.ui.focusVisible)) {
      const ink = this.ui.theme.value.color('accent');
      const inset = mark === 'ring' ? 2 : 0;
      const right = this.w - 1 - inset;
      const bottom = this.h - 1 - inset;
      for (let x = inset; x <= right; x += 2) { this.bitmap.set(x, inset, ink); this.bitmap.set(x, bottom, ink); }
      for (let y = inset; y <= bottom; y += 2) { this.bitmap.set(inset, y, ink); this.bitmap.set(right, y, ink); }
    }
    this.commit();
  }

  /** The widget's bitmap at the given size, recreated only when the size changes. */
  surface(w, h) {
    if (this.bitmap?.width === w && this.bitmap.height === h) return this.bitmap;
    const previous = this.#texture;
    this.bitmap = new Bitmap(w, h);
    this.#texture = this.ui.stage.texture(this.bitmap);
    if (this.#sprite) {
      this.#sprite.texture = this.#texture;
    } else {
      this.#sprite = new this.ui.PIXI.Sprite(this.#texture);
      this.view.addChildAt(this.#sprite, 0);
    }
    previous?.destroy(true);
    return this.bitmap;
  }

  /** Shows what was painted, locked to the theme palette when it has one. */
  commit() {
    const theme = this.ui.theme.value;
    if (theme.palette) this.bitmap.remap(color => theme.lock(color));
    this.upload();
  }

  /** Sends the bitmap to the compositor exactly as it is. */
  upload() {
    this.#texture.source.update();
  }

  /** The deepest interactive widget under a point given in the parent's space. */
  hit(px, py) {
    if (!this.visible) return null;
    const x = Math.floor((px - this.x) / this.#zoom);
    const y = Math.floor((py - this.y) / this.#zoom);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const target = this.children[i].hit(x, y);
      if (target) return target;
    }
    return this.interactive ? this : null;
  }

  /** A point of this widget, in screen art pixels. */
  toScreen(x = 0, y = 0) {
    for (let widget = this; widget; widget = widget.parent) {
      x = widget.x + x * widget.zoom;
      y = widget.y + y * widget.zoom;
    }
    return { x, y };
  }

  /** A screen point in this widget's own pixels. */
  toLocal(gx, gy) {
    const { x, y } = this.parent ? this.parent.toLocal(gx, gy) : { x: gx, y: gy };
    return { x: Math.floor((x - this.x) / this.#zoom), y: Math.floor((y - this.y) / this.#zoom) };
  }

  /** Top-left corner in screen art pixels. */
  origin() {
    return this.toScreen(0, 0);
  }

  /** Screen pixels per pixel of this widget: its zoom times its ancestors'. */
  get magnification() {
    let zoom = 1;
    for (let widget = this; widget; widget = widget.parent) zoom *= widget.zoom;
    return zoom;
  }

  contains(widget) {
    for (let node = widget; node; node = node.parent) if (node === this) return true;
    return false;
  }

  /**
   * type: 'down' | 'move' | 'up' | 'cancel'
   * event: { x, y, gx, gy, inside, button, alt }, x and y in this widget's pixels.
   *
   * A widget may also define menu(event) -> boolean, called for a right
   * click or a long press, and cursor(event) -> a CSS cursor name.
   */
  pointer() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.contains(this.ui.focused)) this.ui.focus(null);
    for (const child of [...this.children]) child.dispose();
    this.parent?.remove(this);
    this.ui.dirty.delete(this);
    this.scope.dispose();
    this.view.destroy();
    this.#texture?.destroy(true);
  }
}
