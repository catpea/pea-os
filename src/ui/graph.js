/**
 * What node-and-wire editors share: wire curves, travelling along them, and
 * a view over a Canvas that pans and zooms about the pointer. Pea Flow and
 * Agent Flow both draw their boards with these.
 */

/** Board magnifications: a half for the whole picture, whole numbers for crisp pixels. */
export const ZOOMS = [0.5, 1, 2, 3];
const WHEEL_STEP = 40; // wheel delta that makes one zoom step

/** A wire from output a to input b: a cubic that leaves and arrives horizontally. */
export function curve(a, b, steps = 18) {
  const reach = Math.max(14, Math.abs(b.x - a.x) / 2);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push({
      x: u * u * u * a.x + 3 * u * u * t * (a.x + reach) + 3 * u * t * t * (b.x - reach) + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y
    });
  }
  return points;
}

/** The point a fraction t of the way along a polyline, and the polyline's length. */
export function along(points, t) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const target = t * lengths.at(-1);
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < target) i++;
  const span = lengths[i] - lengths[i - 1] || 1;
  const f = (target - lengths[i - 1]) / span;
  return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * f, y: points[i - 1].y + (points[i].y - points[i - 1].y) * f, length: lengths.at(-1) };
}

/**
 * The window onto a board: where it is scrolled (x, y in board pixels) and
 * how much it is magnified. Magnified, the board is drawn at 1x into a
 * bitmap of its own and scaled onto the canvas, so every zoom stays crisp.
 */
export class GraphView {
  x = 0;
  y = 0;
  zoom = 1;
  #wheeled = 0;
  #world = null;
  #grab = null;

  /** onChange(view) runs after every change, to repaint and show the zoom. */
  constructor(canvas, { Bitmap, onChange = () => {} }) {
    this.canvas = canvas;
    this.Bitmap = Bitmap;
    this.onChange = onChange;
  }

  toWorld(event) {
    return { x: event.x / this.zoom + this.x, y: event.y / this.zoom + this.y };
  }

  fromWorld(x, y) {
    return { x: (x - this.x) * this.zoom, y: (y - this.y) * this.zoom };
  }

  scrollTo(x, y) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.onChange(this);
  }

  /** Magnifies to `next`, keeping the board point under canvas point (cx, cy) where it is. */
  setZoom(next, cx = this.canvas.w / 2, cy = this.canvas.h / 2) {
    if (next === this.zoom || !ZOOMS.includes(next)) return;
    const anchor = { x: cx / this.zoom + this.x, y: cy / this.zoom + this.y };
    this.zoom = next;
    this.x = Math.round(anchor.x - cx / next);
    this.y = Math.round(anchor.y - cy / next);
    this.onChange(this);
  }

  step(steps, cx, cy) {
    const at = ZOOMS.indexOf(this.zoom);
    this.setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + steps))], cx, cy);
  }

  /** The wheel zooms about the pointer; with Shift it scrolls instead. */
  wheel(event) {
    if (event.shift) {
      this.scrollTo(this.x + (event.dx || event.dy) / this.zoom, this.y + (event.dx ? event.dy : 0) / this.zoom);
      return;
    }
    this.#wheeled += event.dy;
    while (Math.abs(this.#wheeled) >= WHEEL_STEP) {
      const step = this.#wheeled > 0 ? -1 : 1;
      this.#wheeled -= Math.sign(this.#wheeled) * WHEEL_STEP;
      this.step(step, event.x, event.y);
    }
  }

  /** A pan with the pointer: call with 'down', then 'move' events. */
  pan(type, event) {
    if (type === 'down') { this.#grab = { x: event.x, y: event.y, from: { x: this.x, y: this.y } }; return; }
    if (!this.#grab) return;
    if (type === 'move') this.scrollTo(this.#grab.from.x - (event.x - this.#grab.x) / this.zoom, this.#grab.from.y - (event.y - this.#grab.y) / this.zoom);
    else this.#grab = null;
  }

  get panning() {
    return Boolean(this.#grab);
  }

  /** The bitmap to draw the board into at 1x, with board point (x, y) at its origin. */
  begin() {
    const screen = this.canvas.bitmap;
    if (this.zoom === 1) return screen;
    const w = Math.ceil(screen.width / this.zoom);
    const h = Math.ceil(screen.height / this.zoom);
    if (this.#world?.width !== w || this.#world.height !== h) this.#world = new this.Bitmap(w, h);
    return this.#world;
  }

  /** Shows what was drawn since begin(). */
  end(bitmap) {
    const screen = this.canvas.bitmap;
    if (bitmap !== screen) {
      screen.clear();
      screen.blit(bitmap, 0, 0, { scale: this.zoom });
    }
    this.canvas.commit();
  }
}

/** The corner a node is resized by: this many board pixels, inside its bottom right. */
export const GRIP = 7;
/** The largest a node may be made; each board sets its own smallest. */
export const MAX_NODE = { w: 480, h: 480 };

/** Whether a board point is on a node's resize grip. */
export function onGrip(node, size, point) {
  return point.x >= node.x + size.w - GRIP && point.x < node.x + size.w + 2 && point.y >= node.y + size.h - GRIP && point.y < node.y + size.h + 2;
}

/** Three short diagonal ridges in a node's bottom right corner, as on a window's grow corner. */
export function drawGrip(bitmap, x, y, w, h, color) {
  for (let i = 0; i < 3; i++) {
    const d = 2 + i * 2;
    for (let j = 0; j <= d - 2; j++) bitmap.set(x + w - 2 - j, y + h - d + j, color);
  }
}

/**
 * A node's size: `node.w` and `node.h` when the user has resized it, else
 * the board's own size for it; never smaller than `least` (what its ports
 * and title need) nor larger than MAX_NODE.
 */
export function sizeOf(node, fallback, least) {
  return {
    w: Math.max(least.w, Math.min(MAX_NODE.w, node.w ?? fallback.w)),
    h: Math.max(least.h, Math.min(MAX_NODE.h, node.h ?? fallback.h))
  };
}

/**
 * A resize gesture on a node, shared by the boards. begin() keeps what the
 * node was; move() sizes it by the pointer's travel, in steps of 2 and within
 * what sizeOf (the board's nodeSize) allows; end() says whether it changed,
 * and on cancel puts it back. A node at its board's own size has no w or h.
 */
export const resizing = {
  begin: (node, point, size) => ({ node, x: point.x, y: point.y, size, from: { w: node.w, h: node.h } }),
  move(grab, point, sizeOf) {
    const wanted = { ...grab.node, w: Math.round((grab.size.w + point.x - grab.x) / 2) * 2, h: Math.round((grab.size.h + point.y - grab.y) / 2) * 2 };
    Object.assign(grab.node, sizeOf(wanted));
  },
  end(grab, cancelled) {
    const { node, from } = grab;
    if (cancelled) {
      for (const side of ['w', 'h']) { if (from[side] === undefined) delete node[side]; else node[side] = from[side]; }
      return false;
    }
    return node.w !== from.w || node.h !== from.h;
  }
};

/** Puts a node back to its board's own size. Returns whether it had another. */
export function defaultSize(node) {
  const had = node.w !== undefined || node.h !== undefined;
  delete node.w;
  delete node.h;
  return had;
}

/**
 * Reads a node-and-wire document, <root version="1"> holding <node> and
 * <wire> elements, against a table of node types: { title, inputs, outputs,
 * params: { name: { type, value, min, max, options } } }. inputs and outputs
 * are port names, or a function from a node's settings to port names. A setting's type is
 * 'number', 'choice', 'text' (up to 200 characters) or 'long' (up to 4000).
 * `source` is the document's text or its already-read root element.
 * A node may carry w and h, its size once the user has resized it.
 * Returns { nodes, wires }; mistakes fail at their line, naming what fits.
 */
export function parseGraph(xml, source, { root: rootName, types, name = rootName, maxNodes = 120, maxWires = 300 }) {
  const root = typeof source === 'string' ? xml.parseXml(source, name) : source;
  if (root.name !== rootName) root.fail(`must be <${rootName}>`);
  root.expect({ attrs: ['version'], children: ['node', 'wire'] });
  if (root.need('version') !== '1') root.fail(`version="${root.attr('version')}" is not supported`);
  const nodes = root.all('node').map(item => {
    item.expect({ attrs: ['id', 'type', 'x', 'y', 'w', 'h'], children: ['set'] });
    const id = item.need('id');
    if (!/^[\w-]{1,40}$/.test(id)) item.fail(`id="${id}" must be letters, digits, "-" or "_"`);
    const type = types[item.need('type')];
    if (!type) item.fail(`type="${item.attr('type')}" is not a node type. Types: ${Object.keys(types).join(', ')}`);
    const params = Object.fromEntries(Object.entries(type.params).map(([key, spec]) => [key, spec.value]));
    for (const set of item.all('set')) {
      set.expect({ attrs: ['name', 'value'] });
      const key = set.need('name');
      const spec = type.params[key];
      if (!spec) set.fail(`name="${key}" is not a setting of ${type.title}. Settings: ${Object.keys(type.params).join(', ') || 'none'}`);
      const raw = set.need('value');
      if (spec.type === 'number') {
        const value = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(value)) set.fail(`value="${raw}" is not a number`);
        params[key] = Math.min(spec.max, Math.max(spec.min, value));
      } else if (spec.type === 'choice') {
        if (!spec.options.includes(raw)) set.fail(`value="${raw}" must be one of ${spec.options.join(', ')}`);
        params[key] = raw;
      } else params[key] = raw.slice(0, spec.type === 'long' ? 4000 : 200);
    }
    const node = { id, type: item.attr('type'), x: Math.round(item.num('x', 0)), y: Math.round(item.num('y', 0)), params, state: {} };
    // A resized node keeps its size; the board makes sure it still fits its ports.
    for (const side of ['w', 'h']) {
      if (item.attr(side) === undefined) continue;
      const value = item.num(side, 0);
      if (!Number.isFinite(value) || value < 8) item.fail(`${side}="${item.attr(side)}" must be a size of at least 8`);
      node[side] = Math.min(MAX_NODE[side], Math.round(value));
    }
    return node;
  });
  if (nodes.length > maxNodes) root.fail(`has more than ${maxNodes} nodes`);
  const byId = new Map();
  for (const [index, node] of nodes.entries()) {
    if (byId.has(node.id)) root.all('node')[index].fail(`id="${node.id}" is used twice`);
    byId.set(node.id, node);
  }
  const wires = root.all('wire').map(item => {
    item.expect({ attrs: ['from', 'to'] });
    const end = (attr, output) => {
      const [id, port] = item.need(attr).split('.');
      const node = byId.get(id);
      if (!node) item.fail(`${attr}="${item.attr(attr)}" names no node`);
      const listed = types[node.type][output ? 'outputs' : 'inputs'];
      const ports = typeof listed === 'function' ? listed(node.params) : listed;
      if (!ports.includes(port)) item.fail(`${attr}="${item.attr(attr)}": ${types[node.type].title} has ${output ? 'outputs' : 'inputs'} ${ports.join(', ') || 'none'}`);
      return { node, port };
    };
    const from = end('from', true);
    const to = end('to', false);
    return { from: from.node, out: from.port, to: to.node, in: to.port };
  });
  if (wires.length > maxWires) root.fail(`has more than ${maxWires} wires`);
  return { nodes, wires };
}

/** Writes what parseGraph reads; settings left at their defaults are left out. */
export function serializeGraph({ escapeXml }, { nodes, wires }, { root, types }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${root} version="1">`];
  for (const node of nodes) {
    const sets = Object.entries(node.params).filter(([key, value]) => value !== types[node.type].params[key].value);
    const size = (node.w === undefined ? '' : ` w="${node.w}"`) + (node.h === undefined ? '' : ` h="${node.h}"`);
    const head = `  <node id="${escapeXml(node.id)}" type="${node.type}" x="${node.x}" y="${node.y}"${size}`;
    if (!sets.length) lines.push(`${head}/>`);
    else {
      lines.push(`${head}>`);
      for (const [key, value] of sets) lines.push(`    <set name="${key}" value="${escapeXml(value).replace(/\n/g, '&#10;')}"/>`);
      lines.push('  </node>');
    }
  }
  for (const wire of wires) lines.push(`  <wire from="${escapeXml(wire.from.id)}.${wire.out}" to="${escapeXml(wire.to.id)}.${wire.in}"/>`);
  lines.push(`</${root}>`, '');
  return lines.join('\n');
}
