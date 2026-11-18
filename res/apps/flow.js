import { createDocumentController } from '../../src/os/document-controller.js';
import { Signal } from '../../src/core/reactive.js';
import { Label, Button } from '../../src/ui/controls.js';
import { Field } from '../../src/ui/fields.js';
import { Select } from '../../src/ui/lists.js';
import { curve, along, parseGraph, serializeGraph, ZOOMS, sizeOf, onGrip, drawGrip, resizing, defaultSize } from '../../src/ui/graph.js';

export { ZOOMS };

/**
 * Pea Flow: a little visual language. Nodes have input ports on the left and
 * output ports on the right; wires join an output to an input. A node that
 * fires sends an object down every wire from that port, and the object
 * travels there at a steady speed, so you can watch the program think.
 *
 * Objects are numbers (blue), text (yellow), yes (green), no (red) and
 * plain pulses (white). A program is an XML document:
 *
 *   <flow version="1">
 *     <node id="n1" type="clock" x="8" y="8"><set name="every" value="1"/></node>
 *     <node id="n2" type="counter" x="90" y="8"/>
 *     <wire from="n1.tick" to="n2.in"/>
 *   </flow>
 */

export const PULSE = Object.freeze({ pulse: true });
const NODE_W = 64;
const MIN_W = 40;
const LOG_KEEP = 50;         // lines a Log keeps; a taller Log shows more of them
const PLOT_KEEP = 160;       // numbers a Plot keeps; a wider Plot shows more of them
const HEAD = 12;
const PORT_ROW = 10;
const SPEED = 30;            // art pixels per second at speed 1
const MAX_OBJECTS = 300;
const MAX_NODES = 120;
const MAX_WIRES = 300;
const WHEEL_STEP = 40;       // wheel delta that makes one zoom step
const KIND_COLORS = { source: '#46b04a', transform: '#3f7fe0', sink: '#c74aa6' };
const OPS = { '+': (a, b) => a + b, '−': (a, b) => a - b, '×': (a, b) => a * b, '÷': (a, b) => (b === 0 ? NaN : a / b), mod: (a, b) => (b === 0 ? NaN : ((a % b) + b) % b), min: Math.min, max: Math.max };
const TESTS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b, '≥': (a, b) => a >= b, '≤': (a, b) => a <= b, '≠': (a, b) => a !== b };

const isPulse = value => value === PULSE;
const luminance = color => (color & 255) * 0.3 + ((color >>> 8) & 255) * 0.59 + ((color >>> 16) & 255) * 0.11;
/** The theme's ink or paper, whichever reads better on `face`. */
const readable = (theme, face) => {
  const [dark, light] = [theme.color('ink'), theme.color('paper')];
  return Math.abs(luminance(dark) - luminance(face)) >= Math.abs(luminance(light) - luminance(face)) ? dark : light;
};
const truthy = value => value === true || (typeof value === 'number' && value !== 0) || (typeof value === 'string' && value !== '') || isPulse(value);
const toNumber = value => (typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : isPulse(value) ? 1 : Number(value));

/** How an object is written on a node. */
export function show(value) {
  if (value === undefined) return '';
  if (isPulse(value)) return '•';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'not a number' : value > 0 ? '∞' : '-∞';
    return String(Math.round(value * 1000) / 1000);
  }
  return String(value);
}

const number = (label, value, min = -1e9, max = 1e9) => ({ type: 'number', label, value, min, max });
const text = (label, value) => ({ type: 'text', label, value });
const choice = (label, value, options) => ({ type: 'choice', label, value, options });

/**
 * Every node type. receive(node, port, value, emit) runs when an object
 * arrives; tick(node, seconds, emit) runs every frame while the program runs;
 * fire(node, emit) is a press of the node's own button or of Fire.
 */
export const TYPES = {
  clock: {
    title: 'Clock', kind: 'source', about: 'Sends a pulse every few seconds', inputs: [], outputs: ['tick'],
    params: { every: number('Every (s)', 1, 0.1, 60) },
    tick(node, seconds, emit) {
      node.state.elapsed = (node.state.elapsed ?? 0) + seconds;
      const every = node.params.every;
      if (node.state.elapsed >= every) { node.state.elapsed %= every; emit('tick', PULSE); }
    }
  },
  button: {
    title: 'Button', kind: 'source', about: 'Tap it to send a pulse', inputs: [], outputs: ['out'], body: 15,
    params: { label: text('Label', 'Press') },
    fire(node, emit) { emit('out', PULSE); }
  },
  number: {
    title: 'Number', kind: 'source', about: 'Sends its number when poked, and at Run', inputs: ['poke'], outputs: ['out'], body: 11,
    params: { value: number('Value', 1) },
    start(node, emit) { emit('out', node.params.value); },
    receive(node, port, value, emit) { emit('out', node.params.value); },
    fire(node, emit) { emit('out', node.params.value); },
    caption: node => show(node.params.value)
  },
  text: {
    title: 'Text', kind: 'source', about: 'Sends its text when poked, and at Run', inputs: ['poke'], outputs: ['out'], body: 11,
    params: { value: text('Text', 'hello') },
    start(node, emit) { emit('out', node.params.value); },
    receive(node, port, value, emit) { emit('out', node.params.value); },
    fire(node, emit) { emit('out', node.params.value); },
    caption: node => `“${node.params.value}”`
  },
  random: {
    title: 'Random', kind: 'source', about: 'A whole number between min and max, when poked', inputs: ['poke'], outputs: ['out'],
    params: { min: number('Min', 1), max: number('Max', 6) },
    receive(node, port, value, emit) {
      const [low, high] = [Math.ceil(Math.min(node.params.min, node.params.max)), Math.floor(Math.max(node.params.min, node.params.max))];
      emit('out', low + Math.floor(Math.random() * (high - low + 1)));
    }
  },
  counter: {
    title: 'Counter', kind: 'transform', about: 'Counts what arrives; reset sets it to zero', inputs: ['in', 'reset'], outputs: ['count'], body: 11,
    params: { step: number('Step', 1) },
    receive(node, port, value, emit) {
      node.state.count = port === 'reset' ? 0 : (node.state.count ?? 0) + node.params.step;
      emit('count', node.state.count);
    },
    caption: node => show(node.state.count ?? 0)
  },
  math: {
    title: 'Math', kind: 'transform', about: 'Works a number out', inputs: ['in'], outputs: ['out'], body: 11,
    params: { op: choice('Do', '×', Object.keys(OPS)), by: number('By', 2) },
    receive(node, port, value, emit) { emit('out', OPS[node.params.op](toNumber(value), node.params.by)); },
    caption: node => `${node.params.op} ${show(node.params.by)}`
  },
  compare: {
    title: 'Compare', kind: 'transform', about: 'Sends what arrives to yes or no', inputs: ['in'], outputs: ['yes', 'no'], body: 11,
    params: { test: choice('Is', '>', Object.keys(TESTS)), than: number('Than', 5) },
    receive(node, port, value, emit) {
      const a = typeof value === 'string' && Number.isNaN(Number(value)) ? value.length : toNumber(value);
      emit(TESTS[node.params.test](a, node.params.than) ? 'yes' : 'no', value);
    },
    caption: node => `${node.params.test} ${show(node.params.than)}`
  },
  toggle: {
    title: 'Toggle', kind: 'transform', about: 'Flips between yes and no', inputs: ['in'], outputs: ['out'],
    params: {},
    receive(node, port, value, emit) { node.state.on = !node.state.on; emit('out', node.state.on); }
  },
  delay: {
    title: 'Delay', kind: 'transform', about: 'Holds each object for a while', inputs: ['in'], outputs: ['out'], body: 11,
    params: { wait: number('Wait (s)', 1, 0, 60) },
    receive(node, port, value) { (node.state.held ??= []).push({ value, left: node.params.wait }); },
    tick(node, seconds, emit) {
      const held = node.state.held ?? [];
      for (const entry of held) entry.left -= seconds;
      while (held.length && held[0].left <= 0) emit('out', held.shift().value);
    },
    caption: node => `${show(node.params.wait)} s${node.state.held?.length ? ` · ${node.state.held.length}` : ''}`
  },
  format: {
    title: 'Format', kind: 'transform', about: 'Puts what arrives into text at {}', inputs: ['in'], outputs: ['out'], body: 11,
    params: { template: text('Text', 'tick {}') },
    receive(node, port, value, emit) { emit('out', node.params.template.split('{}').join(show(value))); },
    caption: node => node.params.template
  },
  display: {
    title: 'Display', kind: 'sink', about: 'Shows the last object', inputs: ['in'], outputs: [], body: 15,
    params: {},
    receive(node, port, value) { node.state.value = value; }
  },
  lamp: {
    title: 'Lamp', kind: 'sink', about: 'Yes lights it, no puts it out, anything else flashes', inputs: ['in'], outputs: [], body: 15,
    params: { color: choice('Color', 'yellow', ['yellow', 'red', 'green', 'blue', 'pink']) },
    receive(node, port, value) {
      if (typeof value === 'boolean') { node.state.on = value; node.state.flash = 0; }
      else node.state.flash = 0.35;
    },
    tick(node, seconds) { if (node.state.flash > 0) node.state.flash = Math.max(0, node.state.flash - seconds); }
  },
  log: {
    title: 'Log', kind: 'sink', about: 'Lists the last few objects', inputs: ['in'], outputs: [], body: 46,
    params: {},
    receive(node, port, value) { (node.state.lines ??= []).push(show(value)); if (node.state.lines.length > LOG_KEEP) node.state.lines.shift(); }
  },
  plot: {
    title: 'Plot', kind: 'sink', about: 'Draws numbers as a line', inputs: ['in'], outputs: [], body: 30,
    params: {},
    receive(node, port, value) {
      const n = toNumber(value);
      if (!Number.isFinite(n)) return;
      (node.state.points ??= []).push(n);
      if (node.state.points.length > PLOT_KEEP) node.state.points.shift();
    }
  }
};

const LAMP_COLORS = { yellow: '#ffd75e', red: '#e8475a', green: '#46b04a', blue: '#63d2f0', pink: '#c74aa6' };

/** A node's own size, before the user resizes it. */
function naturalSize(node) {
  const type = TYPES[node.type];
  const rows = Math.max(type.inputs.length, type.outputs.length, 1);
  return { w: NODE_W, h: HEAD + 3 + rows * PORT_ROW + (type.body ?? 0) + 2 };
}

/** A node's size: as the user made it, else its own; never smaller than its ports and a little of its body. */
export function nodeSize(node) {
  const natural = naturalSize(node);
  return sizeOf(node, natural, { w: MIN_W, h: natural.h - Math.max(0, (TYPES[node.type].body ?? 0) - 15) });
}

function portAt(node, port, output) {
  const type = TYPES[node.type];
  const list = output ? type.outputs : type.inputs;
  const index = list.indexOf(port);
  if (index < 0) return null;
  return { x: node.x + (output ? nodeSize(node).w : 0), y: node.y + HEAD + 3 + index * PORT_ROW + (PORT_ROW >> 1) };
}

/** Reads a flow document into { nodes, wires }. Names fail loudly, at their line. */
export function parseFlow(xml, text, source = 'flow') {
  return parseGraph(xml, text, { root: 'flow', name: source, types: TYPES, maxNodes: MAX_NODES, maxWires: MAX_WIRES });
}

export function serializeFlow(xml, program) {
  return serializeGraph(xml, program, { root: 'flow', types: TYPES });
}

const EXAMPLE = `<flow version="1">
  <node id="clock" type="clock" x="4" y="6"><set name="every" value="0.8"/></node>
  <node id="zero" type="button" x="4" y="62"><set name="label" value="Zero"/></node>
  <node id="count" type="counter" x="88" y="6"/>
  <node id="beat" type="toggle" x="88" y="122"/>
  <node id="big" type="compare" x="172" y="6"><set name="than" value="7"/></node>
  <node id="graph" type="plot" x="172" y="60"/>
  <node id="show" type="display" x="256" y="4"/>
  <node id="flash" type="lamp" x="256" y="52"><set name="color" value="red"/></node>
  <node id="heart" type="lamp" x="256" y="118"><set name="color" value="green"/></node>
  <wire from="clock.tick" to="count.in"/>
  <wire from="clock.tick" to="beat.in"/>
  <wire from="zero.out" to="count.reset"/>
  <wire from="beat.out" to="heart.in"/>
  <wire from="count.count" to="big.in"/>
  <wire from="count.count" to="graph.in"/>
  <wire from="count.count" to="show.in"/>
  <wire from="big.yes" to="count.reset"/>
  <wire from="big.yes" to="flash.in"/>
</flow>`;

/** Points along the wire's curve, for drawing, length and hit testing. */
export default function flow(app) {
  const { ui } = app.os;
  const { board, palette, inspector } = app.refs;
  const status = app.signal('status');
  const speed = app.signal('speed');

  let program = parseFlow(app.xml, EXAMPLE, 'example');
  let objects = [];           // { wire, t, value }
  let running = false;
  let selected = null;        // { node } | { wire }
  let view = { x: -4, y: -4 };
  let zoom = 1;
  let wheeled = 0;            // wheel delta not yet spent on a zoom step
  let world = null;           // the board drawn at 1x, when it is shown magnified
  let gesture = null;
  let glow = new Map();       // node -> seconds of glow left
  let puffs = [];             // { x, y, t } where an object fell off an unwired port
  let dirty = true;
  let inspectorScope = app.scope.child();
  let warned = false;

  palette.items = Object.entries(TYPES).map(([value, type]) => ({ value, text: type.title, detail: type.about }));

  // ---- Running ----------------------------------------------------------------

  function emitter(node) {
    return (port, value) => {
      glow.set(node, 0.18);
      const wires = program.wires.filter(wire => wire.from === node && wire.out === port);
      if (!wires.length) {
        const at = portAt(node, port, true);
        if (at) puffs.push({ ...at, t: 0 });
        return;
      }
      for (const wire of wires) {
        if (objects.length >= MAX_OBJECTS) {
          if (!warned) { status.set(`More than ${MAX_OBJECTS} objects in flight: new ones are dropped. A loop may be running away.`); warned = true; }
          return;
        }
        objects.push({ wire, t: 0, value });
      }
      dirty = true;
    };
  }

  function deliver(wire, value) {
    const type = TYPES[wire.to.type];
    glow.set(wire.to, 0.18);
    try { type.receive?.(wire.to, wire.in, value, emitter(wire.to)); }
    catch (error) { status.set(`${type.title}: ${error.message}`); }
  }

  function setRunning(on) {
    if (on === running) return;
    running = on;
    app.signal('run-label').set(running ? 'Pause' : 'Run');
    if (running && !program.started) {
      program.started = true;
      for (const node of program.nodes) TYPES[node.type].start?.(node, emitter(node));
    }
    status.set(running ? 'Running. Objects travel along the wires.' : 'Paused.');
    dirty = true;
  }

  function reset() {
    objects = [];
    puffs = [];
    glow = new Map();
    warned = false;
    program.started = false;
    for (const node of program.nodes) node.state = {};
    dirty = true;
  }

  function step(seconds) {
    if (running) {
      const pixels = SPEED * speed.value * seconds;
      const arrived = [];
      for (const object of objects) {
        const { length } = along(wirePoints(object.wire), 1);
        object.t += pixels / Math.max(8, length);
        if (object.t >= 1) arrived.push(object);
      }
      if (arrived.length) {
        objects = objects.filter(object => object.t < 1);
        for (const object of arrived) deliver(object.wire, object.value);
      }
      for (const node of program.nodes) TYPES[node.type].tick?.(node, seconds * Math.max(1, speed.value / 3), emitter(node));
      dirty = true;
    }
    for (const [node, left] of glow) {
      if (left - seconds <= 0) glow.delete(node); else glow.set(node, left - seconds);
      dirty = true;
    }
    if (puffs.length) {
      for (const puff of puffs) puff.t += seconds;
      puffs = puffs.filter(puff => puff.t < 0.4);
      dirty = true;
    }
  }

  // ---- Geometry ---------------------------------------------------------------

  const wireCache = new WeakMap();
  function wirePoints(wire) {
    const a = portAt(wire.from, wire.out, true);
    const b = portAt(wire.to, wire.in, false);
    const key = `${a.x},${a.y},${b.x},${b.y}`;
    const cached = wireCache.get(wire);
    if (cached?.key === key) return cached.points;
    const points = curve(a, b);
    wireCache.set(wire, { key, points });
    return points;
  }

  const toWorld = event => ({ x: event.x / zoom + view.x, y: event.y / zoom + view.y });
  /** Where a board point is on the canvas, for anything that drives the board from outside. */
  board.fromWorld = (x, y) => ({ x: (x - view.x) * zoom, y: (y - view.y) * zoom });

  /** Magnifies the board to `next`, keeping the board point under (cx, cy) on the canvas where it is. */
  function setZoom(next, cx = board.w / 2, cy = board.h / 2) {
    if (next === zoom || !ZOOMS.includes(next)) return;
    const anchor = { x: cx / zoom + view.x, y: cy / zoom + view.y };
    zoom = next;
    view = { x: Math.round(anchor.x - cx / zoom), y: Math.round(anchor.y - cy / zoom) };
    app.signal('zoom-label').set(`${Math.round(zoom * 100)}%`);
    dirty = true;
  }
  const zoomStep = (step, cx, cy) => setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + step))], cx, cy);
  board.magnifier = () => zoom;

  function nodeAt(point) {
    for (let i = program.nodes.length - 1; i >= 0; i--) {
      const node = program.nodes[i];
      const { w, h } = nodeSize(node);
      if (point.x >= node.x - 3 && point.x < node.x + w + 3 && point.y >= node.y && point.y < node.y + h) return node;
    }
    return null;
  }

  function portNear(point, output) {
    let best = null;
    for (const node of program.nodes) {
      for (const port of TYPES[node.type][output ? 'outputs' : 'inputs']) {
        const at = portAt(node, port, output);
        const distance = Math.hypot(at.x - point.x, at.y - point.y);
        if (distance <= 6 && (!best || distance < best.distance)) best = { node, port, distance };
      }
    }
    return best;
  }

  function wireNear(point) {
    let best = null;
    for (const wire of program.wires) {
      for (const p of wirePoints(wire)) {
        const distance = Math.hypot(p.x - point.x, p.y - point.y);
        if (distance <= 4 && (!best || distance < best.distance)) best = { wire, distance };
      }
    }
    return best?.wire ?? null;
  }

  function buttonRect(node) {
    const { w, h } = nodeSize(node);
    return { x: node.x + 6, y: node.y + h - 16, w: w - 12, h: 13 };
  }

  // ---- Painting ---------------------------------------------------------------

  function paint() {
    const screen = board.bitmap;
    if (!screen) return;
    dirty = false;
    // Magnified, the board is drawn at 1x into its own bitmap and scaled onto the canvas.
    let bitmap = screen;
    if (zoom !== 1) {
      const w = Math.ceil(screen.width / zoom);
      const h = Math.ceil(screen.height / zoom);
      if (world?.width !== w || world.height !== h) world = new app.gfx.Bitmap(w, h);
      bitmap = world;
    }
    const theme = app.theme.value;
    const { font, gfx } = app;
    const ink = theme.color('ink');
    const dim = theme.color('dim');
    const color = hex => theme.lock(gfx.parseColor(hex));
    bitmap.clear(theme.color('field'));
    // A quiet dot grid that pans with the board.
    const dot = theme.lock(gfx.mix(theme.color('field'), dim, 0.45));
    for (let y = ((-view.y % 12) + 12) % 12; y < bitmap.height; y += 12) {
      for (let x = ((-view.x % 12) + 12) % 12; x < bitmap.width; x += 12) bitmap.set(x, y, dot);
    }
    const sx = x => Math.round(x - view.x);
    const sy = y => Math.round(y - view.y);

    // Wires first, under the nodes.
    const drawCurve = (points, wireColor) => {
      for (let i = 1; i < points.length; i++) bitmap.line(sx(points[i - 1].x), sy(points[i - 1].y), sx(points[i].x), sy(points[i].y), wireColor);
    };
    for (const wire of program.wires) {
      const chosen = selected?.wire === wire;
      drawCurve(wirePoints(wire), chosen ? theme.color('accent') : dim);
    }
    if (gesture?.kind === 'wire') {
      const a = gesture.output ? portAt(gesture.node, gesture.port, true) : gesture.pointer;
      const b = gesture.output ? gesture.pointer : portAt(gesture.node, gesture.port, false);
      drawCurve(curve(a, b), theme.color('accent'));
    }

    // Nodes.
    for (const node of program.nodes) {
      const type = TYPES[node.type];
      const { w, h } = nodeSize(node);
      const x = sx(node.x);
      const y = sy(node.y);
      if (x > bitmap.width + 8 || y > bitmap.height + 8 || x + w < -8 || y + h < -8) continue;
      const head = color(KIND_COLORS[type.kind]);
      const hot = glow.has(node);
      if (theme.has('shadow')) bitmap.roundFill(x + 2, y + 2, w, h, 2, theme.color('shadow'));
      bitmap.roundFill(x, y, w, h, 2, theme.color('paper'));
      const face = hot ? theme.lock(gfx.lighten(head, 0.45)) : head;
      bitmap.roundFill(x, y, w, HEAD, 2, face);
      bitmap.fill(x, y + HEAD - 1, w, 1, ink);
      bitmap.roundFrame(x, y, w, h, 2, ink);
      if (selected?.node === node) bitmap.roundFrame(x - 1, y - 1, w + 2, h + 2, 3, theme.color('accent'));
      font.draw(bitmap, type.title, x + 4, y + 3, readable(theme, face), { bold: true });
      const label = (port, index, output) => {
        if (port === 'in' || port === 'out') return;
        const text = port;
        const py = y + HEAD + 3 + index * PORT_ROW + 1;
        font.draw(bitmap, text, output ? x + w - 5 - font.measure(text) : x + 5, py, dim);
      };
      type.inputs.forEach((port, index) => {
        const at = portAt(node, port, false);
        bitmap.fill(sx(at.x) - 2, sy(at.y) - 2, 5, 5, theme.color('panel'));
        bitmap.frame(sx(at.x) - 2, sy(at.y) - 2, 5, 5, ink);
        label(port, index, false);
      });
      type.outputs.forEach((port, index) => {
        const at = portAt(node, port, true);
        bitmap.fill(sx(at.x) - 2, sy(at.y) - 2, 5, 5, head);
        bitmap.frame(sx(at.x) - 2, sy(at.y) - 2, 5, 5, ink);
        label(port, index, true);
      });
      paintBody(bitmap, theme, node, x, y, w, h);
      drawGrip(bitmap, x, y, w, h, selected?.node === node ? theme.color('accent') : dim);
    }

    // Objects on their way, on top of everything.
    for (const object of objects) {
      const at = along(wirePoints(object.wire), Math.min(1, object.t));
      const value = object.value;
      const fill = isPulse(value) ? '#fbf7ea' : typeof value === 'boolean' ? (value ? '#46b04a' : '#e8475a') : typeof value === 'number' ? '#3f7fe0' : '#ffd75e';
      bitmap.disc(sx(at.x), sy(at.y), 3, ink);
      bitmap.disc(sx(at.x), sy(at.y), 2, color(fill));
      bitmap.set(sx(at.x) - 1, sy(at.y) - 1, theme.lock(gfx.lighten(color(fill), 0.6)));
    }
    for (const puff of puffs) {
      const r = 2 + Math.round(puff.t * 10);
      bitmap.frame(sx(puff.x) + r - 2, sy(puff.y) - 1, 2, 2, dim);
    }
    if (!program.nodes.length) font.draw(bitmap, 'Drag a node here from the list on the left.', 8, 8, dim);
    if (bitmap !== screen) {
      screen.clear();
      screen.blit(bitmap, 0, 0, { scale: zoom });
    }
    board.commit();
  }

  function paintBody(bitmap, theme, node, x, y, w, h) {
    const { font, gfx } = app;
    const type = TYPES[node.type];
    const ink = theme.color('ink');
    const rows = Math.max(type.inputs.length, type.outputs.length, 1);
    const top = y + HEAD + 3 + rows * PORT_ROW;
    const fit = (text, width) => {
      let value = text;
      while (value.length > 1 && font.measure(value) > width) value = `${value.slice(0, -2)}…`;
      return value;
    };
    // What a resize added to the node's own height goes to its screen, log or plot.
    const more = h - naturalSize(node).h;
    if (type.caption && node.type !== 'counter') font.draw(bitmap, fit(type.caption(node), w - 8), x + 4, top, theme.color('text'));
    if (node.type === 'counter') font.draw(bitmap, fit(type.caption(node), w - 8), x + 4, top, theme.color('text'), { bold: true });
    if (node.type === 'display') {
      bitmap.fill(x + 3, top - 1, w - 6, 14 + more, theme.color('field'));
      bitmap.frame(x + 3, top - 1, w - 6, 14 + more, ink);
      // A taller Display wraps a long object onto more lines.
      const room = Math.max(1, Math.floor((14 + more - 4) / 9));
      const lines = room > 1 ? font.wrap(show(node.state.value) || '—', w - 12, { bold: true }) : [show(node.state.value) || '—'];
      lines.slice(0, room).forEach((value, index) => font.draw(bitmap, fit(index === room - 1 && lines.length > room ? `${value}…` : value, w - 12), x + 6, top + 3 + index * 9, theme.color('field-ink'), { bold: true }));
    } else if (node.type === 'button') {
      const rect = buttonRect(node);
      const pressed = gesture?.kind === 'press' && gesture.node === node;
      const top2 = pressButton(bitmap, theme, x + 6, rect.y - node.y + y, w - 12, 13, pressed);
      const label = fit(node.params.label, w - 16);
      font.draw(bitmap, label, x + ((w - font.measure(label)) >> 1), rect.y - node.y + y + 3 + top2, theme.color('panel-ink'));
    } else if (node.type === 'lamp') {
      const lit = node.state.on || node.state.flash > 0;
      const base = theme.lock(gfx.parseColor(LAMP_COLORS[node.params.color]));
      // A larger Lamp is a larger bulb, in the middle of its body.
      const r = Math.max(3, Math.min(5 + (more >> 1), ((w - 6) >> 1) - 2));
      const cx = x + (w >> 1);
      const cy = top + 6 + (more >> 1);
      const shine = Math.max(2, Math.round(r * 0.4));
      if (lit) bitmap.disc(cx, cy, r + 2, theme.lock(gfx.mix(base, theme.color('paper'), 0.55)), { dither: true });
      bitmap.disc(cx, cy, r, ink);
      bitmap.disc(cx, cy, r - 1, lit ? base : theme.lock(gfx.darken(base, 0.6)));
      if (lit) bitmap.fill(cx - shine, cy - shine, shine, shine, theme.lock(gfx.lighten(base, 0.7)));
    } else if (node.type === 'log') {
      bitmap.fill(x + 3, top - 1, w - 6, 47 + more, theme.color('field'));
      bitmap.frame(x + 3, top - 1, w - 6, 47 + more, ink);
      // The newest lines that fit, oldest at the top.
      const room = Math.max(1, Math.floor((47 + more - 11) / 9) + 1);
      (node.state.lines ?? []).slice(-room).forEach((line, index) => font.draw(bitmap, fit(line, w - 12), x + 6, top + 2 + index * 9, theme.color('field-ink')));
    } else if (node.type === 'plot') {
      const px = x + 3;
      const pw = w - 6;
      const ph = 29 + more;
      bitmap.fill(px, top - 1, pw, ph, theme.color('field'));
      bitmap.frame(px, top - 1, pw, ph, ink);
      // About three numbers to every four pixels: the newest that fit the plot's width.
      const slots = Math.max(8, Math.min(PLOT_KEEP, Math.round((pw - 5) * 40 / 53)));
      const points = (node.state.points ?? []).slice(-slots);
      if (points.length > 1) {
        const low = Math.min(...points);
        const high = Math.max(...points);
        const span = high - low || 1;
        const at = (value, index) => ({ x: px + 2 + Math.round(index * (pw - 5) / (slots - 1)), y: top + ph - 5 - Math.round((value - low) / span * (ph - 7)) });
        for (let i = 1; i < points.length; i++) {
          const a = at(points[i - 1], i - 1 + slots - points.length);
          const b = at(points[i], i + slots - points.length);
          bitmap.line(a.x, a.y, b.x, b.y, theme.lock(gfx.parseColor('#3f7fe0')));
        }
      }
    }
  }

  function pressButton(bitmap, theme, x, y, w, h, pressed) {
    const base = theme.color('panel');
    const { gfx } = app;
    const top = pressed ? 1 : 0;
    bitmap.roundFill(x, y + top, w, h - top, 2, theme.lock(gfx.darken(base, 0.3)));
    bitmap.roundFill(x, y + top, w, h - top - (pressed ? 1 : 2), 2, base);
    bitmap.roundFrame(x, y + top, w, h - top, 2, theme.color('ink'));
    return top;
  }

  app.frame(({ dt }) => {
    step(Math.min(0.1, dt / 1000));
    if (dirty) paint();
  });
  app.scope.on(board.events, 'resize', () => { dirty = true; paint(); });
  app.scope.subscribe(app.theme, () => { dirty = true; }, { immediate: false });

  // ---- Editing ----------------------------------------------------------------

  const files = createDocumentController(app, {
    format: 'application/xml', extension: '.xml', accept: '.xml,application/xml,text/xml',
    create: () => ({ nodes: [], wires: [] }),
    parse: (text, source) => parseFlow(app.xml, text, source),
    serialize: () => serializeFlow(app.xml, program),
    install(value, { reset: fresh = false } = {}) {
      const keep = selected?.node?.id;
      program = value;
      objects = [];
      puffs = [];
      glow = new Map();
      selected = keep && !fresh ? (program.nodes.find(node => node.id === keep) ? { node: program.nodes.find(node => node.id === keep) } : null) : null;
      if (fresh) { setRunning(false); frame(); }
      inspect();
      dirty = true;
    }
  });
  const changed = coalesce => files.changed(coalesce ? { coalesce } : undefined);

  /** Brings the whole program into view. */
  function frame() {
    if (!program.nodes.length) { view = { x: -8, y: -8 }; return; }
    const left = Math.min(...program.nodes.map(node => node.x));
    const top = Math.min(...program.nodes.map(node => node.y));
    view = { x: left - 8, y: top - 6 };
  }

  function select(next) {
    selected = next;
    inspect();
    dirty = true;
  }

  function inspect() {
    inspectorScope.dispose();
    inspectorScope = app.scope.child();
    for (const child of inspector.children.slice(1)) child.dispose();
    const node = selected?.node;
    app.signal('has-selection').set(Boolean(selected));
    if (selected?.wire) {
      const { wire } = selected;
      app.signal('selection-title').set(`Wire: ${TYPES[wire.from.type].title} ${wire.out} → ${TYPES[wire.to.type].title} ${wire.in}`);
      return;
    }
    if (!node) {
      app.signal('selection-title').set(running ? 'Tap a node to change it.' : 'Drag from a port to wire nodes.');
      return;
    }
    const type = TYPES[node.type];
    app.signal('selection-title').set(type.title);
    for (const [name, spec] of Object.entries(type.params)) {
      inspector.add(new Label(ui, { text: spec.label, color: 'dim' }));
      const value = inspectorScope.add(new Signal(String(node.params[name])));
      const apply = () => {
        let next = value.value;
        if (spec.type === 'number') {
          const parsed = Number(next);
          if (next.trim() === '' || !Number.isFinite(parsed)) { status.set(`${spec.label} needs a number.`); return; }
          next = Math.min(spec.max, Math.max(spec.min, parsed));
        } else if (spec.type === 'text') next = next.slice(0, 200);
        if (node.params[name] === next) return;
        node.params[name] = next;
        status.set('');
        dirty = true;
        changed(`param:${node.id}:${name}`);
      };
      if (spec.type === 'choice') {
        inspector.add(new Select(ui, { value, items: spec.options.map(option => ({ value: option, text: option })), width: 46, label: spec.label, onChange: apply }));
      } else {
        inspector.add(new Field(ui, { value, width: spec.type === 'number' ? 40 : 76, maxlength: 200, label: spec.label, onChange: apply }));
      }
    }
    if (type.fire) inspector.add(new Button(ui, { text: 'Fire', onPress: () => fire(node) }));
  }

  function fire(node) {
    setRunning(true);
    TYPES[node.type].fire(node, emitter(node));
  }

  const nextId = type => {
    let n = 1;
    const taken = new Set(program.nodes.map(node => node.id));
    while (taken.has(`${type}${n}`)) n++;
    return `${type}${n}`;
  };

  function addNode(typeName, at = null) {
    const type = TYPES[typeName];
    if (!type) return;
    if (program.nodes.length >= MAX_NODES) { status.set(`A flow holds up to ${MAX_NODES} nodes.`); return; }
    const wanted = at ?? { x: view.x + Math.max(8, (board.w - NODE_W) >> 1), y: view.y + Math.max(8, (board.h - 40) >> 1) };
    const place = { x: Math.round(wanted.x / 2) * 2, y: Math.round(wanted.y / 2) * 2 };
    // Step aside from a node that is already exactly there.
    while (program.nodes.some(node => node.x === place.x && node.y === place.y)) { place.x += 10; place.y += 10; }
    const node = { id: nextId(typeName), type: typeName, x: place.x, y: place.y, params: Object.fromEntries(Object.entries(type.params).map(([name, spec]) => [name, spec.value])), state: {} };
    program.nodes.push(node);
    select({ node });
    changed();
    status.set(`${type.title} added. ${type.about}.`);
  }

  function remove() {
    if (selected?.node) {
      const { node } = selected;
      program.nodes = program.nodes.filter(candidate => candidate !== node);
      program.wires = program.wires.filter(wire => wire.from !== node && wire.to !== node);
      objects = objects.filter(object => program.wires.includes(object.wire));
      status.set(`${TYPES[node.type].title} deleted.`);
    } else if (selected?.wire) {
      program.wires = program.wires.filter(wire => wire !== selected.wire);
      objects = objects.filter(object => object.wire !== selected.wire);
      status.set('Wire deleted.');
    } else return;
    select(null);
    changed();
  }

  function connect(from, out, to, port) {
    if (from === to) { status.set('A node cannot wire to itself directly. Put a Delay between.'); return; }
    if (program.wires.some(wire => wire.from === from && wire.out === out && wire.to === to && wire.in === port)) return;
    if (program.wires.length >= MAX_WIRES) { status.set(`A flow holds up to ${MAX_WIRES} wires.`); return; }
    const wire = { from, out, to, in: port };
    program.wires.push(wire);
    select({ wire });
    changed();
    status.set(`Wired ${TYPES[from.type].title} ${out} to ${TYPES[to.type].title} ${port}.`);
  }

  app.scope.on(board.events, 'down', event => {
    const point = toWorld(event);
    const output = portNear(point, true);
    if (output) { gesture = { kind: 'wire', output: true, node: output.node, port: output.port, pointer: point }; dirty = true; return; }
    const input = portNear(point, false);
    if (input) {
      // Pulling a wire off an input picks it up again, to move or drop it.
      const attached = program.wires.findLast(wire => wire.to === input.node && wire.in === input.port);
      if (attached) {
        const index = program.wires.indexOf(attached);
        program.wires = program.wires.filter(wire => wire !== attached);
        objects = objects.filter(object => object.wire !== attached);
        gesture = { kind: 'wire', output: true, node: attached.from, port: attached.out, pointer: point, detached: attached, index };
      } else gesture = { kind: 'wire', output: false, node: input.node, port: input.port, pointer: point };
      dirty = true;
      return;
    }
    const gripped = program.nodes.findLast(candidate => onGrip(candidate, nodeSize(candidate), point));
    if (gripped) {
      program.nodes.push(...program.nodes.splice(program.nodes.indexOf(gripped), 1));
      gesture = { kind: 'size', grab: resizing.begin(gripped, point, nodeSize(gripped)) };
      select({ node: gripped });
      return;
    }
    const node = nodeAt(point);
    if (node) {
      program.nodes.push(...program.nodes.splice(program.nodes.indexOf(node), 1)); // to the front
      const rect = node.type === 'button' ? buttonRect(node) : null;
      if (rect && point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h) {
        gesture = { kind: 'press', node };
        select({ node });
        return;
      }
      gesture = { kind: 'move', node, dx: point.x - node.x, dy: point.y - node.y, from: { x: node.x, y: node.y } };
      select({ node });
      return;
    }
    const wire = wireNear(point);
    if (wire) { select({ wire }); return; }
    select(null);
    gesture = { kind: 'pan', x: event.x, y: event.y, view: { ...view } };
  });

  app.scope.on(board.events, 'move', event => {
    if (!gesture) return;
    const point = toWorld(event);
    if (gesture.kind === 'move') {
      gesture.node.x = Math.round((point.x - gesture.dx) / 2) * 2;
      gesture.node.y = Math.round((point.y - gesture.dy) / 2) * 2;
    } else if (gesture.kind === 'size') {
      resizing.move(gesture.grab, point, nodeSize);
    } else if (gesture.kind === 'pan') {
      view = { x: Math.round(gesture.view.x - (event.x - gesture.x) / zoom), y: Math.round(gesture.view.y - (event.y - gesture.y) / zoom) };
    } else if (gesture.kind === 'wire') {
      gesture.pointer = point;
    }
    dirty = true;
  });

  const finish = (event, cancelled) => {
    const done = gesture;
    gesture = null;
    dirty = true;
    if (!done) return;
    const point = event ? toWorld(event) : null;
    if (done.kind === 'move') {
      if (cancelled) Object.assign(done.node, done.from);
      else if (done.node.x !== done.from.x || done.node.y !== done.from.y) changed();
    } else if (done.kind === 'size') {
      if (resizing.end(done.grab, cancelled)) changed();
    } else if (done.kind === 'press') {
      if (!cancelled && event?.inside) fire(done.node);
    } else if (done.kind === 'wire') {
      const target = !cancelled && point ? portNear(point, !done.output) : null;
      const home = done.detached && (cancelled || (target && target.node === done.detached.to && target.port === done.detached.in));
      if (home) {
        // A cancelled pull, or one let go where it started, leaves the wire as it was: nothing to undo.
        program.wires.splice(done.index, 0, done.detached);
        dirty = true;
      } else if (target) {
        if (done.output) connect(done.node, done.port, target.node, target.port);
        else connect(target.node, target.port, done.node, done.port);
      } else if (done.detached) {
        select(null);
        changed();
        status.set('Wire removed.');
      }
    }
  };
  app.scope.on(board.events, 'up', event => finish(event, false));
  app.scope.on(board.events, 'cancel', event => finish(event, true));
  // The wheel zooms about the pointer; with Shift it scrolls instead.
  app.scope.on(board.events, 'wheel', event => {
    event.handled = true;
    if (event.shift) {
      view = { x: view.x + Math.round((event.dx || event.dy) / zoom), y: view.y + Math.round((event.dx ? event.dy : 0) / zoom) };
      dirty = true;
      return;
    }
    wheeled += event.dy;
    while (Math.abs(wheeled) >= WHEEL_STEP) {
      const step = wheeled > 0 ? -1 : 1;
      wheeled -= Math.sign(wheeled) * WHEEL_STEP;
      zoomStep(step, event.x, event.y);
    }
  });

  // Node types drag in from the list and land where they are let go.
  board.useDrop({
    accepts: payload => payload?.kind === 'node-type' && Boolean(TYPES[payload.value]),
    drop: (payload, event) => {
      const point = toWorld(event);
      addNode(payload.value, { x: point.x - (NODE_W >> 1), y: point.y - 6 });
    }
  });

  board.useCursor(event => {
    const point = toWorld(event);
    if (gesture?.kind === 'pan') return 'grabbing';
    if (portNear(point, true) || portNear(point, false)) return 'crosshair';
    if (program.nodes.some(node => onGrip(node, nodeSize(node), point))) return 'nwse-resize';
    const node = nodeAt(point);
    if (node) return node.type === 'button' ? 'pointer' : 'move';
    return wireNear(point) ? 'pointer' : 'grab';
  });

  board.useMenu(event => {
    const point = toWorld(event);
    const node = nodeAt(point);
    const wire = node ? null : wireNear(point);
    if (node) {
      select({ node });
      return app.menu([
        ...(TYPES[node.type].fire ? [{ text: 'Fire', icon: 'glyph-play', invoke: () => fire(node) }, { separator: true }] : []),
        { text: 'Duplicate', icon: 'glyph-copy', invoke: () => {
          const copy = { ...node, id: nextId(node.type), x: node.x + 12, y: node.y + 12, params: { ...node.params }, state: {} };
          program.nodes.push(copy);
          select({ node: copy });
          changed();
        } },
        { text: 'Default size', disabled: node.w === undefined && node.h === undefined, invoke: () => { if (defaultSize(node)) changed(); } },
        { text: 'Delete node', icon: 'glyph-bin', invoke: remove }
      ], event);
    }
    if (wire) {
      select({ wire });
      return app.menu([{ text: 'Delete wire', icon: 'glyph-bin', invoke: remove }], event);
    }
    const groups = ['source', 'transform', 'sink'];
    const icons = { source: 'glyph-play', transform: 'glyph-settings', sink: 'glyph-eye' };
    return app.menu(groups.flatMap((kind, index) => [
      ...(index ? [{ separator: true }] : []),
      ...Object.entries(TYPES).filter(([, type]) => type.kind === kind).map(([name, type]) => ({ text: `Add ${type.title}`, icon: icons[kind], invoke: () => addNode(name, { x: point.x - (NODE_W >> 1), y: point.y - 6 }) }))
    ]), event);
  });

  // ---- Commands ---------------------------------------------------------------

  app.command('run', () => setRunning(!running));
  app.command('reset', () => { reset(); status.set('Reset: every node starts again.'); });
  app.command('add-node', () => addNode(app.signal('node-type').value));
  app.command('delete', remove);
  app.command('zoom-in', () => zoomStep(1));
  app.command('zoom-out', () => zoomStep(-1));
  app.command('zoom-reset', () => setZoom(1));
  app.scope.on(app.keys, 'down', event => {
    if (event.key === 'Delete' || event.key === 'Backspace') remove();
    else if (event.key === 'F5') setRunning(!running);
    else if (event.key === 'Escape') select(null);
    else if (event.key === '+' || event.key === '=') zoomStep(1);
    else if (event.key === '-') zoomStep(-1);
    else if (event.key === '0') setZoom(1);
  });
  app.scope.subscribe(app.visible, visible => { if (!visible && running) setRunning(false); }, { immediate: false });

  frame();
  inspect();
  status.set('Press Run to start the example.');
}
