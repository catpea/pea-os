import { Widget } from '../ui/widget.js';
import { TASK_H } from '../gfx/skin.js';
import { lighten, darken } from '../gfx/color.js';

export const TASK_MAX = 86;   // widest a task button gets: room for the longest title in bold
const ROOMY = 250;     // below this width the desktop switcher folds into one button
const START = 'Start';

/**
 * A flat bar button: a soft rounded face, outlined lightly at rest and firmly
 * under the pointer or when on, sinking a pixel while pressed. Returns that
 * offset for the content.
 */
function pill(bitmap, theme, x, w, { face, hover = false, on = false, pressed = false, bare = false }) {
  const top = pressed ? 1 : 0;
  if (bare && !hover) return top;
  const base = hover && !pressed ? theme.lock(lighten(face, 0.22)) : pressed ? theme.lock(darken(face, 0.12)) : face;
  bitmap.roundFill(x, 2 + top, w, 12, 2, base);
  if (!pressed) bitmap.fill(x + 2, 3, w - 4, 1, theme.lock(lighten(base, 0.35)));
  bitmap.roundFrame(x, 2 + top, w, 12, 2, theme.color(on || hover ? 'ink' : 'dim'));
  return top;
}

/**
 * The bar across the bottom: a launcher, one button per open window, the
 * virtual desktops, pan mode, the on-screen keyboard and "show desktop".
 *
 * It is a view of the desktop model and a few system signals. It never
 * changes anything itself: every press is reported to the shell as a slot.
 */
/**
 * The words on a task button w pixels wide, shortened with an ellipsis to
 * fit, or null when not even a letter fits and the icon shows alone. Fitted
 * as bold, which is wider, so the window in front stays inside its button
 * and selecting a window never changes its words.
 */
export function taskLabel(font, title, w) {
  const room = w - 17;
  const bold = { bold: true };
  let label = title;
  while (label.length > 1 && font.measure(label, bold) > room) label = `${label.slice(0, -2)}…`;
  return label.length > 1 && font.measure(label, bold) <= room ? label : null;
}

export class TaskBar extends Widget {
  interactive = true;
  focusable = true;
  focusMark = 'none'; // it frames its selected slot itself
  preserveFocus = true;
  #press = null;
  #launching = false;
  #selected = 0;
  #hot = null;

  /** onPress(slot) and onContext(slot | null, event); slot: { kind, id, index } */
  constructor(ui, { os, onPress, onContext }) {
    super(ui);
    this.os = os;
    this.onPress = onPress;
    this.onContext = onContext;
    this.watch(os.model.state, () => this.invalidate());
    for (const name of ['pan-mode', 'panning', 'keys']) this.watch(os.signals.resolve(name), () => this.invalidate());
  }

  /** Shows the launcher as held down while its menu is open. */
  setLaunching(launching) {
    if (launching === this.#launching) return;
    this.#launching = launching;
    this.invalidate();
  }

  /** The bar's parts, left to right: { kind, x, w, ... }. */
  slots() {
    const { os } = this;
    const state = os.model.state.value;
    // The label shows only when it fits whole; a narrow bar keeps just the pea.
    const label = this.ui.font.measure(START, { bold: true });
    const startW = this.w >= 170 ? label + 21 : Math.min(17, Math.max(12, this.w - 2));
    const slots = [{ kind: 'launcher', x: 1, w: startW }];
    let right = this.w - 1;
    const take = (kind, w, extra) => {
      if (right - w < startW + 5) return;
      right -= w;
      slots.push({ kind, x: right, w, ...extra });
      right -= 1;
    };
    take('peek', 11);
    take('overview', 13);
    if (this.w >= 190) take('keys', 15);
    if (this.w >= 220 && os.signals.get('panning')) take('pan', 13);
    right -= 1;
    if (this.w < ROOMY) {
      take('desk', 13, { index: (state.desk + 1) % state.desks.length, label: state.desk + 1, current: true });
    } else {
      for (let index = state.desks.length - 1; index >= 0; index--) take('desk', 10, { index, label: index + 1, current: index === state.desk });
    }

    const tasks = state.windows.filter(win => !win.owner && win.open);
    const left = startW + 4;
    const available = Math.max(0, right - left - 1);
    const capacity = Math.floor(available / 28);
    const overflowing = tasks.length > capacity;
    const count = overflowing ? Math.max(0, Math.floor((available - 23) / 28)) : tasks.length;
    const shown = tasks.slice(0, count);
    const active = tasks.find(win => win.id === state.active);
    if (active && shown.length && !shown.includes(active)) shown[shown.length - 1] = active;
    const each = Math.min(TASK_MAX, Math.floor((available - (overflowing ? 23 : 0)) / Math.max(1, shown.length)));
    shown.forEach((win, i) => {
      slots.push({ kind: 'task', id: win.id, x: left + i * each, w: each - 1, title: win.title, min: win.min, active: state.active === win.id });
    });
    if (overflowing && available >= 14) slots.push({ kind: 'overflow', x: left + shown.length * each, w: Math.min(22, available - shown.length * each), count: tasks.length - shown.length });
    return slots;
  }

  /** Where a window's task button is on screen, for zooming outlines; null when it has none. */
  slotRect(id) {
    const slots = this.slots();
    const slot = slots.find(candidate => candidate.kind === 'task' && candidate.id === id) ?? slots.find(candidate => candidate.kind === 'overflow');
    if (!slot || !this.visible) return null;
    const { x, y } = this.toScreen(slot.x, 2);
    return { x, y, w: slot.w * this.zoom, h: 13 * this.zoom };
  }

  paint(bitmap, theme) {
    const { font, sprites } = this.ui;
    const { os } = this;
    const ink = theme.color('ink');
    const barInk = theme.color('bar-ink');
    bitmap.fill(0, 1, this.w, this.h - 1, theme.color('bar'));
    bitmap.fill(0, 0, this.w, 1, ink);

    const slots = this.slots();
    const selected = [...slots].sort((a, b) => a.x - b.x)[this.#selected];
    for (const slot of slots) {
      const { x, w } = slot;
      const hover = this.#hot === TaskBar.#key(slot);
      if (slot.kind === 'launcher') {
        const top = pill(bitmap, theme, x, w, { face: theme.color('accent'), hover, on: true, pressed: this.#launching });
        const pea = sprites.get('pea-9').frames[0];
        const text = w >= font.measure(START, { bold: true }) + 21;
        bitmap.blit(pea, x + (text ? 4 : ((w - pea.width) >> 1)), 3 + top);
        if (text) font.draw(bitmap, START, x + 16, 4 + top, theme.color('accent-ink'), { bold: true });
      } else if (slot.kind === 'task') {
        if (w < 8) continue;
        const top = pill(bitmap, theme, x, w, { face: slot.active ? theme.lock(lighten(theme.color('panel'), 0.2)) : theme.color('panel'), hover, on: slot.active, bare: slot.min });
        // The app's little icon when it has one; otherwise a swatch of its tint.
        const icon = this.parent?.appIcon?.(slot.id);
        const label = taskLabel(font, slot.title, w);
        const words = label !== null;
        const left = words ? x + 3 : x + ((w - 9) >> 1);
        if (icon) bitmap.blit(sprites.get(icon).frames[0], left, 3 + top, { alpha: slot.min ? 0.55 : 1 });
        else {
          bitmap.fill(left + 2, 5 + top, 3, 6, theme.paint(os.apps.get(slot.id).tint));
          bitmap.frame(left + 1, 4 + top, 5, 8, ink);
        }
        if (words) font.draw(bitmap, label, x + 14, 4 + top, theme.color(slot.min ? 'dim' : 'panel-ink'), { bold: slot.active });
        // The window in front is underlined, as on a modern dock.
        if (slot.active) bitmap.fill(x + 3, 12 + top, w - 6, 1, theme.color('accent'));
      } else if (slot.kind === 'desk') {
        bitmap.fill(x, 3, w, 11, theme.color(slot.current ? 'accent' : hover ? 'paper' : 'panel'));
        bitmap.frame(x, 3, w, 11, ink);
        const text = String(slot.label);
        font.draw(bitmap, text, x + ((w - font.measure(text) + 1) >> 1), 5, theme.color(slot.current ? 'accent-ink' : 'panel-ink'));
      } else if (slot.kind === 'pan') {
        const on = os.signals.get('pan-mode');
        if (on) bitmap.fill(x, 3, w, 11, theme.color('accent'));
        const color = on ? theme.color('accent-ink') : barInk;
        const cx = x + 6;
        bitmap.fill(cx, 4, 1, 9, color);
        bitmap.fill(cx - 4, 8, 9, 1, color);
        for (const [dx, dy] of [[-1, 5], [1, 5], [-1, 11], [1, 11], [-3, 7], [-3, 9], [3, 7], [3, 9]]) bitmap.set(cx + dx, dy, color);
      } else if (slot.kind === 'keys') {
        const on = os.signals.get('keys');
        if (on) bitmap.fill(x, 3, w, 11, theme.color('accent'));
        const color = on ? theme.color('accent-ink') : barInk;
        bitmap.frame(x + 1, 5, 13, 8, color);
        for (let i = 0; i < 5; i++) bitmap.set(x + 3 + i * 2, 7, color);
        for (let i = 0; i < 4; i++) bitmap.set(x + 4 + i * 2, 9, color);
        bitmap.fill(x + 4, 11, 7, 1, color);
      } else if (slot.kind === 'peek') {
        if (hover) bitmap.fill(x, 3, w, 11, theme.color('panel'));
        bitmap.frame(x + 1, 4, 8, 9, barInk);
        bitmap.fill(x + 2, 5, 6, 2, barInk);
      } else if (slot.kind === 'overview') {
        if (hover) bitmap.fill(x, 3, w, 11, theme.color('panel'));
        for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) bitmap.frame(x + 1 + column * 6, 4 + row * 5, 5, 4, barInk);
      } else if (slot.kind === 'overflow') {
        pill(bitmap, theme, x, w, { face: theme.color('panel'), hover });
        font.draw(bitmap, `+${slot.count}`, x + ((w - font.measure(`+${slot.count}`) + 1) >> 1), 4, theme.color('panel-ink'));
      }
      if (this.focused && slot === selected) bitmap.frame(x, 1, w, this.h - 2, theme.color('accent'));
    }
  }

  static #key(slot) {
    return `${slot.kind}:${slot.id ?? slot.index ?? ''}`;
  }

  /** Follows the pointer from slot to slot, so each button answers it. */
  hover(inside, event) {
    const slot = inside && event ? this.#slotAt(event) : null;
    const hot = slot ? TaskBar.#key(slot) : null;
    this.hovered = inside;
    if (hot === this.#hot) return;
    this.#hot = hot;
    this.invalidate();
  }

  #slotAt(event) {
    if (event.y < 0 || event.y >= this.h) return null;
    return this.slots().find(slot => event.x >= slot.x && event.x < slot.x + slot.w) ?? null;
  }

  pointer(type, event) {
    if (type === 'down') {
      this.#press = this.#slotAt(event);
      return;
    }
    if (type === 'move') return;
    const press = this.#press;
    this.#press = null;
    const slot = type === 'up' ? this.#slotAt(event) : null;
    if (press && slot && slot.kind === press.kind && slot.id === press.id && slot.index === press.index) this.onPress(slot);
  }

  menu(event) {
    const slot = this.#slotAt(event);
    this.onContext(slot?.kind === 'task' || slot?.kind === 'launcher' ? slot : null, event);
    return true;
  }

  key(type, event) {
    if (type !== 'down') return false;
    const slots = this.slots().sort((a, b) => a.x - b.x);
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      this.#selected = (this.#selected + (event.key === 'ArrowLeft' ? -1 : 1) + slots.length) % slots.length;
      this.invalidate(); return true;
    }
    if (event.key === 'Enter' || event.key === ' ') { this.onPress(slots[this.#selected] ?? slots[0]); return true; }
    return false;
  }
}
