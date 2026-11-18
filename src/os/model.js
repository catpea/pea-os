import { Signal } from '../core/reactive.js';

/**
 * The desktop's observable state. Commands replace an immutable snapshot;
 * views subscribe and push the difference to the widgets they already own.
 *
 *   state.value = {
 *     desk:    0,                       // the virtual desktop on screen
 *     desks:   [{ windows, order, pan, peek }],   // one arrangement per desktop
 *     icons:   { paint: { x, y } },     // icons the user has placed, on the work area; others flow
 *     // the arrangement on screen, spread for convenience:
 *     windows: [{ id, title, owner, resizable, minW, minH,
 *                 open, min, mode, shade, top, all, x, y, w, h }],
 *     order:   ['about', 'paint'],      // open windows, least to most recently raised
 *     layers:  ['paint', 'about'],      // the same, back to front as drawn: `top` windows last
 *     pan:     { x, y },                // how far this desktop is scrolled
 *     active:  'paint'                  // the app window in front, or null
 *   }
 *
 * x, y, w and h are a window's normal rectangle: its frame in the desktop's
 * world, x and y in desktop pixels, w and h in the window's own pixels. A
 * `mode` other than "normal" tiles the window against the screen instead and
 * leaves the normal rectangle alone, so that restoring needs nothing stored.
 *
 * A tool window names its `owner`. It is stacked directly above its owner,
 * shows only while the owner shows, and moves when the owner moves. A tool
 * whose x is null is docked: the shell places it beside its owner.
 *
 * A window kept `top` is drawn above the others without being the active
 * one. A window kept on `all` desktops goes along whenever another desktop
 * is shown, at the same place on screen: GNOME's "Always on Visible
 * Workspace".
 *
 * A saved layout is presentation only. It never contains what an app holds.
 */

export const MODES = ['normal', 'max', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

const frozen = value => (Object.isFrozen(value) ? value : Object.freeze(value));

function freezeDesk(desk) {
  if (Object.isFrozen(desk)) return desk;
  return Object.freeze({
    windows: Object.freeze(desk.windows.map(frozen)),
    order: Object.freeze(stack(desk)),
    pan: Object.freeze({ ...desk.pan }),
    peek: Object.freeze([...desk.peek])
  });
}

/** Back-to-front order with every tool directly above its owner. */
function stack({ windows, order }) {
  const owner = id => windows.find(win => win.id === id).owner;
  const result = order.filter(id => owner(id) && !order.includes(owner(id)));
  for (const id of order) {
    if (owner(id)) continue;
    result.push(id, ...order.filter(other => owner(other) === id));
  }
  return result;
}

/**
 * The desktops after window `id` and its tools go from desktop `from` to
 * `to`. With `onScreen`, it keeps its place on screen rather than in the world.
 */
function carry(desks, from, to, id, onScreen) {
  const family = other => other.id === id || other.owner === id;
  const here = desks[from];
  const there = desks[to];
  const dx = onScreen ? there.pan.x - here.pan.x : 0;
  const dy = onScreen ? there.pan.y - here.pan.y : 0;
  const shift = win => (win.x === null ? win : { ...win, x: win.x + dx, y: win.y + dy });
  const moved = new Map(here.windows.filter(family).map(other => [other.id, shift(other)]));
  return desks.map((arrangement, i) => {
    if (i === from) {
      return {
        ...arrangement,
        windows: arrangement.windows.map(other => (other.id === id ? { ...other, open: false } : other)),
        order: arrangement.order.filter(other => other !== id),
        peek: arrangement.peek.filter(other => other !== id)
      };
    }
    if (i !== to) return arrangement;
    return {
      ...arrangement,
      windows: there.windows.map(other => moved.get(other.id) ?? other),
      order: [...there.order.filter(other => !moved.has(other)), ...here.order.filter(other => moved.has(other))]
    };
  });
}

/** Whether a window is on screen: open, not minimized, and so is its owner. */
export function shows(windows, win) {
  if (!win.open || win.min) return false;
  return !win.owner || shows(windows, windows.find(other => other.id === win.owner));
}

function freeze({ desk, desks, icons }) {
  const all = Object.freeze(desks.map(freezeDesk));
  const { windows, order, pan } = all[desk];
  const front = windows.find(win => win.id === order.findLast(id => shows(windows, windows.find(win => win.id === id))));
  const top = id => windows.find(win => win.id === id)?.top;
  const raised = id => top(windows.find(win => win.id === id).owner ?? id);
  return Object.freeze({
    desk,
    desks: all,
    icons: frozen(icons),
    windows,
    order,
    layers: Object.freeze([...order.filter(id => !raised(id)), ...order.filter(raised)]),
    pan,
    active: front?.owner ?? front?.id ?? null // a tool in front means its owner is the active app
  });
}

export class DesktopModel {
  /**
   * windows: [{ id, title, w, h, minW, minH, resizable, owner, open }]
   * `open` is how a tool starts out; app windows start closed.
   */
  constructor(windows, { desks = 4 } = {}) {
    const blank = () => ({
      windows: windows.map(({ id, title, w, h, minW = w, minH = h, resizable = true, owner = null, open = false }) => ({
        id, title, owner, resizable, minW, minH, open: Boolean(owner && open), min: false, mode: 'normal', shade: false, top: false, all: false, x: null, y: null, w, h
      })),
      order: windows.filter(win => win.owner && win.open).map(win => win.id),
      pan: { x: 0, y: 0 },
      peek: []
    });
    for (const win of windows) {
      if (win.owner && !windows.some(other => other.id === win.owner && !other.owner)) throw new Error(`Tool window "${win.id}" has no owner "${win.owner}"`);
    }
    this.state = new Signal(freeze({ desk: 0, desks: Array.from({ length: desks }, blank), icons: {} }));
  }

  window(id) {
    const win = this.state.value.windows.find(candidate => candidate.id === id);
    if (!win) throw new Error(`Unknown window "${id}". Windows: ${this.state.value.windows.map(w => w.id).join(', ')}`);
    return win;
  }

  /** Whether a window is on screen right now. */
  shows(id) {
    return shows(this.state.value.windows, this.window(id));
  }

  /** Opens, restores and activates a window. `at` positions it the first time only. */
  open(id, at = { x: 0, y: 0 }) {
    this.window(id);
    this.#change(draft => {
      const win = draft.window(id);
      win.open = true;
      win.min = false;
      if (!win.owner) {
        win.x ??= Math.round(at.x);
        win.y ??= Math.round(at.y);
      }
      draft.raise(id);
    });
  }

  /** Hides a window. Its content and rectangle are kept for the next open. */
  close(id) {
    this.window(id);
    this.#change(draft => {
      draft.window(id).open = false;
      draft.order = draft.order.filter(other => other !== id);
    });
  }

  /** Brings an open window to the front, out of the taskbar if it was minimized. */
  activate(id) {
    const win = this.window(id);
    if (!win.open) throw new Error(`Window "${id}" is closed`);
    const { active, order } = this.state.value;
    if (active === (win.owner ?? id) && !win.min && (!win.owner || order.at(-1) === id)) return;
    this.#change(draft => {
      draft.window(id).min = false;
      draft.raise(id);
    });
  }

  minimize(id) {
    const win = this.window(id);
    if (win.owner) throw new Error(`Tool window "${id}" cannot be minimized`);
    if (!win.open || win.min) return;
    this.#change(draft => { draft.window(id).min = true; });
  }

  /** Moves a window; its tools keep their place beside it. Dragging a tiled window makes it normal again. */
  move(id, { x, y }) {
    const win = this.window(id);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('move needs finite x and y');
    const dx = Math.round(x) - win.x;
    const dy = Math.round(y) - win.y;
    this.#change(draft => {
      const follow = win.mode === 'normal' && win.x !== null;
      Object.assign(draft.window(id), { x: Math.round(x), y: Math.round(y), mode: 'normal' });
      if (!follow) return;
      for (const tool of draft.windows) {
        if (tool.owner !== id || tool.x === null) continue;
        tool.x += dx;
        tool.y += dy;
      }
    });
  }

  /** Sets a window's normal rectangle. Sizes never go below the window's minimum. */
  resize(id, { x, y, w, h }) {
    const win = this.window(id);
    if (!win.resizable) throw new Error(`Window "${id}" has a fixed size`);
    if (![x, y, w, h].every(Number.isFinite)) throw new TypeError('resize needs finite x, y, w and h');
    this.#change(draft => {
      Object.assign(draft.window(id), {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.max(win.minW, Math.round(w)),
        h: Math.max(win.minH, Math.round(h)),
        mode: 'normal',
        shade: false
      });
    });
  }

  /** Tiles a window against the screen ("max", "left", "top-right", ...) or makes it "normal" again. */
  mode(id, mode) {
    const win = this.window(id);
    if (!MODES.includes(mode)) throw new Error(`Unknown window mode "${mode}". Modes: ${MODES.join(', ')}`);
    if (win.owner) throw new Error(`Tool window "${id}" cannot be tiled`);
    if (!win.open) throw new Error(`Window "${id}" is closed`);
    this.#change(draft => {
      Object.assign(draft.window(id), { mode, min: false, shade: mode === 'normal' && win.shade });
      draft.raise(id);
    });
  }

  /** Rolls a window up into its caption, or back down. */
  shade(id, shade) {
    this.window(id);
    this.#change(draft => { draft.window(id).shade = Boolean(shade); });
  }

  /** Scrolls the desktop on screen. */
  pan({ x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('pan needs finite x and y');
    const { pan } = this.state.value;
    if (pan.x === Math.round(x) && pan.y === Math.round(y)) return;
    this.#change(draft => { draft.pan = { x: Math.round(x), y: Math.round(y) }; });
  }

  /** Several geometry changes at once: { id: { x, y, w, h, mode, min } } and optionally a new pan. */
  arrange(patches, pan) {
    for (const id of Object.keys(patches)) this.window(id);
    this.#change(draft => {
      for (const [id, patch] of Object.entries(patches)) Object.assign(draft.window(id), patch);
      if (pan) draft.pan = { x: Math.round(pan.x), y: Math.round(pan.y) };
    });
  }

  /** Clears the desk: minimizes every window, or brings back the ones the last call put away. */
  peek() {
    this.#change(draft => {
      const up = draft.windows.filter(win => !win.owner && win.open && !win.min);
      if (up.length) {
        for (const win of up) win.min = true;
        draft.peek = up.map(win => win.id);
        return;
      }
      for (const id of draft.peek) draft.window(id).min = false;
      draft.peek = [];
    });
  }

  /**
   * Shows another virtual desktop. Each keeps its own arrangement, pan and
   * active window; windows kept on all desktops come along, where they were on screen.
   */
  desk(index) {
    const { desk, desks, icons } = this.state.value;
    if (!Number.isInteger(index) || index < 0 || index >= desks.length) throw new RangeError(`There is no desktop ${index + 1}; there are ${desks.length}`);
    if (index === desk) return;
    let moved = desks;
    for (const win of desks[desk].windows) if (win.all && win.open && !win.owner) moved = carry(moved, desk, index, win.id, true);
    this.state.set(freeze({ desk: index, desks: moved, icons }));
  }

  /** Keeps a window above the others (`top`) or on every desktop (`all`), or stops. */
  keep(id, flag, on) {
    const win = this.window(id);
    if (!['top', 'all'].includes(flag)) throw new Error(`A window can be kept "top" or on "all" desktops, not "${flag}"`);
    if (win.owner) throw new Error(`Tool window "${id}" goes where its owner goes`);
    if (win[flag] === Boolean(on)) return;
    this.#change(draft => { draft.window(id)[flag] = Boolean(on); });
  }

  /** Moves a window, as it is, to another virtual desktop. */
  send(id, index) {
    const win = this.window(id);
    const { desk, desks, icons } = this.state.value;
    if (!Number.isInteger(index) || index < 0 || index >= desks.length) throw new RangeError(`There is no desktop ${index + 1}; there are ${desks.length}`);
    if (win.owner) throw new Error(`Tool window "${id}" travels with its owner`);
    if (index === desk || !win.open) return;
    this.state.set(freeze({ desk, icons, desks: carry(desks, desk, index, id, false) }));
  }

  /** Places an icon on the work area (icons do not pan), or returns it to the flow with null. */
  icon(id, position) {
    const { desk, desks, icons } = this.state.value;
    const next = { ...icons };
    if (position === null) delete next[id];
    else if (Number.isFinite(position?.x) && Number.isFinite(position.y)) next[id] = Object.freeze({ x: Math.round(position.x), y: Math.round(position.y) });
    else throw new TypeError('icon needs finite x and y, or null');
    this.state.set(freeze({ desk, desks, icons: next }));
  }

  /** Returns every icon to the flow. */
  tidy() {
    const { desk, desks } = this.state.value;
    this.state.set(freeze({ desk, desks, icons: {} }));
  }

  snapshot() {
    const { desk, desks, icons } = this.state.value;
    return {
      version: 2,
      desk,
      icons: Object.fromEntries(Object.entries(icons).map(([id, { x, y }]) => [id, { x, y }])),
      desks: desks.map(({ windows, order, pan, peek }) => ({
        windows: windows.map(({ id, open, min, mode, shade, top, all, x, y, w, h }) => ({ id, open, min, mode, shade, top, all, x, y, w, h })),
        order: [...order],
        pan: { ...pan },
        peek: [...peek]
      }))
    };
  }

  /** Replaces the layout after validating all of it; an invalid snapshot changes nothing. */
  restore(snapshot) {
    const fail = reason => { throw new Error(`Invalid layout snapshot: ${reason}`); };
    const current = this.state.value;
    const point = value => Number.isFinite(value?.x) && Number.isFinite(value.y);
    if (snapshot?.version !== 2 || !Array.isArray(snapshot.desks) || typeof snapshot.icons !== 'object' || snapshot.icons === null) fail('unsupported shape');
    if (snapshot.desks.length !== current.desks.length) fail(`needs ${current.desks.length} desktops`);
    if (!Number.isInteger(snapshot.desk) || snapshot.desk < 0 || snapshot.desk >= snapshot.desks.length) fail('names a desktop that does not exist');
    if (!Object.values(snapshot.icons).every(point)) fail('malformed icon position');

    const desks = snapshot.desks.map((entry, index) => {
      if (!Array.isArray(entry?.windows) || !Array.isArray(entry.order) || !Array.isArray(entry.peek) || !point(entry.pan)) fail('malformed desktop');
      const saved = new Map();
      for (const win of entry.windows) {
        const place = value => value === null || Number.isFinite(value);
        const sound = typeof win?.id === 'string' && typeof win.open === 'boolean' && typeof win.min === 'boolean' && typeof win.shade === 'boolean'
          && MODES.includes(win.mode) && place(win.x) && place(win.y) && win.w > 0 && win.h > 0
          // Added later, so older layouts may leave them out.
          && [win.top, win.all].every(flag => flag === undefined || typeof flag === 'boolean');
        if (!sound) fail('malformed window');
        const known = this.window(win.id);
        if (win.open && !known.owner && (win.x === null || win.y === null)) fail(`open window "${win.id}" has no position`);
        if (known.owner && (win.min || win.mode !== 'normal')) fail(`tool window "${win.id}" cannot be minimized or tiled`);
        saved.set(win.id, win);
      }
      const open = [...saved.values()].filter(win => win.open).map(win => win.id);
      if (entry.order.length !== open.length || !open.every(id => entry.order.includes(id))) fail('order does not match the open windows');
      if (!entry.peek.every(id => saved.get(id)?.open)) fail('peek names a window that is not open');
      // Windows the snapshot never heard of (an app added since it was saved) keep their defaults, and an open one takes its place in the order.
      const unsaved = current.desks[index].windows.filter(win => !saved.has(win.id) && win.open).map(win => win.id);
      return {
        windows: current.desks[index].windows.map(win => {
          const { id, top = false, all = false, ...rest } = saved.get(win.id) ?? {};
          if (!id) return win;
          Object.assign(rest, win.owner ? { top: false, all: false } : { top, all });
          // A fixed-size window keeps the size its app declares now, whatever was saved.
          return win.resizable
            ? { ...win, ...rest, w: Math.max(win.minW, Math.round(rest.w)), h: Math.max(win.minH, Math.round(rest.h)) }
            : { ...win, ...rest, w: win.w, h: win.h };
        }),
        order: [...entry.order, ...unsaved],
        pan: { x: Math.round(entry.pan.x), y: Math.round(entry.pan.y) },
        peek: [...entry.peek]
      };
    });
    this.state.set(freeze({
      desk: snapshot.desk,
      desks,
      icons: Object.fromEntries(Object.entries(snapshot.icons).map(([id, { x, y }]) => [id, Object.freeze({ x: Math.round(x), y: Math.round(y) })]))
    }));
  }

  /** Applies `mutate` to a draft of the arrangement on screen. */
  #change(mutate) {
    const { desk, desks, icons } = this.state.value;
    const current = desks[desk];
    const draft = {
      windows: current.windows.map(win => ({ ...win })),
      order: [...current.order],
      pan: current.pan,
      peek: [...current.peek],
      window(id) {
        return this.windows.find(win => win.id === id);
      },
      /** To the front; raising a tool raises its owner's whole group. */
      raise(id) {
        const group = this.window(id).owner ?? id;
        const rest = this.order.filter(other => other !== id && other !== group);
        this.order = group === id ? [...rest, id] : [...rest, group, id];
      }
    };
    mutate(draft);
    const { windows, order, pan, peek } = draft;
    const open = id => windows.find(win => win.id === id).open;
    this.state.set(freeze({
      desk,
      icons,
      desks: desks.map((arrangement, index) => (index === desk ? { windows, order, pan, peek: peek.filter(open) } : arrangement))
    }));
  }
}
