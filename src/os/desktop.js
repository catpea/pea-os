import { Widget } from '../ui/widget.js';
import { ease } from '../gfx/animator.js';
import { button, BAR_H, TASK_H, TITLE_H, TOOL_H, SHADOW } from '../gfx/skin.js';
import { Keyboard } from './keyboard.js';
import { MenuBar, Popup } from './menu.js';
import { shows } from './model.js';
import { TaskBar } from './taskbar.js';
import { Wallpaper } from './wallpaper.js';
import { Window } from './window.js';
import { Launcher } from './launcher.js';
import { Minimap } from './minimap.js';
import { Overview } from './overview.js';
import { StickyNotes, StickyNote, NOTE_COLORS, NOTE_COLOR_NAMES } from './sticky-notes.js';
import { CATEGORIES } from './app.js';

/**
 * The desktop shell, configured by an XML document:
 *
 *   <desktop version="2">
 *     <menubar>
 *       <menu title="Pea" sprite="pea-9">
 *         <item text="About Pea OS" action="launch:about"/>
 *         <separator/>
 *         <item text="Smooth pixels" action="toggle:os.smooth" check="os.smooth"/>
 *       </menu>
 *       <menu title="Apps"><apps/></menu>
 *     </menubar>
 *     <launcher><apps/></launcher>                  <!-- the taskbar's pea button -->
 *     <context for="window">                        <!-- right click or long press -->
 *       <magnify/>
 *       <item text="Minimize" action="window:minimize"/>
 *     </context>
 *     <icons><icon app="paint"/></icons>
 *   </desktop>
 *
 * An <item> may name an icon (a glyph-* or mini-* sprite) and a shortcut
 * to show beside it: <item text="Save" action="file:save" icon="glyph-save" shortcut="Ctrl+S"/>.
 *
 * Entries that expand: <apps/>, <themes/>, <desks/>, <send/> (move a window
 * to another desktop), <tools/> (show or hide a window's tool windows) and
 * <magnify for="window|menubar|taskbar|icons|start|minimap|overview"/>.
 * Contexts: window, tool, task, desktop, icon, menubar, taskbar, start, minimap, overview.
 *
 * The shell is a view of the desktop model: it subscribes once and pushes
 * each change to the window widgets it already owns. Normal windows and notes
 * live in a world that pans; icons, tiled windows, the bars and menus stay put,
 * so panning can also clear the windows away from the icons.
 */

const ICON_W = 58;
const ICON_H = 42;
const TILE = 24;
const REACH = 40;        // screen pixels of caption that stay reachable
const SNAP_EDGE = 6;     // how close to a screen edge the pointer previews a tile
const SNAP_CORNER = 28;  // and how far along it a corner reaches
const MAGNET = 5;        // screen pixels within which edges attract
const ZOOMS = [1, 2, 3, 4];

const ENTRIES = ['item', 'separator', 'apps', 'themes', 'desks', 'send', 'tools', 'magnify'];
const CONTEXTS = { window: 'window', tool: 'window', task: 'window', desktop: 'icons', icon: 'icons', menubar: 'menubar', taskbar: 'taskbar',
  start: 'start', minimap: 'minimap', overview: 'overview' };
const MAGNIFIABLE = ['window', 'menubar', 'taskbar', 'icons', 'start', 'minimap', 'overview'];
const WINDOW_FLAGS = ['min', 'max', 'shade', 'top', 'all'];
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where a rectangle beside a window goes when the window goes from `from` to
 * `to` (screen x, y; w, h in window pixels times zoom): it keeps its distance
 * from the nearer of the window's left or right edge, and of its top or bottom.
 */
export function anchor(from, to, rect) {
  const span = r => ({ w: r.w * r.zoom, h: r.h * r.zoom });
  const a = span(from);
  const b = span(to);
  const own = span(rect);
  const right = rect.x + own.w / 2 >= from.x + a.w / 2;
  const below = rect.y + own.h / 2 >= from.y + a.h / 2;
  return {
    x: Math.round(right ? rect.x + (to.x + b.w) - (from.x + a.w) : rect.x + to.x - from.x),
    y: Math.round(below ? rect.y + (to.y + b.h) - (from.y + a.h) : rect.y + to.y - from.y)
  };
}

/**
 * Where docked tools go, in screen pixels: beside their owner and never over
 * one another. Each tool, in order, takes the first free place that fits in
 * `area`: a column to the right of the owner, further columns to the right,
 * then columns to its left, each filled from the owner's top down; failing
 * all of those, stacked up from the owner's bottom-right corner, below its
 * caption. `taken` are rectangles to keep clear of, such as floating tools;
 * `avoid` are ones to keep clear of where possible, such as the map, which
 * may cover the edge of a tool rather than have the tool cover its owner.
 * owner and taken are { x, y, w, h }; sizes are [{ w, h }]; owner.caption is
 * how far down its content starts.
 */
export function dock(owner, sizes, taken, area, avoid = []) {
  const GAP = 3;
  const placed = [...taken];
  const clear = (r, others) => !others.some(o => r.x < o.x + o.w + GAP && o.x < r.x + r.w + GAP && r.y < o.y + o.h + GAP && o.y < r.y + r.h + GAP);
  const free = r => clear(r, placed);
  const fits = r => r.x >= area.x && r.x + r.w <= area.x + area.w && r.y >= area.y && r.y + r.h <= area.y + area.h;
  const right = owner.x + owner.w;
  const bottom = Math.min(owner.y + owner.h, area.y + area.h);
  return sizes.map(({ w, h }) => {
    const unique = list => [...new Set(list.map(Math.round))];
    const columns = [
      ...unique([right + GAP, ...placed.filter(o => o.x >= right).map(o => o.x + o.w + GAP)]).sort((a, b) => a - b),
      ...unique([owner.x - GAP - w, ...placed.filter(o => o.x + o.w <= owner.x).map(o => o.x - GAP - w)]).sort((a, b) => b - a)
    ];
    // From the owner's top down, then upward from there when the owner sits low.
    const rows = unique([owner.y, owner.y + owner.h - h, area.y + area.h - h, area.y, ...placed.map(o => o.y + o.h + GAP)]);
    const order = [...rows.filter(y => y >= owner.y).sort((a, b) => a - b), ...rows.filter(y => y < owner.y).sort((a, b) => b - a)];
    const beside = test => {
      for (const x of columns) {
        const found = order.map(y => ({ x, y, w, h })).find(r => fits(r) && free(r) && test(r));
        if (found) return found;
      }
      return null;
    };
    let spot = beside(r => clear(r, avoid)) ?? beside(() => true);
    if (!spot) {
      // No room outside: inside the owner's bottom-right corner, stacking upward.
      const x = Math.max(owner.x + 4, Math.min(right, area.x + area.w) - w - 4);
      const lowest = bottom - h - 4;
      const ups = unique([lowest, ...placed.map(o => o.y - GAP - h)]).filter(y => y <= lowest).sort((a, b) => b - a);
      spot = ups.map(y => ({ x, y, w, h })).find(r => r.y >= owner.y + owner.caption && free(r))
        ?? { x, y: Math.max(owner.y + owner.caption, lowest), w, h };
    }
    placed.push(spot);
    return { x: spot.x, y: spot.y };
  });
}

class DesktopIcon extends Widget {
  interactive = true;
  pressed = false;
  #grab = null;

  constructor(ui, { app, desktop }) {
    super(ui);
    this.app = app;
    this.desktop = desktop;
  }

  get dragging() {
    return Boolean(this.#grab?.moved);
  }

  /** The tile's rectangle on screen: where windows zoom from and to. */
  get tile() {
    const { x, y } = this.toScreen((this.w - TILE) >> 1, 0);
    return { x, y, w: TILE * this.zoom, h: TILE * this.zoom };
  }

  paint(bitmap, theme) {
    const { font, sprites } = this.ui;
    const x = (this.w - TILE) >> 1;
    const top = button(bitmap, theme, x, 0, TILE, TILE, { pressed: this.pressed, face: theme.paint(this.app.tint), radius: 4 });
    const picture = sprites.get(this.app.sprite).frames[0];
    bitmap.blit(picture, x + ((TILE - picture.width) >> 1), top + ((TILE - 2 - picture.height) >> 1));
    if (!this.desktop.labels) return;
    const label = this.app.title;
    const lx = Math.max(1, (this.w - font.measure(label)) >> 1);
    font.drawOutlined(bitmap, label, lx, TILE + 4, theme.color('label'), theme.color('label-edge'));
  }

  #show(pressed) {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    this.invalidate();
  }

  pointer(type, event) {
    if (type === 'down') {
      this.#grab = { gx: event.gx, gy: event.gy, dx: event.gx - this.x, dy: event.gy - this.y, moved: false };
      this.#show(true);
      return;
    }
    const grab = this.#grab;
    if (!grab) return;
    if (type === 'move') {
      if (!grab.moved && Math.abs(event.gx - grab.gx) + Math.abs(event.gy - grab.gy) <= 3) return;
      if (!grab.moved) this.parent.raise(this);
      grab.moved = true;
      this.#show(false);
      this.place(event.gx - grab.dx, event.gy - grab.dy, this.w, this.h);
      return;
    }
    this.#grab = null;
    this.#show(false);
    if (type === 'up' && grab.moved) this.desktop.dropIcon(this);
    else if (type === 'up' && event.inside) this.desktop.os.open(this.app.id);
    else if (grab.moved) this.ui.requestLayout();
  }

  menu(event) {
    return this.desktop.openContext('icon', this.app.id, event);
  }
}

/** The empty desk under the icons: where panning starts and the desktop menu opens. */
class Desk extends Widget {
  interactive = true;

  constructor(ui, desktop) {
    super(ui);
    this.desktop = desktop;
  }

  pointer(type, event) {
    if (type === 'down' && !this.desktop.pans(event)) return;
    this.desktop.panGesture(type, event);
  }

  menu(event) {
    return this.desktop.openContext('desktop', null, event);
  }

  cursor() {
    return this.desktop.os.signals.get('pan-mode') ? 'grab' : 'default';
  }
}

/** Where a dragged window will land when it is let go at a screen edge. */
class Preview extends Widget {
  paint(bitmap, theme) {
    bitmap.checker(0, 0, this.w, this.h, theme.color('accent'), 0);
    bitmap.frame(0, 0, this.w, this.h, theme.color('ink'));
    bitmap.frame(1, 1, this.w - 2, this.h - 2, theme.color('paper'));
  }
}

export class Desktop extends Widget {
  /** The middle button pans from anywhere, so it is captured here. */
  middle = true;
  #frames = new Map();
  /** The window being dragged or resized: { id, from, live, tiled }, while the gesture lasts. */
  #gesture = null;
  /** Docked tools in the order they came on screen, which is the order they take their places in. */
  #docked = [];
  #icons = new Map();
  #iconHomes = new Map();
  #iconZoom = 1;
  #notes = new Map();
  #menu = null;
  #pan = null;       // where a pan gesture or glide is right now; null follows the model
  #panGrab = null;
  #space = false;
  #switching = false;
  #sliding = null;
  #slide = 0;

  constructor(ui, os, node) {
    super(ui);
    this.os = os;
    const { menus, launcher, contexts, icons } = this.#read(node);
    this.menus = menus;
    this.launcher = launcher;
    this.contexts = contexts;

    this.wallpaper = this.add(new Wallpaper(ui));
    this.desk = this.add(new Desk(ui, this));
    // The map sits in one of two layers: under the windows, or above them (always on top).
    this.mapUnder = this.add(new Widget(ui));
    this.notesLayer = this.add(new Widget(ui));
    this.windows = this.add(new Widget(ui));
    this.mapOver = this.add(new Widget(ui));
    this.minimap = this.mapOver.add(new Minimap(ui, this));
    this.fx = this.add(new Widget(ui));
    this.preview = this.fx.add(new Preview(ui));
    this.preview.visible = false;
    this.keys = this.add(new Keyboard(ui, {
      onKey: key => {
        ui.stage.keys.emit('down', { key });
        ui.stage.keys.emit('up', { key });
      }
    }));
    this.keys.preserveFocus = true;
    this.tasks = this.add(new TaskBar(ui, {
      os,
      onPress: slot => this.#task(slot),
      onContext: (slot, event) => this.openContext(slot?.kind === 'launcher' ? 'start' : slot ? 'task' : 'taskbar', slot?.id ?? null, event)
    }));
    this.bar = this.add(new MenuBar(ui, {
      menus,
      clock: os.signals.resolve('clock'),
      onMenu: index => (this.#menu?.index === index ? this.#closeMenu() : this.#openMenu(index)),
      onContext: event => this.openContext('menubar', null, event)
    }));
    this.popups = this.add(new Widget(ui));
    this.notes = new StickyNotes(os, this);

    for (const id of icons) this.#icons.set(id, this.desk.add(new DesktopIcon(ui, { app: os.apps.get(id), desktop: this })));

    this.scope.on(ui.pressed, 'down', ({ target }) => {
      if (this.#menu && target !== this.bar && target !== this.tasks && !this.#menu.popup.contains(target)) this.#closeMenu();
      for (const frame of this.#frames.values()) {
        if (target && frame.contains(target) && os.model.shows(frame.id)) os.activate(frame.id);
      }
    });
    this.scope.on(ui.stage.keys, 'down', event => this.#key('down', event));
    this.scope.on(ui.stage.keys, 'up', event => this.#key('up', event));
    this.scope.subscribe(os.signals.resolve('minimap-top'), top => {
      const layer = top ? this.mapOver : this.mapUnder;
      if (this.minimap.parent === layer) return;
      this.minimap.parent.remove(this.minimap);
      layer.add(this.minimap);
    });
    for (const name of ['zooms', 'taskbar', 'keys', 'panning', 'minimap']) {
      this.scope.subscribe(os.signals.resolve(name), () => ui.requestLayout(), { immediate: false });
    }
    // Apps removed with Software leave the desktop; the others close ranks.
    this.scope.subscribe(os.software.changed, () => { this.#iconHomes.clear(); ui.requestLayout(); }, { immediate: false });
    this.scope.subscribe(os.signals.resolve('labels'), () => {
      for (const icon of this.#icons.values()) icon.invalidate();
      ui.requestLayout();
    }, { immediate: false });
    this.scope.subscribe(this.notes.state, () => { this.#syncNotes(); ui.requestLayout(); });
    this.scope.subscribe(os.model.state, (state, previous) => this.#sync(state, previous));
  }

  /** The 9x9 picture that stands for an app in menus and task buttons, or null. */
  appIcon(id) {
    const { sprites } = this.ui;
    if (sprites.has(`mini-${id}`)) return `mini-${id}`;
    const sprite = this.os.apps.get(id)?.sprite;
    return sprite?.startsWith('pea-') ? 'pea-9' : null;
  }

  /** Small screens show one maximized window at a time. */
  get compact() {
    return this.w < 340 || this.h < 230;
  }

  get labels() {
    return this.os.signals.get('labels');
  }

  /** How far the world is scrolled, mid-gesture included. */
  get pan() {
    return this.#pan ?? this.os.model.state.value.pan;
  }

  /** The screen between the menu bar and whatever is docked at the bottom. */
  get work() {
    const top = BAR_H * this.bar.zoom;
    const bottom = this.keys.visible ? this.keys.y : this.tasks.visible ? this.tasks.y : this.h;
    return { x: 0, y: top, w: this.w, h: Math.max(TITLE_H, bottom - top) };
  }

  /** World coordinates start at the top left of the work area and scroll with the pan. */
  toWorld({ x, y }) {
    return { x: Math.round(x + this.pan.x), y: Math.round(y - this.work.y + this.pan.y) };
  }

  fromWorld({ x, y }) {
    return { x: x - this.pan.x, y: y + this.work.y - this.pan.y };
  }

  /** Navigator panning changes the camera only; it never edits world geometry. */
  setPan(point, commit = true) {
    const to = { x: Math.round(point.x), y: Math.round(point.y) };
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;
    if (commit) { this.#pan = null; this.os.model.pan(to); }
    else this.#pan = to;
    this.ui.requestLayout();
  }

  /** Rectangles shared by the minimap and desk overview, in world coordinates. */
  worldItems(index = this.os.model.state.value.desk) {
    const state = this.os.model.state.value;
    const desk = state.desks[index];
    const items = [];
    // Back to front, so the window drawn last is the one a press on the map picks.
    // Minimized windows are empty outlines, so they go over the open ones instead of hiding under them.
    const stacked = desk.order.map(id => desk.windows.find(win => win.id === id));
    for (const win of [...stacked.filter(win => !win.min), ...stacked.filter(win => win.min)]) {
      if (!win.open || win.owner || win.x === null || win.y === null) continue;
      const zoom = this.os.zoomOf(win.id);
      items.push({ kind: 'window', id: win.id, x: win.x, y: win.y, w: win.w * zoom, h: win.h * zoom, min: win.min,
        color: this.os.apps.get(win.id)?.tint ?? 'panel', active: index === state.desk && state.active === win.id });
    }
    for (const note of this.notes.state.value.notes) {
      if (note.desk === index && !note.deleted && !note.hidden) items.push({ kind: 'note', ...note, w: note.w * this.noteZoom(note), h: StickyNote.height(note) * this.noteZoom(note) });
    }
    return items;
  }

  #syncNotes() {
    const present = new Set(this.notes.state.value.notes.map(note => note.id));
    for (const [id, widget] of this.#notes) {
      if (!present.has(id)) { widget.dispose(); this.#notes.delete(id); }
    }
    for (const note of this.notes.state.value.notes) {
      let widget = this.#notes.get(note.id);
      if (!widget) {
        widget = this.notesLayer.add(new StickyNote(this.ui, this, note));
        this.#notes.set(note.id, widget);
      } else widget.update(note);
    }
    this.minimap.invalidate();
  }

  /** How much one note is magnified at this pixel size: each note has its own, so the important ones can stand out. */
  noteZoom(note) {
    return note.zooms?.[String(this.os.signals.get('pixel'))] ?? 1;
  }

  /** Magnifies one note at this pixel size only, as windows are. */
  sizeNote(id, zoom) {
    const note = this.notes.state.value.notes.find(item => item.id === id);
    if (!note) throw new Error('This sticky note no longer exists.');
    const realm = String(this.os.signals.get('pixel'));
    const { [realm]: _, ...others } = note.zooms ?? {};
    this.notes.patch(id, { zooms: zoom === 1 ? others : { ...others, [realm]: zoom } });
  }

  /**
   * A new note where the user is looking: at `at` (a screen point, as from
   * the desk's context menu) or in the first clear spot of the view. The view
   * stays where it is.
   */
  newNote(at = null) {
    this.#closeMenu();
    const note = this.notes.create(this.toWorld(this.#noteSpot(at)));
    this.revealNote(note.id);
    return note;
  }

  /** Screen rectangles of the windows showing now, which a new note should not hide under. */
  #covers() {
    return [...this.#frames.values()].filter(frame => frame.visible && this.os.model.shows(frame.id)).map(frame => frame.bounds);
  }

  #noteSpot(at) {
    const zoom = 1;
    const { work } = this;
    const w = 148 * zoom;
    const h = 112 * zoom;
    const fit = (x, y) => ({ x: Math.round(clamp(x, 4, this.w - w - 4)), y: Math.round(clamp(y, work.y + 4, work.y + work.h - h - 4)) });
    if (at) return fit(at.x, at.y);
    const covers = [...this.#covers(), ...[...this.#notes.values(), ...this.#icons.values()].filter(widget => widget.visible)
      .map(widget => ({ x: widget.x, y: widget.y, w: widget.w * widget.zoom, h: widget.h * widget.zoom }))];
    const clear = spot => !covers.some(r => spot.x < r.x + r.w && spot.x + w > r.x && spot.y < r.y + r.h && spot.y + h > r.y);
    // Down the left of the view first, where notes are usually kept, then across.
    for (let x = 12; x + w <= this.w - 4; x += 24) {
      for (let y = work.y + 12; y + h <= work.y + work.h - 4; y += 20) if (clear({ x, y })) return { x, y };
    }
    const count = [...this.#notes.values()].filter(note => note.visible).length % 5;
    return fit(20 + count * 12, work.y + 20 + count * 12);
  }

  /**
   * Brings a note into view to be written in. The view moves only as far as
   * it must, and windows step aside only when one hides the note.
   */
  revealNote(id) {
    let note = this.notes.state.value.notes.find(item => item.id === id);
    if (!note || note.deleted) return;
    if (note.hidden) { this.notes.patch(id, { hidden: false }); note = this.notes.state.value.notes.find(item => item.id === id); }
    this.os.model.desk(note.desk);
    const zoom = this.noteZoom(note);
    const { work } = this;
    const w = note.w * zoom;
    const h = StickyNote.height(note) * zoom;
    const at = this.fromWorld(note);
    const dx = at.x < 4 ? at.x - 4 : at.x + w > this.w - 4 ? Math.min(at.x - 4, at.x + w - this.w + 4) : 0;
    const dy = at.y < work.y + 4 ? at.y - work.y - 4 : at.y + h > work.y + work.h - 4 ? Math.min(at.y - work.y - 4, at.y + h - work.y - work.h + 4) : 0;
    if (dx || dy) this.setPan({ x: this.pan.x + dx, y: this.pan.y + dy });
    this.ui.flush();
    const spot = this.fromWorld(note);
    if (this.#covers().some(r => spot.x < r.x + r.w && spot.x + w > r.x && spot.y < r.y + r.h && spot.y + h > r.y)) this.os.model.peek();
    this.ui.flush();
    const widget = this.#notes.get(id);
    if (widget) { this.notesLayer.raise(widget); this.ui.focus(widget.editor); }
  }

  noteMenu(id, event) {
    const note = this.notes.state.value.notes.find(item => item.id === id);
    if (!note) return;
    const safely = fn => () => { try { fn(); } catch (error) { this.os.report(error); } };
    this.#popup([
      { text: 'Edit note', icon: 'glyph-pencil', invoke: () => this.revealNote(id) },
      { text: 'New note', icon: 'glyph-note', invoke: safely(() => this.newNote()) },
      { text: 'Duplicate', icon: 'glyph-copy', invoke: safely(() => this.notes.duplicate(id)) },
      { text: note.rolled ? 'Unroll' : 'Roll up', icon: 'glyph-shade', invoke: () => this.notes.patch(id, { rolled: !note.rolled }) },
      { text: 'Hide note', icon: 'glyph-eye', invoke: () => this.notes.patch(id, { hidden: true }) },
      { separator: true },
      ...NOTE_COLORS.map((color, index) => ({ text: NOTE_COLOR_NAMES[index], icon: `note-${index + 1}`, checked: note.color === color, invoke: () => this.notes.patch(id, { color }) })),
      { separator: true },
      ...this.os.model.state.value.desks.flatMap((_, desk) => desk === note.desk ? [] : [{ text: `Move to desktop ${desk + 1}`, icon: 'glyph-move', invoke: () => this.notes.patch(id, { desk }) }]),
      { separator: true },
      ...ZOOMS.map(zoom => ({ text: `Size ${zoom}×`, icon: 'glyph-zoom', checked: this.noteZoom(note) === zoom, invoke: safely(() => this.sizeNote(id, zoom)) })),
      { separator: true },
      { text: 'Delete note (recoverable)', icon: 'glyph-bin', invoke: () => this.notes.remove(id) }
    ], { x: event.gx, y: event.gy }, {});
  }

  /** Where a window first appears: centered in view, cascading. */
  placement(id) {
    const win = this.os.model.window(id);
    const zoom = this.os.zoomOf(id);
    const { work } = this;
    const step = (this.os.model.state.value.order.length % 5) * 10;
    return this.toWorld({
      x: Math.max(4, (this.w - win.w * zoom) >> 1) + step,
      y: work.y + 6 + Math.max(0, (work.h - win.h * zoom) >> 2) + step
    });
  }

  arrange() {
    const { w, h, os } = this;
    const state = os.model.state.value;
    this.wallpaper.place(0, 0, w, h);

    this.bar.zoom = Math.min(os.zoomOf('menubar'), Math.max(1, Math.floor(w / 140)), Math.max(1, Math.floor(h / (BAR_H * 4))));
    this.bar.place(0, 0, Math.ceil(w / this.bar.zoom), BAR_H);
    const dock = Math.min(os.zoomOf('taskbar'), Math.max(1, Math.floor(w / 160)), Math.max(1, Math.floor(h / (TASK_H * 4))));
    this.tasks.visible = os.signals.get('taskbar');
    this.tasks.zoom = dock;
    this.tasks.place(0, h - TASK_H * dock, Math.ceil(w / dock), TASK_H);
    this.keys.visible = os.signals.get('keys');
    this.keys.zoom = Math.min(dock, Math.max(1, Math.floor((h - BAR_H * this.bar.zoom - TASK_H * dock - 30) / Keyboard.HEIGHT)));
    this.keys.place(0, (this.tasks.visible ? this.tasks.y : h) - Keyboard.HEIGHT * this.keys.zoom, Math.ceil(w / this.keys.zoom), Keyboard.HEIGHT);

    for (const layer of [this.desk, this.mapUnder, this.notesLayer, this.windows, this.mapOver, this.fx, this.popups]) layer.place(0, 0, w, h);
    for (const layer of [this.notesLayer, this.windows]) layer.view.position.x = this.#slide;

    const zoom = os.zoomOf('icons');
    if (zoom !== this.#iconZoom) { this.#iconHomes.clear(); this.#iconZoom = zoom; }
    const cell = this.#cell(zoom);
    const columns = Math.max(1, Math.floor((w - 8) / cell.w));
    let flow = 0;
    for (const [id, icon] of this.#icons) {
      icon.visible = os.software.installed(id);
      if (!icon.visible) continue;
      if (!this.#iconHomes.has(id)) this.#iconHomes.set(id, { x: 4 + (flow % columns) * cell.w, y: 6 + Math.floor(flow / columns) * cell.h });
      const at = state.icons[id] ?? this.#iconHomes.get(id);
      if (!state.icons[id]) flow += 1;
      if (icon.dragging) continue;
      // Icons sit on the screen, not in the world, and stay in view when the screen shrinks.
      icon.zoom = zoom;
      icon.place(clamp(at.x, 0, w - cell.w), this.work.y + clamp(at.y, 0, this.work.h - cell.h), ICON_W, cell.h / zoom - 2);
    }

    for (const win of state.windows) {
      const frame = this.#frames.get(win.id);
      if (frame) this.#fit(frame, win, state);
    }
    for (const note of this.notes.state.value.notes) {
      const widget = this.#notes.get(note.id);
      if (!widget) continue;
      widget.visible = !note.hidden && !note.deleted && note.desk === state.desk;
      widget.zoom = this.noteZoom(note);
      if (!widget.dragging) {
        const at = this.fromWorld(note);
        widget.place(at.x, at.y, note.w, StickyNote.height(note));
      }
    }
    // Always on top, it would cover too much of a small screen; there the overview stands in.
    this.minimap.visible = os.signals.get('minimap') && os.signals.get('panning') && this.work.h >= 200 && w >= 400;
    const mapZoom = this.#fitZoom('minimap', 200, 150);
    const mapW = Math.max(64, Math.min(112, Math.floor(w / 3 / mapZoom)));
    const mapH = Math.min(76, Math.max(52, Math.floor(this.work.h / 3 / mapZoom)));
    this.minimap.zoom = mapZoom;
    this.minimap.place(w - mapW * mapZoom - 5, this.work.y + this.work.h - mapH * mapZoom - 5, mapW, mapH);
    this.minimap.invalidate();
    for (const overlay of this.children.slice(this.children.indexOf(this.popups) + 1)) overlay.place(0, 0, w, h);
  }

  resized() {
    if (this.#menu) this.#closeMenu();
  }

  // ---- Windows -------------------------------------------------------------

  /**
   * Where a window's frame goes: x and y in screen pixels, w and h in the
   * window's own, `zoom` between the two, `flat` when it fills the work area.
   */
  rect(win, state = this.os.model.state.value) {
    const { work } = this;
    const requestedZoom = this.os.zoomOf(win.owner ?? win.id);
    const zoom = this.compact ? Math.min(requestedZoom, Math.max(1, Math.floor(work.w / Math.min(220, win.minW)))) : requestedZoom;
    const mode = this.#mode(win);
    if (mode === 'max') {
      // The top edge slides under the menu bar's own line.
      return { zoom, flat: true, x: 0, y: work.y - zoom, w: Math.ceil(work.w / zoom), h: Math.ceil(work.h / zoom) + 1 };
    }
    if (mode !== 'normal') {
      const w = work.w >> 1;
      const h = mode.includes('-') ? work.h >> 1 : work.h;
      return {
        zoom,
        flat: false,
        x: mode.endsWith('right') ? work.w - w : 0,
        y: work.y + (mode.startsWith('bottom') ? work.h - h : 0),
        w: Math.floor(w / zoom),
        h: Math.floor(h / zoom)
      };
    }

    const h = win.shade ? TITLE_H + 1 : win.h;
    if (win.owner && win.x === null) {
      // A docked tool sits beside its owner (as it is mid-gesture, too), clear of its other tools.
      const owner = this.#gesture?.id === win.owner ? this.#gesture.live : this.rect(state.windows.find(other => other.id === win.owner), state);
      const tools = state.windows.filter(other => other.owner === win.owner && shows(state.windows, other));
      const docked = tools.filter(other => other.x === null);
      const rank = other => (this.#docked.indexOf(other.id) + 1 || Infinity);
      docked.sort((a, b) => rank(a) - rank(b));
      const size = other => ({ w: other.w * zoom, h: (other.shade ? TITLE_H + 1 : other.h) * zoom });
      const taken = tools.filter(other => other.x !== null).map(other => ({ ...this.fromWorld(other), ...size(other) }));
      const spots = dock(
        { x: owner.x, y: owner.y, w: owner.w * owner.zoom, h: owner.h * owner.zoom, caption: (TITLE_H + 4) * owner.zoom },
        docked.map(size), taken, { x: 0, y: work.y, w: this.w, h: work.h }, this.#overlays());
      const at = spots[docked.indexOf(win)] ?? spots[0] ?? { x: owner.x, y: owner.y };
      return { zoom, flat: false, ...at, w: win.w, h };
    }
    let { x, y } = this.fromWorld(win);
    if (!this.os.signals.get('panning')) ({ x, y } = this.#reach(x, y, win.w * zoom, win.owner ? TOOL_H : TITLE_H, zoom));
    return { zoom, flat: false, x, y, w: win.w, h };
  }

  /** What stays on top of windows on screen, which docked tools keep clear of when they can. */
  #overlays() {
    const map = this.minimap;
    if (!map.visible || !this.os.signals.get('minimap-top')) return [];
    return [{ x: map.x, y: map.y, w: map.w * map.zoom, h: map.h * map.zoom }];
  }

  /** Small screens maximize every app window; tools always float. */
  #mode(win) {
    return win.owner ? 'normal' : this.compact ? 'max' : win.mode;
  }

  /** Keeps a strip of caption reachable inside the work area. */
  #reach(x, y, width, titleH, zoom) {
    const { work } = this;
    x = Math.round(clamp(x, REACH - width, this.w - REACH));
    y = Math.round(clamp(y, work.y, work.y + work.h - titleH * zoom));
    // The map, on top, must not swallow a caption: one that would be hidden under it rises above it.
    const map = this.minimap;
    if (map.visible && map.parent === this.mapOver) {
      const top = map.y;
      const left = map.x;
      const right = map.x + map.w * map.zoom;
      const free = Math.max(0, Math.min(x + width, this.w) - Math.max(x, 0)) - Math.max(0, Math.min(x + width, right) - Math.max(x, left));
      if (y + titleH * zoom > top && free < REACH) y = Math.max(work.y, top - titleH * zoom - 2);
    }
    return { x, y };
  }

  #fit(frame, win, state) {
    const rect = this.rect(win, state);
    const tool = Boolean(win.owner);
    const mode = this.#mode(win);
    const document = !tool && this.os.running(win.id)?.files?.state.value;
    frame.setLook({
      title: document ? `${document.dirty ? '* ' : ''}${document.name} · ${win.title}` : win.title,
      tool,
      flat: rect.flat,
      shade: win.shade && mode === 'normal',
      min: !tool,
      max: !tool && !this.compact,
      maxed: mode !== 'normal',
      sizable: win.resizable && mode === 'normal' && !win.shade,
      minW: win.minW,
      minH: win.minH
    });
    frame.zoom = rect.zoom;
    const shadow = rect.flat ? 0 : SHADOW;
    frame.place(rect.x, rect.y, rect.w + shadow, rect.h + shadow);
  }

  canDrag(id) {
    return Boolean(this.os.model.window(id).owner) || !this.compact;
  }

  /** A tiled window about to be dragged: returns its normal frame size, or null if it is not tiled. */
  lift(frame) {
    const win = this.os.model.window(frame.id);
    if (this.#mode(win) === 'normal') return null;
    frame.setLook({ flat: false, maxed: false });
    return { w: win.w, h: win.shade ? TITLE_H + 1 : win.h };
  }

  /** Where a dragged window may be: magnets, the reachable caption, and the tile a drop here would mean. */
  dragTo(frame, x, y, event) {
    const { os } = this;
    const { w, h } = frame.bounds;
    const zone = !frame.look.tool && !this.compact && os.signals.get('snap') ? this.#zoneAt(event.gx, event.gy) : null;
    if (!zone && os.signals.get('magnets') && !event.alt) {
      x += this.#attract(this.#lines(frame, 'x', y, y + h), [x, x + w]);
      y += this.#attract(this.#lines(frame, 'y', x, x + w), [y, y + h]);
    }
    this.#preview(zone ? this.rect({ ...os.model.window(frame.id), mode: zone, shade: false }) : null);
    return { ...this.#reach(x, y, w, frame.titleH, frame.zoom), zone };
  }

  /**
   * Keeps a window's tools with it while it is dragged or resized, before
   * anything is committed, so the family moves as one. A docked tool sits
   * beside the live frame; a floating one keeps to the edges it is nearest,
   * so a tool by the right edge rides that edge as the window grows.
   */
  follow(frame) {
    const state = this.os.model.state.value;
    const win = state.windows.find(other => other.id === frame.id);
    if (!win || win.owner) return;
    if (this.#gesture?.id !== frame.id) this.#gesture = { id: frame.id, from: this.rect(win, state), tiled: this.#mode(win) !== 'normal' };
    const gesture = this.#gesture;
    gesture.live = { x: frame.x, y: frame.y, w: frame.frame.w, h: frame.frame.h, zoom: frame.zoom, flat: false };
    for (const tool of state.windows) {
      const widget = this.#frames.get(tool.id);
      if (tool.owner !== frame.id || !widget || !shows(state.windows, tool)) continue;
      let rect = this.rect(tool, state);
      if (tool.x !== null) {
        if (gesture.tiled) continue; // floating tools stay put while a tiled window is lifted, as on commit
        rect = { ...rect, ...anchor(gesture.from, gesture.live, rect) };
      }
      widget.place(rect.x, rect.y, rect.w + SHADOW, rect.h + SHADOW);
    }
  }

  /** Puts a window and its tools back where the model says, after a gesture that was abandoned. */
  cancelGesture() {
    this.#gesture = null;
    this.ui.requestLayout();
  }

  /** Ends a drag: tiles the window, moves it, or puts it back. */
  drop(frame, zone, cancelled = false) {
    this.#gesture = null;
    this.#preview(null);
    if (cancelled) this.ui.requestLayout();
    else if (zone) this.os.model.mode(frame.id, zone);
    else this.os.move(frame.id, this.toWorld(frame));
  }

  /** The frame a resize gesture gives: x, y on screen, w, h in window pixels. */
  sizeTo(frame, from, dir, dx, dy, alt) {
    const { zoom } = frame;
    const { minW, minH } = frame.look;
    const { work } = this;
    let left = from.x;
    let top = from.y;
    let right = from.x + from.w * zoom;
    let bottom = from.y + from.h * zoom;
    if (dir.includes('w')) left += dx;
    if (dir.includes('e')) right += dx;
    if (dir.includes('n')) top += dy;
    if (dir.includes('s')) bottom += dy;

    if (this.os.signals.get('magnets') && !alt) {
      // Edges of other windows attract, and so do their widths and heights.
      const others = this.#others(frame);
      const xs = this.#lines(frame, 'x', top, bottom);
      const ys = this.#lines(frame, 'y', left, right);
      if (dir.includes('e')) right += this.#attract([...xs, ...others.map(other => left + other.w)], [right]);
      if (dir.includes('w')) left += this.#attract([...xs, ...others.map(other => right - other.w)], [left]);
      if (dir.includes('s')) bottom += this.#attract([...ys, ...others.map(other => top + other.h)], [bottom]);
      if (dir.includes('n')) top += this.#attract([...ys, ...others.map(other => bottom - other.h)], [top]);
    }

    if (dir.includes('n')) top = Math.max(top, work.y);
    const w = Math.max(minW, Math.round((right - left) / zoom));
    const h = Math.max(minH, Math.round((bottom - top) / zoom));
    return {
      x: Math.round(dir.includes('w') ? right - w * zoom : left),
      y: Math.round(dir.includes('n') ? bottom - h * zoom : top),
      w,
      h
    };
  }

  /** Ends a resize gesture with one command; floating tools keep to the edges they rode. */
  commitSize(frame) {
    const { w, h } = frame.frame;
    const gesture = this.#gesture?.id === frame.id ? this.#gesture : null;
    this.#gesture = null;
    const state = this.os.model.state.value;
    const win = state.windows.find(other => other.id === frame.id);
    if (win.owner && win.x === null) {
      // A docked tool resized from its right or bottom edge stays docked; pulled from the left or top, it floats.
      const at = this.rect(win, state);
      const place = at.x === frame.x && at.y === frame.y ? { x: null, y: null } : this.toWorld(frame);
      this.os.model.arrange({ [frame.id]: { ...place, w: Math.max(win.minW, w), h: Math.max(win.minH, h), shade: false } });
      return;
    }
    const patches = { [frame.id]: { ...this.toWorld(frame), w, h, mode: 'normal', shade: false } };
    if (gesture && !gesture.tiled) {
      for (const tool of state.windows) {
        if (tool.owner !== frame.id || tool.x === null) continue;
        const rect = this.rect(tool, state);
        patches[tool.id] = this.toWorld(anchor(gesture.from, gesture.live, rect));
      }
    }
    if (Object.keys(patches).length === 1) this.os.model.resize(frame.id, patches[frame.id]);
    else this.os.model.arrange(patches);
  }

  /** A caption box was pressed. */
  windowBox(id, box) {
    const { model } = this.os;
    const win = model.window(id);
    if (box === 'close') this.os.close(id);
    else if (box === 'min') model.minimize(id);
    else if (box === 'max' && !win.owner && !this.compact) model.mode(id, win.mode === 'normal' ? 'max' : 'normal');
  }

  /** Scrolls the desktop until a window that has wandered off is back in view. */
  reveal(id) {
    const win = this.os.model.window(id);
    if (this.#mode(win) !== 'normal' || !this.os.signals.get('panning')) return;
    const { work, pan } = this;
    const rect = this.rect(win);
    const w = rect.w * rect.zoom;
    const reachable = rect.x + w >= REACH && rect.x <= this.w - REACH && rect.y >= work.y && rect.y <= work.y + work.h - TITLE_H * rect.zoom;
    if (reachable) return;
    this.glide({
      x: pan.x + rect.x - Math.max(4, (this.w - w) >> 1),
      y: pan.y + rect.y - work.y - Math.max(4, (work.h - rect.h * rect.zoom) >> 2)
    });
  }

  /** Brings a window back if it was minimized and glides the camera to center it: a pick on the map. */
  showWindow(id) {
    const win = this.os.model.window(id);
    this.os.activate(id);
    if (win.x === null || win.y === null || this.#mode(win) !== 'normal') return; // a tiled window is already in view
    const zoom = this.os.zoomOf(id);
    const { work } = this;
    // A window bigger than the view shows its top left, caption first.
    const along = (at, size, view) => Math.round(size <= view ? at - (view - size) / 2 : at - 4);
    this.glide({ x: along(win.x, win.w * zoom, work.w), y: along(win.y, win.h * zoom, work.h) });
  }

  /** Puts a window where it first appears: in view. */
  bring(id) {
    const win = this.os.model.window(id);
    const rect = this.rect({ ...win, mode: 'normal' });
    const w = rect.w * rect.zoom;
    const { work } = this;
    this.os.model.activate(id);
    this.os.move(id, this.toWorld({
      x: Math.max(4, (this.w - w) >> 1),
      y: work.y + Math.max(4, (work.h - rect.h * rect.zoom) >> 2)
    }));
  }

  /** Scrolls home and pulls every window on this desktop back into view. */
  gather() {
    const { model } = this.os;
    const { work } = this;
    const patches = {};
    for (const win of model.state.value.windows) {
      if (win.owner) patches[win.id] = { x: null, y: null }; // tools dock beside their owners again
      if (win.owner || win.x === null) continue;
      const zoom = this.os.zoomOf(win.id);
      const at = this.fromWorld(win);
      patches[win.id] = {
        x: Math.round(clamp(at.x, 0, this.w - win.w * zoom)),
        y: Math.round(clamp(at.y, work.y, work.y + work.h - win.h * zoom) - work.y)
      };
    }
    model.arrange(patches, { x: 0, y: 0 });
  }

  /** Scrolls home and steps the windows of this desktop down from the top left. */
  cascade() {
    const { model } = this.os;
    const state = model.state.value;
    const patches = {};
    for (const win of state.windows) if (win.owner) patches[win.id] = { x: null, y: null };
    state.order.filter(id => !model.window(id).owner).forEach((id, i) => {
      patches[id] = { x: 8 + i * 16, y: 6 + i * 16, mode: 'normal', shade: false };
    });
    model.arrange(patches, { x: 0, y: 0 });
  }

  // ---- Panning -------------------------------------------------------------

  /** Whether a press on the empty desk starts a pan. */
  pans(event) {
    const { signals } = this.os;
    return signals.get('panning') && (event.button === 1 || this.#space || signals.get('pan-mode'));
  }

  /** A pan follows the pointer and commits once, when the gesture ends. */
  panGesture(type, event) {
    if (type === 'down') {
      this.#panGrab = { gx: event.gx, gy: event.gy, from: this.pan };
      return;
    }
    const grab = this.#panGrab;
    if (!grab) return;
    if (type === 'move') {
      this.#pan = { x: grab.from.x - (event.gx - grab.gx), y: grab.from.y - (event.gy - grab.gy) };
      this.ui.requestLayout();
      return;
    }
    const to = this.#pan;
    this.#panGrab = null;
    this.#pan = null;
    if (type === 'up' && to) this.os.model.pan(to);
    else this.ui.requestLayout();
  }

  /** The middle button, captured by the desktop from wherever it was pressed. */
  pointer(type, event) {
    if (type === 'down' && (event.button !== 1 || !this.os.signals.get('panning'))) return;
    this.panGesture(type, event);
  }

  /** Scrolls smoothly to a pan position, then commits it. */
  glide(to) {
    const from = this.pan;
    return this.ui.anim.tween(220, t => {
      this.#pan = { x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) };
      this.ui.requestLayout();
    }).then(() => {
      this.#pan = null;
      this.os.model.pan(to);
    });
  }

  // ---- Icons ---------------------------------------------------------------

  #cell(zoom) {
    return { w: ICON_W * zoom, h: (this.labels ? ICON_H : TILE + 8) * zoom };
  }

  /** An icon was let go: it stays there, on the grid when the grid is on. Icons are kept relative to the work area, not the world. */
  dropIcon(icon) {
    const at = { x: icon.x, y: icon.y - this.work.y };
    if (this.os.signals.get('grid')) {
      const cell = this.#cell(icon.zoom);
      at.x = 4 + Math.round((at.x - 4) / cell.w) * cell.w;
      at.y = 6 + Math.round((at.y - 6) / cell.h) * cell.h;
    }
    this.os.model.icon(icon.app.id, at);
  }

  // ---- Snapping and magnets --------------------------------------------------

  /** The tile a drop at this pointer position means, or null. */
  #zoneAt(gx, gy) {
    const { work } = this;
    const side = gx < SNAP_EDGE ? 'left' : gx >= this.w - SNAP_EDGE ? 'right' : null;
    if (side) return gy < work.y + SNAP_CORNER ? `top-${side}` : gy >= work.y + work.h - SNAP_CORNER ? `bottom-${side}` : side;
    return gy < work.y + 3 ? 'max' : null;
  }

  #preview(rect) {
    this.preview.visible = Boolean(rect);
    if (rect) this.preview.place(rect.x, rect.y, rect.w * rect.zoom, rect.h * rect.zoom);
  }

  /**
   * The frames of the other windows on screen. A window's own tools are left
   * out: they ride along with it, so an edge drawn to theirs would pull it
   * after them on every step, and it would jitter.
   */
  #others(frame) {
    const windows = this.os.model.state.value.windows;
    const own = other => windows.find(win => win.id === other.id)?.owner === frame.id;
    return [...this.#frames.values()].filter(other => other !== frame && other.visible && !other.look.flat && !own(other)).map(other => other.bounds);
  }

  /** Lines along one axis that an edge may snap to: the work area's and nearby windows'. */
  #lines(frame, axis, from, to) {
    const { work } = this;
    const lines = axis === 'x' ? [0, this.w] : [work.y, work.y + work.h];
    for (const other of this.#others(frame)) {
      const [low, high] = axis === 'x' ? [other.y, other.y + other.h] : [other.x, other.x + other.w];
      if (high < from - 16 || low > to + 16) continue; // only neighbors attract
      lines.push(...(axis === 'x' ? [other.x, other.x + other.w] : [other.y, other.y + other.h]));
    }
    return lines;
  }

  /** The smallest shift that puts one of `edges` on one of `lines`, if any is within reach. */
  #attract(lines, edges) {
    let best = 0;
    let distance = MAGNET + 1;
    for (const line of lines) {
      for (const edge of edges) {
        if (Math.abs(line - edge) < distance) {
          distance = Math.abs(line - edge);
          best = line - edge;
        }
      }
    }
    return best;
  }

  // ---- Following the model -------------------------------------------------

  #sync(state, previous) {
    if (this.#switching) return; // the arrangement is applied when the slide turns around
    if (!previous || state.desk === previous.desk || !this.ui.motion.value || this.w < 1) this.#apply(state, previous);
    else this.#switch(Math.sign(state.desk - previous.desk) * this.w).catch(error => this.os.report(error));
  }

  /** Another desktop: this one slides out, the new arrangement slides in. */
  async #switch(side) {
    const { anim } = this.ui;
    const slide = offset => {
      this.#slide = Math.round(offset);
      for (const layer of [this.notesLayer, this.windows]) layer.view.position.x = this.#slide;
    };
    this.#sliding?.cancel();
    this.#switching = true;
    await anim.tween(110, t => slide(-side * t), { easing: ease.in });
    this.#switching = false;
    this.#apply(this.os.model.state.value, null);
    this.#sliding = anim.tween(170, t => slide(side * (1 - t)));
  }

  #apply(state, previous) {
    const { os } = this;
    const settled = !previous || previous.desk !== state.desk;
    if (previous && previous.icons !== state.icons && !Object.keys(state.icons).length) this.#iconHomes.clear();
    if (previous?.active !== state.active) {
      const focused = [...this.#frames.values()].find(frame => frame.contains(this.ui.focused));
      if (focused && (state.windows.find(win => win.id === focused.id)?.owner ?? focused.id) !== state.active) this.ui.focus(null);
    }
    const docked = new Set(state.windows.filter(win => win.owner && win.x === null && shows(state.windows, win)).map(win => win.id));
    this.#docked = [...this.#docked.filter(id => docked.has(id)), ...[...docked].filter(id => !this.#docked.includes(id))];
    for (const win of state.windows) {
      const visible = shows(state.windows, win);
      let frame = this.#frames.get(win.id);
      if (!frame && !visible) continue;
      if (!frame) {
        frame = new Window(this.ui, { id: win.id, content: os.view(win.id), desktop: this });
        this.#frames.set(win.id, frame);
        this.windows.add(frame);
        const files = !win.owner && os.running(win.id)?.files;
        if (files) frame.scope.subscribe(files.state, () => this.ui.requestLayout());
      }
      if (this.w > 0) this.#fit(frame, win, state);
      if (!win.owner) {
        os.app(win.id).visible.set(visible);
        // Open means open on any desktop: a window left on another one is still open there.
        os.app(win.id).open.set(state.desks.some(desk => desk.windows.some(other => other.id === win.id && other.open)));
      }
      frame.setActive(state.active === (win.owner ?? win.id));

      const before = previous?.windows.find(other => other.id === win.id);
      const was = settled ? visible : shows(previous.windows, before);
      if (was === visible || win.owner) {
        frame.visible = visible;
        continue;
      }
      // Classic zooming outlines: to and from the taskbar when minimizing, the icon otherwise.
      const home = (win.open && before.open ? this.tasks.slotRect(win.id) : null) ?? this.#icons.get(win.id)?.tile ?? this.tasks.slotRect(win.id);
      frame.visible = false;
      if (visible) this.#zoom(home, frame.bounds).then(() => { frame.visible = os.model.shows(win.id); });
      else this.#zoom(frame.bounds, home);
    }
    for (const id of state.layers) {
      const frame = this.#frames.get(id);
      if (frame) this.windows.raise(frame);
    }
    this.ui.requestLayout();
  }

  #zoom(from, to) {
    const { ui } = this;
    if (!from || !to || !ui.motion.value) return Promise.resolve();
    const theme = ui.theme.value;
    const outlines = [ui.solid(theme.color('ink')), ui.solid(theme.color('paper'))].map(texture => (
      Array.from({ length: 4 }, () => this.fx.view.addChild(new ui.PIXI.Sprite(texture)))
    ));
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    return ui.anim.tween(200, t => {
      outlines.forEach(([top, bottom, left, right], inset) => {
        const x = lerp(from.x, to.x, t) + inset;
        const y = lerp(from.y, to.y, t) + inset;
        const w = Math.max(1, lerp(from.w, to.w, t) - 2 * inset);
        const h = Math.max(1, lerp(from.h, to.h, t) - 2 * inset);
        top.position.set(x, y);
        top.scale.set(w, 1);
        bottom.position.set(x, y + h - 1);
        bottom.scale.set(w, 1);
        left.position.set(x, y);
        left.scale.set(1, h);
        right.position.set(x + w - 1, y);
        right.scale.set(1, h);
      });
    }).then(() => {
      for (const sprite of outlines.flat()) sprite.destroy();
    });
  }

  /** Keys go to the app whose window is in front. */
  #type(type, event) {
    if (this.#menu || this.notesLayer.contains(this.ui.focused) || this.ui.focusScopes.some(scope => scope.trap)) return;
    const { active } = this.os.model.state.value;
    if (active) this.os.app(active).keys.emit(type, event);
  }

  #key(type, event) {
    if (type === 'up' && event.key === ' ') this.#space = false;
    if (this.ui.handleKey(type, event)) return;
    if (this.ui.focusScopes.some(scope => scope.trap)) return;
    if (type === 'down') {
      if (event.key === 'Escape' && this.#menu) { event.handled = true; this.#closeMenu(); return; }
      if (event.ctrl && event.key === 'Escape') { event.handled = true; this.openStart(); return; }
      if (event.key === 'F10' && !event.shift) { event.handled = true; this.ui.focus(this.bar); this.#openMenu(0); return; }
      if (event.alt && event.key === 'Tab') { event.handled = true; this.openWindowSwitcher(); return; }
      if (event.ctrl && event.alt && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const state = this.os.model.state.value;
        this.os.model.desk((state.desk + (event.key === 'ArrowLeft' ? -1 : 1) + state.desks.length) % state.desks.length);
        event.handled = true;
        return;
      }
      const file = event.ctrl && !event.alt ? ({ n: 'new', o: 'open', s: event.shift ? 'save-as' : 'save', z: event.shift ? 'redo' : 'undo', y: 'redo' })[event.key.toLowerCase()] : null;
      const active = this.os.model.state.value.active;
      if (file && active && this.os.app(active).files) { this.os.run(`file:${file}`); event.handled = true; return; }
      if (event.key === ' ' && !this.ui.focused?.textInput) this.#space = true;
    }
    this.#type(type, event);
  }

  // ---- The taskbar ---------------------------------------------------------

  #task(slot) {
    const { os } = this;
    const launching = this.#menu?.launcher;
    this.#closeMenu();
    if (slot.kind === 'launcher') {
      if (!launching) this.#launch();
    } else if (slot.kind === 'task') {
      if (slot.active) {
        os.model.minimize(slot.id);
      } else {
        os.activate(slot.id);
        this.reveal(slot.id);
      }
    } else if (slot.kind === 'desk') {
      os.model.desk(slot.index);
    } else if (slot.kind === 'pan') {
      os.run('toggle:os.pan-mode');
    } else if (slot.kind === 'keys') {
      os.run('toggle:os.keys');
    } else if (slot.kind === 'peek') {
      os.model.peek();
    } else if (slot.kind === 'overflow') {
      this.openWindowSwitcher();
    } else if (slot.kind === 'overview') {
      this.openOverview();
    }
  }

  #launch() {
    this.openStart();
  }

  openStart() {
    const wasOpen = this.#menu?.launcher;
    this.#closeMenu();
    if (wasOpen) return;
    const popup = new Launcher(this.ui, { desktop: this, onClose: () => this.#closeMenu() });
    this.popups.add(popup);
    const { work } = this;
    popup.zoom = this.#fitZoom('start', 200, 150);
    const width = Math.min(280, Math.floor((this.w - 8) / popup.zoom));
    const height = Math.min(286, Math.floor((work.h - 6) / popup.zoom));
    popup.place(4, work.y + work.h - height * popup.zoom - 3, width, height);
    this.#menu = { popup, index: null, launcher: true, releaseFocus: this.ui.focusWithin(popup) };
    this.tasks.setLaunching(true);
    this.ui.focus(popup.search);
  }

  openOverview() {
    this.#closeMenu();
    if (this.work.h < 150) {
      const state = this.os.model.state.value;
      this.#popup(state.desks.flatMap((desk, index) => [
        { text: `Desktop ${index + 1}`, checked: state.desk === index, invoke: () => this.os.model.desk(index) },
        ...desk.windows.filter(win => !win.owner && win.open).map(win => ({ text: `  ${win.title}`, invoke: () => {
          this.os.model.desk(index); this.os.activate(win.id); this.reveal(win.id);
        } }))
      ]), { x: 4, y: this.work.y + 2 }, {});
      return;
    }
    const popup = new Overview(this.ui, {
      desktop: this, onClose: () => this.#closeMenu(),
      onPick: (desk, id) => {
        this.#closeMenu(); this.os.model.desk(desk);
        if (id) { this.os.activate(id); this.reveal(id); }
      }
    });
    this.popups.add(popup);
    popup.zoom = this.#fitZoom('overview', 300, 200);
    const width = Math.min(440, Math.floor((this.w - 8) / popup.zoom));
    const height = Math.min(300, Math.floor((this.work.h - 6) / popup.zoom));
    popup.place(Math.floor((this.w - width * popup.zoom) / 2), this.work.y + Math.floor((this.work.h - height * popup.zoom) / 2), width, height);
    this.#menu = { popup, index: null, releaseFocus: this.ui.focusWithin(popup) };
    this.ui.focus(popup);
  }

  /** A shell panel's magnification, as large as asked while it still fits in w x h of its own pixels. */
  #fitZoom(target, w, h) {
    return Math.max(1, Math.min(this.os.zoomOf(target), Math.floor(this.w / w), Math.floor(this.work.h / h)));
  }

  openWindowSwitcher() {
    const state = this.os.model.state.value;
    const items = state.desks.flatMap((desk, index) => desk.windows.filter(win => !win.owner && win.open).map(win => ({
      text: `${win.title} · Desk ${index + 1}${win.min ? ' (minimized)' : ''}`,
      icon: this.appIcon(win.id),
      checked: index === state.desk && win.id === state.active,
      invoke: () => { this.os.model.desk(index); this.os.activate(win.id); this.reveal(win.id); }
    })));
    if (!items.length) items.push({ text: 'No open windows', disabled: true });
    this.#popup(items, { x: Math.max(8, this.w / 2 - 100), y: this.work.y + 20 }, {});
  }

  // ---- Menus ---------------------------------------------------------------

  /**
   * Opens the context menu of a kind of thing; `id` is the window or icon it
   * is about. `after(item)` runs once an item has, so a panel the menu closed
   * (the Start menu, the overview) can come back at its new size.
   */
  openContext(kind, id, event, after = null) {
    const menu = this.contexts.get(kind);
    if (!menu) return false;
    const context = { window: id, kind, at: { x: event.gx, y: event.gy }, after };
    this.#popup(this.#items(menu, context), { x: event.gx, y: event.gy }, context);
    return true;
  }

  #openMenu(index) {
    if (index === -1) {
      const at = this.bar.toScreen(this.bar.slot(-1).x, BAR_H - 1);
      this.#popup(this.bar.overflow.map(menuIndex => ({ text: this.menus[menuIndex].title, invoke: () => this.#openMenu(menuIndex) })), at, {});
      this.#menu.index = -1;
      this.bar.setOpen(-1);
      return;
    }
    const context = { window: null, kind: 'menubar' };
    const at = this.bar.toScreen(this.bar.slot(index).x, BAR_H - 1);
    this.#popup(this.#items(this.menus[index], context), at, context, step => this.#openMenu((index + step + this.menus.length) % this.menus.length));
    this.#menu.index = index;
    this.bar.setOpen(index);
  }

  /**
   * A menu an app asks for, at a screen point: items are
   * { text, invoke, icon, checked, disabled, shortcut } or { separator: true }.
   */
  popupMenu(items, at) {
    this.#popup(items, at, {});
  }

  /** Shows a popup at a screen point, or with its bottom there when `up` is set. */
  #popup(items, { x, y, up = false }, context, onNavigate = null) {
    this.#closeMenu();
    const popup = new Popup(this.ui, {
      items,
      onPick: item => {
        if (item.disabled) return;
        this.#closeMenu();
        if (item.invoke) item.invoke();
        else this.os.run(item.action, null, context);
        context?.after?.(item);
      },
      onClose: () => this.#closeMenu(), onNavigate
    });
    popup.zoom = this.bar.zoom;
    const size = popup.measure();
    size.w = Math.min(size.w, Math.floor(this.w / popup.zoom));
    size.h = Math.min(size.h, Math.floor(this.h / popup.zoom));
    const w = size.w * popup.zoom;
    const h = size.h * popup.zoom;
    this.popups.add(popup);
    popup.place(clamp(x, 0, this.w - w), clamp(up ? y - h : y, 0, this.h - h), size.w, size.h);
    this.#menu = { popup, index: null, launcher: false, releaseFocus: this.ui.focusWithin(popup) };
    this.ui.focus(popup);
  }

  #closeMenu() {
    const menu = this.#menu;
    this.#menu = null;
    menu?.popup.dispose();
    menu?.releaseFocus?.();
    this.bar.setOpen(null);
    this.tasks.setLaunching(false);
  }

  /** The window a menu is about: the one it was opened on, or the active one. */
  #subject(context) {
    const { model } = this.os;
    const id = context.window ?? model.state.value.active;
    return id && context.kind !== 'icon' ? model.window(id) : null;
  }

  /** Expands a menu definition into the items to show right now. */
  #items(menu, context) {
    const { os } = this;
    const state = os.model.state.value;
    const subject = this.#subject(context);
    return menu.entries.flatMap(entry => {
      switch (entry.kind) {
        case 'separator':
          return [{ separator: true }];
        case 'apps': {
          // Grouped by category, in the order categories are declared, with a quiet rule between groups.
          const groups = Object.keys(CATEGORIES).map(category => [...os.apps.values()].filter(app => app.category === category && os.software.installed(app.id))).filter(group => group.length);
          return groups.flatMap((group, index) => [
            ...(index ? [{ separator: true }] : []),
            ...group.map(app => ({ text: app.title, action: `launch:${app.id}`, icon: this.appIcon(app.id) }))
          ]);
        }
        case 'themes':
          return [...os.themes.values()].map(theme => ({ text: theme.name, action: `set:os.theme=${theme.id}`, checked: os.signals.get('theme') === theme.id }));
        case 'desks':
          return state.desks.map((_, i) => ({ text: `Desktop ${i + 1}`, action: `desk:${i + 1}`, checked: i === state.desk }));
        case 'send':
          if (!subject || subject.owner) return [];
          return state.desks.flatMap((_, i) => (i === state.desk ? [] : [{ text: `Move to desktop ${i + 1}`, action: `send:${i + 1}`, icon: 'glyph-move' }]));
        case 'tools': {
          const owner = subject?.owner ?? subject?.id;
          return state.windows.filter(win => owner && win.owner === owner).map(win => ({ text: win.title, action: `tool:${win.id}`, checked: win.open }));
        }
        case 'magnify': {
          const target = entry.target === 'window' ? subject?.owner ?? subject?.id : entry.target;
          if (!target) return [];
          return ZOOMS.map(zoom => ({ text: `${entry.label} ${zoom}×`, action: `magnify:${target}=${zoom}`, checked: os.zoomOf(target) === zoom }));
        }
        default:
          return [{ text: entry.text, action: entry.action, icon: entry.icon, shortcut: entry.shortcut, checked: this.#checked(entry.check, subject), disabled: this.#disabled(entry.action, subject, context) }];
      }
    });
  }

  #disabled(action, subject, context) {
    // In the menu bar, window actions are about the active window; with none, there is nothing to act on.
    if (action.startsWith('window:') && context.kind === 'menubar') return !subject;
    if (!action.startsWith('file:')) return false;
    if (!subject) return true;
    const files = this.os.app(subject.owner ?? subject.id).files;
    if (!files) return true;
    const state = files.state.value;
    if (state.saving || state.ready === false) return true;
    const verb = action.slice(5);
    return verb === 'undo' ? !state.canUndo : verb === 'redo' ? !state.canRedo : false;
  }

  #checked(check, subject) {
    if (!check) return false;
    if (check.window) return Boolean(subject) && (check.window === 'max' ? subject.mode === 'max' : subject[check.window]);
    const { value } = this.os.shell.resolve(check.name);
    return check.equals === undefined ? Boolean(value) : String(value) === check.equals;
  }

  /** Validates <desktop> into menus, the launcher, context menus and icon app ids. */
  #read(node) {
    const { os } = this;
    if (node.name !== 'desktop') node.fail('must be <desktop>');
    node.expect({ attrs: ['version'], children: ['menubar', 'launcher', 'context', 'icons'] });
    if (node.need('version') !== '2') node.fail(`version="${node.attr('version')}" is not supported; this shell reads version 2`);

    const entries = (parent, zoomTarget) => parent.children.map(child => {
      if (child.name === 'magnify') {
        child.expect({ attrs: ['for', 'label'] });
        const target = child.attr('for', zoomTarget);
        if (!MAGNIFIABLE.includes(target)) child.fail(`needs for= one of ${MAGNIFIABLE.join(', ')}`);
        return { kind: 'magnify', target, label: child.attr('label', 'Size') };
      }
      if (child.name !== 'item') {
        child.expect();
        return { kind: child.name };
      }
      child.expect({ attrs: ['text', 'action', 'check', 'icon', 'shortcut'] });
      const action = child.need('action');
      const icon = child.attr('icon');
      if (icon !== undefined && !os.ui.sprites.has(icon)) child.fail(`icon="${icon}" is not a known sprite`);
      const problem = os.check(action);
      if (problem) child.fail(`action="${action}": ${problem}`);
      let check = null;
      if (child.has('check')) {
        const [name, equals] = child.attr('check').split('=');
        if (name.startsWith('window.')) {
          if (!WINDOW_FLAGS.includes(name.slice(7)) || equals !== undefined) child.fail(`check="${child.attr('check')}" must be one of ${WINDOW_FLAGS.map(flag => `window.${flag}`).join(', ')}`);
          check = { window: name.slice(7) };
        } else {
          try {
            os.shell.resolve(name);
          } catch (error) {
            child.fail(`check="${child.attr('check')}": ${error.message}`);
          }
          check = { name, equals };
        }
      }
      return { kind: 'item', text: child.need('text'), action, check, icon, shortcut: child.attr('shortcut') };
    });

    const menus = (node.child('menubar')?.expect({ children: ['menu'] }).children ?? []).map(menu => {
      menu.expect({ attrs: ['title', 'sprite'], children: ENTRIES });
      const sprite = menu.attr('sprite');
      if (sprite && !os.ui.sprites.has(sprite)) menu.fail(`sprite="${sprite}" is not a known sprite`);
      return { title: menu.need('title'), sprite, entries: entries(menu) };
    });

    if (node.all('launcher').length > 1) node.fail('has more than one <launcher>');
    const launcher = { entries: node.child('launcher') ? entries(node.child('launcher').expect({ children: ENTRIES })) : [{ kind: 'apps' }] };

    const contexts = new Map();
    for (const context of node.all('context')) {
      context.expect({ attrs: ['for'], children: ENTRIES });
      const kind = context.need('for');
      if (!(kind in CONTEXTS)) context.fail(`for="${kind}" must be one of ${Object.keys(CONTEXTS).join(', ')}`);
      if (contexts.has(kind)) context.fail(`for="${kind}" is defined twice`);
      contexts.set(kind, { entries: entries(context, CONTEXTS[kind]) });
    }

    const icons = (node.child('icons')?.expect({ children: ['icon'] }).children ?? []).map(icon => {
      icon.expect({ attrs: ['app'] });
      const id = icon.need('app');
      if (!os.apps.has(id)) icon.fail(`app="${id}" is not an installed app. Apps: ${[...os.apps.keys()].join(', ')}`);
      return id;
    });
    if (new Set(icons).size !== icons.length) node.fail('lists the same app icon twice');
    return { menus, launcher, contexts, icons };
  }

  dispose() {
    this.#closeMenu();
    super.dispose();
    this.notes.dispose();
  }
}
