/**
 * Push-based state for Pea OS.
 *
 * Signal          owns one value and publishes (value, previous) when it changes.
 * combineLatest   derives a read-only Signal from explicit sources.
 * batch           coalesces synchronous writes into one publication wave.
 * EventEmitter    publishes named, valueless-or-valued moments (frames, taps).
 * DisposableScope owns lifetimes: subscriptions, derived edges, named signals.
 * SignalBinder    pushes a Signal into one property of one target.
 * persist         keeps a small Signal in a key/value store.
 *
 * Nothing here polls. Derived values settle in depth order before any
 * subscriber runs, so a subscriber never observes a half-updated graph.
 */

const MAX_WAVES = 100;

const release = resource => {
  if (typeof resource === 'function') resource();
  else if (typeof resource?.dispose === 'function') resource.dispose();
};

const raise = (errors, message) => {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, message);
};

export class Signal {
  static #batching = 0;
  static #publishing = false;
  static #pending = new Map(); // changed signal -> its state before this wave
  static #dirty = new Set();   // derived signals that must settle

  #value;
  #ready;
  #equals;
  #listeners = new Set();
  #dependents = new Set();
  #sources = null;
  #project = null;
  #depth = 0;

  /** `new Signal()` is uninitialized; `new Signal(undefined)` holds undefined. */
  constructor(...args) {
    this.#ready = args.length > 0;
    this.#value = args[0];
    this.#equals = args[1]?.equals ?? Object.is;
  }

  get initialized() {
    this.#settle();
    return this.#ready;
  }

  get value() {
    this.#settle();
    return this.#value;
  }

  set value(next) {
    this.set(next);
  }

  get readOnly() {
    return this.#sources !== null;
  }

  set(next) {
    if (this.#sources) throw new TypeError('A derived Signal is read-only');
    if (this.#ready && this.#equals(next, this.#value)) return false;
    this.#remember();
    this.#value = next;
    this.#ready = true;
    this.#taint();
    Signal.#publish();
    return true;
  }

  update(fn) {
    return this.set(fn(this.value));
  }

  subscribe(listener, { immediate = true, signal } = {}) {
    this.#listeners.add(listener);
    const stop = () => { this.#listeners.delete(listener); };
    signal?.addEventListener('abort', stop, { once: true });
    if (immediate && this.initialized) listener(this.#value, undefined);
    return stop;
  }

  map(project, options) {
    return Signal.combine([this], project, options);
  }

  /** Removes derived graph edges and every listener. */
  dispose() {
    for (const source of this.#sources ?? []) source.#dependents.delete(this);
    this.#listeners.clear();
    Signal.#dirty.delete(this);
    Signal.#pending.delete(this);
  }

  static combine(sources, project, { scope } = {}) {
    const node = new Signal();
    node.#sources = [...sources];
    node.#project = project;
    node.#depth = 1 + Math.max(0, ...node.#sources.map(source => source.#depth));
    for (const source of node.#sources) source.#dependents.add(node);
    Signal.#dirty.add(node);
    try {
      node.#settle();
    } catch (error) {
      node.dispose();
      throw error;
    }
    Signal.#pending.delete(node); // the first value is read, not published
    scope?.add(node);
    return node;
  }

  static batch(fn) {
    const errors = [];
    let result;
    Signal.#batching += 1;
    try {
      result = fn();
    } catch (error) {
      errors.push(error);
    }
    Signal.#batching -= 1;
    try {
      Signal.#publish();
    } catch (error) {
      errors.push(error);
    }
    raise(errors, 'batch failed');
    if (typeof result?.then === 'function') throw new TypeError('batch(fn) must be synchronous');
    return result;
  }

  #remember() {
    if (!Signal.#pending.has(this)) Signal.#pending.set(this, { ready: this.#ready, value: this.#value });
  }

  #taint() {
    for (const dependent of this.#dependents) {
      if (Signal.#dirty.has(dependent)) continue;
      Signal.#dirty.add(dependent);
      dependent.#taint();
    }
  }

  #settle() {
    if (!this.#sources || !Signal.#dirty.delete(this)) return;
    if (!this.#sources.every(source => source.initialized)) return;
    const next = this.#project(...this.#sources.map(source => source.value));
    if (this.#ready && this.#equals(next, this.#value)) return;
    this.#remember();
    this.#value = next;
    this.#ready = true;
  }

  static #publish() {
    if (Signal.#batching || Signal.#publishing) return;
    Signal.#publishing = true;
    const errors = [];
    try {
      for (let wave = 0; Signal.#pending.size || Signal.#dirty.size; wave++) {
        if (wave === MAX_WAVES) {
          Signal.#pending.clear();
          Signal.#dirty.clear();
          throw new Error(`Signal feedback loop: ${MAX_WAVES} waves without settling`);
        }
        for (const node of [...Signal.#dirty].sort((a, b) => a.#depth - b.#depth)) {
          try {
            node.#settle();
          } catch (error) {
            errors.push(error);
          }
        }
        const envelopes = [];
        for (const [signal, before] of Signal.#pending) {
          const unchanged = before.ready && signal.#equals(signal.#value, before.value);
          if (signal.#ready && !unchanged) envelopes.push([signal, signal.#value, before.value]);
        }
        Signal.#pending.clear();
        for (const [signal, value, previous] of envelopes) {
          for (const listener of [...signal.#listeners]) {
            if (!signal.#listeners.has(listener)) continue;
            try {
              listener(value, previous);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }
    } finally {
      Signal.#publishing = false;
    }
    raise(errors, 'Signal subscribers failed');
  }
}

/** combineLatest(a, b, fn) or combineLatest([a, b], fn); both accept trailing options. */
export function combineLatest(...args) {
  const last = args.at(-1);
  const options = last && typeof last === 'object' && !(last instanceof Signal) && !Array.isArray(last) ? args.pop() : {};
  const project = typeof args.at(-1) === 'function' ? args.pop() : (...values) => values;
  const sources = Array.isArray(args[0]) ? args[0] : args;
  if (!sources.length || !sources.every(source => source instanceof Signal)) {
    throw new TypeError('combineLatest needs at least one Signal');
  }
  return Signal.combine(sources, project, options);
}

export const batch = fn => Signal.batch(fn);

export class EventEmitter {
  #listeners = new Map();

  on(type, listener) {
    let listeners = this.#listeners.get(type);
    if (!listeners) this.#listeners.set(type, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  once(type, listener) {
    const off = this.on(type, payload => {
      off();
      listener(payload);
    });
    return off;
  }

  emit(type, payload) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return 0;
    for (const listener of [...listeners]) if (listeners.has(listener)) listener(payload);
    return listeners.size;
  }

  dispose() {
    this.#listeners.clear();
  }
}

export class DisposableScope {
  #resources = [];
  #signals = new Map();
  #disposed = false;

  get disposed() {
    return this.#disposed;
  }

  /** Takes ownership of a disposer function or an object with dispose(). */
  add(resource) {
    if (this.#disposed) release(resource);
    else this.#resources.push(resource);
    return resource;
  }

  /** Disposes one owned resource now. */
  release(resource) {
    const index = this.#resources.indexOf(resource);
    if (index >= 0) this.#resources.splice(index, 1);
    release(resource);
  }

  child() {
    return this.add(new DisposableScope());
  }

  /** Declares a named Signal exactly once. Passing a Signal aliases it without owning it. */
  signal(name, ...initial) {
    if (this.#signals.has(name)) throw new Error(`Signal "${name}" is already declared`);
    const signal = initial[0] instanceof Signal ? initial[0] : this.add(new Signal(...initial));
    this.#signals.set(name, signal);
    return signal;
  }

  has(name) {
    return this.#signals.has(name);
  }

  /** Names fail loudly; a typo never creates a ghost Signal. */
  resolve(source) {
    if (source instanceof Signal) return source;
    const signal = this.#signals.get(source);
    if (!signal) throw new Error(`Unknown signal "${source}". Declared: ${[...this.#signals.keys()].join(', ') || 'none'}`);
    return signal;
  }

  get(name) {
    return this.resolve(name).value;
  }

  set(name, value) {
    this.resolve(name).set(value);
    return this;
  }

  computed(name, sources, project) {
    const node = combineLatest(sources.map(source => this.resolve(source)), project, { scope: this });
    return this.signal(name, node);
  }

  /** Runs fn(...values) when settled sources change; fn may return a cleanup. */
  effect(sources, fn) {
    let cleanup;
    const node = combineLatest(sources.map(source => this.resolve(source)));
    const stop = () => {
      node.dispose();
      release(cleanup);
      cleanup = undefined;
    };
    try {
      node.subscribe(values => {
        release(cleanup);
        cleanup = fn(...values);
      });
    } catch (error) {
      stop();
      throw error;
    }
    this.add(stop);
    return this;
  }

  subscribe(source, listener, options) {
    return this.add(this.resolve(source).subscribe(listener, options));
  }

  /** Listens on an EventEmitter or a DOM EventTarget. */
  on(target, type, listener, options) {
    if (typeof target.on === 'function') return this.add(target.on(type, listener));
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  bind(target, source, apply) {
    return this.add(new SignalBinder(target, this.resolve(source), apply));
  }

  /** LIFO, idempotent, and it keeps going when one cleanup throws. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors = [];
    for (const resource of this.#resources.splice(0).reverse()) {
      try {
        release(resource);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#signals.clear();
    raise(errors, 'Scope disposal failed');
  }
}

/** Pushes every value of `signal` into `target`: a property name, or (target, value) => {}. */
export class SignalBinder {
  #stop;

  constructor(target, signal, apply = 'text') {
    const push = typeof apply === 'function'
      ? value => apply(target, value)
      : value => { target[apply] = value; };
    this.#stop = signal.subscribe(push);
  }

  dispose() {
    this.#stop();
  }
}

/**
 * Keeps a small Signal in a synchronous { get(key), set(key, text) } store.
 * Hydration happens before this returns. Records are versioned JSON; a record
 * that is malformed, from another version, or refused by `accept` is ignored.
 */
export function persist(signal, { key, storage, version = 1, accept = () => true, onError = () => {} }) {
  try {
    const record = JSON.parse(storage.get(key) ?? 'null');
    if (record?.version === version && accept(record.value)) signal.set(record.value);
  } catch (error) {
    onError(error);
  }
  const save = () => {
    try {
      storage.set(key, JSON.stringify({ version, value: signal.value }));
    } catch (error) {
      onError(error);
    }
  };
  const stop = signal.subscribe(save, { immediate: false });
  return { save, dispose: stop };
}
