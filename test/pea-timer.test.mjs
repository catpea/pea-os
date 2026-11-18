import test from 'node:test';
import assert from 'node:assert/strict';
import { session } from './helpers.mjs';
import { stepPlan } from '../res/apps/pea-timer.js';

// The timer reads performance.now(); the test owns that clock.
let clock = 0;
const realNow = performance.now.bind(performance);
test.before(() => { performance.now = () => clock; });
test.after(() => { performance.now = realNow; });

async function launch(t, stored = new Map()) {
  const live = await session(t, { width: 400, height: 260, stored });
  live.os.run('launch:pea-timer');
  await live.frames(10);
  const app = live.os.app('pea-timer');
  assert.ok(app, 'the app launched');
  return { live, app, os: live.os, stored };
}
const savedXml = stored => [...stored.entries()].find(([key]) => key.includes('pea-timer'))?.[1] ?? '';
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

test('Pea Timer runs a workout, poses the hero, and keeps the look as XML', async t => {
  const { live, app, stored } = await launch(t);
  assert.equal(app.signal('phase').value, 'Ready');
  app.signal('preset').set('quick');
  app.run('go');
  clock += 4000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Warm up');
  assert.equal(app.signal('go').value, 'Pause');
  assert.equal(app.signal('editable').value, false, 'the plan is locked during a session');
  clock += 10000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Work!');
  assert.equal(app.signal('move').value, 'Curls');
  clock += 8000; await live.frames(2);
  assert.equal(app.signal('move').value, 'Press', 'the second third of work is the overhead press');
  app.run('next:hair');
  app.run('prev:skin');
  assert.equal(app.signal('lookHair').value, 'BUN');
  // Locked cosmetics are skipped at level 1: the gi top needs level 2.
  for (let i = 0; i < 6; i++) app.run('next:top');
  assert.notEqual(app.signal('lookTop').value, 'GI');
  clock += 200000; await live.frames(3);
  assert.equal(app.signal('phase').value, 'Done!');
  assert.equal(app.signal('level').value, 'Level 2');
  assert.equal(app.signal('editable').value, true);
  await settle();
  const saved = savedXml(stored);
  assert.match(saved, /<pea-timer version="1" workouts="1" preset="quick">/);
  assert.match(saved, /<plan warmup="30" workout="45" rest="15" cooldown="60" rounds="8"\/>/);
  assert.match(saved, /hair="bun"/);
  assert.deepEqual(live.errors, []);
});

test('a workout with skipped work earns no level; skipping a warmup is fine', async t => {
  const { live, app } = await launch(t);
  app.signal('preset').set('quick');
  app.run('go');
  app.run('skip'); await live.frames(1);
  assert.equal(app.signal('phase').value, 'Work!', 'the warmup was skipped');
  clock += 300000; await live.frames(2);
  assert.equal(app.signal('level').value, 'Level 2');

  app.run('go');
  clock += 15000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Work!');
  app.run('skip'); await live.frames(1);
  clock += 300000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Done!');
  assert.equal(app.signal('level').value, 'Level 2', 'skipped work does not count');
  assert.deepEqual(live.errors, []);
});

test('the plan steppers make "Mine", which is kept and comes back', async t => {
  const stored = new Map();
  {
    const { live, app } = await launch(t, stored);
    app.run('more:rounds');
    app.run('more:workout');
    app.run('less:rest');
    assert.equal(app.signal('preset').value, 'mine');
    assert.equal(app.signal('planRounds').value, '9');
    assert.equal(app.signal('planWorkout').value, '50 s');
    assert.equal(app.signal('planRest').value, '10 s');
    assert.equal(app.signal('round').value, 'Round 1/9');
    app.run('go');
    await live.frames(2);
    app.run('more:rounds');
    assert.equal(app.signal('planRounds').value, '9', 'steppers do nothing during a session');
    assert.match(app.signal('planTotal').value, /Reset to change it/);
    app.run('reset');
    app.signal('preset').set('long');
    assert.equal(app.signal('planWorkout').value, '1:00');
    app.signal('preset').set('mine');
    assert.equal(app.signal('planWorkout').value, '50 s', '"Mine" keeps its times while another preset is chosen');
    await settle();
    assert.match(savedXml(stored), /preset="mine">\n  <plan warmup="30" workout="50" rest="10" cooldown="60" rounds="9"\/>/);
    assert.deepEqual(live.errors, []);
  }
  {
    const { live, app } = await launch(t, stored);
    assert.equal(app.signal('preset').value, 'mine');
    assert.equal(app.signal('planRounds').value, '9');
    assert.deepEqual(live.errors, []);
  }
});

test('stepPlan moves by 5 s under a minute, 15 s under five, then by minutes, within limits', () => {
  const plan = { warmup: 0, workout: 5, rest: 55, cooldown: 300, rounds: 99 };
  assert.equal(stepPlan(plan, 'warmup', -1).warmup, 0);
  assert.equal(stepPlan(plan, 'warmup', 1).warmup, 5);
  assert.equal(stepPlan(plan, 'workout', -1).workout, 5, 'work cannot be switched off');
  assert.equal(stepPlan(plan, 'rest', 1).rest, 60);
  assert.equal(stepPlan({ ...plan, rest: 60 }, 'rest', 1).rest, 75);
  assert.equal(stepPlan({ ...plan, rest: 60 }, 'rest', -1).rest, 55);
  assert.equal(stepPlan(plan, 'cooldown', -1).cooldown, 285);
  assert.equal(stepPlan(plan, 'cooldown', 1).cooldown, 360);
  assert.equal(stepPlan({ ...plan, cooldown: 65 }, 'cooldown', 1).cooldown, 75, 'odd times snap to the step');
  assert.equal(stepPlan(plan, 'rounds', 1).rounds, 99);
});

test('cues sound at the start, in the last three seconds and at each phase; Sounds off is silent', async t => {
  const { live, app, os } = await launch(t);
  app.signal('preset').set('quick');
  live.played.length = 0;
  app.run('go'); await live.frames(1);
  assert.deepEqual(live.played.map(notes => notes.length), [3], 'a three-note start');
  for (let second = 1; second <= 10; second++) { clock += 1000; await live.frames(1); }
  const ticks = live.played.filter(notes => notes.length === 1);
  assert.equal(ticks.length, 3, 'one tick at 3, 2 and 1 seconds left');
  assert.equal(app.signal('phase').value, 'Work!');
  assert.equal(live.played.at(-1).at(-1).hz, 1047, 'work starts on a high note');
  os.signals.set('sound', false);
  const heard = live.played.length;
  clock += 20000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Rest');
  assert.equal(live.played.length, heard);
  assert.throws(() => app.play([{ hz: 5, ms: 10 }]), /hz 0 or 20-12000/);
  assert.deepEqual(live.errors, []);
});

test('a minimized timer keeps time and calls the phases; closing it pauses', async t => {
  const { live, app, os } = await launch(t);
  app.signal('preset').set('quick');
  app.run('go'); await live.frames(1);
  os.model.minimize('pea-timer'); await live.frames(2);
  assert.equal(app.visible.value, false);
  live.played.length = 0;
  clock += 11000; await live.frames(2);
  assert.equal(app.signal('phase').value, 'Work!', 'the phase changed while minimized');
  assert.ok(live.played.length > 0, 'and it was heard');
  os.close('pea-timer'); await live.frames(2);
  assert.equal(app.signal('go').value, 'Go on', 'closing the window paused the workout');
  assert.deepEqual(live.errors, []);
});
