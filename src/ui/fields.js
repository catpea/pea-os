import { Signal, EventEmitter } from '../core/reactive.js';
import { field } from '../gfx/skin.js';
import { Widget } from './widget.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const asModel = value => value instanceof Signal ? value : new Signal(String(value ?? ''));
const previous = (text, at) => at > 1 && /[\uDC00-\uDFFF]/.test(text[at - 1]) && /[\uD800-\uDBFF]/.test(text[at - 2]) ? at - 2 : Math.max(0, at - 1);
const following = (text, at) => Math.min(text.length, at + ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1));

/** Shared editing model for pixel fields. Selection offsets match native UTF-16 offsets. */
export class Field extends Widget {
  static attrs = { ...Widget.attrs, value: 'model', placeholder: 'text', readonly: 'model', maxlength: 'number', action: 'action', submit: 'action', fill: 'color', color: 'color', wrap: 'boolean', secret: 'boolean' };
  interactive = true;
  focusable = true;
  textInput = true;
  multiline = false;
  documentUndo = false;
  events = new EventEmitter();
  scrollX = 0;
  scrollY = 0;
  composing = false;
  #text = '';
  #anchor = 0;
  #caret = 0;
  #drag = false;
  #undo = [];
  #redo = [];
  #editing = false;
  #cache = null;
  #blink = true;

  constructor(ui, props = {}) {
    super(ui, props);
    this.model = asModel(props.value);
    this.maxlength = props.maxlength ?? Infinity;
    if (!(this.maxlength >= 0) || (Number.isFinite(this.maxlength) && !Number.isInteger(this.maxlength))) throw new Error('maxlength must be a non-negative integer');
    this.watch(props.readonly ?? false, value => { this.readonly = Boolean(value); ui.textInput?.sync?.(this); });
    this.watch(props.placeholder ?? '', value => { this.placeholder = String(value); this.invalidate(); });
    this.watch(this.model, value => {
      this.#text = String(value ?? '');
      this.#cache = null;
      this.#anchor = clamp(this.#anchor, 0, this.#text.length);
      this.#caret = clamp(this.#caret, 0, this.#text.length);
      if (!this.#editing) { this.#undo.length = 0; this.#redo.length = 0; }
      this.#reveal();
      this.invalidate();
      if (this.focused) ui.textInput?.sync?.(this);
    });
    this.scope.on(ui.stage.frame, 'tick', ({ time }) => {
      if (!this.focused) return;
      const blink = !ui.motion.value || Math.floor(time / 500) % 2 === 0;
      if (blink !== this.#blink) { this.#blink = blink; this.invalidate(); }
    });
  }

  get text() { return this.#text; }
  set text(value) { this.model.set(String(value ?? '')); }
  get value() { return this.text; }
  set value(value) { this.text = value; }
  get selection() { return { start: Math.min(this.#anchor, this.#caret), end: Math.max(this.#anchor, this.#caret) }; }
  get selectionDirection() { return this.#caret < this.#anchor ? 'backward' : 'forward'; }
  get caret() { return this.#caret; }
  get caretRect() {
    const { line, index } = this.#lineAt(this.#caret);
    const { x, y } = this.toScreen(4 + this.#xAt(line, this.#caret) - this.scrollX, 4 + index * this.ui.font.lineHeight - this.scrollY);
    return { x, y, w: this.magnification, h: this.ui.font.height * this.magnification };
  }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }

  content() { return { w: this.multiline ? 160 : 120, h: this.multiline ? 90 : 19 }; }
  cursor() { return 'text'; }

  setSelection(start, end = start, direction = 'forward') {
    start = clamp(Math.round(start), 0, this.text.length);
    end = clamp(Math.round(end), 0, this.text.length);
    this.#anchor = direction === 'backward' ? end : start;
    this.#caret = direction === 'backward' ? start : end;
    this.#blink = true;
    this.#reveal();
    this.invalidate();
    this.events.emit('selection', this.selection);
    if (this.focused) this.ui.textInput?.sync?.(this);
  }

  selectAll() { this.setSelection(0, this.text.length); }

  #snapshot() { return { text: this.text, anchor: this.#anchor, caret: this.#caret }; }
  #remember() {
    if (this.documentUndo) return;
    this.#undo.push(this.#snapshot());
    if (this.#undo.length > 64) this.#undo.shift();
    this.#redo.length = 0;
  }

  #edit(value, start, end = start, { remember = true, direction = 'forward' } = {}) {
    if (this.readonly || !this.enabled) return false;
    value = String(value).replace(/\r\n?/g, '\n');
    if (!this.multiline) value = value.replace(/\n/g, ' ');
    value = value.slice(0, this.maxlength);
    const old = this.text;
    if (value === old) { this.setSelection(start, end, direction); return false; }
    if (remember) this.#remember();
    this.#editing = true;
    try { this.model.set(value); } finally { this.#editing = false; }
    this.setSelection(start, end, direction);
    const event = { value, previous: old, composing: this.composing };
    this.events.emit('change', event);
    this.props.onChange?.(value, this);
    if (this.props.action) this.context?.run(this.props.action, this);
    return true;
  }

  replaceSelection(value) {
    const { start, end } = this.selection;
    const insert = String(value).replace(/\r\n?/g, '\n');
    const room = Math.max(0, this.maxlength - (this.text.length - (end - start)));
    const text = insert.slice(0, room);
    return this.#edit(this.text.slice(0, start) + text + this.text.slice(end), start + text.length);
  }

  /** Native textarea is authoritative for text, clipboard, and IME composition. */
  applyNative(value, start, end, direction = 'forward') {
    return this.#edit(value, start, end, { remember: !this.composing, direction });
  }
  beginComposition() { if (!this.composing) this.#remember(); this.composing = true; }
  endComposition() { this.composing = false; this.invalidate(); }

  undo() {
    if (!this.canUndo || this.readonly) return false;
    const previous = this.#undo.pop();
    this.#redo.push(this.#snapshot());
    this.#edit(previous.text, previous.anchor, previous.caret, { remember: false });
    return true;
  }
  redo() {
    if (!this.canRedo || this.readonly) return false;
    const next = this.#redo.pop();
    this.#undo.push(this.#snapshot());
    this.#edit(next.text, next.anchor, next.caret, { remember: false });
    return true;
  }

  /** What is drawn: the text, or a dot for each character of a secret such as an API key. */
  get #shown() { return this.props.secret ? this.text.replace(/[^\n]/g, '•') : this.text; }

  #lines() {
    const width = Math.max(1, this.w - 12);
    if (this.#cache?.text === this.text && this.#cache.width === width) return this.#cache.lines;
    const shown = this.#shown;
    const lines = [];
    const { font } = this.ui;
    let start = 0;
    let text = '';
    let used = 0;
    for (let at = 0; at < shown.length;) {
      const ch = String.fromCodePoint(shown.codePointAt(at));
      const advance = font.glyph(ch).w + font.spacing;
      if (ch === '\n') {
        lines.push({ start, end: at, text });
        at += ch.length; start = at; text = ''; used = 0;
        continue;
      }
      if (this.multiline && this.props.wrap !== false && text && used + advance > width) {
        lines.push({ start, end: at, text });
        start = at; text = ''; used = 0;
      }
      text += ch; used += advance; at += ch.length;
    }
    lines.push({ start, end: this.text.length, text });
    this.#cache = { text: this.text, width, lines };
    return lines;
  }

  #lineAt(at) {
    const lines = this.#lines();
    let index = lines.findIndex((line, i) => at <= line.end && !(at === line.end && lines[i + 1]?.start === at));
    if (index < 0) index = lines.length - 1;
    return { line: lines[index], index };
  }

  #xAt(line, at) { const part = this.#shown.slice(line.start, at); return part ? this.ui.font.measure(part) + this.ui.font.spacing : 0; }
  #atX(line, x) {
    let at = line.start;
    let left = 0;
    for (const ch of line.text) {
      const width = this.ui.font.glyph(ch).w + this.ui.font.spacing;
      if (x < left + width / 2) break;
      left += width; at += ch.length;
    }
    return at;
  }

  #reveal() {
    if (!this.w || !this.h) return;
    const { line, index } = this.#lineAt(this.#caret);
    const step = this.ui.font.lineHeight;
    const x = this.#xAt(line, this.#caret);
    const y = index * step;
    this.scrollY = clamp(this.scrollY, y - Math.max(1, this.h - 8 - step), y);
    this.scrollX = clamp(this.scrollX, x - Math.max(1, this.w - 12), x);
    if (this.multiline && this.props.wrap !== false) this.scrollX = 0;
  }

  resized() { this.#cache = null; this.#reveal(); }

  paint(bitmap, theme) {
    field(bitmap, theme, 0, 0, this.w, this.h);
    if (this.props.fill) bitmap.fill(1, 1, this.w - 2, this.h - 2, theme.paint(this.props.fill));
    const { font } = this.ui;
    const ink = theme.paint(this.props.color ?? 'field-ink');
    const selected = this.selection;
    const step = font.lineHeight;
    const lines = this.#lines();
    if (!this.text && !this.focused) font.draw(bitmap, this.placeholder, 4, 5, theme.color('dim'));
    for (let i = 0; i < lines.length; i++) {
      const y = 4 + i * step - this.scrollY;
      if (y < 3 - step || y >= this.h - 3) continue;
      const line = lines[i];
      if (this.focused && selected.end > selected.start && selected.start <= line.end && selected.end > line.start) {
        const begin = Math.max(line.start, selected.start);
        const end = Math.min(line.end, selected.end);
        const x = 4 + this.#xAt(line, begin) - this.scrollX;
        const right = 4 + this.#xAt(line, end) - this.scrollX;
        bitmap.fill(x, y - 1, Math.max(2, right - x), step, theme.color('accent'));
      }
      let x = 4 - this.scrollX;
      let at = line.start;
      for (const ch of line.text) {
        const isSelected = this.focused && at >= selected.start && at < selected.end;
        font.draw(bitmap, ch, x, y, isSelected ? theme.color('accent-ink') : ink);
        x += font.glyph(ch).w + font.spacing;
        at += ch.length;
      }
    }
    if (this.focused && (this.#blink || this.composing)) {
      const { line, index } = this.#lineAt(this.#caret);
      bitmap.fill(4 + this.#xAt(line, this.#caret) - this.scrollX, 4 + index * step - this.scrollY, 1, font.height, ink);
    }
    // Keep scrolled content inside the field frame, including partial glyphs.
    const edge = theme.paint(this.props.fill ?? 'field');
    bitmap.fill(1, 1, this.w - 2, 2, edge);
    bitmap.fill(1, this.h - 3, this.w - 2, 2, edge);
    bitmap.fill(1, 1, 2, this.h - 2, edge);
    bitmap.fill(this.w - 3, 1, 2, this.h - 2, edge);
    if (this.multiline && lines.length * step > this.h - 8) {
      const total = lines.length * step;
      const track = Math.max(1, this.h - 6);
      const knob = Math.max(3, Math.floor(track * (this.h - 8) / total));
      const top = 3 + Math.round((track - knob) * this.scrollY / Math.max(1, total - (this.h - 8)));
      bitmap.fill(this.w - 5, top, 2, knob, theme.color('dim'));
    }
  }

  pointer(type, event) {
    if (!this.enabled) return;
    if (type === 'up' || type === 'cancel') { this.#drag = false; return; }
    if (type !== 'down' && !(type === 'move' && this.#drag)) return;
    const lines = this.#lines();
    const index = clamp(Math.floor((event.y - 4 + this.scrollY) / this.ui.font.lineHeight), 0, lines.length - 1);
    const at = this.#atX(lines[index], event.x - 4 + this.scrollX);
    if (type === 'down' && !event.shift) this.#anchor = at;
    this.#drag = true;
    this.setSelection(this.#anchor, at);
  }

  wheel(event) {
    if (!this.multiline) return false;
    const max = Math.max(0, this.#lines().length * this.ui.font.lineHeight - (this.h - 8));
    const next = clamp(this.scrollY + Math.round(event.dy), 0, max);
    if (next === this.scrollY) return false;
    this.scrollY = next; this.invalidate(); return true;
  }

  #word(at, direction) {
    const word = ch => ch && /[\p{L}\p{N}_]/u.test(ch);
    if (direction < 0) {
      while (at > 0 && !word(String.fromCodePoint(this.text.codePointAt(previous(this.text, at))))) at = previous(this.text, at);
      while (at > 0 && word(String.fromCodePoint(this.text.codePointAt(previous(this.text, at))))) at = previous(this.text, at);
    } else {
      while (at < this.text.length && word(String.fromCodePoint(this.text.codePointAt(at)))) at = following(this.text, at);
      while (at < this.text.length && !word(String.fromCodePoint(this.text.codePointAt(at)))) at = following(this.text, at);
    }
    return at;
  }

  key(type, event) {
    if (!this.enabled || event.alt) return false;
    const { key, ctrl, shift } = event;
    if (type !== 'down') return !ctrl && (key.length === 1 || ['Backspace', 'Delete', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(key));
    if (ctrl && ['z', 'y'].includes(key.toLowerCase())) {
      if (this.documentUndo) return false;
      if (key.toLowerCase() === 'y' || shift) this.redo(); else this.undo();
      return true;
    }
    if (ctrl && key.toLowerCase() === 'a') { this.selectAll(); return true; }
    // A secret can be replaced or pasted, never copied out.
    if (ctrl && this.props.secret && ['c', 'x'].includes(key.toLowerCase())) return true;
    if (ctrl && ['c', 'x', 'v'].includes(key.toLowerCase())) {
      if (event.nativeText) { event.nativeDefault = true; return true; }
      return Boolean(this.ui.textInput?.clipboard?.(key.toLowerCase(), this));
    }
    if (key === 'Enter' && !this.multiline) {
      const listeners = this.events.emit('submit', { value: this.text });
      this.props.onSubmit?.(this.text, this);
      if (this.props.submit) this.context?.run(this.props.submit, this);
      return Boolean(listeners || this.props.onSubmit || this.props.submit);
    }
    // Navigation follows the visible pixel lines, not the invisible native
    // textarea's wrapping. Native input remains authoritative for actual edits.
    if (event.nativeText && ((!ctrl && (key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(key))) || (ctrl && ['Backspace', 'Delete'].includes(key)))) {
      event.nativeDefault = true;
      return true;
    }
    let at = this.#caret;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const left = key === 'ArrowLeft';
      const selection = this.selection;
      at = !shift && selection.start !== selection.end ? (left ? selection.start : selection.end) : ctrl ? this.#word(at, left ? -1 : 1) : left ? previous(this.text, at) : following(this.text, at);
    } else if (key === 'Home' || key === 'End') {
      const { line } = this.#lineAt(at);
      at = ctrl ? (key === 'Home' ? 0 : this.text.length) : key === 'Home' ? line.start : line.end;
    } else if (this.multiline && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(key)) {
      const { line, index } = this.#lineAt(at);
      const direction = key === 'ArrowUp' || key === 'PageUp' ? -1 : 1;
      const amount = key.startsWith('Page') ? Math.max(1, Math.floor((this.h - 8) / this.ui.font.lineHeight)) : 1;
      const lines = this.#lines();
      at = this.#atX(lines[clamp(index + direction * amount, 0, lines.length - 1)], this.#xAt(line, at));
    } else if (key === 'Backspace' || key === 'Delete') {
      if (this.readonly) return true;
      const selected = this.selection;
      if (selected.start === selected.end) this.setSelection(key === 'Backspace' ? (ctrl ? this.#word(at, -1) : previous(this.text, at)) : at, key === 'Delete' ? (ctrl ? this.#word(at, 1) : following(this.text, at)) : at);
      this.replaceSelection(''); return true;
    } else if (key === 'Enter' && this.multiline) { this.replaceSelection('\n'); return true; }
    else if (!ctrl && [...key].length === 1) { this.replaceSelection(key); return true; }
    else return false;
    this.setSelection(shift ? this.#anchor : at, at);
    return true;
  }

  onBlur() { this.#drag = false; this.endComposition(); }
  dispose() { this.events.dispose(); super.dispose(); }
}

export class TextArea extends Field { multiline = true; }
