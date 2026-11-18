import { Signal, DisposableScope, combineLatest, batch, persist } from '../core/reactive.js';
import { parseXml, escapeXml } from '../core/xml.js';
import { Bitmap, bayer } from '../gfx/bitmap.js';
import * as color from '../gfx/color.js';
import { PixelFont } from '../gfx/font.js';
import { Sprites } from '../gfx/sprites.js';
import { Theme } from '../gfx/theme.js';
import { Stage } from '../gfx/stage.js';
import { ease } from '../gfx/animator.js';
import { makePea, makeBall, seeded, PEA, PLUM } from '../gfx/art.js';
import { UI } from '../ui/ui.js';
import { parseAction, parseValue } from '../ui/markup.js';
import { readManifest } from './manifest.js';
import { DesktopModel } from './model.js';
import { App, parseApp } from './app.js';
import { Desktop } from './desktop.js';
import { readSettings, writeSettings, validMagnify } from './settings.js';
import { Splash } from './splash.js';
import { WALLPAPERS } from './wallpaper.js';
import { Window } from './window.js';
import { createDocumentStore } from './documents.js';
import { DialogService } from './dialogs.js';
import { Software } from './software.js';
import { Providers } from './providers.js';

/**
 * Pea OS boots from a platform object and nothing else:
 *
 *   platform = {
 *     PIXI,                       the Pixi namespace for this platform
 *     canvas,                     what Pixi renders into
 *     readText(path)   -> Promise<string>    a file named in manifest.xml
 *     importModule(path) -> Promise<module>  an app script
 *     storage: { get(key), set(key, text), remove(key) }   small synchronous
 *                 preferences; remove is optional
 *     attach(stage)    -> disposer           wires resize and input to the stage
 *     options: { boot, open, theme, pixel }  optional launch overrides
 *     reducedMotion, fullscreen(), report(error)   optional
 *     cursor(name)                           optional: show a CSS-named pointer shape
 *     download(name, text, type)             optional: hand the user a file
 *     pick(accept) -> Promise<{ name, text } | null>   optional: let the user choose one
 *     pickFiles(accept, { multiple }) -> Promise<[{ name, type, size, data }]>
 *                 optional: let the user choose files of any kind; data is a Blob or bytes
 *     providers: [provider]                  optional: what this platform gives
 *                 each service, such as files, sound and the internet
 *                 (see src/os/providers.js); Pea OS adds its built-in ones
 *     openUrl(url)                           optional: show a web page outside Pea OS
 *     tone(notes)                            optional: play [{ hz, ms }] as square-wave beeps
 *     name, capabilities: { webgpu }         optional: what the model router may use
 *   }
 */

const PIXELS = ['auto', 1, 2, 3, 4, 5, 6];
const ZOOMS = [1, 2, 3, 4];
const SHELL_ZOOMS = ['menubar', 'taskbar', 'icons', 'start', 'minimap', 'overview'];
const DESKS = 4;
const WINDOW_VERBS = ['open', 'close', 'minimize', 'maximize', 'restore', 'shade', 'left', 'right', 'here', 'top', 'all'];
const ARRANGEMENTS = ['gather', 'cascade', 'icons', 'home'];
const FILE_VERBS = ['new', 'open', 'open-dialog', 'save', 'save-as', 'import', 'export', 'undo', 'redo'];
const NO_ZOOMS = Object.freeze({});
const deskNumber = arg => (/^[1-9]\d*$/.test(arg ?? '') && Number(arg) <= DESKS ? Number(arg) - 1 : null);
const clockText = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export async function boot(platform) {
  const os = new Kernel(platform);
  try {
    await os.start();
  } catch (error) {
    os.dispose(); // a failed boot leaves no timers or listeners behind
    throw error;
  }
  return os;
}

export class Kernel {
  scope = new DisposableScope();
  /** Named system signals; views reach them as "{os.name}". */
  signals = new DisposableScope();
  /** System commands: name -> (argument, app | null) => void. */
  commands = new Map();
  /** App definitions by id. */
  apps = new Map();
  themes = new Map();
  /** What app scripts draw with. */
  gfx = { Bitmap, bayer, ease, makeBall, makePea, seeded, ...color };
  /** What app scripts read and write documents with. */
  xml = { parseXml, escapeXml };
  #running = new Map();
  #options = new Map();
  #data = new Map();

  constructor(platform) {
    this.platform = platform;
    this.scope.add(this.signals);
    /** The context for actions and bindings that belong to no app. */
    this.shell = {
      resolve: name => {
        if (!name.startsWith('os.')) throw new Error(`"${name}" is not a system signal; system signals start with "os."`);
        return this.signals.resolve(name.slice(3));
      }
    };
  }

  async start() {
    const { platform } = this;
    const options = platform.options ?? {};
    const read = async src => parseXml(await platform.readText(src), src);

    this.manifest = readManifest(await read('manifest.xml'));
    const load = (kind, make) => Promise.all(this.manifest.resources.filter(item => item.kind === kind).map(make));
    const [fonts, sheets, themes, [desktop], apps, data] = await Promise.all([
      load('font', async item => new PixelFont(await read(item.src))),
      load('sprites', item => read(item.src)),
      load('theme', async item => {
        const node = await read(item.src);
        const theme = new Theme(node);
        if (theme.id !== item.id) node.fail(`id="${theme.id}" does not match the manifest id "${item.id}"`);
        if (!WALLPAPERS.includes(theme.wallpaper)) node.fail(`wallpaper="${theme.wallpaper}" must be one of ${WALLPAPERS.join(', ')}`);
        return theme;
      }),
      load('desktop', item => read(item.src)),
      load('app', async item => parseApp(await read(item.src), item.id, item.script ? (await platform.importModule(item.script)).default ?? undefined : null)),
      load('data', async item => [item.id, { src: item.src, text: await platform.readText(item.src) }])
    ]);
    this.#data = new Map(data);
    for (const theme of themes) this.themes.set(theme.id, theme);
    for (const app of apps) {
      if (SHELL_ZOOMS.includes(app.id)) throw new Error(`An app cannot be called "${app.id}"; that name belongs to the shell`);
      this.apps.set(app.id, app);
    }

    const sprites = new Sprites();
    for (const sheet of sheets) sprites.add(sheet);
    for (const size of [9, 16, 32, 48]) sprites.define(`pea-${size}`, () => (size === 9 ? makeBall(4, PEA) : makePea(size)));
    sprites.define('plum-9', () => makeBall(4, PLUM));
    for (const app of apps) {
      if (!sprites.has(app.sprite)) throw new Error(`App "${app.id}" uses sprite "${app.sprite}", which no sprite sheet defines`);
    }

    this.#settings(options);
    this.providers = this.scope.add(new Providers(this, { catalog: this.data('software') }));
    /** The thinking service: one way to ask for a reply, whichever model answers. */
    this.ai = this.providers.thinking;
    // Documents are files, kept wherever the files service keeps them here.
    this.documents = this.scope.add(createDocumentStore(() => this.providers.files.route()));
    this.software = this.scope.add(new Software(this, this.data('software')));
    const theme = () => this.themes.get(this.signals.get('theme'));
    sprites.build(theme());

    this.stage = this.scope.add(await Stage.create(platform.PIXI, platform.canvas));
    this.ui = this.scope.add(new UI({ PIXI: platform.PIXI, stage: this.stage, font: fonts[0], sprites, theme: theme() }));
    this.dialogs = this.scope.add(new DialogService(this.ui));
    this.signals.subscribe('theme', () => {
      sprites.build(theme());
      this.ui.theme.set(theme());
    }, { immediate: false });
    this.signals.bind(this.ui.motion, 'motion', (motion, value) => motion.set(value));
    this.scope.subscribe(this.ui.cursor, name => platform.cursor?.(name));
    this.signals.effect(['pixel', 'smooth', 'scanlines'], (pixel, smooth, scanlines) => {
      this.stage.configure({ pixel, smooth, scanlines });
    });
    this.signals.signal('screen', combineLatest(this.stage.size, ({ w, h, pixel }) => (
      `${w}×${h} · ${Number.isInteger(pixel) ? pixel : pixel.toFixed(1)}px`
    ), { scope: this.signals }));

    this.#commands();
    // The model keeps frame sizes: an app declares its content, the chrome is added here.
    this.model = new DesktopModel(apps.flatMap(app => {
      const chrome = Window.chrome(false);
      const tools = Window.chrome(true);
      return [
        { id: app.id, title: app.title, resizable: app.resizable, w: app.width + chrome.w, h: app.height + chrome.h, minW: app.minWidth + chrome.w, minH: app.minHeight + chrome.h },
        ...app.tools.map(tool => ({ id: `${app.id}.${tool.id}`, title: tool.title, owner: app.id, open: tool.open, resizable: tool.resizable, w: tool.width + tools.w, h: tool.height + tools.h, minW: tool.minWidth + tools.w, minH: tool.minHeight + tools.h }))
      ];
    }), { desks: DESKS });
    this.signals.signal('desk', combineLatest(this.model.state, state => state.desk + 1, { scope: this.signals }));
    this.#layout();

    this.desktop = new Desktop(this.ui, this, desktop);
    this.ui.mount(this.desktop);
    this.scope.add(platform.attach(this.stage, this.ui, this));
    this.ui.flush(); // lay out once, so windows opened below are placed on a real screen

    for (const id of options.open ?? []) this.open(id);
    this.ready = this.providers.refresh().catch(error => this.report(error));
    if (options.boot !== false) this.#intro().catch(error => this.report(error));
  }

  /** The running instance of an app, started on first use and kept until shutdown. */
  app(id) {
    let app = this.#running.get(id);
    if (!app) {
      const definition = this.apps.get(id);
      if (!definition) throw new Error(`Unknown app "${id}". Apps: ${[...this.apps.keys()].join(', ')}`);
      app = this.scope.add(new App(this, definition));
      this.#running.set(id, app);
    }
    return app;
  }

  /** The view that goes inside a window: an app's own, or one of its tools'. */
  view(id) {
    const { owner } = this.model.window(id);
    return owner ? this.app(owner).tools.get(id.slice(owner.length + 1)) : this.app(id).view;
  }

  open(id) {
    const { owner } = this.model.window(id);
    this.app(owner ?? id);
    this.model.open(id, owner ? undefined : this.desktop.placement(id));
  }

  /** Opens a saved document in its editor, preserving that editor's unsaved work. */
  async openDocument(id) {
    const record = await this.documents.get(id);
    if (!record) throw new Error('This document is no longer available.');
    if (!this.apps.has(record.appId)) throw new Error('The application for this document is not installed.');
    this.open(record.appId);
    const app = this.app(record.appId);
    if (!app.files) throw new Error('This application cannot open saved documents.');
    return app.files.open(id);
  }

  /** Existing instance only; looking at shell state must not launch an application. */
  running(id) { return this.#running.get(id) ?? null; }

  async flushDocuments() {
    await Promise.all([...this.#running.values()].map(app => app.files?.flushRecovery?.()).filter(Boolean));
  }

  close(id) {
    this.model.close(id);
  }

  activate(id) {
    this.model.activate(id);
  }

  move(id, position) {
    this.model.move(id, position);
  }

  /** Why an action cannot run, or null. `extra` are command names an app adds. */
  check(action, extra = []) {
    const { name, arg } = parseAction(action);
    if (!this.commands.has(name)) return `no command "${name}". Commands: ${[...extra, ...this.commands.keys()].join(', ')}`;
    if (name === 'launch' && !this.apps.has(arg)) return `no app "${arg}". Apps: ${[...this.apps.keys()].join(', ')}`;
    if ((name === 'set' || name === 'toggle') && !arg) return `"${name}" needs a signal name`;
    if (name === 'window' && !WINDOW_VERBS.includes(arg)) return `"window" needs one of: ${WINDOW_VERBS.join(', ')}`;
    if (name === 'arrange' && !ARRANGEMENTS.includes(arg)) return `"arrange" needs one of: ${ARRANGEMENTS.join(', ')}`;
    if (name === 'file' && !FILE_VERBS.includes(arg)) return `"file" needs one of: ${FILE_VERBS.join(', ')}`;
    if (name === 'notes' && !['show', 'restore', 'export'].includes(arg)) return '"notes" needs show, restore or export';
    if (name === 'desk' && deskNumber(arg) === null && arg !== 'next' && arg !== 'previous') return `"desk" needs 1 to ${DESKS}, "next" or "previous"`;
    if (name === 'send' && deskNumber(arg) === null) return `"send" needs a desktop from 1 to ${DESKS}`;
    if (name === 'tool' && !this.apps.get((arg ?? '').split('.')[0])?.tools.some(tool => tool.id === arg.split('.')[1])) return `"tool" needs a tool window such as "paint.colors", got "${arg}"`;
    if (name === 'magnify') {
      const [target, zoom] = (arg ?? '').split('=');
      if (!this.zoomTargets.includes(target)) return `"magnify" needs "target=N"; targets: ${this.zoomTargets.join(', ')}`;
      if (!ZOOMS.includes(Number(zoom))) return `"magnify" needs a size from ${ZOOMS.join(', ')}`;
    }
    return null;
  }

  /**
   * Runs "name" or "name:argument" on behalf of an app, or of the shell.
   * `context.window` is the window a context menu was opened on, if any.
   */
  run(action, app = null, context = null) {
    const { name, arg } = parseAction(action);
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown command "${name}"`);
    const problem = this.check(action);
    if (problem) throw new Error(`Cannot run "${action}": ${problem}`);
    return command(arg, app, context);
  }

  /** Everything that can be magnified: each app's windows, and the parts of the shell. */
  get zoomTargets() {
    return [...SHELL_ZOOMS, ...this.apps.keys()];
  }

  /** The magnification of a target at the current pixel size. */
  zoomOf(target) {
    return this.signals.get('zooms')[target] ?? 1;
  }

  /** Magnifies a target at the current pixel size only; other pixel sizes keep their own. */
  setZoom(target, zoom) {
    if (!this.zoomTargets.includes(target)) throw new Error(`"${target}" cannot be magnified. Targets: ${this.zoomTargets.join(', ')}`);
    if (!ZOOMS.includes(zoom)) throw new RangeError(`Magnification must be one of ${ZOOMS.join(', ')}`);
    const realm = String(this.signals.get('pixel'));
    const { [realm]: table = {}, ...rest } = this.signals.get('magnify');
    const { [target]: _, ...others } = table;
    if (zoom !== 1) others[target] = zoom;
    this.signals.set('magnify', Object.keys(others).length ? { ...rest, [realm]: others } : rest);
  }

  /** A data resource from the manifest, parsed: <data id="..." src="..."/>. */
  data(id) {
    const entry = this.#data.get(id);
    if (!entry) throw new Error(`Unknown data resource "${id}". Known: ${[...this.#data.keys()].join(', ') || 'none'}`);
    return parseXml(entry.text, entry.src);
  }

  /** A data resource from the manifest as its original text, for documents that are read like files. */
  dataText(id) {
    const entry = this.#data.get(id);
    if (!entry) throw new Error(`Unknown data resource "${id}". Known: ${[...this.#data.keys()].join(', ') || 'none'}`);
    return entry.text;
  }

  /** Hands the user a file to keep. */
  download(name, text, type = 'application/xml') {
    if (!this.platform.download) throw new Error('This platform cannot save files yet');
    return this.platform.download(name, text, type);
  }

  /** Lets the user choose a file; resolves to { name, text }, or null when they change their mind. */
  async pick(accept = '.xml') {
    if (!this.platform.pick) throw new Error('This platform cannot open files yet');
    return this.platform.pick(accept);
  }

  /** Lets the user choose files of any kind: [{ name, type, size, data }], empty when they change their mind. */
  async pickFiles(accept = '', { multiple = false } = {}) {
    if (!this.platform.pickFiles) throw new Error('This platform cannot open files yet');
    return (await this.platform.pickFiles(accept, { multiple })) ?? [];
  }

  /**
   * One network request: { url, method, headers, body, signal, onText },
   * through `network`, or else whichever provider gives the internet here.
   * onText receives the body as it arrives, for streamed answers. Only http
   * and https addresses are allowed.
   */
  async request(options, network = null) {
    let url;
    try { url = new URL(String(options?.url ?? '')); } catch { throw new Error(`"${options?.url ?? ''}" is not a web address.`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be fetched.');
    network ??= await this.providers.network.route();
    return network.request({ ...options, url: url.href });
  }

  /**
   * Plays notes one after another on the platform's square-wave synth:
   * [{ hz, ms }], where hz 0 is a rest. Nothing plays while the sound
   * setting is off or on a platform without a synth.
   */
  play(notes) {
    if (!Array.isArray(notes) || !notes.length || notes.length > 32) throw new Error('play needs 1 to 32 notes');
    for (const note of notes) {
      const { hz, ms } = note ?? {};
      if (!(hz === 0 || (hz >= 20 && hz <= 12000)) || !(ms >= 1 && ms <= 2000)) throw new Error(`A note needs hz 0 or 20-12000 and ms 1-2000, got ${JSON.stringify(note)}`);
    }
    if (this.signals.get('sound')) this.platform.tone?.(notes.map(({ hz, ms }) => ({ hz, ms })));
  }

  /** Shows a web page outside Pea OS, where the platform can. */
  openUrl(url) {
    const address = new URL(String(url));
    if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error('Only http and https links can be opened.');
    if (!this.platform.openUrl) throw new Error('This platform cannot open web pages.');
    this.platform.openUrl(address.href);
  }

  #schema() {
    return { options: this.#options, realms: PIXELS, targets: this.zoomTargets, zooms: ZOOMS };
  }

  /** Every remembered preference as a settings.xml document. */
  settingsXml() {
    const values = Object.fromEntries([...this.#options].map(([name, { signal }]) => [name, signal.value]));
    return writeSettings({ release: this.manifest.release, values, magnify: this.signals.get('magnify') });
  }

  /** Applies a settings.xml document. It is validated in full first; a document with a mistake changes nothing. */
  applySettings(text, source = 'settings.xml') {
    const { values, magnify } = readSettings(parseXml(text, source), this.#schema());
    batch(() => {
      for (const [name, value] of Object.entries(values)) this.#options.get(name).signal.set(value);
      this.signals.set('magnify', magnify);
    });
  }

  report(error, { notify = true } = {}) {
    if (this.platform.report) this.platform.report(error);
    else console.error(error);
    // Reporting must not recursively fail while an application is still booting.
    if (notify && this.ui?.root && this.dialogs && !this.reporting) {
      this.reporting = true;
      Promise.resolve(this.dialogs.alert({ title: 'Pea OS', message: String(error?.message ?? error) }))
        .catch(() => {}).finally(() => { this.reporting = false; });
    }
  }

  dispose() {
    this.scope.dispose();
  }

  #settings(options) {
    const { signals, platform } = this;
    const themeIds = [...this.themes.keys()];
    // A setting is remembered between runs, unless a launch option pins it:
    // then it holds for this run only and the remembered value is left alone.
    const declare = (name, value, choices = null, pinned = undefined) => {
      const signal = signals.signal(name, value);
      this.#options.set(name, { signal, choices });
      const accept = choices ? candidate => choices.includes(candidate) : candidate => typeof candidate === 'boolean';
      if (pinned === undefined) {
        signals.add(persist(signal, { key: `pea-os.${name}`, storage: platform.storage, accept, onError: error => this.report(error) }));
      } else if (accept(pinned)) {
        signal.set(pinned);
      } else {
        throw new Error(`Launch option ${name}="${pinned}" is not valid. Choose one of: ${choices.join(', ')}`);
      }
    };

    declare('theme', themeIds[0], themeIds, options.theme);
    declare('pixel', 'auto', PIXELS, options.pixel);
    declare('smooth', false);
    declare('scanlines', false);
    declare('motion', !platform.reducedMotion);
    declare('sound', true);
    declare('taskbar', true);
    declare('panning', true);
    declare('snap', true);
    declare('magnets', true);
    declare('labels', true);
    declare('grid', true);
    declare('minimap', true);
    declare('minimap-top', true);

    // Magnification is kept per pixel size: what reads well at 1 is too big at 4.
    const magnify = signals.signal('magnify', NO_ZOOMS);
    signals.add(persist(magnify, {
      key: 'pea-os.magnify',
      storage: platform.storage,
      accept: value => validMagnify(value, this.#schema()),
      onError: error => this.report(error)
    }));
    signals.computed('zooms', ['pixel', 'magnify'], (pixel, table) => table[pixel] ?? NO_ZOOMS);
    signals.signal('pan-mode', false);
    signals.signal('keys', false);
    signals.signal('themes', [...this.themes.values()].map(theme => ({ value: theme.id, text: theme.name })));
    signals.signal('pixels', PIXELS.map(value => ({ value, text: value === 'auto' ? 'Auto' : String(value) })));
    signals.signal('release', this.manifest.release);

    const clock = signals.signal('clock', clockText(new Date()));
    const timer = setInterval(() => clock.set(clockText(new Date())), 1000);
    signals.add(() => clearInterval(timer));
  }

  #commands() {
    const target = (app, name) => (app ?? this.shell).resolve(name);
    this.commands.set('launch', id => this.open(id));
    this.commands.set('close', (_, app) => { if (app) this.close(app.id); });
    this.commands.set('set', (arg, app) => {
      const split = arg.indexOf('=');
      if (split < 0) throw new Error(`set needs "name=value", got "${arg}"`);
      target(app, arg.slice(0, split)).set(parseValue(arg.slice(split + 1)));
    });
    this.commands.set('toggle', (name, app) => {
      const signal = target(app, name);
      signal.set(!signal.value);
    });
    this.commands.set('fullscreen', () => this.platform.fullscreen?.());
    this.commands.set('start', () => this.desktop.openStart());
    this.commands.set('overview', () => this.desktop.openOverview());
    this.commands.set('switcher', () => this.desktop.openWindowSwitcher());
    this.commands.set('new-note', (arg, app, context) => this.desktop.newNote(context?.kind === 'desktop' ? context.at : null));
    this.commands.set('notes', verb => {
      const notes = this.desktop.notes;
      if (verb === 'show') return notes.showAll();
      if (verb === 'export') return this.download('sticky-notes.json', notes.export(), 'application/json');
      if (verb === 'restore') {
        const deleted = notes.state.value.notes.filter(note => note.deleted).at(-1);
        if (deleted) return notes.restore(deleted.id);
      }
    });
    this.commands.set('file', (verb, app, context) => {
      const id = context?.window ?? this.model.state.value.active;
      const owner = id && this.model.window(id).owner;
      const targetApp = app ?? this.running(owner ?? id);
      return targetApp?.files?.run(verb === 'open-dialog' ? 'open' : verb)?.catch?.(error => this.report(error));
    });

    const subject = context => {
      const id = context?.window ?? this.model.state.value.active;
      if (!id) throw new Error('There is no window to act on');
      return id;
    };
    this.commands.set('window', (verb, _, context) => {
      const { model, desktop } = this;
      const id = subject(context);
      const win = model.window(id);
      if (verb === 'open') this.open(id);
      else if (verb === 'close') this.close(id);
      else if (verb === 'minimize') model.minimize(id);
      else if (verb === 'maximize') desktop.windowBox(id, 'max');
      else if (verb === 'restore') model.mode(id, 'normal');
      else if (verb === 'shade') model.shade(id, !win.shade);
      else if (verb === 'here') desktop.bring(id);
      else if (verb === 'top' || verb === 'all') model.keep(win.owner ?? id, verb, !model.window(win.owner ?? id)[verb]);
      else model.mode(id, win.mode === verb ? 'normal' : verb);
    });
    this.commands.set('magnify', arg => {
      const [target, zoom] = arg.split('=');
      this.setZoom(target, Number(zoom));
    });
    this.commands.set('desk', arg => {
      const { desk, desks } = this.model.state.value;
      const step = arg === 'next' ? 1 : arg === 'previous' ? desks.length - 1 : null;
      this.model.desk(step === null ? deskNumber(arg) : (desk + step) % desks.length);
    });
    this.commands.set('tool', id => {
      if (this.model.window(id).open) this.close(id);
      else this.open(id);
    });
    this.commands.set('send', (arg, _, context) => this.model.send(subject(context), deskNumber(arg)));
    this.commands.set('arrange', verb => {
      if (verb === 'gather') this.desktop.gather();
      else if (verb === 'cascade') this.desktop.cascade();
      else if (verb === 'icons') this.model.tidy();
      else this.desktop.glide({ x: 0, y: 0 });
    });
    this.commands.set('show-desktop', () => this.model.peek());
    this.commands.set('save-settings', () => this.download('settings.xml', this.settingsXml()));
    this.commands.set('load-settings', () => {
      this.pick('.xml').then(file => file && this.applySettings(file.text, file.name)).catch(error => this.report(error));
    });
  }

  /** Window arrangement survives restarts; app content is never part of it. */
  #layout() {
    const layout = new Signal(this.model.snapshot());
    this.scope.add(persist(layout, {
      key: 'pea-os.layout',
      version: 2,
      storage: this.platform.storage,
      onError: error => this.report(error),
      accept: snapshot => {
        try {
          this.model.restore(snapshot);
          return true;
        } catch {
          return false;
        }
      }
    }));
    this.scope.subscribe(this.model.state, () => layout.set(this.model.snapshot()), { immediate: false });
  }

  async #intro() {
    const splash = this.desktop.add(new Splash(this.ui, { release: this.manifest.release }));
    this.ui.requestLayout();
    await splash.play();
    splash.dispose();
  }
}
