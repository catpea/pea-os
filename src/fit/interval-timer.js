/**
 * Pure interval timing. The host calls tick(); this package creates no timers.
 * Time is measured against a run anchor, never by counting delivered ticks.
 */

export const DEFAULT_CONFIG = Object.freeze({
  warmup: 30,
  workout: 45,
  rest: 15,
  cooldown: 120,
  rounds: 8,
});

const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));
const PHASE_LABELS = Object.freeze({
  warmup: 'Ready!', workout: 'Fight!', rest: 'K.O.', cooldown: 'Winner',
});
const STATUSES = new Set(['idle', 'running', 'paused', 'completed']);

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function integer(value, key, minimum, maximum) {
  let number = value;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) {
      throw new TypeError(`${key} must be a whole number.`);
    }
    number = Number(value.trim());
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new TypeError(`${key} must be a whole number.`);
  }
  if (number < minimum || number > maximum) {
    const unit = key === 'rounds' ? '' : ' seconds';
    throw new RangeError(`${key} must be between ${minimum} and ${maximum}${unit}.`);
  }
  return number;
}

/** Missing settings inherit DEFAULT_CONFIG; numeric form-field strings are accepted. */
export function validateConfig(input = DEFAULT_CONFIG) {
  object(input, 'Timer configuration');
  const result = {};
  for (const key of CONFIG_KEYS) {
    const value = Object.hasOwn(input, key) ? input[key] : DEFAULT_CONFIG[key];
    result[key] = integer(value, key, key === 'rounds' || key === 'workout' ? 1 : 0,
      key === 'rounds' ? 99 : 3600);
  }
  return Object.freeze(result);
}

/**
 * Positive-duration steps only. Rest occurs between rounds, never after the
 * final workout. startMs/endMs are positions in the complete planned session.
 */
export function buildPlan(input = DEFAULT_CONFIG) {
  const config = validateConfig(input);
  const steps = [];
  let position = 0;
  const add = (phase, seconds, round) => {
    if (seconds === 0) return;
    const durationMs = seconds * 1000;
    steps.push(Object.freeze({
      id: phase === 'workout' || phase === 'rest' ? `${phase}-${round}` : phase,
      phase,
      round,
      durationMs,
      startMs: position,
      endMs: position + durationMs,
    }));
    position += durationMs;
  };
  add('warmup', config.warmup, 1);
  for (let round = 1; round <= config.rounds; round += 1) {
    add('workout', config.workout, round);
    if (round < config.rounds) add('rest', config.rest, round);
  }
  add('cooldown', config.cooldown, config.rounds);
  return Object.freeze(steps);
}

/** A remaining-time display: 1 ms is 00:01, not 00:00. */
export function formatTime(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) {
    throw new TypeError('Time must be a finite number of milliseconds.');
  }
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export class IntervalTimer {
  #config;
  #plan;
  #totalMs;
  #now;
  #status = 'idle';
  #position = 0;
  #anchorTime = 0;
  #anchorPosition = 0;
  #lastObservedTime = 0;
  #listeners = new Set();
  #publishedSignature;
  #notifying = false;
  #pendingNotification = null;

  constructor({ config = DEFAULT_CONFIG, now = () => Date.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a clock function.');
    this.#now = now;
    this.#setConfig(validateConfig(config));
    this.#publishedSignature = JSON.stringify(this.#makeSnapshot());
  }

  #setConfig(config) {
    this.#config = config;
    this.#plan = buildPlan(config);
    this.#totalMs = this.#plan.at(-1).endMs;
  }

  #readClock() {
    const value = this.#now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('The timer clock must return finite milliseconds.');
    }
    return value;
  }

  #beginRun() {
    const time = this.#readClock();
    this.#anchorTime = time;
    this.#lastObservedTime = time;
    this.#anchorPosition = this.#position;
    this.#status = 'running';
  }

  #synchronize() {
    if (this.#status !== 'running') return;
    // A backward clock movement cannot increase remaining time. Prefer a
    // monotonic platform clock; Date.now is the dependency-free default.
    const time = Math.max(this.#lastObservedTime, this.#readClock());
    this.#lastObservedTime = time;
    this.#position = Math.min(this.#totalMs,
      this.#anchorPosition + time - this.#anchorTime);
    if (this.#position >= this.#totalMs) {
      this.#position = this.#totalMs;
      this.#status = 'completed';
    }
  }

  #stepIndex() {
    if (this.#position >= this.#totalMs) return this.#plan.length - 1;
    return this.#plan.findIndex(step => this.#position < step.endMs);
  }

  #makeSnapshot() {
    const stepIndex = this.#stepIndex();
    const step = this.#plan[stepIndex];
    const remainingMs = this.#status === 'completed' ? 0 : step.endMs - this.#position;
    return Object.freeze({
      status: this.#status,
      phase: step.phase,
      phaseLabel: this.#status === 'completed' ? 'Winner' : PHASE_LABELS[step.phase],
      remainingMs,
      phaseDurationMs: step.durationMs,
      progress: remainingMs / step.durationMs,
      round: step.round,
      rounds: this.#config.rounds,
      elapsedMs: this.#position,
      totalMs: this.#totalMs,
      totalRemainingMs: this.#totalMs - this.#position,
      stepIndex,
      stepCount: this.#plan.length,
      config: this.#config,
    });
  }

  #publish() {
    const snapshot = this.#makeSnapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.#publishedSignature) return snapshot;
    this.#publishedSignature = signature;
    this.#pendingNotification = snapshot;
    if (this.#notifying) return snapshot;
    this.#notifying = true;
    try {
      // A subscriber may pause/reset in response to a state change. Deliver
      // that subsequent state after the current notification, not recursively.
      while (this.#pendingNotification) {
        const current = this.#pendingNotification;
        this.#pendingNotification = null;
        for (const listener of [...this.#listeners]) {
          if (!this.#listeners.has(listener)) continue;
          try { listener(current); } catch { /* A view cannot stop the clock. */ }
        }
      }
    } finally {
      this.#notifying = false;
    }
    return this.#makeSnapshot();
  }

  /** Subscribe immediately by default; the returned function unsubscribes. */
  subscribe(listener, { emit = true } = {}) {
    if (typeof listener !== 'function') throw new TypeError('Subscriber must be a function.');
    if (typeof emit !== 'boolean') throw new TypeError('emit must be a boolean.');
    this.#listeners.add(listener);
    if (emit) {
      try { listener(this.#makeSnapshot()); } catch { /* Isolate observer errors. */ }
    }
    return () => this.#listeners.delete(listener);
  }

  /** Last committed state; call tick() to synchronize it with the clock. */
  snapshot() { return this.#makeSnapshot(); }

  configure(input) {
    const config = validateConfig(input);
    this.#synchronize();
    if (this.#status === 'running' || this.#status === 'paused') {
      throw new Error('Reset the session before changing its configuration.');
    }
    this.#setConfig(config);
    this.#status = 'idle';
    this.#position = 0;
    return this.#publish();
  }

  /** Start idle/completed sessions; start on a paused session resumes it. */
  start() {
    if (this.#status === 'running') return this.tick();
    if (this.#status === 'completed') this.#position = 0;
    this.#beginRun();
    return this.#publish();
  }

  pause() {
    this.#synchronize();
    if (this.#status === 'running') this.#status = 'paused';
    return this.#publish();
  }

  resume() {
    if (this.#status === 'paused') this.#beginRun();
    return this.#publish();
  }

  toggle() {
    if (this.#status === 'running') return this.pause();
    if (this.#status === 'paused') return this.resume();
    return this.start();
  }

  /** Skip the current running/paused step. Paused sessions remain paused. */
  skip() {
    this.#synchronize();
    if (this.#status === 'idle' || this.#status === 'completed') return this.#publish();
    this.#position = this.#plan[this.#stepIndex()].endMs;
    if (this.#position >= this.#totalMs) {
      this.#status = 'completed';
    } else if (this.#status === 'running') {
      this.#anchorTime = this.#lastObservedTime;
      this.#anchorPosition = this.#position;
    }
    return this.#publish();
  }

  reset() {
    this.#status = 'idle';
    this.#position = 0;
    return this.#publish();
  }

  tick() {
    this.#synchronize();
    return this.#publish();
  }

  /** JSON-safe committed state. No wall-clock timestamp is needed on restore. */
  exportState() {
    return {
      schemaVersion: 1,
      config: { ...this.#config },
      status: this.#status,
      positionMs: this.#position,
    };
  }

  /** Restore atomically. An in-progress session always returns paused. */
  restoreState(data) {
    object(data, 'Saved timer state');
    if (data.schemaVersion !== 1) throw new RangeError('Unsupported timer state version.');
    object(data.config, 'Saved timer configuration');
    if (!CONFIG_KEYS.every(key => Object.hasOwn(data.config, key))) {
      throw new TypeError('Saved timer configuration is incomplete.');
    }
    const config = validateConfig(data.config);
    if (!STATUSES.has(data.status)) throw new TypeError('Invalid saved timer status.');
    const totalMs = buildPlan(config).at(-1).endMs;
    const position = data.positionMs;
    if (typeof position !== 'number' || !Number.isFinite(position)
        || position < 0 || position > totalMs) {
      throw new RangeError('Saved timer position is outside its planned session.');
    }
    if (data.status === 'idle' && position !== 0) {
      throw new RangeError('An idle saved timer must start at zero.');
    }
    if (data.status === 'completed' && position !== totalMs) {
      throw new RangeError('A completed saved timer must be at the end.');
    }
    if ((data.status === 'running' || data.status === 'paused') && position >= totalMs) {
      throw new RangeError('An in-progress saved timer must have time remaining.');
    }
    this.#setConfig(config);
    this.#position = position;
    this.#status = data.status === 'running' ? 'paused' : data.status;
    return this.#publish();
  }
}
