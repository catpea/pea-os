import { bootHeadless } from '../cli/headless.mjs';
import { ROOT } from '../cli/project.mjs';
import { Popup } from '../src/os/menu.js';
import { Window } from '../src/os/window.js';

/** What the whole-system tests share: a booted kernel and ways to find and press things. */

/** Boots the real kernel on a virtual screen and disposes it after the test. */
export async function session(t, config = {}) {
  const live = await bootHeadless({ root: ROOT, ...config });
  t.after(() => live.dispose());
  return live;
}

export const walk = function* (widget) {
  yield widget;
  for (const child of widget.children) yield* walk(child);
};

/** The middle of a widget, on screen. */
export const center = widget => {
  const { x, y } = widget.toScreen(widget.w >> 1, widget.h >> 1);
  return [x, y];
};

export const frameOf = (live, id) => [...walk(live.os.desktop)].find(widget => widget instanceof Window && widget.id === id);

/** The popup menu on screen, if any. */
export const popupOf = live => live.os.desktop.popups.children.find(widget => widget instanceof Popup) ?? null;

/** Taps the item of the open popup menu that has this text. */
export async function pick(live, text) {
  const popup = popupOf(live);
  const at = popup?.locate(text);
  if (!at) throw new Error(`No menu item "${text}". Items: ${popup ? popup.items.map(item => item.text ?? '-').join(', ') : 'no menu is open'}`);
  const { x, y } = popup.toScreen(at.x, at.y);
  await live.tap(x, y);
}

/** A point on a window's caption that is clear of its boxes, on screen. */
export const caption = (frame, along = 60) => [frame.x + along * frame.zoom, frame.y + 5 * frame.zoom];

/** The middle of a taskbar slot, on screen. */
export function slot(live, kind, match = () => true) {
  const { tasks } = live.os.desktop;
  const found = tasks.slots().find(candidate => candidate.kind === kind && match(candidate));
  if (!found) throw new Error(`The taskbar has no ${kind} slot like that`);
  const { x, y } = tasks.toScreen(found.x + (found.w >> 1), 8);
  return [x, y];
}

/** Counts how often the desktop model commits from now on. */
export function commits(os) {
  const count = { n: 0 };
  os.model.state.subscribe(() => { count.n += 1; }, { immediate: false });
  return count;
}
