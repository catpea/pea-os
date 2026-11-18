import { Signal, EventEmitter, DisposableScope } from '../core/reactive.js';
import { parseColor } from '../gfx/color.js';
import { build, parseAction, parseValue, TAGS } from '../ui/markup.js';
import { SERVICES } from './providers.js';

/**
 * An app is one XML document: declared state and a view.
 *
 *   <app version="1" id="calc" title="Calculator" sprite="calc" tint="#ff9a3d" width="150" height="190"
 *        category="utility" summary="Sums, quickly">
 *     <state>
 *       <signal name="display" value="0"/>
 *     </state>
 *     <view>
 *       <column> ... </column>
 *     </view>
 *     <tool id="colors" title="Colors" width="40" height="90">   <!-- optional, any number -->
 *       <view> ... </view>
 *     </tool>
 *   </app>
 *
 * width and height are the content's size. A window can be resized down to
 * min-width and min-height, which default to the declared size; resize="false"
 * fixes it. category groups the app in menus and Start (create, organize,
 * connect, develop, play, utility or system); summary is one line about what it does.
 * Services (src/os/providers.js) are declared too: requires="media" names
 * those the app cannot work without, so it is installed only where they are
 * given; uses="network schedule" names those it is better with, so it runs
 * anyway and says plainly what is missing. The script reaches a declared
 * service through app.service(name), and no other.
 *
 * A <tool> is a small companion window that floats above the app's
 * own, follows it, and hides with it. Its view shares the app's state. A tool
 * resizes like a window, with the same width, height, min-width, min-height
 * and resize attributes.
 *
 * An optional script exports default function (app) {} and adds behavior:
 * commands for the view's actions, drawing, input. State is declared in XML
 * so that every "{binding}" can be checked before the app ever runs.
 */

/** Where an app is listed, in menu order, with the name shown for it. */
export const CATEGORIES = { create: 'Create', organize: 'Organize', connect: 'Connect', develop: 'Develop', play: 'Play', utility: 'Utilities', system: 'System' };

const SIGNAL_TYPES = {
  string: value => value,
  number: (value, node) => {
    const number = Number(value);
    if (value.trim() === '' || !Number.isFinite(number)) node.fail(`value="${value}" is not a number`);
    return number;
  },
  boolean: (value, node) => {
    if (value !== 'true' && value !== 'false') node.fail(`value="${value}" must be "true" or "false"`);
    return value === 'true';
  }
};

/** Validates an <app> document into a definition. `setup` is its script's default export, if any. */
export function parseApp(node, id, setup = null) {
  if (node.name !== 'app') node.fail('must be <app>');
  node.expect({ attrs: ['version', 'id', 'title', 'sprite', 'tint', 'width', 'height', 'min-width', 'min-height', 'resize', 'category', 'summary', 'requires', 'uses'], children: ['state', 'view', 'tool'] });
  if (node.need('id') !== id) node.fail(`id="${node.attr('id')}" does not match the manifest id "${id}"`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) node.fail(`id="${id}" must be lowercase letters, digits and "-"`);
  if (setup !== null && typeof setup !== 'function') node.fail('has a script without a default export function');

  const signals = (node.child('state')?.expect({ children: ['signal'] }).children ?? []).map(signal => {
    signal.expect({ attrs: ['name', 'value', 'type'] });
    const name = signal.need('name');
    if (!/^[A-Za-z][\w-]*$/.test(name)) signal.fail(`name="${name}" must start with a letter and use letters, digits, "-" or "_"`);
    const type = signal.attr('type', 'string');
    if (!(type in SIGNAL_TYPES)) signal.fail(`type="${type}" must be one of ${Object.keys(SIGNAL_TYPES).join(', ')}`);
    return { name, value: SIGNAL_TYPES[type](signal.attr('value', type === 'string' ? '' : type === 'number' ? '0' : 'false'), signal) };
  });

  const rootOf = owner => {
    const views = owner.all('view');
    if (views.length !== 1) owner.fail('needs exactly one <view>');
    const [view] = views;
    view.expect({ children: Object.keys(TAGS) });
    if (view.children.length !== 1) view.fail('needs exactly one root widget');
    return view.children[0];
  };

  const tools = node.all('tool').map(tool => {
    tool.expect({ attrs: ['id', 'title', 'width', 'height', 'min-width', 'min-height', 'resize', 'open'], children: ['view'] });
    const toolId = tool.need('id');
    if (!/^[a-z][a-z0-9-]*$/.test(toolId)) tool.fail(`id="${toolId}" must be lowercase letters, digits and "-"`);
    const width = tool.num('width', 48), height = tool.num('height', 96);
    return {
      id: toolId,
      title: tool.attr('title', toolId),
      width,
      height,
      minWidth: Math.min(tool.num('min-width', Infinity), width),
      minHeight: Math.min(tool.num('min-height', Infinity), height),
      resizable: tool.flag('resize', true),
      open: tool.flag('open', true),
      view: rootOf(tool)
    };
  });
  if (new Set(tools.map(tool => tool.id)).size !== tools.length) node.fail('has two tools with the same id');

  const tint = node.attr('tint', 'panel');
  if (tint.startsWith('#')) {
    try {
      parseColor(tint);
    } catch (error) {
      node.fail(error.message);
    }
  }

  const category = node.attr('category', 'utility');
  if (!(category in CATEGORIES)) node.fail(`category="${category}" must be one of ${Object.keys(CATEGORIES).join(', ')}`);

  const services = attr => {
    const names = node.attr(attr, '').split(/\s+/).filter(Boolean);
    for (const name of names) if (!(name in SERVICES)) node.fail(`${attr}="${name}" must name services from ${Object.keys(SERVICES).join(', ')}`);
    return names;
  };
  const requires = services('requires');
  const uses = services('uses');
  const both = requires.find(name => uses.includes(name));
  if (both) node.fail(`names "${both}" in both requires and uses; an app either cannot work without a service or can`);

  return {
    id,
    title: node.need('title'),
    category,
    requires,
    uses,
    summary: node.attr('summary', ''),
    sprite: node.need('sprite'),
    tint,
    width: node.num('width', 160),
    height: node.num('height', 120),
    minWidth: Math.min(node.num('min-width', Infinity), node.num('width', 160)),
    minHeight: Math.min(node.num('min-height', Infinity), node.num('height', 120)),
    resizable: node.flag('resize', true),
    signals,
    view: rootOf(node),
    tools,
    setup
  };
}

/**
 * A running app: its signals, commands, view and lifetime. This object is
 * also the context its view was built against, and what its script receives.
 */
export class App {
  scope = new DisposableScope();
  /** Widgets that have an id attribute. */
  refs = {};
  /** Every action="" in the view, kept for validation. */
  actions = [];
  /** 'down' | 'up' with { key } while this app's window is active. */
  keys = new EventEmitter();
  /** True while the window is on screen. Frame callbacks pause when it is false. */
  visible = new Signal(false);
  /** True while the window is open, even minimized, rolled up or on another desktop; false once it is closed. */
  open = new Signal(false);
  /** The views of this app's tool windows, by tool id. */
  tools = new Map();
  #commands = new Map();
  #services = new Map();

  constructor(os, definition) {
    this.os = os;
    this.id = definition.id;
    this.definition = definition;
    this.scope.add(this.keys);
    try {
      for (const { name, value } of definition.signals) this.scope.signal(name, value);
      this.view = build(os.ui, definition.view, this);
      this.scope.add(this.view);
      for (const tool of definition.tools) this.tools.set(tool.id, this.scope.add(build(os.ui, tool.view, this)));
      const cleanup = definition.setup?.(this);
      if (cleanup) this.scope.add(cleanup);
      for (const { action, node } of this.actions) {
        const problem = this.check(action);
        if (problem) node.fail(`action="${action}": ${problem}`);
      }
    } catch (error) {
      this.scope.dispose();
      throw error;
    }
  }

  get gfx() { return this.os.gfx; }
  get xml() { return this.os.xml; }
  get anim() { return this.os.ui.anim; }
  get motion() { return this.os.ui.motion; }

  /** A <data> resource from the manifest, parsed. */
  data(id) {
    return this.os.data(id);
  }

  /** Hands the user a file to keep. */
  download(name, text, type) {
    return this.os.download(name, text, type);
  }

  /** Lets the user choose a file; resolves to { name, text } or null. */
  pick(accept) {
    return this.os.pick(accept);
  }

  /** Lets the user choose files of any kind; see Kernel.pickFiles. */
  pickFiles(accept, options) {
    return this.os.pickFiles(accept, options);
  }

  /**
   * A service this app declares in its XML, as { name, title, ready, use(), why() }:
   *   ready   a Signal, true while something here gives the service
   *   use()   -> the provider to do the work with; fails with a sentence a
   *           person can read, such as "Pea Feeds can't reach the internet here. …"
   *   why()   -> that sentence, or '' while the service is ready
   */
  service(name) {
    let service = this.#services.get(name);
    if (service) return service;
    const { title, requires, uses } = this.definition;
    if (!requires.includes(name) && !uses.includes(name)) {
      throw new Error(`${title} uses the ${name} service without declaring it. Add it to requires or uses in its app XML.`);
    }
    const set = this.os.providers.service(name);
    const lacking = async () => `${title} can't ${SERVICES[name].can} here. ${await set.why()}`.trim();
    service = {
      name,
      title: set.title,
      ready: set.current.map(id => id !== null, { scope: this.scope }),
      async use() {
        try { return await set.route(); }
        catch { throw new Error(await lacking()); }
      },
      async why() { return (await set.find()) ? '' : lacking(); }
    };
    this.#services.set(name, service);
    return service;
  }

  /** The thinking service, for an app that declares it: one way to ask for a reply, whichever model answers (see src/ai/router.js). */
  get ai() {
    this.service('thinking');
    return this.os.ai;
  }

  /** A network request through the internet service, which the app must declare; see Kernel.request. */
  async request(options) {
    return this.os.request(options, await this.service('network').use());
  }

  /** Opens a popup menu where a pointer event happened: items are { text, invoke, icon, checked, disabled } or { separator: true }. */
  menu(items, event) {
    this.os.desktop.popupMenu(items, { x: event.gx, y: event.gy });
    return true;
  }

  /** Shows a web page outside Pea OS. */
  openUrl(url) {
    return this.os.openUrl(url);
  }

  report(error, options) {
    this.os.report(error, options);
  }
  get font() { return this.os.ui.font; }
  get sprites() { return this.os.ui.sprites; }
  get theme() { return this.os.ui.theme; }

  /** A declared signal by name; "os.name" reaches a system signal. */
  resolve(name) {
    return name.startsWith('os.') ? this.os.signals.resolve(name.slice(3)) : this.scope.resolve(name);
  }

  signal(name) {
    return this.resolve(name);
  }

  /** Registers a command the view can name in action="name" or action="name:argument". */
  command(name, fn) {
    if (this.#commands.has(name) || this.os.commands.has(name)) throw new Error(`Command "${name}" is already defined`);
    this.#commands.set(name, fn);
    return this;
  }

  /** Why an action cannot run, or null when it can. */
  check(action) {
    const { name } = parseAction(action);
    if (this.#commands.has(name)) return null;
    return this.os.check(action, [...this.#commands.keys()]);
  }

  run(action, widget) {
    const { name, arg } = parseAction(action);
    const command = this.#commands.get(name);
    if (command) return command(arg === undefined ? undefined : parseValue(arg), widget);
    return this.os.run(action, this);
  }

  /**
   * This app's document: one text, kept between runs. Window layout is saved
   * by the shell; what an app holds is saved here, by the app.
   */
  get document() {
    const { storage } = this.os.platform;
    const key = `pea-os.doc.${this.id}`;
    return { load: () => storage.get(key), save: text => storage.set(key, text) };
  }

  /** Returns a function that runs fn once, `ms` after it was last called. flush() runs a pending call now. */
  debounce(ms, fn) {
    let timer = null;
    const run = () => {
      timer = null;
      fn();
    };
    const call = () => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    call.flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    };
    this.scope.add(call.flush);
    return call;
  }

  /**
   * Calls fn({ dt, time }) every frame while the window is on screen, or with
   * { background: true } while it is open at all, for clocks that must not
   * stop when their window is minimized.
   */
  frame(fn, { background = false } = {}) {
    const running = background ? this.open : this.visible;
    return this.scope.on(this.os.stage.frame, 'tick', frame => {
      if (running.value) fn(frame);
    });
  }

  /** Plays notes on the system synth: [{ hz, ms }], hz 0 is a rest. Silent when sounds are off. */
  play(notes) {
    this.os.play(notes);
  }

  close() {
    this.os.close(this.id);
  }

  dispose() {
    this.scope.dispose();
  }
}
