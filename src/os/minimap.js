import { Widget } from '../ui/widget.js';
import { caption, CLOSE_BOX, TITLE_H } from '../gfx/skin.js';
import { channels } from '../gfx/color.js';

const luma = color => { const [r, g, b] = channels(color); return r * 0.3 + g * 0.59 + b * 0.11; };

/** A stable map projection for one gesture. Extents include home and all placed objects. */
export function mapProjection(items, viewport, box) {
  const left = Math.min(0, viewport.x, ...items.map(item => item.x));
  const top = Math.min(0, viewport.y, ...items.map(item => item.y));
  const right = Math.max(viewport.w, viewport.x + viewport.w, ...items.map(item => item.x + item.w));
  const bottom = Math.max(viewport.h, viewport.y + viewport.h, ...items.map(item => item.y + item.h));
  const padding = 24;
  const world = { x: left - padding, y: top - padding, w: right - left + padding * 2, h: bottom - top + padding * 2 };
  const scale = Math.min(box.w / world.w, box.h / world.h);
  const ox = box.x + (box.w - world.w * scale) / 2;
  const oy = box.y + (box.h - world.h * scale) / 2;
  return {
    world, scale,
    screen: (x, y) => ({ x: Math.round(ox + (x - world.x) * scale), y: Math.round(oy + (y - world.y) * scale) }),
    point: (x, y) => ({ x: Math.round(world.x + (x - ox) / scale), y: Math.round(world.y + (y - oy) / scale) }),
    rect(rect) {
      const at = this.screen(rect.x, rect.y);
      return { ...at, w: Math.max(2, Math.round(rect.w * scale)), h: Math.max(2, Math.round(rect.h * scale)) };
    }
  };
}

/** An empty outline drawn every other pixel. */
function dotted(bitmap, { x, y, w, h }, color) {
  for (let i = 0; i < w; i += 2) { bitmap.set(x + i, y, color); bitmap.set(x + i, y + h - 1, color); }
  for (let j = 0; j < h; j += 2) { bitmap.set(x, y + j, color); bitmap.set(x + w - 1, y + j, color); }
}

export function paintMap(bitmap, theme, items, viewport, box, projection = mapProjection(items, viewport, box)) {
  const ground = theme.color('wall-a');
  // Ink or the wallpaper label color, whichever stands out from the map's ground in this theme.
  const outline = [theme.color('ink'), theme.color('label')].sort((a, b) => Math.abs(luma(b) - luma(ground)) - Math.abs(luma(a) - luma(ground)))[0];
  bitmap.fill(box.x, box.y, box.w, box.h, ground);
  const home = projection.screen(0, 0);
  bitmap.fill(home.x - 1, home.y, 3, 1, theme.color('dim'));
  bitmap.fill(home.x, home.y - 1, 1, 3, theme.color('dim'));
  for (const item of items) {
    const r = projection.rect(item);
    if (item.min) { dotted(bitmap, r, outline); continue; } // minimized: only where it will come back
    bitmap.fill(r.x, r.y, r.w, r.h, theme.paint(item.color ?? 'panel'));
    if (item.kind === 'window') bitmap.frame(r.x, r.y, r.w, r.h, theme.color(item.active ? 'accent' : 'ink'));
  }
  const view = projection.rect(viewport);
  bitmap.frame(view.x, view.y, view.w, view.h, theme.color('paper'));
  if (view.w > 4 && view.h > 4) bitmap.frame(view.x + 1, view.y + 1, view.w - 2, view.h - 2, theme.color('accent'));
  return projection;
}

/**
 * Screen-anchored navigator. Drag the viewport or click anywhere to recenter.
 * Clicking a window centers it and brings it back if it was minimized; dragging from one still drags the view.
 */
export class Minimap extends Widget {
  interactive = true;
  focusable = true;
  #grab = null;
  #projection = null;

  constructor(ui, desktop) { super(ui); this.desktop = desktop; }

  get viewport() {
    return { ...this.desktop.pan, w: this.desktop.work.w, h: this.desktop.work.h };
  }

  paint(bitmap, theme) {
    bitmap.fill(0, 0, this.w, this.h, theme.color('paper'));
    bitmap.frame(0, 0, this.w, this.h, theme.color('ink'));
    caption(bitmap, theme, this.ui.font, 1, 1, this.w - 2, { title: 'Map' });
    bitmap.fill(1, TITLE_H, this.w - 2, 1, theme.color('ink'));
    const items = this.desktop.worldItems();
    this.#projection = paintMap(bitmap, theme, items, this.viewport, { x: 3, y: TITLE_H + 3, w: this.w - 6, h: this.h - TITLE_H - 6 }, this.#grab?.projection);
  }

  pointer(type, event) {
    if (type === 'down') {
      if (event.y <= TITLE_H) {
        if (event.x < CLOSE_BOX.w) this.desktop.os.run('toggle:os.minimap');
        else this.desktop.openOverview();
        return;
      }
      const projection = this.#projection;
      if (!projection) return;
      const point = projection.point(event.x, event.y);
      const view = this.viewport;
      const inside = point.x >= view.x && point.y >= view.y && point.x <= view.x + view.w && point.y <= view.y + view.h;
      const window = this.#windowAt(projection, event);
      this.#grab = { projection, from: { ...this.desktop.pan }, dx: inside ? point.x - view.x : view.w / 2, dy: inside ? point.y - view.y : view.h / 2,
        window, at: { x: event.x, y: event.y } };
      if (!window) this.#move(event);
      return;
    }
    if (!this.#grab) return;
    if (type === 'move') {
      // A press on a window is a click until the pointer travels.
      if (this.#grab.window && Math.abs(event.x - this.#grab.at.x) + Math.abs(event.y - this.#grab.at.y) < 3) return;
      this.#grab.window = null;
      this.#move(event);
      return;
    }
    if (type === 'up' && this.#grab.window) {
      const { window } = this.#grab;
      this.#grab = null;
      this.desktop.showWindow(window);
      this.invalidate();
      return;
    }
    const to = type === 'up' ? this.desktop.pan : this.#grab.from;
    this.#grab = null;
    this.desktop.setPan(to);
    this.invalidate();
  }

  /** The frontmost window under a point on the map, or null. */
  #windowAt(projection, { x, y }) {
    const hit = this.desktop.worldItems().findLast(item => {
      if (item.kind !== 'window') return false;
      const r = projection.rect(item);
      return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    });
    return hit?.id ?? null;
  }

  #move(event) {
    const point = this.#grab.projection.point(event.x, event.y);
    this.desktop.setPan({ x: point.x - this.#grab.dx, y: point.y - this.#grab.dy }, false);
    this.invalidate();
  }

  key(type, event) {
    if (type !== 'down') return false;
    const delta = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] }[event.key];
    if (delta) {
      this.desktop.setPan({ x: this.desktop.pan.x + delta[0], y: this.desktop.pan.y + delta[1] });
      return true;
    }
    if (event.key === 'Home') { this.desktop.setPan({ x: 0, y: 0 }); return true; }
    return false;
  }

  menu(event) { return this.desktop.openContext('minimap', null, event); }

  cursor() { return this.#grab ? 'grabbing' : 'pointer'; }
}
