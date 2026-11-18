/** Time-based motion driven by the stage's frame events. */

export const ease = {
  linear: t => t,
  in: t => t * t * t,
  out: t => 1 - (1 - t) ** 3,
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  bounce(t) {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }
};

export class Animator {
  /** When false, tweens jump straight to their end state. */
  motion = true;
  #running = new Set();
  #stop;

  constructor(frame) {
    this.#stop = frame.on('tick', ({ dt }) => {
      for (const step of [...this.#running]) step(dt);
    });
  }

  /**
   * Calls update(t) with eased t from 0 to 1 over `ms`. The returned promise
   * resolves true when finished, false when cancelled through promise.cancel().
   */
  tween(ms, update, { easing = ease.out, delay = 0 } = {}) {
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    let elapsed = -delay;
    const end = done => {
      this.#running.delete(step);
      finish(done);
    };
    const step = dt => {
      elapsed += dt;
      if (elapsed < 0) return;
      const t = this.motion && ms > 0 ? Math.min(1, elapsed / ms) : 1;
      update(easing(t));
      if (t === 1) end(true);
    };
    promise.cancel = () => end(false);
    this.#running.add(step);
    return promise;
  }

  wait(ms) {
    return this.tween(ms, () => {}, { easing: ease.linear });
  }

  dispose() {
    this.#stop();
    for (const step of [...this.#running]) this.#running.delete(step);
  }
}
