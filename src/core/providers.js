import { Signal } from './reactive.js';

/**
 * Services and the providers that give them.
 *
 * A service is something that can be done in more than one way, such as
 * keeping files or reaching the internet. Each way is a provider:
 *
 *   { id, title, kind, about, status(), requires, ...the service's methods }
 *
 *   status()  -> Promise<{ ok, reason, setup }>: whether it can work right
 *             now, and if not, why, in words a person can act on.
 *   requires  optional: the services it cannot work without. Disk files
 *             require the Pea server; a model server requires the internet.
 *   setup(changed)  optional: makes ready a provider whose status says `setup`.
 *
 * A provider is usable when it is installed, each service it requires has a
 * usable provider, and its own status is ok. Resolving is only that: walking
 * requirements down a graph without cycles, in the order the user chose. It
 * never searches, so every answer can be explained in a sentence.
 */
export class ProviderSet {
  providers = new Map();
  /** { order: [id], off: [id] }: the user's preference, kept in storage. */
  settings;
  /** Counts up whenever a provider's status may have changed. */
  changed = new Signal(0);
  /** The id of the provider that works now, or null when none does. Kept fresh by refresh(). */
  current = new Signal(null);
  /** The registry this set belongs to, which answers for the services its providers require. */
  registry = null;
  #refreshes = 0;
  #disposed = false;

  /**
   * options: { service, title, methods, key, order, off, always }: the
   * service's name and title, the methods its providers need, the storage
   * key for the user's choices, the preferred order, what starts turned off,
   * and the one provider that always stays (Pea Mind, memory files).
   */
  constructor(os, { service, title, methods, key, order = [], off = [], always = null }) {
    this.os = os;
    this.service = service;
    this.title = title;
    this.methods = methods;
    this.key = key ?? `pea-os.providers.${service}.v1`;
    this.always = always;
    this.settings = new Signal({ order, off });
    try {
      const saved = JSON.parse(os.platform.storage?.get(this.key) ?? 'null');
      if (saved?.version === 1 && Array.isArray(saved.off) && saved.off.every(id => typeof id === 'string')) {
        this.settings.set({ ...this.settings.value, off: saved.off.filter(id => id !== always) });
      }
    } catch (error) { os.report?.(new Error(`${title} settings could not be loaded: ${error.message}`)); }
  }

  get #name() { return this.title.toLowerCase(); }

  register(provider) {
    for (const field of ['id', 'title', 'kind', 'status', ...(provider.placeholder ? [] : this.methods)]) {
      if (!provider[field]) throw new Error(`A ${this.#name} provider needs "${field}"${provider.id ? ` ("${provider.id}" has none)` : ''}`);
    }
    if (provider.requires !== undefined && !(Array.isArray(provider.requires) && provider.requires.every(name => typeof name === 'string'))) {
      throw new Error(`${provider.title}: requires must be a list of service names`);
    }
    if (this.providers.has(provider.id) && !this.providers.get(provider.id).placeholder) throw new Error(`There are two ${this.#name} providers called "${provider.id}"`);
    this.providers.set(provider.id, provider);
    if (!this.settings.value.order.includes(provider.id)) {
      // Unknown providers go before the one that always stays, which is the last resort.
      const order = this.settings.value.order.filter(id => id !== this.always);
      this.settings.set({ ...this.settings.value, order: [...order, provider.id, ...(this.always ? [this.always] : [])] });
    }
    return provider;
  }

  installed(id) {
    return this.providers.has(id) && !this.providers.get(id).placeholder && !this.settings.value.off.includes(id);
  }

  /** Turns a provider on or off; the one that always stays cannot be turned off. */
  install(id, on) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`There is no ${this.#name} provider "${id}"`);
    if (provider.placeholder && on) throw new Error(`${provider.title} cannot be installed here.`);
    if (id === this.always && !on) throw new Error(`${provider.title} is part of Pea OS and always stays.`);
    const off = this.settings.value.off.filter(other => other !== id);
    this.settings.set({ ...this.settings.value, off: on ? off : [...off, id] });
    try { this.os.platform.storage?.set(this.key, JSON.stringify({ version: 1, off: this.settings.value.off })); }
    catch (error) { this.os.report?.(error); }
    this.#settle();
  }

  /** Makes a provider ready that needs it (status says `setup`), and installs it. */
  async setup(id) {
    const provider = this.providers.get(id);
    if (!provider?.setup) throw new Error(`${provider?.title ?? id} needs no setting up.`);
    if (!this.installed(id)) this.install(id, true);
    const bump = () => { this.changed.set(this.changed.value + 1); this.#settle(); };
    bump();
    await provider.setup(bump);
  }

  /** A change here can change every service that requires this one. */
  #settle() {
    (this.registry ?? this).refresh();
  }

  /**
   * Whether a provider can work, installed or not: { ok, reason, setup, missing }.
   * `missing` are the services it requires that nothing here gives.
   */
  async check(provider) {
    if (!provider.placeholder) {
      const missing = [];
      for (const name of provider.requires ?? []) {
        const set = this.#required(name);
        if (!(await set.find())) missing.push(set);
      }
      if (missing.length) {
        return { ok: false, missing: missing.map(set => set.service), reason: `Needs ${missing.map(set => set.title).join(' and ')}, which nothing here gives.` };
      }
    }
    try {
      const { ok, reason = '', setup = false } = await provider.status();
      return { ok: Boolean(ok), reason, setup: Boolean(setup && provider.setup), missing: [] };
    } catch (error) {
      return { ok: false, reason: error.message, setup: false, missing: [] };
    }
  }

  #required(name) {
    if (!this.registry) throw new Error(`${this.title} providers can require other services only inside a registry`);
    return this.registry.service(name);
  }

  /** The first installed provider, in the user's order, that can work now; null when none can. */
  async find() {
    for (const id of this.settings.value.order) {
      const provider = this.providers.get(id);
      if (provider && this.installed(id) && (await this.check(provider)).ok) return provider;
    }
    return null;
  }

  /**
   * Every provider with its state: [{ id, title, kind, about, placeholder,
   * installed, ready, ok, reason, setup, requires: [{ service, title, met }] }].
   * ready: it could work if installed; ok: it is installed and ready.
   */
  async survey() {
    return Promise.all([...this.providers.values()].map(async provider => {
      const { ok, reason, setup, missing } = await this.check(provider);
      const installed = this.installed(provider.id);
      return {
        id: provider.id, title: provider.title, kind: provider.kind, about: provider.about ?? '',
        placeholder: Boolean(provider.placeholder), installed, ready: ok, ok: ok && installed, reason, setup,
        requires: (provider.requires ?? []).map(name => ({ service: name, title: this.#required(name).title, met: !missing.includes(name) }))
      };
    }));
  }

  /** Looks again at which provider works now, and updates `current`. */
  async refresh() {
    const mine = ++this.#refreshes;
    const found = (await this.find())?.id ?? null;
    // Looks can finish out of order; only the newest one describes things as they are.
    if (mine === this.#refreshes && !this.#disposed) this.current.set(found);
    return found;
  }

  /**
   * Why nothing gives this service here, in a sentence or two: each real
   * provider's reason, or, where this platform has none, why the ones Pea
   * knows of are missing. Empty when something gives it.
   */
  async why() {
    if (await this.find()) return '';
    const entries = await this.survey();
    const real = entries.filter(entry => !entry.placeholder);
    return (real.length ? real : entries)
      .map(entry => `${entry.title}: ${!entry.installed && entry.ready ? 'turned off in Software.' : entry.reason}`)
      .join(' ');
  }

  /** The provider that will work: `prefer` if it is ready, else the first ready one in order. Throws a sentence when none is. */
  async route(prefer = 'auto') {
    if (prefer && prefer !== 'auto') {
      const provider = this.providers.get(prefer);
      if (!provider) throw new Error(`There is no ${this.#name} provider "${prefer}"`);
      const { ok, reason } = await this.check(provider);
      if (ok && this.installed(prefer)) return provider;
      throw new Error(`${provider.title}: ${reason}`);
    }
    const found = await this.find();
    if (found) return found;
    if (this.always) return this.providers.get(this.always);
    throw new Error(`Nothing here gives ${this.#name}. ${await this.why()}`.trim());
  }

  dispose() {
    this.#disposed = true;
    this.changed.dispose();
    this.current.dispose();
  }
}

/**
 * Every service, by name. Each provider's requirements are answered here,
 * and checked once everything is registered: they must name services that
 * exist, and must not go round in a circle.
 */
export class ProviderRegistry {
  #sets = new Map();

  add(set) {
    if (this.#sets.has(set.service)) throw new Error(`There are two services called "${set.service}"`);
    set.registry = this;
    this.#sets.set(set.service, set);
    return set;
  }

  service(name) {
    const set = this.#sets.get(name);
    if (!set) throw new Error(`There is no service "${name}". Services: ${[...this.#sets.keys()].join(', ')}`);
    return set;
  }

  /** The services, by name. */
  get services() {
    return Object.fromEntries(this.#sets);
  }

  /** Throws when a requirement names no service, or when requirements form a circle. */
  validate() {
    const state = new Map(); // service -> 'visiting' | 'done'
    const visit = (name, path) => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') throw new Error(`Services require each other in a circle: ${[...path, name].join(' → ')}`);
      state.set(name, 'visiting');
      for (const provider of this.service(name).providers.values()) {
        for (const required of provider.requires ?? []) {
          if (!this.#sets.has(required)) throw new Error(`${provider.title} requires "${required}", which is not a service. Services: ${[...this.#sets.keys()].join(', ')}`);
          visit(required, [...path, name]);
        }
      }
      state.set(name, 'done');
    };
    for (const name of this.#sets.keys()) visit(name, []);
  }

  /** Looks again at every service, so each `current` is right. */
  refresh() {
    return Promise.all([...this.#sets.values()].map(set => set.refresh()));
  }

  dispose() {
    for (const set of this.#sets.values()) set.dispose();
    this.#sets.clear();
  }
}
