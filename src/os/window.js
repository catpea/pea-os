import { Widget } from '../ui/widget.js';
import { Viewport } from '../ui/containers.js';
import { windowFrame, captionBoxes, grip, TITLE_H, TOOL_H, SHADOW } from '../gfx/skin.js';

const EDGE = 3;        // window pixels of frame that resize it
const CORNER = 10;     // and how far a corner reaches along each edge
const DRAG_SLOP = 3;   // screen pixels a press may wander before it is a drag
const DOUBLE_MS = 400;

const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

/** The grow corner, drawn over the content so a thumb can find it. */
class Grip extends Widget {
  interactive = true;

  paint(bitmap, theme) {
    grip(bitmap, theme, 0, 0);
  }

  pointer(type, event) {
    this.parent.resizeFrom('se', type, event);
  }

  cursor() {
    return CURSORS.se;
  }
}

/**
 * Window chrome around an app's view. The frame is painted once and repainted
 * only when its look or size changes.
 *
 * A drag or a resize moves the widget directly and commits one command when
 * the gesture ends, so nothing is stored for rectangles the window merely
 * passed through. The shell decides where a gesture may go (`dragTo`,
 * `sizeTo`) and what it means when it ends (`drop`).
 */
export class Window extends Widget {
  interactive = true;
  focusBoundary = true;
  active = false;
  /** How the shell shows this window right now. */
  look = { title: '', tool: false, flat: false, shade: false, min: false, max: false, maxed: false, sizable: false, minW: 1, minH: 1 };
  #grab = null;
  #tapped = -Infinity;

  constructor(ui, { id, content, desktop }) {
    super(ui);
    this.id = id;
    this.desktop = desktop;
    this.viewport = this.add(new Viewport(ui));
    this.content = this.viewport.add(content);
    this.grip = this.add(new Grip(ui));
  }

  /** What the frame adds around its content. */
  static chrome(tool = false) {
    return { w: 2, h: (tool ? TOOL_H : TITLE_H) + 2 };
  }

  get titleH() {
    return this.look.tool ? TOOL_H : TITLE_H;
  }

  /** The frame's size in window pixels; the widget is larger by the shadow. */
  get frame() {
    const shadow = this.look.flat ? 0 : SHADOW;
    return { w: this.w - shadow, h: this.h - shadow };
  }

  /** The frame's rectangle on screen. */
  get bounds() {
    const { w, h } = this.frame;
    return { x: this.x, y: this.y, w: w * this.zoom, h: h * this.zoom };
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.invalidate();
  }

  setLook(look) {
    if (Object.keys(look).every(key => look[key] === this.look[key])) return;
    this.look = { ...this.look, ...look };
    this.invalidate();
  }

  arrange() {
    const { w, h } = this.frame;
    const { titleH } = this;
    this.viewport.visible = !this.look.shade;
    this.content.visible = !this.look.shade;
    this.viewport.place(1, titleH + 1, w - 2, h - titleH - 2);
    this.content.place(0, 0, this.viewport.w, this.viewport.h);
    // A tool resizes by its edges; a grow corner would cover its last control.
    this.grip.visible = this.look.sizable && !this.look.tool;
    this.grip.place(w - 10, h - 10, 9, 9);
  }

  paint(bitmap, theme) {
    const { w, h } = this.frame;
    windowFrame(bitmap, theme, this.ui.font, w, h, { ...this.look, active: this.active });
  }

  /** The frame's edges win over the content, so a thin border is still easy to grab. */
  hit(px, py) {
    if (!this.visible) return null;
    const x = Math.floor((px - this.x) / this.zoom);
    const y = Math.floor((py - this.y) / this.zoom);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h && this.#edge(x, y)) return this;
    return super.hit(px, py);
  }

  cursor(event) {
    return CURSORS[this.#edge(event.x, event.y)] ?? 'default';
  }

  menu(event) {
    return this.desktop.openContext(this.look.tool ? 'tool' : 'window', this.id, event);
  }

  pointer(type, event) {
    if (type === 'down') {
      const edge = this.#edge(event.x, event.y);
      if (edge) this.#grab = this.#sizing(edge, event);
      else if (event.y < this.titleH) this.#grab = this.#box(event) ? { box: this.#box(event) } : { gx: event.gx, gy: event.gy, dx: event.gx - this.x, dy: event.gy - this.y, moved: false, zone: null };
      return;
    }
    const grab = this.#grab;
    if (!grab) return;
    if (grab.dir) this.#size(type, event);
    else if (grab.box) this.#press(type, event);
    else this.#drag(type, event);
  }

  /** Lets the grow corner start and steer a resize. */
  resizeFrom(dir, type, event) {
    if (type === 'down') this.#grab = this.#sizing(dir, event);
    else if (this.#grab?.dir) this.#size(type, event);
  }

  /** Which edge or corner a point of the widget resizes, or null. */
  #edge(x, y) {
    if (!this.look.sizable) return null;
    const { w, h } = this.frame;
    const north = y < 2;
    const south = y >= h - EDGE;
    const west = x < EDGE;
    const east = x >= w - EDGE;
    if (!north && !south && !west && !east) return null;
    const vertical = north || (y < CORNER && (west || east)) ? 'n' : south || (y >= h - CORNER && (west || east)) ? 's' : '';
    const horizontal = west || (x < CORNER && (north || south)) ? 'w' : east || (x >= w - CORNER && (north || south)) ? 'e' : '';
    return vertical + horizontal;
  }

  /** The caption box under a point: 'close' | 'min' | 'max', or null. */
  #box(event) {
    if (event.y < 0 || event.y >= this.titleH) return null;
    const boxes = captionBoxes(this.frame.w, this.look);
    return Object.keys(boxes).find(name => event.x >= boxes[name].x && event.x < boxes[name].x + boxes[name].w) ?? null;
  }

  #press(type, event) {
    if (type === 'move') return;
    const { box } = this.#grab;
    this.#grab = null;
    if (type === 'up' && this.#box(event) === box) this.desktop.windowBox(this.id, box);
  }

  #drag(type, event) {
    const grab = this.#grab;
    const { desktop } = this;
    if (type === 'move') {
      if (!grab.moved) {
        if (Math.abs(event.gx - grab.gx) + Math.abs(event.gy - grab.gy) <= DRAG_SLOP || !desktop.canDrag(this.id)) return;
        grab.moved = true;
        // A tiled window takes its normal size again, under the pointer.
        const normal = desktop.lift(this);
        if (normal) {
          const along = grab.dx / this.bounds.w;
          this.place(this.x, this.y, normal.w + SHADOW, normal.h + SHADOW);
          grab.dx = Math.round(along * this.bounds.w);
        }
      }
      const { x, y, zone } = desktop.dragTo(this, event.gx - grab.dx, event.gy - grab.dy, event);
      grab.zone = zone;
      this.place(x, y, this.w, this.h);
      desktop.follow(this);
      return;
    }
    this.#grab = null;
    if (grab.moved) {
      desktop.drop(this, type === 'up' ? grab.zone : null, type !== 'up');
    } else if (type === 'up') {
      // A second tap on the caption zooms the window, as a double click does.
      const now = this.ui.stage.time;
      const double = now - this.#tapped < DOUBLE_MS;
      this.#tapped = double ? -Infinity : now;
      if (double) desktop.windowBox(this.id, 'max');
    }
  }

  #sizing(dir, event) {
    const { w, h } = this.frame;
    return { dir, gx: event.gx, gy: event.gy, from: { x: this.x, y: this.y, w, h }, moved: false };
  }

  #size(type, event) {
    const grab = this.#grab;
    if (type === 'move') {
      grab.moved = true;
      const { x, y, w, h } = this.desktop.sizeTo(this, grab.from, grab.dir, event.gx - grab.gx, event.gy - grab.gy, event.alt);
      this.place(x, y, w + SHADOW, h + SHADOW);
      this.desktop.follow(this);
      return;
    }
    this.#grab = null;
    if (!grab.moved) return;
    if (type === 'up') this.desktop.commitSize(this);
    else this.desktop.cancelGesture();
  }
}
