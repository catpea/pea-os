import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bitmap } from '../src/gfx/bitmap.js';
import { over } from '../src/gfx/color.js';
import { boot } from '../src/os/kernel.js';
import { Signal, EventEmitter } from '../src/core/reactive.js';
import { encodePng } from './png.mjs';

/**
 * A headless platform: Pea OS running in Node with no browser and no GPU.
 *
 * The engine uses a deliberately small part of Pixi (containers, sprites,
 * buffer textures, a ticker). This file implements that part in software, so
 * the real kernel, widgets and apps can be booted, driven and rendered to a
 * Bitmap for validation, tests and screenshots.
 */

class Point {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x, y = x) {
    this.x = x;
    this.y = y;
  }
}

class Container {
  children = [];
  parent = null;
  visible = true;
  alpha = 1;
  position = new Point();
  scale = new Point(1, 1);

  addChild(child) {
    return this.addChildAt(child, this.children.length);
  }

  addChildAt(child, index) {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return child;
  }

  destroy() {
    this.parent?.removeChild(this);
  }
}

class Sprite extends Container {
  constructor(texture = null) {
    super();
    this.texture = texture;
  }
}

class BufferImageSource {
  constructor({ resource, width, height, scaleMode }) {
    Object.assign(this, { resource, width, height, scaleMode });
  }

  update() {}
  destroy() {}
}

class Texture {
  constructor({ source }) {
    this.source = source;
  }

  get width() { return this.source.width; }
  get height() { return this.source.height; }
  destroy() {}
}

class RenderTexture {
  static create({ width, height, scaleMode }) {
    return new Texture({ source: { resource: null, width, height, scaleMode } });
  }
}

class Ticker {
  #listeners = new Set();
  deltaMS = 0;

  add(listener) { this.#listeners.add(listener); }
  remove(listener) { this.#listeners.delete(listener); }

  step(ms) {
    this.deltaMS = ms;
    for (const listener of [...this.#listeners]) listener(this);
  }
}

function createPixi() {
  const tickers = [];
  class Application {
    stage = new Container();
    ticker = new Ticker();
    renderer = { resize() {}, render() {} };

    async init() {
      tickers.push(this.ticker);
    }

    destroy() {}
  }
  return {
    PIXI: { Application, Container, Sprite, Texture, BufferImageSource, RenderTexture },
    step: ms => { for (const ticker of tickers) ticker.step(ms); }
  };
}

function drawTexture(target, source, x, y, sx, sy, alpha, clip) {
  const pixels = new Uint32Array(source.resource.buffer, source.resource.byteOffset, source.width * source.height);
  const x0 = Math.max(0, Math.round(x), clip?.x0 ?? 0);
  const y0 = Math.max(0, Math.round(y), clip?.y0 ?? 0);
  const x1 = Math.min(target.width, Math.round(x + source.width * sx), clip?.x1 ?? target.width);
  const y1 = Math.min(target.height, Math.round(y + source.height * sy), clip?.y1 ?? target.height);
  const fade = Math.round(alpha * 255);
  for (let py = y0; py < y1; py++) {
    const row = Math.min(source.height - 1, Math.floor((py - y) / sy)) * source.width;
    for (let px = x0; px < x1; px++) {
      let color = pixels[row + Math.min(source.width - 1, Math.floor((px - x) / sx))];
      if (fade < 255) {
        const part = shift => (((color >>> shift) & 255) * fade + 127) / 255 | 0;
        color = ((part(24) << 24) | (part(16) << 16) | (part(8) << 8) | part(0)) >>> 0;
      }
      const at = py * target.width + px;
      target.px[at] = over(target.px[at], color);
    }
  }
}

function composite(target, node, ox = 0, oy = 0, sx = 1, sy = 1, alpha = 1, clip = null) {
  if (!node.visible || node.peaClip || alpha * node.alpha <= 0) return;
  const x = ox + node.position.x * sx;
  const y = oy + node.position.y * sy;
  sx *= node.scale.x;
  sy *= node.scale.y;
  alpha *= node.alpha;
  if (node.mask?.peaClip) {
    const mask = node.mask;
    const left = Math.round(x + mask.position.x * sx);
    const top = Math.round(y + mask.position.y * sy);
    clip = { x0: Math.max(clip?.x0 ?? 0, left), y0: Math.max(clip?.y0 ?? 0, top), x1: Math.min(clip?.x1 ?? target.width, left + mask.scale.x * sx), y1: Math.min(clip?.y1 ?? target.height, top + mask.scale.y * sy) };
  }
  if (node.texture?.source.resource) drawTexture(target, node.texture.source, x, y, sx, sy, alpha, clip);
  for (const child of node.children) composite(target, child, x, y, sx, sy, alpha, clip);
}

/** Seconds of sound in a RIFF WAVE file, or null for anything else. */
export function wavSeconds(data) {
  if (!(data instanceof Uint8Array) || data.length < 44) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at, n) => String.fromCharCode(...data.subarray(at, at + n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= data.length;) {
    const id = text(at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') byteRate = view.getUint32(at + 16, true);
    if (id === 'data') return byteRate ? Math.min(size, data.length - at - 8) / byteRate : null;
    at += 8 + size + (size & 1);
  }
  return null;
}

/**
 * The test-audio provider: a player that keeps time on the frame clock and
 * makes no sound, so tests can play, seek and reach the end of a track.
 */
function testAudio() {
  let clock = 0;
  const players = new Set();
  const provider = {
    service: 'audio',
    id: 'test-audio',
    title: 'Test audio',
    kind: 'test',
    about: 'A pretend player for tests: it keeps time and makes no sound.',
    async status() { return { ok: true, reason: 'Keeps time without sound.' }; },
    player() {
      const state = new Signal({ status: 'empty', position: 0, at: clock, duration: 0, error: '' });
      const remote = new EventEmitter();
      let loading = null;
      const position = () => {
        const { status, position: at, at: since } = state.value;
        return status === 'playing' ? at + (clock - since) / 1000 : at;
      };
      const publish = patch => state.set({ ...state.value, position: position(), at: clock, ...patch });
      const api = {
        state, remote, volumeLevel: 1, url: '',
        now: () => clock,
        load({ url, data }) {
          api.url = url;
          const seconds = wavSeconds(data);
          loading = seconds === null ? { error: 'This could not be played: this player only understands WAV files.' } : { duration: seconds };
          state.set({ status: 'loading', position: 0, at: clock, duration: 0, error: '' });
        },
        play() { if (['paused', 'ended'].includes(state.value.status)) publish({ status: 'playing', ...(state.value.status === 'ended' ? { position: 0 } : {}) }); },
        pause() { if (state.value.status === 'playing') publish({ status: 'paused' }); },
        stop() { if (state.value.status !== 'empty') publish({ status: 'paused', position: 0 }); },
        seek(seconds) { publish({ position: Math.max(0, Math.min(state.value.duration, seconds)) }); },
        volume(level) { api.volumeLevel = level; },
        spectrum(out) {
          if (state.value.status !== 'playing') return false;
          for (let i = 0; i < out.length; i++) out[i] = Math.round(127 + 120 * Math.sin(i * 0.7 + clock / 90));
          return true;
        },
        tick() {
          if (loading) {
            const done = loading;
            loading = null;
            publish(done.error ? { status: 'error', error: done.error } : { status: 'paused', duration: done.duration });
          } else if (state.value.status === 'playing' && position() >= state.value.duration) {
            publish({ status: 'ended', position: state.value.duration });
          }
        },
        dispose() { players.delete(api); state.dispose(); remote.dispose(); }
      };
      players.add(api);
      return api;
    }
  };
  return { provider, players, step(ms) { clock += ms; for (const player of [...players]) player.tick(); } };
}

/** The internet, answered by a test's own request(). */
function testNetwork(request) {
  return {
    service: 'network',
    id: 'test-network',
    title: 'Test network',
    kind: 'test',
    about: 'Answers requests from the test that started Pea OS.',
    async status() { return { ok: true, reason: 'Answers from the test.' }; },
    request
  };
}

/**
 * Boots Pea OS from `root` on a virtual screen of width x height art pixels.
 * Returns the kernel plus ways to advance time, tap and render. Pass the same
 * `stored` Map to a second boot to simulate a restart.
 *
 * There is no internet here unless `request` supplies one: tests pass a fake
 * that answers like a network provider's request(), and `pos check` runs
 * offline. Files are kept with the preferences in `stored`, and sound comes
 * from a silent test player; `providers` adds more, such as
 * servedProviders() pointed at a real pos serve.
 */
export async function bootHeadless({ root, width = 320, height = 200, options = {}, stored = new Map(), files = [], request = null, capabilities = {}, languageModel, providers = [] }) {
  const pixi = createPixi();
  const audio = testAudio();
  const errors = [];
  /** Files the OS handed to the user: [{ name, text, type }]. */
  const downloads = [];
  /** Addresses the OS asked to open outside itself. */
  const opened = [];
  /** Every tune the OS played: [[{ hz, ms }], ...]. */
  const played = [];

  const os = await boot({
    name: 'headless',
    capabilities,
    languageModel,
    PIXI: pixi.PIXI,
    canvas: null,
    options: { boot: false, ...options },
    readText: path => readFile(join(root, path), 'utf8'),
    importModule: path => import(pathToFileURL(join(root, path)).href),
    storage: { get: key => stored.get(key) ?? null, set: (key, value) => stored.set(key, value), remove: key => stored.delete(key) },
    attach(stage) {
      stage.resize(width, height, 1);
      return () => {};
    },
    report: error => errors.push(error),
    download: (name, text, type) => downloads.push({ name, text, type }),
    exportBitmap: (name, bitmap) => downloads.push({ name, text: encodePng(bitmap), type: 'image/png' }),
    // `files` stands in for the user's choices in a file dialog, first come first served.
    pick: async () => files.shift() ?? null,
    // An entry may be one file or several: { name, type, data } with data as bytes.
    async pickFiles() {
      const next = files.shift();
      return next ? [].concat(next).map(file => {
        const data = file.data ?? new TextEncoder().encode(file.text ?? '');
        return { name: file.name, type: file.type ?? '', size: data.length, data };
      }) : [];
    },
    providers: [audio.provider, ...(request ? [testNetwork(request)] : []), ...providers],
    openUrl: url => opened.push(url),
    tone: notes => played.push(notes)
  });

  /** Runs `count` frames at 60 per second, letting promises settle between them. */
  const frames = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      audio.step(1000 / 60);
      pixi.step(1000 / 60);
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  return {
    os,
    errors,
    /** The test players made so far, to look at or to press their remote buttons. */
    players: audio.players,
    downloads,
    opened,
    played,
    frames,
    async tap(x, y, button = 0) {
      os.stage.pointer.emit('down', { x, y, button });
      await frames(2);
      os.stage.pointer.emit('up', { x, y, button });
      await frames(2);
    },
    /** Presses at one point, moves through the others, and lets go at the last. */
    async drag(points, extra = {}) {
      const [first, ...rest] = points;
      os.stage.pointer.emit('down', { x: first[0], y: first[1], ...extra });
      for (const [x, y] of rest) {
        os.stage.pointer.emit('move', { x, y, ...extra });
        await frames(1);
      }
      const [x, y] = points.at(-1);
      os.stage.pointer.emit('up', { x, y, ...extra });
      await frames(2);
    },
    render() {
      const { w, h } = os.stage.size.value;
      const screen = new Bitmap(w, h);
      composite(screen, os.stage.scene);
      return screen;
    },
    dispose: () => os.dispose()
  };
}
