import { Signal, EventEmitter, DisposableScope } from '../core/reactive.js';
import { Bitmap } from '../gfx/bitmap.js';
import { Animator } from '../gfx/animator.js';
import { DragGhost } from './drag.js';

const HOLD_MS = 550;  // a press this long, held still, asks for a context menu
const HOLD_SLOP = 3;

/**
 * What every widget shares: the stage, the theme Signal, the font, sprites
 * and the animator. It also routes pointer input and flushes the two kinds of
 * pending work, layout and repaint, once per frame.
 */
export class UI {
  /** Widgets waiting to repaint. */
  dirty = new Set();
  /** 'down' with { target, x, y }, before the target itself hears about it. */
  pressed = new EventEmitter();
  root = null;
  scope = new DisposableScope();

  /** The pointer shape the widget under the pointer asks for. */
  cursor = new Signal('default');
  focused = null;
  focusChanged = new EventEmitter();
  textInput = null;
  focusScopes = [];

  #layout = false;
  #capture = null;
  #hold = null;
  #solids = new Map();
  #spriteTextures = new Map();
  #hovered = null;
  #drag = null;

  constructor({ PIXI, stage, font, sprites, theme }) {
    this.PIXI = PIXI;
    this.stage = stage;
    this.font = font;
    this.sprites = sprites;
    this.theme = new Signal(theme);
    /** False when the user prefers reduced motion: decorative animation stops. */
    this.motion = new Signal(true);
    this.anim = this.scope.add(new Animator(stage.frame));
    this.scope.subscribe(this.motion, motion => { this.anim.motion = motion; });

    this.scope.subscribe(this.theme, () => {
      for (const texture of this.#spriteTextures.values()) texture.destroy(true);
      this.#spriteTextures.clear();
      this.root?.invalidateTree();
    }, { immediate: false });
    this.scope.subscribe(stage.size, () => this.requestLayout(), { immediate: false });
    this.scope.on(stage.frame, 'paint', () => this.flush());
    this.scope.on(stage.frame, 'tick', ({ dt }) => this.#held(dt));
    for (const type of ['down', 'move', 'up', 'cancel']) {
      this.scope.on(stage.pointer, type, point => this.#dispatch(type, point));
    }
  }

  mount(root) {
    this.root = root;
    this.stage.scene.addChild(root.view);
    this.requestLayout();
  }

  /** Whether focus last moved by keyboard; large panes show their focus only then. */
  get focusVisible() { return this.#focusVisible; }
  set focusVisible(value) {
    if (value === this.#focusVisible) return;
    this.#focusVisible = value;
    this.focused?.invalidate();
  }
  #focusVisible = false;

  /**
   * Focus is a widget identity, never a pixel coordinate. Scroll panes reveal
   * the newly focused widget unless `reveal` is false: what a press lands on is
   * already in view.
   */
  focus(widget, { reveal = true } = {}) {
    const boundary = this.focusScopes.at(-1);
    if (widget && (!widget.focusable || !widget.enabled || !widget.shown || widget.disposed || (boundary?.trap && !boundary.root.contains(widget)))) return false;
    if (widget === this.focused) return true;
    const previous = this.focused;
    this.focused = widget;
    if (previous) { previous.focused = false; previous.onBlur?.(); previous.invalidate(); }
    if (widget) {
      widget.focused = true;
      widget.onFocus?.();
      widget.invalidate();
      if (reveal) for (let parent = widget.parent; parent; parent = parent.parent) parent.revealChild?.(widget);
    }
    if (widget?.textInput) this.textInput?.focus(widget);
    else this.textInput?.blur();
    this.focusChanged.emit('change', { widget, previous });
    return true;
  }

  /** A temporary focus region. Its disposer restores the previous region and focus. */
  focusWithin(root, { trap = false } = {}) {
    const scope = { root, trap, previous: this.focused };
    this.focusScopes.push(scope);
    if (!root.contains(this.focused)) this.focus(null);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const top = this.focusScopes.at(-1) === scope;
      this.focusScopes = this.focusScopes.filter(candidate => candidate !== scope);
      if (top) this.focus(scope.previous?.shown && !scope.previous.disposed ? scope.previous : null);
    };
  }

  attachTextInput(adapter) {
    this.textInput = adapter;
    if (this.focused?.textInput) adapter.focus(this.focused);
    return () => { if (this.textInput === adapter) { adapter.blur(); this.textInput = null; } };
  }

  /** Shell calls this before forwarding an unhandled key to the active app. */
  handleKey(type, event) {
    if (this.focused && (!this.focused.shown || !this.focused.enabled)) this.focus(null);
    const scope = this.focusScopes.at(-1);
    let boundary = scope?.root ?? this.root;
    if (!scope && this.focused) {
      for (let node = this.focused; node; node = node.parent) if (node.focusBoundary) { boundary = node; break; }
    }
    if (type === 'down' && event.key === 'Tab' && !event.ctrl && !event.alt) {
      this.focusVisible = true;
      const choices = [];
      const visit = node => {
        if (!node || !node.shown || !node.enabled) return;
        if (node.focusable) choices.push(node);
        for (const child of node.children) visit(child);
      };
      visit(boundary);
      if (choices.length) {
        const current = choices.indexOf(this.focused);
        const at = current < 0 ? (event.shift ? choices.length - 1 : 0) : (current + (event.shift ? -1 : 1) + choices.length) % choices.length;
        this.focus(choices[at]);
      }
      event.handled = true;
      return true;
    }
    for (let node = this.focused ?? scope?.root; node; node = node.parent) {
      if (node.enabled && node.key?.(type, event)) { event.handled = true; return true; }
      if (node === boundary) break;
    }
    return false;
  }

  wheel(point) {
    for (let widget = this.root?.hit(point.x, point.y); widget; widget = widget.parent) {
      if (widget.enabled && widget.wheel?.({ ...this.#event(widget, point), dx: (point.dx ?? 0) / widget.magnification, dy: (point.dy ?? 0) / widget.magnification })) return true;
    }
    return false;
  }

  /**
   * Turns the press in progress into a drag of `payload` (see drag.js). The
   * source that calls this forgets its own press; the pointer is the drag's.
   */
  drag(payload, { label = '', sprite = null, zoom = 1 } = {}) {
    this.#endDrag();
    const ghost = new DragGhost(this, { label: String(label), sprite, zoom });
    this.stage.scene.addChild(ghost.view);
    this.#capture = null;
    this.#hold = null;
    this.#drag = { payload, ghost };
  }

  /** Whether a drag is in progress. */
  get dragging() {
    return Boolean(this.#drag);
  }

  #dragPointer(type, point) {
    const { payload, ghost } = this.#drag;
    const under = [];
    for (let widget = this.root?.hit(point.x, point.y); widget; widget = widget.parent) under.push(widget);
    if (type === 'move') {
      const size = ghost.measure();
      ghost.place(point.x + 8, point.y + 6, size.w, size.h);
      const accepting = under.some(widget => widget.enabled && widget.accepts?.(payload));
      ghost.setAccepted(accepting);
      this.cursor.set(accepting ? 'copy' : 'no-drop');
      return;
    }
    this.#endDrag();
    if (type !== 'up') return;
    // Only a widget that accepts the payload is offered it: drop() alone may mean something else.
    const target = under.find(widget => widget.enabled && widget.accepts?.(payload));
    target?.drop(payload, this.#event(target, point));
    this.#hover(point);
  }

  #endDrag() {
    if (!this.#drag) return;
    const { ghost } = this.#drag;
    this.#drag = null;
    this.stage.scene.removeChild(ghost.view);
    this.dirty.delete(ghost);
    ghost.dispose();
  }

  /** Re-runs layout from the root before the next frame. Layout is cheap; trees are small. */
  requestLayout() {
    this.#layout = true;
  }

  flush() {
    if (this.#layout && this.root) {
      this.#layout = false;
      const { w, h } = this.stage.size.value;
      this.root.place(0, 0, w, h);
    }
    for (const widget of this.dirty) {
      this.dirty.delete(widget);
      widget.repaint();
    }
  }

  /** A 1x1 texture of one color, for lines and flashes made of scaled sprites. */
  solid(color) {
    let texture = this.#solids.get(color);
    if (!texture) {
      const bitmap = new Bitmap(1, 1);
      bitmap.px[0] = color;
      this.#solids.set(color, texture = this.stage.texture(bitmap));
    }
    return texture;
  }

  /** The shared texture of a sprite frame; rebuilt when the theme changes. */
  spriteTexture(bitmap) {
    let texture = this.#spriteTextures.get(bitmap);
    if (!texture) this.#spriteTextures.set(bitmap, texture = this.stage.texture(bitmap));
    return texture;
  }

  #event(widget, point) {
    const { x, y } = widget.toLocal(point.x, point.y);
    return {
      x,
      y,
      gx: point.x,
      gy: point.y,
      inside: x >= 0 && y >= 0 && x < widget.w && y < widget.h,
      button: point.button ?? 0,
      alt: Boolean(point.alt),
      shift: Boolean(point.shift),
      ctrl: Boolean(point.ctrl)
    };
  }

  #dispatch(type, point) {
    if (this.#drag) { this.#dragPointer(type, point); return; }
    if (type === 'down') {
      // A press while another is still held means its release was lost: end that gesture first.
      if (this.#capture) this.#dispatch('cancel', point);
      let target = this.root?.hit(point.x, point.y) ?? null;
      const boundary = this.focusScopes.at(-1);
      if (boundary?.trap && !boundary.root.contains(target)) target = boundary.root;
      this.pressed.emit('down', { target, ...point });
      if (target?.enabled === false) return;
      this.focusVisible = false;
      if (!point.button && !target?.preserveFocus) {
        let candidate = target;
        while (candidate && !candidate.focusable) candidate = candidate.parent;
        this.focus(candidate, { reveal: false });
      }
      if (point.button === 2) {
        // A right click asks the widget under it, then each ancestor in turn.
        for (let widget = target; widget; widget = widget.parent) {
          if (widget.menu?.(this.#event(widget, point))) break;
        }
        return;
      }
      // The middle button belongs to the nearest widget that claims it.
      this.#capture = point.button === 1 ? this.#claimant(target) : target;
      this.#hold = this.#capture?.menu && !point.button ? { point, ms: 0 } : null;
    } else if (type === 'move' && !this.#capture) {
      this.#hover(point);
      return;
    }
    const target = this.#capture;
    const ended = type === 'up' || type === 'cancel';
    // A press also ends when its widget is disabled or removed meanwhile; left captured, it would open a menu after the release.
    const gone = !target || !target.enabled || target.disposed;
    if (ended || gone) {
      this.#capture = null;
      this.#hold = null;
    } else if (this.#hold && Math.abs(point.x - this.#hold.point.x) + Math.abs(point.y - this.#hold.point.y) > HOLD_SLOP) {
      this.#hold = null;
    }
    if (!gone) target.pointer(type, this.#event(target, point));
  }

  /** A long press on a widget that has a context menu opens it, as a right click would. */
  #held(dt) {
    const hold = this.#hold;
    if (!hold || (hold.ms += dt) < HOLD_MS) return;
    const target = this.#capture;
    this.#hold = null;
    this.#capture = null;
    target.pointer('cancel', this.#event(target, hold.point));
    target.menu(this.#event(target, hold.point));
  }

  #claimant(target) {
    while (target && !target.middle) target = target.parent;
    return target;
  }

  #hover(point) {
    let name = 'default';
    const target = this.root?.hit(point.x, point.y);
    if (target !== this.#hovered) { this.#hovered?.hover?.(false); this.#hovered = target; }
    target?.hover?.(true, this.#event(target, point));
    for (let widget = target; widget; widget = widget.parent) {
      if (!widget.cursor) continue;
      name = widget.cursor(this.#event(widget, point)) ?? 'default';
      break;
    }
    this.cursor.set(name);
  }

  dispose() {
    this.root?.dispose();
    this.scope.dispose();
    this.focusChanged.dispose();
    for (const texture of [...this.#solids.values(), ...this.#spriteTextures.values()]) texture.destroy(true);
  }
}
