import { Signal, EventEmitter } from '../core/reactive.js';
import { Bitmap } from './bitmap.js';
import { rgba } from './color.js';

/**
 * The only module that talks to Pixi.
 *
 * Pea OS draws into a low-resolution scene measured in art pixels. Each frame
 * the scene is rendered into a framebuffer of exactly that size, and the
 * framebuffer is scaled up to the display. One art pixel therefore covers
 * `pixel` device pixels everywhere, moving sprites snap to the art grid, and
 * "smooth" is a single filtering switch on the final upscale.
 *
 * Pixi is injected, never imported, so the same file runs against the browser
 * build, the NativeScript build and the headless compositor.
 */

const AUTO_SHORT = 200;  // auto pixel size keeps at least this many art pixels
const AUTO_LONG = 400;   // on the short and long screen sides
const AUTO_MAX = 4;      // CSS pixels per art pixel, at most, in auto mode
const MIN_SHORT = 160;   // no setting may leave fewer art pixels than this

export class Stage {
  /** 'tick' then 'paint', each with { dt, time } in milliseconds. */
  frame = new EventEmitter();
  /** 'down' | 'move' | 'up' | 'cancel' with { x, y } in art pixels. */
  pointer = new EventEmitter();
  /** 'down' | 'up' with { key }. */
  keys = new EventEmitter();
  /** { w, h } in art pixels and `pixel`, the device pixels per art pixel. */
  size = new Signal({ w: 1, h: 1, pixel: 1 });
  time = 0;

  #app;
  #target = null;
  #screen;
  #lines;
  #linesTexture = null;
  #device = { w: 1, h: 1, dpr: 1 };
  #mode = { pixel: 'auto', smooth: false, scanlines: false };

  static async create(PIXI, canvas) {
    const app = new PIXI.Application();
    await app.init({
      canvas,
      width: 1,
      height: 1,
      resolution: 1,
      autoDensity: false,
      antialias: false,
      backgroundColor: 0x000000,
      preference: 'webgl'
    });
    return new Stage(PIXI, app);
  }

  constructor(PIXI, app) {
    this.PIXI = PIXI;
    this.#app = app;
    this.scene = new PIXI.Container();
    this.#screen = new PIXI.Sprite();
    this.#lines = new PIXI.Sprite();
    this.#lines.visible = false;
    app.stage.addChild(this.#screen);
    app.stage.addChild(this.#lines);
    app.ticker.add(this.#tick);
    this.#apply();
  }

  #tick = ticker => {
    const dt = Math.min(50, ticker.deltaMS);
    this.time += dt;
    const frame = { dt, time: this.time };
    this.frame.emit('tick', frame);
    this.frame.emit('paint', frame);
    this.#app.renderer.render({ container: this.scene, target: this.#target, clear: true });
  };

  /** A texture that shows `bitmap`; call texture.source.update() after repainting. */
  texture(bitmap) {
    const source = new this.PIXI.BufferImageSource({
      resource: bitmap.data,
      width: bitmap.width,
      height: bitmap.height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'nearest'
    });
    return new this.PIXI.Texture({ source });
  }

  /** The platform reports the drawable size in device pixels. */
  resize(width, height, dpr = 1) {
    this.#device = { w: Math.max(1, Math.round(width)), h: Math.max(1, Math.round(height)), dpr };
    this.#apply();
  }

  /** pixel: 'auto' or CSS pixels per art pixel; smooth and scanlines are booleans. */
  configure(mode) {
    this.#mode = { ...this.#mode, ...mode };
    this.#apply();
  }

  /** Device pixels to art pixels. */
  toLogical(x, y) {
    const { pixel } = this.size.value;
    return { x: Math.floor(x / pixel), y: Math.floor(y / pixel) };
  }

  dispose() {
    this.#app.ticker.remove(this.#tick);
    this.#target?.destroy(true);
    this.#linesTexture?.destroy(true);
    this.frame.dispose();
    this.pointer.dispose();
    this.keys.dispose();
    this.#app.destroy();
  }

  #pixelSize() {
    const { w, h, dpr } = this.#device;
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    const { pixel, smooth } = this.#mode;
    const wanted = pixel === 'auto'
      ? Math.min(Math.floor(short / AUTO_SHORT), Math.floor(long / AUTO_LONG), Math.round(AUTO_MAX * dpr))
      : smooth ? pixel * dpr : Math.round(pixel * dpr);
    return Math.max(1, Math.min(wanted, Math.floor(short / MIN_SHORT)));
  }

  #apply() {
    const { PIXI } = this;
    const { w: deviceW, h: deviceH } = this.#device;
    const pixel = this.#pixelSize();
    const w = Math.ceil(deviceW / pixel);
    const h = Math.ceil(deviceH / pixel);

    this.#app.renderer.resize(deviceW, deviceH);
    if (!this.#target || this.#target.width !== w || this.#target.height !== h) {
      const previous = this.#target;
      this.#target = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1, antialias: false, scaleMode: 'nearest' });
      this.#screen.texture = this.#target;
      previous?.destroy(true);
    }
    this.#target.source.scaleMode = this.#mode.smooth ? 'linear' : 'nearest';
    this.#screen.scale.set(pixel);

    const rows = Math.round(pixel);
    this.#lines.visible = this.#mode.scanlines && rows >= 2;
    if (this.#lines.visible) {
      const bitmap = new Bitmap(1, deviceH);
      for (let y = rows - 1; y < deviceH; y += rows) bitmap.px[y] = rgba(0, 0, 0, 72);
      const previous = this.#linesTexture;
      this.#linesTexture = this.texture(bitmap);
      this.#lines.texture = this.#linesTexture;
      this.#lines.scale.set(deviceW, 1);
      previous?.destroy(true);
    }

    const current = this.size.value;
    if (current.w !== w || current.h !== h || current.pixel !== pixel) this.size.set({ w, h, pixel });
  }
}
