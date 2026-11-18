/**
 * Pea Timer: warmup, work, rest and cooldown with a hero who does the moves.
 * The timer is monotonic (it reads the clock, never counts frames); the hero is
 * a list of whole-pixel rectangles painted into the stage canvas at 1:1 or 2:1.
 * Hero, plan and finished-workout count are kept as one small XML document.
 */
import { IntervalTimer, validateConfig, buildPlan, formatTime } from '../../src/fit/interval-timer.js';
import { workoutExercise } from '../../src/fit/exercises.js';
import { FEET, HERO_FIELDS, DEFAULT_LOOK, heroRects, heroPosePair, normalizeLook, stepLook, randomLook, optionLabel, nextUnlock } from '../../src/fit/hero-doll.js';

const PRESETS = {
  quick: { warmup: 10, workout: 20, rest: 10, cooldown: 20, rounds: 4 },
  classic: { warmup: 30, workout: 45, rest: 15, cooldown: 60, rounds: 8 },
  long: { warmup: 60, workout: 60, rest: 20, cooldown: 120, rounds: 10 },
};
const PLAN_FIELDS = ['warmup', 'workout', 'rest', 'cooldown', 'rounds'];
const PLAN_LIMITS = { warmup: [0, 3600], workout: [5, 3600], rest: [0, 3600], cooldown: [0, 3600], rounds: [1, 99] };
const PHASES = { warmup: 'Warm up', workout: 'Work!', rest: 'Rest', cooldown: 'Cool down' };
const MOVES = { 'bicep-curl': 'Curls', 'overhead-press': 'Press', 'lateral-raise': 'Raises' };
const POSE_MS = 600;
const BANNER_MS = 1400;
const MAX_LEVEL = 6;
const signalName = (prefix, id) => prefix + id[0].toUpperCase() + id.slice(1);

// Square-wave cues, so the workout can be followed without watching the screen.
const note = (hz, ms) => ({ hz, ms });
const TUNES = {
  tick: [note(880, 60)],
  go: [note(523, 90), note(659, 90), note(784, 140)],
  workout: [note(784, 90), note(0, 30), note(1047, 180)],
  rest: [note(659, 110), note(523, 200)],
  cooldown: [note(523, 100), note(440, 100), note(392, 200)],
  done: [note(523, 110), note(659, 110), note(784, 110), note(1047, 320)],
};

// Little pictures for the stage, "#" is ink.
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];
const SPARKLE = ['..#..', '..#..', '##.##', '..#..', '..#..'];

/** Seconds move by 5 below a minute, by 15 below five minutes, then by whole minutes. */
const stepOf = seconds => seconds < 60 ? 5 : seconds < 300 ? 15 : 60;
export function stepPlan(plan, field, direction) {
  const value = plan[field];
  const step = field === 'rounds' ? 1 : stepOf(direction > 0 ? value : value - 1);
  const next = direction > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
  const [low, high] = PLAN_LIMITS[field];
  return { ...plan, [field]: Math.min(high, Math.max(low, next)) };
}
const secondsLabel = seconds => seconds === 0 ? 'Off' : seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** A number from 0 to 1 that is always the same for the same n. */
function hash(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export default function peaTimer(app) {
  const { parseColor, rgba } = app.gfx;
  const { stage, preview } = app.refs;
  const { font } = app;
  const skies = {
    warmup: ['#1b1640', '#3a2a78', '#6d3fa8'],
    workout: ['#2a1038', '#6a1f5c', '#c2456a'],
    rest: ['#10233f', '#1f4d6e', '#2f7f8a'],
    cooldown: ['#0f1a3a', '#1f3b78', '#3f6fb0'],
  };
  for (const id in skies) skies[id] = skies[id].map(parseColor);
  const floor = parseColor('#3a3550'), floorTop = parseColor('#6b6a86'), floorLine = parseColor('#2b2740');
  const cream = parseColor('#fbf7ea'), dim = parseColor('#c9c3e6'), sun = parseColor('#ffd75e'), ink = parseColor('#16161d');
  const track = parseColor('#2b2740');
  const phaseColors = { warmup: sun, workout: parseColor('#ff9a3d'), rest: parseColor('#3fd0c9'), cooldown: parseColor('#5aa0ff') };
  const confetti = ['#ff6fb5', '#ffd75e', '#3fd0c9', '#9be36b', '#ff9a3d', '#b07cff'].map(parseColor);
  const heartColors = ['#ff6fb5', '#e8475a', '#ff8fc8'].map(parseColor);
  const paints = new Map();
  const paint = color => {
    if (!paints.has(color)) paints.set(color, rgba((color >> 16) & 255, (color >> 8) & 255, color & 255));
    return paints.get(color);
  };

  // One XML document holds everything this app keeps between runs.
  let look = { ...DEFAULT_LOOK }, workouts = 0, preset = 'classic', mine = { ...PRESETS.classic };
  const level = () => Math.min(MAX_LEVEL, 1 + workouts);
  try {
    const text = app.document.load();
    if (text) {
      const root = app.xml.parseXml(text, 'pea-timer document');
      const hero = root.children.find(child => child.name === 'hero');
      const plan = root.children.find(child => child.name === 'plan');
      workouts = Math.max(0, Math.floor(Number(root.attr('workouts', 0)) || 0));
      if (plan) mine = { ...validateConfig(plan.attrs) };
      const saved = root.attr('preset');
      if (Object.hasOwn(PRESETS, saved) || saved === 'mine') preset = saved;
      if (hero) look = normalizeLook(hero.attrs, { level: level() });
    }
  } catch (error) {
    app.report(error, { quiet: true });
  }
  const planOf = id => id === 'mine' ? mine : PRESETS[id];
  const attrs = (fields, values) => fields.map(id => `${id}="${app.xml.escapeXml(String(values[id]))}"`).join(' ');
  const save = app.debounce(300, () => app.document.save(
    `<pea-timer version="1" workouts="${workouts}" preset="${preset}">\n` +
    `  <plan ${attrs(PLAN_FIELDS, mine)}/>\n` +
    `  <hero ${attrs(HERO_FIELDS.map(({ id }) => id), look)}/>\n` +
    `</pea-timer>\n`));

  const timer = new IntervalTimer({ config: validateConfig(planOf(preset)), now: () => performance.now() });
  app.scope.add(() => timer.pause());
  let snapshot = timer.snapshot();
  let now = 0;
  // A workout counts only when every work interval was done, not skipped.
  let skippedWork = false;
  let finished = false;
  let cheer = '';
  let banner = { text: '', at: -Infinity };
  let doneAt = 0;

  function showLook() {
    for (const { id } of HERO_FIELDS) app.signal(signalName('look', id)).set(optionLabel(id, look[id]));
    app.signal('level').set(`Level ${level()}`);
    const next = nextUnlock(level());
    app.signal('unlock').set(next && next.level <= MAX_LEVEL ? `Level ${next.level} unlocks ${next.label.toLowerCase()}` : 'Every look is unlocked');
  }
  function setLook(next) {
    look = normalizeLook(next, { level: level() });
    showLook();
    save();
  }

  function showPlan() {
    const config = snapshot.config;
    for (const id of PLAN_FIELDS) app.signal(signalName('plan', id)).set(id === 'rounds' ? String(config.rounds) : secondsLabel(config[id]));
    const editable = snapshot.status === 'idle' || snapshot.status === 'completed';
    app.signal('editable').set(editable);
    app.signal('planTotal').set(`Takes ${formatTime(snapshot.totalMs)}.${editable ? '' : ' Reset to change it.'}`);
  }

  function cue(previous, next) {
    if (next.status === 'completed') {
      if (previous.status !== 'completed') app.play(TUNES.done);
      return;
    }
    if (next.status !== 'running') return;
    if (previous.status === 'idle' || previous.status === 'completed') return app.play(TUNES.go);
    if (next.stepIndex !== previous.stepIndex) return app.play(TUNES[next.phase] ?? TUNES.tick);
    const left = Math.ceil(next.remainingMs / 1000);
    if (left >= 1 && left <= 3 && left !== Math.ceil(previous.remainingMs / 1000) && next.phaseDurationMs >= 5000) app.play(TUNES.tick);
  }

  function announce(next) {
    const text = next.phase === 'workout' ? `Round ${next.round}!` : { warmup: 'Ready?', rest: 'Breathe', cooldown: 'Cool down' }[next.phase];
    banner = { text, at: now };
  }

  function showTimer(next) {
    const previous = snapshot;
    snapshot = next;
    const exercise = workoutExercise(next);
    app.signal('phase').set(next.status === 'completed' ? 'Done!' : next.status === 'idle' ? 'Ready' : PHASES[next.phase] ?? 'Ready');
    app.signal('move').set(exercise ? MOVES[exercise.id] : '');
    app.signal('round').set(`Round ${next.round}/${next.rounds}`);
    app.signal('go').set(next.status === 'running' ? 'Pause' : next.status === 'paused' ? 'Go on' : 'Start');
    if (next.status === 'running' && (previous.status === 'idle' || previous.status === 'completed' || previous.stepIndex !== next.stepIndex)) announce(next);
    if (next.status === 'completed' && !finished) {
      finished = true;
      doneAt = now;
      banner = { text: '', at: -Infinity };
      const before = level();
      if (skippedWork) {
        cheer = 'Skipped work earns no level';
      } else {
        workouts += 1;
        const unlocked = level() > before ? nextUnlock(before) : null;
        cheer = unlocked ? `Level ${level()}! New: ${unlocked.label.toLowerCase()}` : level() > before ? `Level ${level()}!` : 'Great work!';
        showLook();
        save();
      }
    }
    if (next.status !== 'completed') finished = false;
    if (previous.status !== next.status || previous.config !== next.config) showPlan();
    cue(previous, next);
  }
  app.scope.add(timer.subscribe(showTimer, { emit: false }));

  app.command('go', () => {
    if (snapshot.status === 'idle' || snapshot.status === 'completed') skippedWork = false;
    if (snapshot.status === 'completed') timer.reset();
    timer.toggle();
  });
  app.command('skip', () => {
    if (snapshot.phase === 'workout' && (snapshot.status === 'running' || snapshot.status === 'paused')) skippedWork = true;
    timer.skip();
  });
  app.command('reset', () => timer.reset());
  app.command('prev', field => setLook(stepLook(look, field, -1, { level: level() })));
  app.command('next', field => setLook(stepLook(look, field, 1, { level: level() })));
  app.command('random', () => setLook({ ...randomLook(Math.random, { level: level() }), name: look.name }));

  // The plan steppers edit "Mine", starting from whatever plan is showing.
  const presetSignal = app.signal('preset');
  function usePlan(id) {
    preset = id;
    presetSignal.set(id);
    timer.reset();
    timer.configure(planOf(id));
    save();
  }
  const changePlan = direction => field => {
    if (!PLAN_FIELDS.includes(field)) throw new Error(`Unknown plan field "${field}"`);
    if (!app.signal('editable').value) return;
    mine = stepPlan({ ...snapshot.config }, field, direction);
    usePlan('mine');
  };
  app.command('less', changePlan(-1));
  app.command('more', changePlan(1));
  presetSignal.set(preset);
  app.scope.subscribe(presetSignal, value => {
    if (value === preset) return;
    if (!Object.hasOwn(PRESETS, value) && value !== 'mine') return;
    usePlan(value);
  });
  app.scope.on(app.keys, 'down', ({ key }) => {
    if (key === ' ') app.run('go');
  });
  // A closed window pauses the workout; minimized, it keeps time and keeps calling.
  app.scope.subscribe(app.open, open => {
    if (!open) timer.pause();
  });

  /** Draws a picture of "#" rows with its top left at (x, y). */
  function picture(bitmap, rows, x, y, color, size = 1) {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === '#') bitmap.fill(x + dx * size, y + dy * size, size, size, color);
    });
  }

  function drawSky(bitmap, w, ground, time) {
    const phase = snapshot.status === 'completed' ? 'cooldown' : snapshot.status === 'idle' ? 'warmup' : snapshot.phase;
    bitmap.gradient(0, 0, w, ground, skies[phase]);
    // Stars twinkle by taking turns; with motion off they all stay lit.
    const turn = Math.floor(time / 700);
    for (let k = 0; k < 28; k++) {
      const x = Math.floor(hash(k * 3 + 1) * w), y = Math.floor(hash(k * 3 + 2) * ground * 0.6);
      if (app.motion.value && hash(k * 7919 + turn) < 0.25) continue;
      bitmap.fill(x, y, 1, 1, hash(k * 3 + 3) < 0.3 ? sun : dim);
    }
  }

  /** The whole session as one strip: a segment per interval, in its phase's color. */
  function drawSession(bitmap, w, h) {
    const steps = buildPlan(snapshot.config);
    const total = snapshot.totalMs, width = w - 8, y = h - 4;
    bitmap.fill(4, y, width, 2, track);
    for (const step of steps) {
      const x0 = 4 + Math.round(step.startMs / total * width);
      const x1 = 4 + Math.round(step.endMs / total * width) - (step.endMs < total ? 1 : 0);
      const done = Math.min(step.endMs, Math.max(step.startMs, snapshot.elapsedMs)) - step.startMs;
      const filled = Math.round((x1 - x0) * done / step.durationMs);
      if (x1 - x0 > 0) bitmap.fill(x0, y, x1 - x0, 2, floorTop);
      if (filled > 0) bitmap.fill(x0, y, filled, 2, phaseColors[step.phase]);
    }
  }

  /** Hearts rise beside the hero while it works and burst into sparkles at the top. */
  function drawHearts(bitmap, cx, top, time, size) {
    const period = 700, life = 2100;
    for (let k = Math.floor((time - life) / period) + 1; k <= Math.floor(time / period); k++) {
      const age = time - k * period;
      if (age < 0) continue;
      const side = hash(k) < 0.5 ? -1 : 1;
      const x = cx + side * Math.round((14 + hash(k + 99) * 12) * size) - 3;
      const y = Math.round(top + 12 * size - age / life * 30 * size);
      const color = heartColors[Math.floor(hash(k + 7) * heartColors.length)];
      if (age < life - 300) picture(bitmap, HEART, x, y, color);
      else picture(bitmap, SPARKLE, x + 1, y, sun);
    }
  }

  function drawConfetti(bitmap, w, ground, time) {
    const age = time - doneAt;
    for (let k = 0; k < 40; k++) {
      const speed = 0.012 + hash(k + 500) * 0.02;
      const start = hash(k + 900) * 1500;
      if (app.motion.value && age < start) continue;
      const fall = app.motion.value ? ((age - start) * speed) % (ground + 8) : hash(k + 300) * ground;
      const x = Math.floor(hash(k + 100) * w + (app.motion.value ? Math.sin((age + k * 300) / 400) * 3 : 0));
      const y = Math.floor(fall) - 4;
      const flat = app.motion.value ? Math.floor((age + k * 97) / 200) % 2 : k % 2;
      bitmap.fill(x, y, flat ? 2 : 1, flat ? 1 : 2, confetti[k % confetti.length]);
    }
  }

  function draw(time) {
    const bitmap = stage.bitmap;
    if (!bitmap) return;
    const { w, h } = stage;
    const ground = h - 10;
    drawSky(bitmap, w, ground, time);
    bitmap.fill(0, ground, w, h - ground, floor);
    bitmap.fill(0, ground, w, 1, floorTop);
    for (let x = 0; x < w; x += 12) bitmap.fill(x, ground + 4, 6, 1, floorLine);
    drawSession(bitmap, w, h);

    // Countdown, top left; it stays readable at any window size. Time for the whole session, top right.
    const done = snapshot.status === 'completed';
    const clock = formatTime(done ? 0 : snapshot.remainingMs ?? 0);
    const scale = h >= 90 && w >= 150 ? 2 : 1;
    font.draw(bitmap, clock, 5, 5, ink, { scale, bold: true });
    font.draw(bitmap, clock, 4, 4, cream, { scale, bold: true });
    const left = `${formatTime(snapshot.totalRemainingMs)} left`;
    const leftW = font.measure(left);
    if (w - leftW - 4 > font.measure(clock, { scale, bold: true }) + 12) font.draw(bitmap, left, w - leftW - 4, 4, dim);

    // The hero: 1 art pixel per hero pixel, or 2 when the window is tall enough.
    const exercise = workoutExercise(snapshot);
    const phase = snapshot.status === 'idle' ? 'warmup' : done ? 'cooldown' : snapshot.phase;
    const [main, alternate] = heroPosePair(phase, exercise?.id ?? null);
    const moving = snapshot.status === 'running' && app.motion.value;
    const pose = (moving || done) && app.motion.value && Math.floor(time / POSE_MS) % 2 ? alternate : main;
    const size = h - 16 >= (FEET + 2) * 2 && w >= 120 ? 2 : 1;
    const flip = exercise?.facing === -1;
    const cx = Math.round(w / 2), feet = ground + 1, top = feet - (FEET + 1) * size;
    bitmap.fill(cx - 9 * size, feet - 1, 18 * size, size, floorLine);
    if (done) drawConfetti(bitmap, w, ground, time);
    paintHero(bitmap, pose, cx, feet, size, flip);
    if (exercise && snapshot.status === 'running') {
      if (app.motion.value) drawHearts(bitmap, cx, top, time, size);
      else picture(bitmap, HEART, cx + 14 * size, top + 4 * size, heartColors[0]);
    }

    // A word when a phase begins, and a cheer at the end.
    const lines = done ? [`${look.name} did it!`, cheer] : time - banner.at < BANNER_MS ? [banner.text] : [];
    lines.forEach((text, index) => {
      const y = Math.max(4 + 9 * scale + 2, top - 22) + index * 11;
      font.drawOutlined(bitmap, text, cx - (font.measure(text) >> 1), y, index ? cream : sun, ink);
    });
    stage.commit();
    drawPreview(time);
  }

  /** Feet at (cx, feet); each hero pixel becomes size × size art pixels. */
  function paintHero(bitmap, pose, cx, feet, size = 1, flip = false) {
    for (const { x, y, w, h, c } of heroRects(look, pose).rects) {
      bitmap.fill(cx + (flip ? -(x + w) : x) * size, feet + (y - FEET - 1) * size, w * size, h * size, paint(c));
    }
  }

  // The designer's own preview, so the hero stays in view while it changes.
  function drawPreview(time) {
    const bitmap = preview?.bitmap;
    if (!bitmap) return;
    const { w, h } = preview;
    bitmap.gradient(0, 0, w, h, skies.warmup);
    bitmap.fill(0, h - 4, w, 4, floor);
    bitmap.fill(0, h - 4, w, 1, floorTop);
    const pose = app.motion.value && Math.floor(time / (POSE_MS * 2)) % 2 ? 'guardBob' : 'guard';
    paintHero(bitmap, pose, w >> 1, h - 3);
    preview.commit();
  }

  // The clock keeps going while the window is minimized, so the cues still sound.
  app.frame(({ time }) => {
    now = time;
    timer.tick();
    if (app.visible.value) draw(time);
  }, { background: true });
  showLook();
  showPlan();
  showTimer(timer.snapshot());
}
