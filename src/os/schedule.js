/**
 * The schedule service runs work again and again, such as fetching feeds.
 * Its provider here is the page itself: work runs while Pea OS is open, and
 * stops when it closes, because a browser never wakes a closed page. A phone
 * can do better (see the catalog's android-alarm).
 *
 *   every(ms, run) -> dispose   runs `run` every `ms`, first after one wait;
 *                               a run still going when the next is due is
 *                               not started twice.
 */
export function pageSchedule(report) {
  return {
    id: 'page',
    title: 'While Pea OS is open',
    kind: 'local',
    about: 'Runs scheduled work while Pea OS is open. A browser never wakes a closed page, so nothing runs while Pea OS is closed.',
    async status() { return { ok: true, reason: 'Built in. Scheduled work runs while Pea OS is open.' }; },
    every(ms, run) {
      if (!(ms > 0)) throw new Error('A schedule needs a time between runs.');
      let running = false;
      const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { await run(); }
        catch (error) { report(error); }
        finally { running = false; }
      }, ms);
      return () => clearInterval(timer);
    }
  };
}
