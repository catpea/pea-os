import { ProviderSet, ProviderRegistry } from '../core/providers.js';
import { ModelRouter } from '../ai/router.js';
import { memoryFiles, storageFiles } from './files.js';
import { pageSchedule } from './schedule.js';

/**
 * Providers: what differs from one place Pea OS runs to the next, behind one
 * shape, so an app asks for a service and never needs to know who gives it.
 * The same files adapt to a static web host, pos serve on a computer, and a
 * phone, because each platform injects the providers it has
 * (platform.providers) and Pea OS adds its built-in ones. The catalog
 * (res/data/software.xml) names every provider Pea OS knows of, so one this
 * platform cannot offer is still listed with the reason.
 *
 * A provider is { id, title, kind, about, status(), requires, ...methods }
 * (see src/core/providers.js); kind says where it works: 'local' (inside
 * Pea OS), 'browser', 'server' (pos serve on this computer), 'device' (the
 * phone) or 'test'. Apps declare the services they need in their XML
 * (requires="media", uses="network schedule"; see src/os/app.js).
 *
 * The services, and what their providers do:
 *
 *   thinking  complete(request)                   see src/ai/router.js
 *   files     list(folder) -> [{ name, size, type, modified }]
 *             read(name) -> Blob | Uint8Array
 *             write(name, data, { signal }) -> { name, size }   data: Blob | Uint8Array
 *             remove(name)
 *             source(name) -> { url, data?, release() }   something a player can play
 *             Names are "folder/name.ext" (see fileName in src/os/files.js).
 *   audio     player() -> a Player (below)
 *   media     probe(name) -> { duration, video: { width, height, fps } | null, audio: { rate, channels } | null }
 *             frame(name, seconds, width) -> { width, height, data }   RGBA pixels
 *             peaks(name, count) -> Uint8Array                         loudness, 0-255
 *             render(projectXml, { onProgress, signal }) -> { name }
 *             files: the files provider whose files it can reach
 *   network   request({ url, method, headers, body, signal, onText }) -> { status, ok, type, text }
 *             onText receives the body as it arrives
 *   schedule  every(ms, run) -> dispose          see src/os/schedule.js
 *   server    describe() -> the <services> pos serve offers (cli/serve.mjs)
 *
 * A Player is
 *   { state: Signal<{ status, position, at, duration, error }>, now(),
 *     load({ url, data, title, artist }), play(), pause(), stop(), seek(s),
 *     volume(0..1), spectrum(bytes) -> boolean, remote: EventEmitter, dispose() }
 * status is 'empty', 'loading', 'paused', 'playing', 'ended' or 'error'.
 * `position` is in seconds at `at` on the player's clock (now(), in ms); while
 * playing, the position moves on with the clock, so nothing polls the player.
 * `remote` emits 'play', 'pause', 'previous', 'next' and 'seek' ({ position })
 * from media keys, headsets and the lock screen.
 */

/**
 * Each service: its title, what an app cannot do without it ("Pea Feeds
 * can't reach the internet here"), its providers' methods, the order they
 * are tried in, and the one that always stays, if any.
 */
export const SERVICES = {
  files: { title: 'Files', can: 'keep files', methods: ['list', 'read', 'write', 'remove', 'source'], order: ['disk', 'device-files', 'browser-files', 'storage-files', 'memory'], always: 'memory' },
  audio: { title: 'Sound', can: 'play sound', methods: ['player'], order: ['android-player', 'web-audio'] },
  media: { title: 'Video tools', can: 'work with video', methods: ['probe', 'frame', 'peaks', 'render'], order: ['ffmpeg-server', 'ffmpeg-wasm', 'ffmpeg-android'] },
  network: { title: 'Internet', can: 'reach the internet', methods: ['request'], order: ['relay', 'native-http', 'direct'] },
  schedule: { title: 'Schedule', can: 'run on a schedule', methods: ['every'], order: ['android-alarm', 'page'], always: 'page' },
  thinking: { title: 'Thinking', can: 'think', methods: ['complete'] },
  server: { title: 'Pea server', can: 'reach pos serve', methods: ['describe'], order: ['pos-serve'] }
};

/** Stands in for a provider the catalog knows of but this platform does not offer. */
function placeholder({ id, title, kind, about, absent }) {
  return { id, title, kind, about, placeholder: true, async status() { return { ok: false, reason: absent }; } };
}

/** Every service and its providers: os.providers.files, .network, … and .thinking, the model router (also os.ai). */
export class Providers extends ProviderRegistry {
  /** What the catalog says of each provider, by id: { service, by, home, license, needs }. */
  catalog = new Map();

  constructor(os, { catalog = null } = {}) {
    super();
    for (const [service, spec] of Object.entries(SERVICES)) {
      this.add(service === 'thinking' ? new ModelRouter(os, { service, ...spec }) : new ProviderSet(os, { service, ...spec }));
    }
    this.files.register(memoryFiles());
    if (os.platform.storage) this.files.register(storageFiles(os.platform.storage));
    this.schedule.register(pageSchedule(error => os.report(error)));
    for (const provider of os.platform.providers ?? []) {
      const offered = Object.keys(SERVICES).filter(name => name !== 'thinking');
      if (!offered.includes(provider?.service)) throw new Error(`A platform provider needs a service: ${offered.join(', ')}`);
      this.service(provider.service).register(provider);
    }
    if (catalog) this.#read(catalog);
    this.validate();
  }

  get files() { return this.service('files'); }
  get audio() { return this.service('audio'); }
  get media() { return this.service('media'); }
  get network() { return this.service('network'); }
  get schedule() { return this.service('schedule'); }
  get thinking() { return this.service('thinking'); }
  get server() { return this.service('server'); }

  #read(catalog) {
    for (const item of catalog.all('provider')) {
      item.expect({ attrs: ['service', 'id', 'title', 'kind', 'by', 'home', 'license', 'needs', 'about', 'absent'] });
      const service = item.need('service');
      if (!SERVICES[service]) item.fail(`service="${service}" must be one of ${Object.keys(SERVICES).join(', ')}`);
      const id = item.need('id');
      if (this.catalog.has(id)) item.fail(`id="${id}" is listed twice`);
      this.catalog.set(id, { service, by: item.need('by'), home: item.attr('home', ''), license: item.need('license'), needs: item.need('needs') });
      const set = this.service(service);
      if (set.providers.has(id)) continue;
      // A provider this platform does not offer is still listed, with why it is missing.
      if (!item.has('absent')) item.fail(`id="${id}" is not offered here, so it needs absent="why"`);
      set.register(placeholder({ id, title: item.need('title'), kind: item.attr('kind', 'local'), about: item.attr('about', ''), absent: item.need('absent') }));
    }
  }
}
