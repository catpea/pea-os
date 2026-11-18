import { createDocumentController } from '../../src/os/document-controller.js';
import { Signal } from '../../src/core/reactive.js';
import { Label } from '../../src/ui/controls.js';
import { Field, TextArea } from '../../src/ui/fields.js';
import { Select } from '../../src/ui/lists.js';
import { curve, along, GraphView, sizeOf, onGrip, drawGrip, resizing, defaultSize } from '../../src/ui/graph.js';
import { TYPES, AgentRun, parseAgentFlow, serializeAgentFlow, parseTemplates, nameOf, cardOf, portsOf, MAX_NODES, MAX_WIRES } from '../../src/ai/flow.js';
import { parseFields } from '../../src/ai/form.js';
import { textOf, dataOf } from '../../src/ai/protocol.js';
import { SHAPES } from '../../src/ai/gofai.js';

/**
 * Agent Flow: build a team of agents on a board and watch them pass
 * messages. Agents think with a language model when one is set up, and with
 * Pea Mind, the rule-based thinker, when not, so every flow runs offline.
 * The runner and the node types live in src/ai/flow.js; this is the board.
 */

const NODE_W = 80;
const MIN_W = 48;
const HEAD = 12;
const PORT_ROW = 10;
const LINE = 9;
const SPEED = 110;        // envelope pixels per second
const THINK = 0.7;        // seconds a node at least looks busy, so a fast thinker can be seen
const KINDS = { io: '#46b04a', llm: '#8a5cd6', gofai: '#e8a33a', steer: '#3f7fe0' };
const BODY = { ask: 2, agent: 3, prompt: 3, router: 1, join: 1, check: 2, poet: 2, story: 3, song: 2, novel: 3, family: 2, grammar: 2, result: 5 };
const STATUS = { waiting: 'waiting', working: 'thinking', done: 'done', skipped: 'skipped', failed: 'failed' };
const STATUS_COLORS = { waiting: 'dim', working: '#ffd75e', done: '#46b04a', skipped: 'dim', failed: '#e8475a' };
const GROUP_ORDER = ['start', 'think', 'steer', 'make'];
const THINKERS = { auto: 'best thinker', 'pea-mind': 'Pea Mind', server: 'model server', 'browser-ai': 'browser AI' };

const luminance = color => (color & 255) * 0.3 + ((color >>> 8) & 255) * 0.59 + ((color >>> 16) & 255) * 0.11;
const readable = (theme, face) => {
  const [dark, light] = [theme.color('ink'), theme.color('paper')];
  return Math.abs(luminance(dark) - luminance(face)) >= Math.abs(luminance(light) - luminance(face)) ? dark : light;
};
const headColor = node => {
  const type = TYPES[node.type];
  if (type.group === 'steer') return KINDS.steer;
  return KINDS[cardOf(node).kind];
};

/** A node's size: as the user made it, else room for its ports and a few lines; never too small for its ports and one line. */
export function nodeSize(node) {
  const rows = Math.max(portsOf(node, 'inputs').length, portsOf(node, 'outputs').length, 1);
  const ports = HEAD + 3 + rows * PORT_ROW;
  return sizeOf(node, { w: NODE_W, h: ports + BODY[node.type] * LINE + 4 }, { w: MIN_W, h: ports + LINE + 4 });
}

function portAt(node, port, output) {
  const index = portsOf(node, output ? 'outputs' : 'inputs').indexOf(port);
  if (index < 0) return null;
  return { x: node.x + (output ? nodeSize(node).w : 0), y: node.y + HEAD + 3 + index * PORT_ROW + (PORT_ROW >> 1) };
}

const STARTER = `<agentflow version="1">
  <node id="ask" type="ask" x="8" y="20"/>
  <node id="poet" type="poet" x="104" y="0"><set name="form" value="haiku"/></node>
  <node id="writer" type="agent" x="104" y="64"><set name="name" value="Writer"/><set name="role" value="write"/></node>
  <node id="both" type="join" x="200" y="28"/>
  <node id="answer" type="result" x="296" y="20"/>
  <wire from="ask.out" to="poet.in"/>
  <wire from="ask.out" to="writer.in"/>
  <wire from="poet.out" to="both.in"/>
  <wire from="writer.out" to="both.in"/>
  <wire from="both.out" to="answer.in"/>
</agentflow>`;

export default function agents(app) {
  const { ui } = app.os;
  const { board, palette, inspector, messages } = app.refs;
  const status = app.signal('status');
  const output = app.signal('output');

  let program = parseAgentFlow(app.xml, STARTER, 'starter');
  let run = null;
  let envelopes = [];        // { wire, msg, t, wait }
  let log = [];              // { msg, to }
  let started = new Map();   // node -> time it began thinking
  let selected = null;       // { node } | { wire }
  let gesture = null;
  let dirty = true;
  let clock = 0;
  let inspectorScope = app.scope.child();
  let said = null;           // the inspector's "last said" text, while a node is selected
  const waiters = [];        // resolves for runFlow()

  const view = new GraphView(board, {
    Bitmap: app.gfx.Bitmap,
    onChange: ({ zoom }) => { app.signal('zoom-label').set(`${Math.round(zoom * 100)}%`); dirty = true; }
  });
  view.x = -8;
  view.y = -8;
  board.fromWorld = (x, y) => view.fromWorld(x, y);
  board.magnifier = () => view.zoom;

  const templates = parseTemplates(app.xml, app.os.dataText('agent-flows'));
  palette.items = Object.entries(TYPES)
    .sort(([, a], [, b]) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .map(([value, type]) => ({ value, text: type.title, detail: type.card.about }));

  // ---- Thinking with: the router's choice, kept current --------------------

  async function describeThinker() {
    try {
      const provider = await app.ai.route('auto');
      if (app.scope.disposed) return;
      app.signal('thinker').set(provider.id === 'pea-mind' ? 'Thinks with Pea Mind (offline)' : `Thinks with ${provider.title}`);
    } catch (error) { if (!app.scope.disposed) app.signal('thinker').set(error.message); }
  }
  app.scope.subscribe(app.ai.settings, () => describeThinker());

  // ---- Running ----------------------------------------------------------------

  const isSkip = msg => dataOf(msg)?.skip === true;

  function send(wire, msg) {
    const since = started.get(wire.from) ?? clock;
    envelopes.push({ wire, msg, t: isSkip(msg) ? 1 : 0, wait: isSkip(msg) ? 0 : Math.max(0, THINK - (clock - since)) });
    dirty = true;
  }

  function results() {
    const done = program.nodes.filter(node => node.type === 'result' && node.state.text);
    if (done.length === 1) return done[0].state.text;
    return done.map(node => `${nameOf(node)}\n\n${node.state.text}`).join('\n\n\n');
  }

  function start() {
    if (run && !run.done) { run.stop(); return; }
    envelopes = [];
    log = [];
    started = new Map();
    messages.items = [];
    output.set('');
    app.signal('has-output').set(false);
    describeThinker();
    run = new AgentRun(program, {
      ai: app.ai,
      title: app.signal('file-name').value,
      send,
      onMessage(msg, node, port) {
        const to = program.wires.filter(wire => wire.from === node && wire.out === port).map(wire => nameOf(wire.to));
        log.push({ msg, to, detail: textOf(msg).split('\n').find(Boolean) ?? '' });
        messages.items = log.map((entry, index) => ({ value: index, text: `${entry.msg.from} → ${entry.to.join(', ') || 'nobody'}`, detail: entry.detail }));
      },
      onChange(node) {
        if (node.state.status === 'working') started.set(node, clock);
        if (selected?.node === node && said) said.set(node.state.text ?? '');
        if (node.type === 'result' && node.state.status === 'done') {
          output.set(results());
          app.signal('has-output').set(true);
        }
        dirty = true;
      },
      onFinish(task, reason) {
        app.signal('run-label').set('Run');
        const sent = task.history.length;
        if (task.state === 'completed') {
          status.set(`Done. The agents sent ${sent} message${sent === 1 ? '' : 's'}.`);
          if (output.value) app.signal('page').set('output');
        } else status.set(reason);
        dirty = true;
        for (const resolve of waiters.splice(0)) resolve({ task, output: output.value });
      }
    });
    app.signal('run-label').set('Stop');
    status.set('Running. Watch the messages travel.');
    run.start();
  }

  function stop() {
    if (run && !run.done) run.stop();
    envelopes = [];
    dirty = true;
  }

  function step(seconds) {
    clock += seconds;
    if (!envelopes.length) {
      if (run && !run.done) dirty = true; // thinking dots
      return;
    }
    const arrived = [];
    for (const envelope of envelopes) {
      if (envelope.wait > 0) { envelope.wait -= seconds; continue; }
      if (envelope.t < 1) envelope.t += SPEED * seconds / Math.max(8, along(wirePoints(envelope.wire), 1).length);
      if (envelope.t >= 1) arrived.push(envelope);
    }
    envelopes = envelopes.filter(envelope => envelope.t < 1);
    for (const envelope of arrived) run?.deliver(envelope.wire, envelope.msg);
    dirty = true;
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
      for (const port of portsOf(node, output ? 'outputs' : 'inputs')) {
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

  // ---- Painting ---------------------------------------------------------------

  function paint() {
    if (!board.bitmap) return;
    dirty = false;
    const bitmap = view.begin();
    const theme = app.theme.value;
    const { font, gfx } = app;
    const ink = theme.color('ink');
    const dim = theme.color('dim');
    const color = hex => theme.lock(gfx.parseColor(hex));
    bitmap.clear(theme.color('field'));
    const dot = theme.lock(gfx.mix(theme.color('field'), dim, 0.45));
    for (let y = ((-view.y % 12) + 12) % 12; y < bitmap.height; y += 12) {
      for (let x = ((-view.x % 12) + 12) % 12; x < bitmap.width; x += 12) bitmap.set(x, y, dot);
    }
    const sx = x => Math.round(x - view.x);
    const sy = y => Math.round(y - view.y);
    const drawCurve = (points, wireColor, dashed = false) => {
      for (let i = 1; i < points.length; i++) {
        if (dashed && i % 2) continue;
        bitmap.line(sx(points[i - 1].x), sy(points[i - 1].y), sx(points[i].x), sy(points[i].y), wireColor);
      }
    };
    // Back wires, the ones that loop to an earlier node, are dashed.
    const back = run?.back ?? new Set();
    for (const wire of program.wires) drawCurve(wirePoints(wire), selected?.wire === wire ? theme.color('accent') : dim, back.has(wire) || wire.to.x <= wire.from.x);
    if (gesture?.kind === 'wire') {
      const a = gesture.output ? portAt(gesture.node, gesture.port, true) : gesture.pointer;
      const b = gesture.output ? gesture.pointer : portAt(gesture.node, gesture.port, false);
      drawCurve(curve(a, b), theme.color('accent'));
    }

    for (const node of program.nodes) {
      const type = TYPES[node.type];
      const { w, h } = nodeSize(node);
      const x = sx(node.x);
      const y = sy(node.y);
      if (x > bitmap.width + 8 || y > bitmap.height + 8 || x + w < -8 || y + h < -8) continue;
      const head = color(headColor(node));
      const busy = node.state.status === 'working' || envelopes.some(envelope => envelope.wire.from === node && envelope.wait > 0);
      if (theme.has('shadow')) bitmap.roundFill(x + 2, y + 2, w, h, 2, theme.color('shadow'));
      bitmap.roundFill(x, y, w, h, 2, theme.color('paper'));
      const face = busy ? theme.lock(gfx.lighten(head, 0.3 + 0.2 * Math.sin(clock * 8))) : head;
      bitmap.roundFill(x, y, w, HEAD, 2, face);
      bitmap.fill(x, y + HEAD - 1, w, 1, ink);
      bitmap.roundFrame(x, y, w, h, 2, ink);
      if (selected?.node === node) bitmap.roundFrame(x - 1, y - 1, w + 2, h + 2, 3, theme.color('accent'));
      font.draw(bitmap, fit(nameOf(node), w - 8), x + 4, y + 3, readable(theme, face), { bold: true });
      const inputs = portsOf(node, 'inputs');
      const outputs = portsOf(node, 'outputs');
      const label = (port, index, output) => {
        if (port === 'in' || port === 'out') return;
        const py = y + HEAD + 3 + index * PORT_ROW + 1;
        // A label has the row to itself when the other side has no port there; a wider node shows longer names.
        const alone = !(output ? inputs : outputs)[index] || (output ? inputs : outputs)[index] === (output ? 'in' : 'out');
        const shown = fit(port, alone ? w - 10 : (w >> 1) - 7);
        font.draw(bitmap, shown, output ? x + w - 5 - font.measure(shown) : x + 5, py, dim);
      };
      inputs.forEach((port, index) => {
        const at = portAt(node, port, false);
        bitmap.fill(sx(at.x) - 2, sy(at.y) - 2, 5, 5, theme.color('panel'));
        bitmap.frame(sx(at.x) - 2, sy(at.y) - 2, 5, 5, ink);
        label(port, index, false);
      });
      outputs.forEach((port, index) => {
        const at = portAt(node, port, true);
        bitmap.fill(sx(at.x) - 2, sy(at.y) - 2, 5, 5, head);
        bitmap.frame(sx(at.x) - 2, sy(at.y) - 2, 5, 5, ink);
        label(port, index, true);
      });
      paintBody(bitmap, theme, node, x, y, w, h, busy);
      drawGrip(bitmap, x, y, w, h, selected?.node === node ? theme.color('accent') : dim);
    }

    // Envelopes on their way, on top of everything.
    for (const envelope of envelopes) {
      if (envelope.wait > 0 || isSkip(envelope.msg)) continue;
      const at = along(wirePoints(envelope.wire), Math.min(1, envelope.t));
      const ex = sx(at.x) - 4;
      const ey = sy(at.y) - 3;
      bitmap.fill(ex, ey, 9, 7, theme.color('paper'));
      bitmap.frame(ex, ey, 9, 7, ink);
      bitmap.line(ex + 1, ey + 1, ex + 4, ey + 3, color(headColor(envelope.wire.from)));
      bitmap.line(ex + 7, ey + 1, ex + 4, ey + 3, color(headColor(envelope.wire.from)));
    }
    if (!program.nodes.length) font.draw(bitmap, 'Drag an agent here from the list, or pick a template.', 8, 8, dim);
    view.end(bitmap);
  }

  function fit(value, width) {
    const { font } = app;
    let text = String(value);
    while (text.length > 1 && font.measure(text) > width) text = `${text.slice(0, -2)}…`;
    return text;
  }

  /** What a node shows under its ports: how it is set up, how it is doing, what it last said. */
  function paintBody(bitmap, theme, node, x, y, w, h, busy) {
    const { font, gfx } = app;
    const type = TYPES[node.type];
    const rows = Math.max(portsOf(node, 'inputs').length, portsOf(node, 'outputs').length, 1);
    let top = y + HEAD + 3 + rows * PORT_ROW;
    const textColor = theme.color('text');
    const dim = theme.color('dim');
    const line = (value, colour = textColor) => { font.draw(bitmap, fit(value, w - 8), x + 4, top, colour); top += LINE; };
    const state = node.state.status;
    if (state && run) {
      const shown = busy ? 'working' : state;
      const tint = STATUS_COLORS[shown];
      const dotColor = tint === 'dim' ? dim : theme.lock(gfx.parseColor(tint));
      bitmap.disc(x + 6, top + 3, 2, dotColor);
      const dots = busy ? '.'.repeat(1 + (Math.floor(clock * 3) % 3)) : '';
      const by = node.state.by && shown === 'done' ? ` · ${node.state.by === 'pea-mind' ? 'Pea Mind' : 'model'}` : '';
      const round = node.type === 'check' && node.state.round ? ` · try ${node.state.round}` : '';
      const route = node.type === 'router' && node.state.chosen && shown === 'done' ? ` → ${node.state.chosen}` : '';
      font.draw(bitmap, fit(`${STATUS[shown]}${dots}${by}${round}${route}`, w - 14), x + 11, top, shown === 'failed' ? dotColor : dim);
      top += LINE;
    } else {
      line(caption(node), dim);
    }
    // The body fills whatever the node's size leaves, so a larger node shows more of what it said.
    const bottom = y + h - 3;
    const rest = Math.floor((bottom - top) / LINE);
    if (node.type === 'story' || node.type === 'novel') { shape(bitmap, theme, node, x + 4, top, w - 8, bottom - top - 1); return; }
    const text = node.state.status === 'failed' ? node.state.error : (node.state.text ?? (node.type === 'ask' ? node.params.text : ''));
    if (!text || rest <= 0) return;
    const lines = text.replace(/\n{3,}/g, '\n\n').split('\n').flatMap(paragraph => (paragraph.trim() ? font.wrap(paragraph, w - 8) : ['']));
    while (lines[0] === '') lines.shift();
    lines.slice(0, rest).forEach((value, index) => line(index === rest - 1 && lines.length > rest ? `${value}…` : value));
  }

  function caption(node) {
    const { params } = node;
    switch (node.type) {
      case 'agent': return `${params.role} · ${THINKERS[params.provider]}`;
      case 'prompt': return `fill-in · ${THINKERS[params.provider]}`;
      case 'poet': return params.form;
      case 'story': case 'novel': return SHAPES[params.shape].title;
      case 'check': return `${params['min-words']}+ words${params.must ? ` · ${params.must}` : ''}`;
      case 'router': return 'by words';
      case 'join': return 'waits for all';
      case 'result': return 'the answer';
      default: return TYPES[node.type].card.kind === 'gofai' ? 'Pea Mind' : '';
    }
  }

  /** A story shape: good fortune up, bad fortune down, as Vonnegut drew it on a blackboard. */
  function shape(bitmap, theme, node, x, y, w, h) {
    const { gfx } = app;
    bitmap.fill(x, y, w, h, theme.color('field'));
    bitmap.frame(x, y, w, h, theme.color('ink'));
    const mid = y + (h >> 1);
    for (let px = x + 2; px < x + w - 2; px += 2) bitmap.set(px, mid, theme.color('dim'));
    const points = node.state.points ?? SHAPES[node.params.shape].beats;
    const at = (point, index) => ({
      x: x + 2 + Math.round((point.t ?? index / Math.max(1, points.length - 1)) * (w - 5)),
      y: mid - Math.round(point.fortune * (h / 2 - 2))
    });
    const pen = theme.lock(gfx.parseColor(KINDS.gofai));
    for (let i = 1; i < points.length; i++) {
      const a = at(points[i - 1], i - 1);
      const b = at(points[i], i);
      bitmap.line(a.x, a.y, b.x, b.y, pen);
    }
  }

  app.frame(({ dt }) => {
    step(Math.min(0.1, dt / 1000));
    if (dirty) paint();
  });
  let framed = false;      // the first flow is framed once the board knows its size
  app.scope.on(board.events, 'resize', () => {
    if (!framed && board.w > 0) { framed = true; frame(); }
    dirty = true;
    paint();
  });
  app.scope.subscribe(app.theme, () => { dirty = true; }, { immediate: false });

  // ---- Documents --------------------------------------------------------------

  const files = createDocumentController(app, {
    format: 'application/xml', extension: '.xml', accept: '.xml,application/xml,text/xml',
    create: () => ({ nodes: [], wires: [] }),
    parse: (text, source) => parseAgentFlow(app.xml, text, source),
    serialize: () => serializeAgentFlow(app.xml, program),
    install(value, { reset: fresh = false } = {}) {
      stop();
      const keep = selected?.node?.id;
      program = value;
      const kept = keep && !fresh ? program.nodes.find(node => node.id === keep) : null;
      selected = kept ? { node: kept } : null;
      if (fresh) { run = null; frame(); }
      inspect();
      dirty = true;
    }
  });
  const changed = coalesce => {
    if (run && !run.done) { stop(); status.set('Stopped, because the flow changed.'); }
    files.changed(coalesce ? { coalesce } : undefined);
  };

  /** Shows the flow from its top left, at 2x when all of it fits so, else at 1x where text stays readable. */
  function frame() {
    if (!program.nodes.length) { view.zoom = 1; view.scrollTo(-8, -8); return; }
    const left = Math.min(...program.nodes.map(node => node.x));
    const top = Math.min(...program.nodes.map(node => node.y));
    const right = Math.max(...program.nodes.map(node => node.x + nodeSize(node).w));
    const bottom = Math.max(...program.nodes.map(node => node.y + nodeSize(node).h));
    const fits = zoom => (right - left + 16) * zoom <= (board.w || 300) && (bottom - top + 12) * zoom <= (board.h || 160);
    view.zoom = fits(2) ? 2 : 1;
    view.scrollTo(left - 8, top - 6);
  }

  async function chooseTemplate() {
    const groups = { make: 'Make', family: 'Family', team: 'Team' };
    const id = await app.os.dialogs.choose({
      title: 'Start from a template', message: 'Every template runs offline with Pea Mind. Agents use a model server when one is set up.', acceptLabel: 'Start',
      items: templates.map(template => ({ value: template.id, text: `${groups[template.group]}: ${template.title}`, detail: template.about }))
    });
    const template = templates.find(item => item.id === id);
    if (!template) return;
    const opened = await files.begin(parseAgentFlow(app.xml, template.element, template.title), { name: template.title });
    if (opened) {
      status.set(`${template.title}: ${template.about} Press Run.`);
      app.signal('page').set('node');
    }
  }

  function select(next) {
    selected = next;
    inspect();
    dirty = true;
  }

  function inspect() {
    inspectorScope.dispose();
    inspectorScope = app.scope.child();
    said = null;
    for (const child of inspector.children.slice(1)) child.dispose();
    const node = selected?.node;
    app.signal('has-selection').set(Boolean(selected));
    const help = text => inspector.add(new Label(ui, { text, color: 'dim', wrap: true }));
    if (selected?.wire) {
      const { wire } = selected;
      app.signal('selection-title').set(`Wire: ${nameOf(wire.from)} ${wire.out} → ${nameOf(wire.to)} ${wire.in}`);
      if (run?.back.has(wire)) help('This wire loops back, so it wakes its node again with feedback.');
      return;
    }
    if (!node) {
      app.signal('selection-title').set('Nothing selected');
      help('Drag agents from the list onto the board. Drag from an output (right) to an input (left) to wire them. Then press Run.');
      return;
    }
    const type = TYPES[node.type];
    const card = cardOf(node);
    app.signal('selection-title').set(`${nameOf(node)} (${type.title})`);
    help(`${type.card.about}. ${card.kind === 'llm' ? 'Thinks with a language model if one is set up, else with Pea Mind.' : card.kind === 'gofai' ? 'Rule-based: works offline.' : ''}`);
    for (const [name, spec] of Object.entries(type.params)) {
      inspector.add(new Label(ui, { text: spec.label, color: 'dim' }));
      const value = inspectorScope.add(new Signal(String(node.params[name])));
      const apply = () => {
        let next = value.value;
        if (spec.type === 'number') {
          const parsed = Number(next);
          if (next.trim() === '' || !Number.isFinite(parsed)) { status.set(`${spec.label} needs a number.`); return; }
          next = Math.min(spec.max, Math.max(spec.min, parsed));
        } else if (spec.type !== 'choice') next = next.slice(0, spec.type === 'long' ? 4000 : 200);
        if (node.params[name] === next) return;
        node.params[name] = next;
        status.set('');
        if (typeof type.inputs === 'function' || typeof type.outputs === 'function') reconnect(node);
        dirty = true;
        changed(`param:${node.id}:${name}`);
        if (name === 'name') app.signal('selection-title').set(`${nameOf(node)} (${type.title})`);
      };
      if (spec.type === 'choice') {
        const items = spec.options.map(option => ({ value: option, text: name === 'shape' ? SHAPES[option].title : option }));
        inspector.add(new Select(ui, { value, items, label: spec.label, onChange: apply }));
      } else if (spec.type === 'long') {
        inspector.add(new TextArea(ui, { value, height: 40, maxlength: 4000, label: spec.label, onChange: apply }));
      } else {
        inspector.add(new Field(ui, { value, width: spec.type === 'number' ? 40 : undefined, maxlength: 200, label: spec.label, onChange: apply }));
      }
    }
    if (node.type !== 'ask') {
      inspector.add(new Label(ui, { text: 'Last said', color: 'dim' }));
      said = inspectorScope.add(new Signal(node.state.text ?? ''));
      inspector.add(new TextArea(ui, { value: said, readonly: true, height: 48, label: `What ${nameOf(node)} last said` }));
    }
  }

  /**
   * A Prompt's ports follow its text: wires to a port that is gone are
   * dropped, and a mistake in the answer form is said at once.
   */
  function reconnect(node) {
    const inputs = portsOf(node, 'inputs');
    const outputs = portsOf(node, 'outputs');
    const before = program.wires.length;
    program.wires = program.wires.filter(wire => (wire.to !== node || inputs.includes(wire.in)) && (wire.from !== node || outputs.includes(wire.out)));
    if (selected?.wire && !program.wires.includes(selected.wire)) selected = null;
    const dropped = before - program.wires.length;
    try {
      if (node.type === 'prompt') parseFields(node.params.answer);
      status.set(dropped ? `${dropped} wire${dropped === 1 ? '' : 's'} removed: ${dropped === 1 ? 'its port is' : 'their ports are'} gone.` : `In: ${inputs.join(', ')}. Out: ${outputs.join(', ')}.`);
    } catch (error) { status.set(error.message); }
  }

  const nextId = typeName => {
    let n = 1;
    const taken = new Set(program.nodes.map(node => node.id));
    while (taken.has(`${typeName}${n}`)) n++;
    return `${typeName}${n}`;
  };

  function addNode(typeName, at = null) {
    const type = TYPES[typeName];
    if (!type) return;
    if (program.nodes.length >= MAX_NODES) { status.set(`A flow holds up to ${MAX_NODES} nodes.`); return; }
    const wanted = at ?? { x: view.x + Math.max(8, (board.w / view.zoom - NODE_W) / 2), y: view.y + Math.max(8, (board.h / view.zoom - 40) / 2) };
    const place = { x: Math.round(wanted.x / 2) * 2, y: Math.round(wanted.y / 2) * 2 };
    while (program.nodes.some(node => node.x === place.x && node.y === place.y)) { place.x += 10; place.y += 10; }
    const node = { id: nextId(typeName), type: typeName, x: place.x, y: place.y, params: Object.fromEntries(Object.entries(type.params).map(([name, spec]) => [name, spec.value])), state: {} };
    program.nodes.push(node);
    select({ node });
    changed();
    status.set(`${type.title} added. ${type.card.about}.`);
  }

  function remove() {
    if (selected?.node) {
      const { node } = selected;
      program.nodes = program.nodes.filter(candidate => candidate !== node);
      program.wires = program.wires.filter(wire => wire.from !== node && wire.to !== node);
      status.set(`${nameOf(node)} deleted.`);
    } else if (selected?.wire) {
      program.wires = program.wires.filter(wire => wire !== selected.wire);
      status.set('Wire deleted.');
    } else return;
    select(null);
    changed();
  }

  function connect(from, out, to, port) {
    if (from === to) { status.set('A node cannot wire to itself. Use a Check to send work back.'); return; }
    if (program.wires.some(wire => wire.from === from && wire.out === out && wire.to === to && wire.in === port)) return;
    if (program.wires.length >= MAX_WIRES) { status.set(`A flow holds up to ${MAX_WIRES} wires.`); return; }
    const wire = { from, out, to, in: port };
    program.wires.push(wire);
    select({ wire });
    changed();
    status.set(`${nameOf(from)} now talks to ${nameOf(to)}.`);
  }

  // ---- Pointer ----------------------------------------------------------------

  app.scope.on(board.events, 'down', event => {
    const point = view.toWorld(event);
    const output = portNear(point, true);
    if (output) { gesture = { kind: 'wire', output: true, node: output.node, port: output.port, pointer: point }; dirty = true; return; }
    const input = portNear(point, false);
    if (input) {
      const attached = program.wires.findLast(wire => wire.to === input.node && wire.in === input.port);
      if (attached) {
        const index = program.wires.indexOf(attached);
        program.wires = program.wires.filter(wire => wire !== attached);
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
      program.nodes.push(...program.nodes.splice(program.nodes.indexOf(node), 1));
      gesture = { kind: 'move', node, dx: point.x - node.x, dy: point.y - node.y, from: { x: node.x, y: node.y } };
      select({ node });
      app.signal('page').set('node');
      return;
    }
    const wire = wireNear(point);
    if (wire) { select({ wire }); return; }
    select(null);
    gesture = { kind: 'pan' };
    view.pan('down', event);
  });

  app.scope.on(board.events, 'move', event => {
    if (!gesture) return;
    const point = view.toWorld(event);
    if (gesture.kind === 'move') {
      gesture.node.x = Math.round((point.x - gesture.dx) / 2) * 2;
      gesture.node.y = Math.round((point.y - gesture.dy) / 2) * 2;
    } else if (gesture.kind === 'size') resizing.move(gesture.grab, point, nodeSize);
    else if (gesture.kind === 'pan') view.pan('move', event);
    else if (gesture.kind === 'wire') gesture.pointer = point;
    dirty = true;
  });

  const finish = (event, cancelled) => {
    const done = gesture;
    gesture = null;
    dirty = true;
    if (!done) return;
    const point = event ? view.toWorld(event) : null;
    if (done.kind === 'pan') view.pan('up', event);
    else if (done.kind === 'size') { if (resizing.end(done.grab, cancelled)) files.changed(); }
    else if (done.kind === 'move') {
      if (cancelled) Object.assign(done.node, done.from);
      else if (done.node.x !== done.from.x || done.node.y !== done.from.y) files.changed();
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
  app.scope.on(board.events, 'wheel', event => { event.handled = true; view.wheel(event); });

  board.useDrop({
    accepts: payload => payload?.kind === 'agent-node' && Boolean(TYPES[payload.value]),
    drop: (payload, event) => {
      const point = view.toWorld(event);
      addNode(payload.value, { x: point.x - (NODE_W >> 1), y: point.y - 6 });
    }
  });

  board.useCursor(event => {
    const point = view.toWorld(event);
    if (view.panning) return 'grabbing';
    if (portNear(point, true) || portNear(point, false)) return 'crosshair';
    if (program.nodes.some(node => onGrip(node, nodeSize(node), point))) return 'nwse-resize';
    if (nodeAt(point)) return 'move';
    return wireNear(point) ? 'pointer' : 'grab';
  });

  board.useMenu(event => {
    const point = view.toWorld(event);
    const node = nodeAt(point);
    const wire = node ? null : wireNear(point);
    if (node) {
      select({ node });
      return app.menu([
        { text: 'Duplicate', icon: 'glyph-copy', invoke: () => {
          const copy = { ...node, id: nextId(node.type), x: node.x + 12, y: node.y + 12, params: { ...node.params }, state: {} };
          program.nodes.push(copy);
          select({ node: copy });
          changed();
        } },
        { text: 'Default size', disabled: node.w === undefined && node.h === undefined, invoke: () => { if (defaultSize(node)) { dirty = true; files.changed(); } } },
        { text: 'Delete node', icon: 'glyph-bin', invoke: remove }
      ], event);
    }
    if (wire) {
      select({ wire });
      return app.menu([{ text: 'Delete wire', icon: 'glyph-bin', invoke: remove }], event);
    }
    return app.menu(GROUP_ORDER.flatMap((group, index) => [
      ...(index ? [{ separator: true }] : []),
      ...Object.entries(TYPES).filter(([, type]) => type.group === group).map(([name, type]) => ({ text: `Add ${type.title}`, invoke: () => addNode(name, { x: point.x - (NODE_W >> 1), y: point.y - 6 }) }))
    ]), event);
  });

  // ---- Commands ---------------------------------------------------------------

  app.command('run', start);
  app.command('templates', chooseTemplate);
  app.command('add-node', () => addNode(app.signal('node-type').value));
  app.command('delete', remove);
  app.command('zoom-in', () => view.step(1));
  app.command('zoom-out', () => view.step(-1));
  app.command('zoom-reset', () => view.setZoom(1));
  app.command('read-message', () => {
    const entry = log[messages.selectedItem?.value];
    if (entry) app.os.dialogs.alert({ title: `${entry.msg.from} → ${entry.to.join(', ') || 'nobody'}`, message: textOf(entry.msg).slice(0, 2000) });
  });
  app.command('to-notepad', async () => {
    try {
      app.os.open('notepad');
      const notepad = app.os.app('notepad');
      if (await notepad.files.run('new') === false) return;
      notepad.signal('content').set(output.value);
      notepad.files.changed();
    } catch (error) { app.report(error); }
  });
  app.command('to-sticky', () => {
    try {
      const note = app.os.desktop.newNote();
      app.os.desktop.notes.patch(note.id, { text: output.value.slice(0, 8000) });
    } catch (error) { app.report(error); }
  });
  app.scope.on(app.keys, 'down', event => {
    if (event.key === 'Delete' || event.key === 'Backspace') remove();
    else if (event.key === 'F5') start();
    else if (event.key === 'Escape') { if (run && !run.done) run.stop(); else select(null); }
    else if (event.key === '+' || event.key === '=') view.step(1);
    else if (event.key === '-') view.step(-1);
    else if (event.key === '0') view.setZoom(1);
  });
  app.scope.add(() => stop());

  frame();
  inspect();
  status.set('Press Run to try it, or Templates for more.');

  /** For tests and other programs: run the open flow and wait for it to finish. */
  board.runFlow = () => new Promise(resolve => {
    waiters.push(resolve);
    start();
  });
  board.templates = templates;
  board.loadTemplate = id => {
    const template = templates.find(item => item.id === id);
    return files.begin(parseAgentFlow(app.xml, template.element, template.title), { name: template.title });
  };
}
