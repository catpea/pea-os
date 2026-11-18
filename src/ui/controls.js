import { Signal, EventEmitter } from '../core/reactive.js';
import { channels } from '../gfx/color.js';
import { button, checkbox, field } from '../gfx/skin.js';
import { Widget } from './widget.js';

/** Leaf widgets: <label>, <button>, <check>, <slider>, <choice>, <image>, <canvas>. */

const model = (source, fallback) => (source instanceof Signal ? source : new Signal(source ?? fallback));

/** Dark or light text, whichever reads on `face`. */
function inkFor(theme, face) {
  const [r, g, b] = channels(face);
  const dark = theme.color('ink');
  const light = theme.color('paper');
  const luminance = color => { const [cr, cg, cb] = channels(color); return cr * 0.3 + cg * 0.59 + cb * 0.11; };
  const here = r * 0.3 + g * 0.59 + b * 0.11;
  return Math.abs(luminance(dark) - here) > Math.abs(luminance(light) - here) ? dark : light;
}

export class Label extends Widget {
  static attrs = { ...Widget.attrs, text: 'text', color: 'color', shadow: 'color', scale: 'number', bold: 'boolean', wrap: 'boolean', align: 'string' };

  text = '';

  constructor(ui, props) {
    super(ui, props);
    this.style = { scale: props.scale ?? 1, bold: props.bold ?? false };
    this.watch(props.text ?? '', value => {
      const text = String(value ?? '');
      if (text === this.text) return;
      this.text = text;
      this.invalidate();
      ui.requestLayout();
    });
  }

  lines(maxW) {
    return this.props.wrap && Number.isFinite(maxW) ? this.ui.font.wrap(this.text, maxW, this.style) : this.text.split('\n');
  }

  content(maxW) {
    const { font } = this.ui;
    const { scale } = this.style;
    const lines = this.lines(maxW);
    return {
      w: Math.max(0, ...lines.map(line => font.measure(line, this.style))) + (this.props.shadow ? scale : 0),
      h: ((lines.length - 1) * font.lineHeight + font.height) * scale + (this.props.shadow ? scale : 0)
    };
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    const { scale } = this.style;
    const color = theme.paint(this.props.color ?? 'text');
    const depth = this.props.shadow ? scale : 0;
    this.lines(this.w).forEach((line, i) => {
      const width = font.measure(line, this.style);
      const free = this.w - depth - width;
      const x = this.props.align === 'center' ? free >> 1 : this.props.align === 'end' ? free : 0;
      const y = i * font.lineHeight * scale;
      if (depth) font.draw(bitmap, line, x + depth, y + depth, theme.paint(this.props.shadow), this.style);
      font.draw(bitmap, line, x, y, color, this.style);
    });
  }
}

export class Button extends Widget {
  static attrs = { ...Widget.attrs, text: 'text', action: 'action', kind: 'string', face: 'color' };

  interactive = true;
  focusable = true;
  pressed = false;
  text = '';

  constructor(ui, props) {
    super(ui, props);
    this.watch(props.text ?? '', value => {
      this.text = String(value ?? '');
      this.invalidate();
      ui.requestLayout();
    });
  }

  content() {
    return { w: this.ui.font.measure(this.text) + 14, h: 17 };
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    const accent = this.props.kind === 'accent';
    const face = this.props.face ? theme.paint(this.props.face) : theme.color(accent ? 'accent' : 'panel');
    const ink = this.props.face ? inkFor(theme, face) : theme.color(accent ? 'accent-ink' : 'panel-ink');
    const top = button(bitmap, theme, 0, 0, this.w, this.h, { pressed: this.pressed, face });
    // A squeezed button shortens its label rather than letting it spill over the edge.
    let label = this.text;
    while (label.length > 1 && font.measure(label) > this.w - 6) label = `${label.slice(0, -2)}…`;
    if (font.measure(label) > this.w - 4) return;
    const x = (this.w - font.measure(label)) >> 1;
    font.draw(bitmap, label, x, top + ((this.h - 2 - font.cap) >> 1), ink);
  }

  pointer(type, event) {
    if (!this.enabled) return;
    const pressed = type === 'down' || (type === 'move' && event.inside);
    if (pressed !== this.pressed) {
      this.pressed = pressed;
      this.invalidate();
    }
    if (type === 'up' && event.inside) {
      this.props.onPress?.(this);
      if (this.props.action) this.context.run(this.props.action, this);
    }
  }

  key(type, event) {
    if (!['Enter', ' '].includes(event.key) || event.ctrl || event.alt) return false;
    if (type === 'down' && !event.repeat) this.pointer('down', { inside: true });
    if (type === 'up') this.pointer('up', { inside: true });
    return true;
  }
  onBlur() { this.pressed = false; this.invalidate(); }
}

export class Check extends Widget {
  static attrs = { ...Widget.attrs, text: 'text', value: 'model', action: 'action' };

  interactive = true;
  focusable = true;
  text = '';

  constructor(ui, props) {
    super(ui, props);
    this.model = model(props.value, false);
    this.watch(this.model, () => this.invalidate());
    this.watch(props.text ?? '', value => {
      this.text = String(value ?? '');
      this.invalidate();
      ui.requestLayout();
    });
  }

  content() {
    return { w: 13 + this.ui.font.measure(this.text), h: 11 };
  }

  paint(bitmap, theme) {
    checkbox(bitmap, theme, 0, 1, Boolean(this.model.value));
    this.ui.font.draw(bitmap, this.text, 13, 2, theme.color('text'));
  }

  pointer(type, event) {
    if (!this.enabled) return;
    if (type !== 'up' || !event.inside) return;
    this.model.set(!this.model.value);
    if (this.props.action) this.context.run(this.props.action, this);
  }

  key(type, event) {
    if (![' ', 'Enter'].includes(event.key) || event.ctrl || event.alt) return false;
    if (type === 'down' && !event.repeat) this.pointer('up', { inside: true });
    return true;
  }
}

export class Slider extends Widget {
  static attrs = { ...Widget.attrs, value: 'model', min: 'number', max: 'number', step: 'number', action: 'action' };

  interactive = true;
  focusable = true;

  constructor(ui, props) {
    super(ui, props);
    this.min = props.min ?? 0;
    this.max = props.max ?? 100;
    this.step = props.step ?? 1;
    if (!(this.max > this.min) || !(this.step > 0)) throw new Error('needs max > min and step > 0');
    this.model = model(props.value, this.min);
    this.watch(this.model, () => this.invalidate());
  }

  content() {
    return { w: 80, h: 11 };
  }

  get knob() {
    const t = (Math.min(this.max, Math.max(this.min, Number(this.model.value) || 0)) - this.min) / (this.max - this.min);
    return Math.round(t * (this.w - 7));
  }

  paint(bitmap, theme) {
    const x = this.knob;
    field(bitmap, theme, 0, 3, this.w, 5);
    bitmap.fill(1, 4, x + 2, 3, theme.color('accent'));
    button(bitmap, theme, x, 0, 7, 11, { radius: 1 });
  }

  pointer(type, event) {
    if (!this.enabled) return;
    if (type !== 'down' && type !== 'move') return;
    const t = Math.min(1, Math.max(0, (event.x - 3) / Math.max(1, this.w - 7)));
    const value = this.min + Math.round(t * (this.max - this.min) / this.step) * this.step;
    if (this.model.set(Math.min(this.max, value)) && this.props.action) this.context.run(this.props.action, this);
  }

  key(type, event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return false;
    if (type !== 'down') return true;
    const delta = ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key) ? -1 : 1;
    const value = event.key === 'Home' ? this.min : event.key === 'End' ? this.max : Number(this.model.value) + delta * this.step * (event.key.startsWith('Page') ? 10 : 1);
    if (this.model.set(Math.max(this.min, Math.min(this.max, value))) && this.props.action) this.context.run(this.props.action, this);
    return true;
  }
}

/** One-of-many as a wrapping row of chips. Options come from <option> or a Signal. */
export class Choice extends Widget {
  static attrs = { ...Widget.attrs, value: 'model', options: 'list', action: 'action' };

  interactive = true;
  focusable = true;
  options = [];
  #chips = [];

  constructor(ui, props) {
    super(ui, props);
    this.model = model(props.value, null);
    this.watch(this.model, () => this.invalidate());
    this.watch(props.options ?? props.items ?? [], options => {
      this.options = options;
      this.invalidate();
      ui.requestLayout();
    });
  }

  #flow(maxW) {
    const { font, sprites } = this.ui;
    let x = 0;
    let y = 0;
    let right = 0;
    let tall = 0;
    const chips = this.options.map(option => {
      const picture = option.sprite ? sprites.get(option.sprite).frames[0] : null;
      const w = picture ? picture.width + 4 : font.measure(String(option.text)) + 10;
      const h = picture ? picture.height + 4 : 13;
      if (x > 0 && x + w > maxW) {
        x = 0;
        y += tall + 2;
        tall = 0;
      }
      const chip = { option, picture, x, y, w, h };
      x += w + 2;
      right = Math.max(right, x - 2);
      tall = Math.max(tall, h);
      return chip;
    });
    return { chips, w: right, h: chips.length ? y + tall : 0 };
  }

  content(maxW) {
    const { w, h } = this.#flow(maxW);
    return { w, h };
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    this.#chips = this.#flow(this.w).chips;
    for (const { option, picture, x, y, w, h } of this.#chips) {
      const selected = String(option.value) === String(this.model.value);
      bitmap.roundFill(x, y, w, h, 2, theme.color(selected ? 'accent' : 'panel'));
      bitmap.roundFrame(x, y, w, h, 2, theme.color('ink'));
      if (picture) bitmap.blit(picture, x + 2, y + 2);
      else font.draw(bitmap, String(option.text), x + 5, y + 3, theme.color(selected ? 'accent-ink' : 'panel-ink'));
    }
  }

  pointer(type, event) {
    if (!this.enabled || type !== 'up') return;
    const chip = this.#chips.find(({ x, y, w, h }) => event.x >= x && event.x < x + w && event.y >= y && event.y < y + h);
    if (chip && !chip.option.disabled && this.model.set(chip.option.value) && this.props.action) this.context.run(this.props.action, this);
  }

  key(type, event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
    if (type !== 'down') return true;
    const choices = this.options.filter(option => !option.disabled);
    if (!choices.length) return true;
    const current = choices.findIndex(option => String(option.value) === String(this.model.value));
    const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    const at = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (Math.max(0, current) + delta + choices.length) % choices.length;
    if (this.model.set(choices[at].value) && this.props.action) this.context.run(this.props.action, this);
    return true;
  }
}

/** A sprite from the registry. Multi-frame sprites animate; effect="bob" floats. */
export class Image extends Widget {
  static attrs = { ...Widget.attrs, sprite: 'text', scale: 'number', effect: 'string' };

  #sprite = null;
  #frame = 0;
  #lift = 0;
  #motion = null;

  constructor(ui, props) {
    super(ui, props);
    this.scale = props.scale ?? 1;
    if (props.effect !== undefined && props.effect !== 'bob') throw new Error('effect must be "bob"');
    this.picture = new ui.PIXI.Sprite();
    this.picture.scale.set(this.scale);
    this.view.addChild(this.picture);
    this.watch(props.sprite, id => {
      this.id = String(id);
      this.#refresh();
      ui.requestLayout();
    });
    this.scope.add(ui.theme.subscribe(() => this.#refresh(), { immediate: false }));
  }

  #refresh() {
    this.#sprite = this.ui.sprites.get(this.id);
    this.#frame = 0;
    this.picture.texture = this.ui.spriteTexture(this.#sprite.frames[0]);
    const moving = this.#sprite.frames.length > 1 || this.props.effect === 'bob';
    if (moving && !this.#motion) this.#motion = this.scope.add(this.ui.stage.frame.on('tick', frame => this.#animate(frame)));
  }

  #animate({ time }) {
    const { frames, fps } = this.#sprite;
    const frame = Math.floor(time * fps / 1000) % frames.length;
    if (frame !== this.#frame) {
      this.#frame = frame;
      this.picture.texture = this.ui.spriteTexture(frames[frame]);
    }
    const lift = this.props.effect === 'bob' && this.ui.anim.motion ? Math.round(Math.sin(time / 320) * 1.5) : 0;
    if (lift !== this.#lift) {
      this.#lift = lift;
      this.arrange();
    }
  }

  content() {
    return { w: this.#sprite.width * this.scale, h: this.#sprite.height * this.scale + (this.props.effect === 'bob' ? 4 : 0) };
  }

  arrange() {
    const w = this.#sprite.width * this.scale;
    const h = this.#sprite.height * this.scale;
    this.picture.position.set((this.w - w) >> 1, ((this.h - h) >> 1) + this.#lift);
  }
}

/**
 * A bitmap an app script draws into. `events` publishes 'down' | 'move' |
 * 'up' | 'cancel' with widget-local coordinates, 'resize' with { w, h } and
 * 'wheel' with { x, y, dx, dy, handled }: set handled to keep the wheel.
 * Call commit() after drawing. Content survives resizes.
 *
 * A canvas has no context menu or cursor of its own, so a long press never
 * interrupts drawing. A script that wants them opts in with useMenu(fn) and
 * useCursor(fn).
 */
export class Canvas extends Widget {
  static attrs = { ...Widget.attrs, fill: 'color' };

  interactive = true;
  // A press keeps focus here, not on a pane around it; the frame mark shows only for the keyboard.
  focusable = true;
  events = new EventEmitter();

  content() {
    return { w: 64, h: 48 };
  }

  resized() {
    if (this.w < 1 || this.h < 1) return;
    const previous = this.bitmap;
    const bitmap = this.surface(this.w, this.h);
    if (this.props.fill) bitmap.clear(this.ui.theme.value.paint(this.props.fill));
    if (previous) bitmap.blit(previous, 0, 0);
    this.events.emit('resize', { w: this.w, h: this.h });
    this.commit();
  }

  /** App pixels are shown as drawn; a palette theme never rewrites a user's picture. */
  commit() {
    this.upload();
  }

  pointer(type, event) {
    this.events.emit(type, event);
  }

  wheel(event) {
    const routed = { ...event, handled: false };
    this.events.emit('wheel', routed);
    return routed.handled;
  }

  /** fn(event) -> true when it opened a menu; a right click or a long press asks it. */
  useMenu(fn) {
    this.menu = event => Boolean(fn(event));
  }

  /** fn(event) -> a CSS cursor name for the point under the pointer. */
  useCursor(fn) {
    this.cursor = fn;
  }

  /**
   * Takes drops (see ui/drag.js): accepts(payload) -> boolean says what may
   * land here, drop(payload, event) handles one at a canvas point.
   */
  useDrop({ accepts, drop }) {
    this.accepts = payload => Boolean(accepts(payload));
    this.drop = (payload, event) => (this.accepts(payload) ? (drop(payload, event), true) : false);
  }

  dispose() {
    this.events.dispose();
    super.dispose();
  }
}
