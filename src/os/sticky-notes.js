import { Signal } from '../core/reactive.js';
import { Widget } from '../ui/widget.js';
import { TextArea } from '../ui/fields.js';
import { caption, CLOSE_BOX, TITLE_H } from '../gfx/skin.js';

const KEY = 'pea-os.notes.v1';
const LIMIT = 80;
const TEXT_LIMIT = 8192;
const COLORS = ['#ffe59a', '#bfe7b7', '#bcdff4', '#f1c6dc', '#d9cff3'];
const COLOR_NAMES = ['Yellow', 'Green', 'Blue', 'Pink', 'Lilac'];
const HEADER = TITLE_H + 1;  // the same caption as a window's
const GRIP = 9;
const MIN_W = 100;
const MIN_H = 70;
const MAX_SIZE = 500;
const coordinate = value => Number.isFinite(value) && Math.abs(value) <= 1000000;
/** A note's own magnifications: { "pixel size": 2..4 }. */
const zooms = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 8
  && Object.entries(value).every(([realm, zoom]) => /^(auto|[1-9])$/.test(realm) && [2, 3, 4].includes(zoom));
const frozen = notes => Object.freeze({ notes: Object.freeze(notes.map(note => Object.freeze(note))), visible: true });

function validate(value, desks) {
  if (value?.version !== 1 || !Array.isArray(value.notes) || value.notes.length > LIMIT) throw new Error('This is not a supported Pea sticky-note file.');
  const ids = new Set();
  return value.notes.map(note => {
    if (!note || typeof note.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(note.id) || ids.has(note.id)
      || typeof note.text !== 'string' || note.text.length > TEXT_LIMIT || !COLORS.includes(note.color)
      || !Number.isInteger(note.desk) || note.desk < 0 || note.desk >= desks
      || !coordinate(note.x) || !coordinate(note.y) || !Number.isFinite(note.w) || note.w < 100 || note.w > 500
      || !Number.isFinite(note.h) || note.h < 70 || note.h > 500
      || typeof note.hidden !== 'boolean' || typeof note.deleted !== 'boolean'
      // Added later, so older files may leave them out.
      || (note.rolled !== undefined && typeof note.rolled !== 'boolean')
      || (note.updated !== undefined && !(Number.isFinite(note.updated) && note.updated >= 0))
      || (note.zooms !== undefined && !zooms(note.zooms))) throw new Error('A sticky note has invalid content or geometry. Nothing was imported.');
    ids.add(note.id);
    return { id: note.id, text: note.text, color: note.color, desk: note.desk, x: Math.round(note.x), y: Math.round(note.y),
      w: Math.round(note.w), h: Math.round(note.h), hidden: note.hidden, deleted: note.deleted, rolled: note.rolled ?? false, updated: note.updated ?? 0,
      zooms: { ...(note.zooms ?? {}) } };
  });
}

/** The first line of a note, for its header and for lists. */
export const noteTitle = note => note.text.trim().split('\n')[0].trim() || 'Untitled note';

/** Small, separately recoverable desktop documents. Permanent deletion is always explicit. */
export class StickyNotes {
  state = new Signal(frozen([]));
  error = new Signal('');
  #serial = 0;

  constructor(os, desktop) {
    this.os = os;
    this.desktop = desktop;
    try {
      const saved = os.platform.storage?.get(KEY);
      if (saved) this.state.set(frozen(validate(JSON.parse(saved), os.model.state.value.desks.length)));
    } catch (error) {
      this.error.set(error.message);
      os.report(new Error(`Sticky notes could not be loaded: ${error.message}`));
    }
  }

  #id() {
    const taken = new Set(this.state.value.notes.map(note => note.id));
    let id;
    do { id = `note-${Date.now().toString(36)}-${(++this.#serial).toString(36)}`; } while (taken.has(id));
    return id;
  }

  #commit(notes) {
    const text = JSON.stringify({ version: 1, notes });
    // Keep the latest work available to Export even if persistence becomes unavailable.
    this.state.set(frozen(notes));
    try {
      this.os.platform.storage?.set(KEY, text);
      this.error.set('');
    } catch (error) {
      const message = `Sticky notes are kept in this session but could not be saved: ${error.message}. Export a copy before closing.`;
      this.error.set(message);
      throw new Error(message);
    }
  }

  /** Each new note takes the color after the newest note's, so neighbors tell apart. */
  get nextColor() {
    const last = this.state.value.notes.at(-1);
    return last ? COLORS[(COLORS.indexOf(last.color) + 1) % COLORS.length] : COLORS[0];
  }

  create({ text = '', color = this.nextColor, desk = this.os.model.state.value.desk, x, y, w = 148, h = 112 } = {}) {
    const notes = this.state.value.notes.slice();
    if (notes.length >= LIMIT) {
      throw new Error(`There can be ${LIMIT} sticky notes, including the recovery bin. Export your notes or permanently delete an archived note before creating another.`);
    }
    const at = this.desktop.toWorld({ x: 20 + (notes.length % 5) * 12, y: this.desktop.work.y + 20 + (notes.length % 5) * 12 });
    const note = { id: this.#id(), text, color, desk, x: x ?? at.x, y: y ?? at.y, w, h, hidden: false, deleted: false, rolled: false, updated: Date.now(), zooms: {} };
    validate({ version: 1, notes: [note] }, this.os.model.state.value.desks.length);
    this.#commit([...notes, note]);
    return note;
  }

  patch(id, patch) {
    const stamp = 'text' in patch ? { updated: Date.now() } : {};
    const notes = this.state.value.notes.map(note => note.id === id ? { ...note, ...patch, ...stamp, id } : note);
    if (!notes.some(note => note.id === id)) throw new Error('This sticky note no longer exists.');
    this.#commit(validate({ version: 1, notes }, this.os.model.state.value.desks.length));
  }

  remove(id) { this.patch(id, { deleted: true, hidden: true }); }

  /** A copy beside the original, on the same desktop. */
  duplicate(id) {
    const note = this.state.value.notes.find(item => item.id === id);
    if (!note) throw new Error('This sticky note no longer exists.');
    const copy = this.create({ text: note.text, color: note.color, desk: note.desk, x: note.x + 14, y: note.y + 14, w: note.w, h: note.h });
    if (Object.keys(note.zooms ?? {}).length) this.patch(copy.id, { zooms: note.zooms });
    return copy;
  }
  purge(id) {
    const note = this.state.value.notes.find(note => note.id === id);
    if (!note?.deleted) throw new Error('Only an archived note can be permanently deleted.');
    this.#commit(this.state.value.notes.filter(note => note.id !== id));
  }
  restore(id) {
    if (!id) id = this.state.value.notes.findLast(note => note.deleted)?.id;
    if (id) { this.patch(id, { deleted: false, hidden: false }); this.reveal(id); }
  }
  showAll() { this.#commit(this.state.value.notes.map(note => ({ ...note, hidden: note.deleted ? note.hidden : false }))); }
  reveal(id) { this.desktop.revealNote(id); }
  export() { return JSON.stringify({ version: 1, notes: this.state.value.notes }, null, 2); }

  import(text) {
    if (typeof text !== 'string' || text.length > 1500000) throw new Error('The sticky-note file is too large.');
    const incoming = validate(JSON.parse(text), this.os.model.state.value.desks.length);
    const current = this.state.value.notes;
    if (current.length + incoming.length > LIMIT) throw new Error(`Import would exceed the ${LIMIT}-note limit. Nothing was imported.`);
    const used = new Set(current.map(note => note.id));
    const merged = incoming.map(note => {
      let id = note.id;
      while (used.has(id)) id = this.#id();
      used.add(id);
      return { ...note, id };
    });
    this.#commit([...current, ...merged]);
    return merged.length;
  }

  dispose() { this.state.dispose(); this.error.dispose(); }
}

/**
 * A real world-space note: its header drags (a double tap rolls it up), its
 * body edits, its corner resizes, and close only hides it. The color chips
 * show while the pointer is over the note or it is being written in.
 */
export class StickyNote extends Widget {
  interactive = true;
  focusBoundary = true;
  #grab = null;
  #size = null;
  #lastTap = -Infinity;

  constructor(ui, desktop, note) {
    super(ui);
    this.desktop = desktop;
    this.note = note;
    this.text = new Signal(note.text);
    // The color chips show while the note is being written in.
    this.scope.on(ui.focusChanged, 'change', ({ widget, previous }) => {
      if (widget === this.editor || previous === this.editor) this.invalidate();
    });
    this.editor = this.add(new TextArea(ui, { value: this.text, maxlength: TEXT_LIMIT, fill: note.color, color: '#22302a', placeholder: 'Write a note…',
      onChange: value => {
        try { desktop.notes.patch(this.note.id, { text: value }); }
        catch (error) { desktop.os.report(error); }
      }
    }));
  }

  get dragging() { return Boolean(this.#grab || this.#size); }

  /** Rolled up, a note is only its header. */
  static height(note) { return note.rolled ? HEADER + 3 : note.h; }

  update(note) {
    this.note = note;
    this.editor.props.fill = note.color;
    this.editor.invalidate();
    if (this.text.value !== note.text) this.text.set(note.text);
    this.invalidate();
  }

  arrange() {
    this.editor.visible = !this.note.rolled;
    this.editor.place(4, HEADER + 2, Math.max(1, this.w - 9), Math.max(1, this.h - HEADER - 7));
  }

  get #chips() { return (this.hovered || this.contains(this.ui.focused)) && this.w >= 112; }
  #chipX(i) { return this.w - 7 - (COLORS.length - i) * 8; }

  paint(bitmap, theme) {
    const { font } = this.ui;
    const paper = theme.paint(this.note.color);
    const ink = theme.color('ink');
    if (theme.has('shadow')) bitmap.fill(2, 2, this.w - 2, this.h - 2, theme.color('shadow'));
    bitmap.fill(0, 0, this.w - 2, this.h - 2, paper);
    bitmap.frame(0, 0, this.w - 2, this.h - 2, ink);
    // The window caption and its motif, in the note's own paper.
    const fold = theme.lock(darkenNote(paper));
    const chips = this.#chips;
    caption(bitmap, theme, font, 1, 1, this.w - 4, {
      title: this.note.text.trim() ? noteTitle(this.note) : 'New note',
      right: chips ? this.w - 3 - this.#chipX(0) : 2,
      colors: { bar: paper, ink, band: fold === paper ? ink : fold, rule: softer(theme, darkenNote(fold), paper, ink) }
    });
    bitmap.fill(1, HEADER - 1, this.w - 4, 1, ink);
    if (chips) {
      COLORS.forEach((color, i) => {
        const x = this.#chipX(i);
        bitmap.fill(x + 1, 4, 6, 6, theme.paint(color));
        bitmap.frame(x + 1, 4, 6, 6, softer(theme, darkenNote(theme.paint(color)), paper, ink));
        if (color === this.note.color) bitmap.frame(x, 3, 8, 8, ink);
      });
    }
    if (!this.note.rolled) {
      // A folded corner at the bottom left, as on a paper note.
      const bottom = this.h - 4;
      bitmap.fill(1, bottom, 3, 1, fold);
      bitmap.fill(1, bottom - 1, 2, 1, fold);
      bitmap.set(1, bottom - 2, fold);
      // The resize grip: three short diagonals in the corner.
      const gx = this.w - 3;
      const gy = this.h - 3;
      const grip = theme.lock(darkenNote(darkenNote(paper)));
      for (const n of [3, 5, 7]) for (let i = 0; i < n - 1; i += 1) if ((i + n) % 2) bitmap.set(gx - n + i + 1, gy - i - 1, grip);
    }
  }

  /** The corner grip is the note's own, above the text area. */
  hit(px, py) {
    const target = super.hit(px, py);
    if (!target || this.note.rolled) return target;
    const x = Math.floor((px - this.x) / this.zoom);
    const y = Math.floor((py - this.y) / this.zoom);
    return x >= this.w - GRIP - 2 && y >= this.h - GRIP - 2 ? this : target;
  }

  pointer(type, event) {
    const notes = this.desktop.notes;
    if (type === 'down') {
      this.parent.raise(this);
      if (!this.note.rolled && event.x >= this.w - GRIP - 2 && event.y >= this.h - GRIP - 2) {
        this.#size = { gx: event.gx, gy: event.gy, w: this.w, h: this.h, zoom: this.magnification };
        return;
      }
      if (event.y >= HEADER) return;
      if (event.x < CLOSE_BOX.w) { notes.patch(this.note.id, { hidden: true }); return; }
      if (this.#chips) {
        const color = COLORS.findIndex((_, i) => event.x >= this.#chipX(i) && event.x < this.#chipX(i) + 8);
        if (color >= 0) { notes.patch(this.note.id, { color: COLORS[color] }); return; }
      }
      const now = this.ui.stage.time;
      if (now - this.#lastTap < 400) {
        this.#lastTap = -Infinity;
        notes.patch(this.note.id, { rolled: !this.note.rolled });
        return;
      }
      this.#lastTap = now;
      this.#grab = { gx: event.gx, gy: event.gy, x: this.x, y: this.y };
      return;
    }
    if (this.#size) {
      const size = this.#size;
      const w = Math.max(MIN_W, Math.min(MAX_SIZE, Math.round(size.w + (event.gx - size.gx) / size.zoom)));
      const h = Math.max(MIN_H, Math.min(MAX_SIZE, Math.round(size.h + (event.gy - size.gy) / size.zoom)));
      if (type === 'move') { this.place(this.x, this.y, w, h); this.desktop.minimap?.invalidate(); return; }
      this.#size = null;
      if (type === 'up') notes.patch(this.note.id, { w, h });
      else this.ui.requestLayout();
      return;
    }
    if (!this.#grab) return;
    if (type === 'move') {
      if (Math.abs(event.gx - this.#grab.gx) + Math.abs(event.gy - this.#grab.gy) > 2) this.#lastTap = -Infinity;
      this.place(this.#grab.x + event.gx - this.#grab.gx, this.#grab.y + event.gy - this.#grab.gy, this.w, this.h);
      this.desktop.minimap?.invalidate();
      return;
    }
    const moved = this.x !== this.#grab.x || this.y !== this.#grab.y;
    this.#grab = null;
    if (type === 'up' && moved) notes.patch(this.note.id, this.desktop.toWorld(this));
    else if (type !== 'up') this.ui.requestLayout();
  }

  menu(event) {
    this.desktop.noteMenu(this.note.id, event);
    return true;
  }

  cursor(event) {
    if (!this.note.rolled && event.x >= this.w - GRIP - 2 && event.y >= this.h - GRIP - 2) return 'nwse-resize';
    if (event.y < HEADER) return event.x < CLOSE_BOX.w || (this.#chips && event.x >= this.#chipX(0)) ? 'pointer' : 'grab';
    return 'text';
  }
  dispose() { super.dispose(); this.text.dispose(); }
}

/** A shade for fine detail on a note, or ink where a small palette would make it vanish into the paper. */
function softer(theme, color, paper, ink) {
  const locked = theme.lock(color);
  return locked === paper ? ink : locked;
}

/** A slightly deeper shade of a note's paper, for its fold, chip edges and grip. */
function darkenNote(color) {
  const part = shift => Math.round(((color >>> shift) & 255) * 0.82);
  return ((color & 0xff000000) | (part(16) << 16) | (part(8) << 8) | part(0)) >>> 0;
}

export { COLORS as NOTE_COLORS, COLOR_NAMES as NOTE_COLOR_NAMES, LIMIT as NOTE_LIMIT };
