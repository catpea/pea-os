import { DisposableScope } from '../core/reactive.js';
import { boot } from '../os/kernel.js';
import { attachTextInput } from './text-input.js';
import { servedProviders } from './served.js';
import { browserFiles } from './files.js';
import { webAudio } from './audio.js';
import { directNetwork } from './network.js';

/**
 * The browser platform: a <canvas>, fetch, localStorage and pointer events.
 * It works full-screen and embedded: the canvas simply fills whatever box the
 * page gives it, and Pea OS lays itself out for that size.
 *
 * Launch options come from the query string:
 *   ?theme=arcade&pixel=3&open=paint,calc&boot=0
 */

const root = new URL('../../', import.meta.url);
const query = new URLSearchParams(location.search);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// A phone or tablet: its system media player, not Web Audio, should carry the sound.
const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

function report(error) {
  console.error(error);
  // The development server prints client errors in its own terminal.
  if (local) navigator.sendBeacon?.(new URL('__pos/log', root), String(error?.stack ?? error));
}

function download(name, content, type = 'application/octet-stream') {
  const link = document.createElement('a');
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Only the platform adapter knows how a browser turns pixels into a file. */
async function exportBitmap(name, bitmap) {
  const surface = document.createElement('canvas');
  surface.width = bitmap.width;
  surface.height = bitmap.height;
  const context = surface.getContext('2d');
  if (!context) throw new Error('This browser cannot export a PNG image. Your editable document can still be saved or exported.');
  const data = context.createImageData(bitmap.width, bitmap.height);
  // Pea's internal surfaces are premultiplied; ImageData uses straight alpha.
  for (let i = 0; i < bitmap.data.length; i += 4) {
    const alpha = bitmap.data[i + 3];
    for (let channel = 0; channel < 3; channel++) data.data[i + channel] = alpha ? Math.min(255, Math.round(bitmap.data[i + channel] * 255 / alpha)) : 0;
    data.data[i + 3] = alpha;
  }
  context.putImageData(data, 0, 0);
  const blob = await new Promise((resolve, reject) => surface.toBlob(value => value ? resolve(value) : reject(new Error('The PNG image could not be encoded.')), 'image/png'));
  download(name, blob, 'image/png');
}

/**
 * A tiny square-wave synth on Web Audio. Browsers keep audio silent until the
 * user interacts with the page, so the first press or key unlocks it.
 */
const synth = {
  context: null,
  unlock() {
    const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContext) return null;
    synth.context ??= new AudioContext();
    if (synth.context.state === 'suspended') synth.context.resume().catch(() => {});
    return synth.context;
  },
  tone(notes) {
    const context = synth.unlock();
    if (!context) return;
    let at = context.currentTime + 0.01;
    for (const { hz, ms } of notes) {
      const end = at + ms / 1000;
      if (hz > 0) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = hz;
        // A short fade at both ends keeps the square wave from clicking.
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.06, at + 0.005);
        gain.gain.setValueAtTime(0.06, Math.max(at + 0.005, end - 0.015));
        gain.gain.linearRampToValueAtTime(0, end);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(end + 0.01);
      }
      at = end;
    }
  }
};

function attach(canvas, stage, ui, os) {
  const scope = new DisposableScope();
  const ratio = () => window.devicePixelRatio || 1;

  const measure = () => stage.resize(canvas.clientWidth * ratio(), canvas.clientHeight * ratio(), ratio());
  const observer = new ResizeObserver(measure);
  observer.observe(canvas);
  scope.add(() => observer.disconnect());
  measure();

  const point = type => event => {
    if (!event.isPrimary) return;
    const box = canvas.getBoundingClientRect();
    if (type === 'down') {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a convenience: a pointer the browser no longer tracks cannot be captured.
      }
    }
    const at = stage.toLogical((event.clientX - box.left) * ratio(), (event.clientY - box.top) * ratio());
    stage.pointer.emit(type, { ...at, button: Math.max(0, event.button), alt: event.altKey, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
    event.preventDefault();
  };
  scope.on(canvas, 'pointerdown', point('down'));
  scope.on(canvas, 'pointermove', point('move'));
  scope.on(canvas, 'pointerup', point('up'));
  scope.on(canvas, 'pointercancel', point('cancel'));
  scope.on(canvas, 'contextmenu', event => event.preventDefault());
  // The middle button pans the desktop; the browser's own autoscroll would fight it.
  scope.on(canvas, 'mousedown', event => { if (event.button === 1) event.preventDefault(); });
  const key = type => event => {
    if (event.target?.closest?.('[data-pea-text-input]')) return;
    if (!canvas.contains(document.activeElement) && document.activeElement !== canvas && document.activeElement !== document.body) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    // Keys Pea OS types with must not also scroll the page or leave it.
    if (plain && [' ', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
    if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'n', 'z', 'y', 'f'].includes(event.key.toLowerCase())) event.preventDefault();
    const routed = { key: event.key, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, repeat: event.repeat };
    stage.keys.emit(type, routed);
    if (routed.handled) event.preventDefault();
  };
  scope.on(window, 'pointerdown', synth.unlock, { capture: true });
  scope.on(window, 'keydown', synth.unlock, { capture: true });
  scope.on(window, 'keydown', key('down'));
  scope.on(window, 'keyup', key('up'));
  scope.on(canvas, 'wheel', event => {
    const box = canvas.getBoundingClientRect();
    const at = stage.toLogical((event.clientX - box.left) * ratio(), (event.clientY - box.top) * ratio());
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    ui.wheel({ ...at, dx: event.deltaX * unit * ratio() / stage.size.value.pixel, dy: event.deltaY * unit * ratio() / stage.size.value.pixel, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
    event.preventDefault();
  }, { passive: false });
  scope.add(attachTextInput(ui, canvas));
  const recover = () => os.flushDocuments().catch(report);
  scope.on(document, 'visibilitychange', () => { if (document.hidden) recover(); });
  scope.on(window, 'pagehide', recover);
  return scope;
}

export function start(canvas) {
  const pixel = query.get('pixel');
  const options = {
    boot: query.get('boot') !== '0',
    open: query.get('open')?.split(',').filter(Boolean) ?? []
  };
  if (query.has('theme')) options.theme = query.get('theme');
  if (pixel !== null) options.pixel = pixel === 'auto' ? pixel : Number(pixel);

  return boot({
    name: 'browser',
    // What the model router may use; WebGPU is what in-browser models such as WebLLM need.
    capabilities: { webgpu: Boolean(globalThis.navigator?.gpu) },
    languageModel: globalThis.LanguageModel, // the Prompt API, where the browser has one
    PIXI: globalThis.PIXI,
    canvas,
    options,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    report,
    async readText(path) {
      const response = await fetch(new URL(path, root));
      if (!response.ok) throw new Error(`Cannot load ${path}: HTTP ${response.status}`);
      return response.text();
    },
    importModule: path => import(new URL(path, root)),
    storage: {
      get(key) {
        try {
          return localStorage.getItem(key);
        } catch {
          return null; // storage can be blocked; preferences then last for the session
        }
      },
      set(key, value) {
        localStorage.setItem(key, value);
      },
      remove(key) {
        localStorage.removeItem(key);
      }
    },
    attach: (stage, ui, os) => attach(canvas, stage, ui, os),
    cursor(name) {
      // Pixi keeps the canvas's own cursor at "inherit", so the shape is set one level up.
      (canvas.parentElement ?? canvas).style.cursor = name;
    },
    // pos serve's disk, ffmpeg and relay where it served this page; browser storage, sound and direct requests everywhere.
    providers: [
      ...servedProviders(root),
      browserFiles(globalThis.indexedDB),
      directNetwork(globalThis.fetch?.bind(globalThis)),
      webAudio({
        createAudio: () => document.createElement('audio'),
        AudioContext: globalThis.AudioContext ?? globalThis.webkitAudioContext,
        mediaSession: navigator.mediaSession,
        audioSession: navigator.audioSession,
        mobile
      })
    ],
    pickFiles(accept, { multiple = false } = {}) {
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.addEventListener('cancel', () => resolve([]));
        input.addEventListener('change', () => resolve([...input.files].map(file => ({ name: file.name, type: file.type, size: file.size, data: file }))));
        input.click();
      });
    },
    download,
    exportBitmap,
    tone: synth.tone,
    openUrl(url) {
      // A new tab that cannot reach back into Pea OS.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    pick(accept) {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener('cancel', () => resolve(null));
        input.addEventListener('change', () => {
          const [file] = input.files;
          if (!file) resolve(null);
          else file.text().then(text => resolve({ name: file.name, text }), reject);
        });
        input.click();
      });
    },
    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    }
  });
}

const canvas = document.querySelector('canvas[data-pea-os]');
if (canvas) {
  addEventListener('error', event => report(event.error ?? event.message));
  addEventListener('unhandledrejection', event => report(event.reason));
  if (!globalThis.PIXI) report(new Error('pixi.js did not load; Pea OS cannot start'));
  else start(canvas).then(os => {
    // Access to the running system is useful when developing local apps.
    // It is deliberately available only on loopback hosts.
    if (local) globalThis.pea = os;
  }).catch(error => {
    report(error);
    const message = document.createElement('p');
    message.className = 'pea-start-error';
    message.textContent = `Pea OS could not start: ${error.message}`;
    canvas.after(message);
  });
}
