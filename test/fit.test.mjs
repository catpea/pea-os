import test from 'node:test';
import assert from 'node:assert/strict';
import { workoutExercise } from '../src/fit/exercises.js';
import { IntervalTimer } from '../src/fit/interval-timer.js';
import { FEET, HERO_FIELDS, HERO_POSES, DEFAULT_LOOK, heroRects, normalizeLook, stepLook, randomLook, nextUnlock, optionIds } from '../src/fit/hero-doll.js';

// Carried over from Roundhouse 1.2.0 with its fitness modules.

test('exercise thirds use exact elapsed time, persist through pauses and restart each round', () => {
  let now = 0;
  const timer = new IntervalTimer({ now: () => now, config: { warmup: 0, workout: 10, rest: 1, cooldown: 0, rounds: 2 } });
  timer.start();
  assert.equal(workoutExercise(timer.snapshot()).id, 'bicep-curl');
  now = 3333; timer.tick(); assert.equal(workoutExercise(timer.snapshot()).index, 0);
  now = 3334; timer.tick(); assert.equal(workoutExercise(timer.snapshot()).facing, -1);
  timer.pause(); const paused = workoutExercise(timer.snapshot());
  now = 20000; timer.tick(); assert.deepEqual(workoutExercise(timer.snapshot()), paused);
  timer.resume(); now += 3333; timer.tick(); assert.equal(workoutExercise(timer.snapshot()).id, 'lateral-raise');
  timer.skip(); assert.equal(workoutExercise(timer.snapshot()), null);
  timer.skip(); assert.equal(workoutExercise(timer.snapshot()).index, 0);
});

test('hero looks normalize unknown or locked values and stepping skips locked cosmetics', () => {
  assert.deepEqual(normalizeLook({ hair: 'mohawk', skin: 42, __proto__: { top: 'gi' } }), DEFAULT_LOOK);
  assert.equal(normalizeLook({ accessory: 'crown' }, { level: 1 }).accessory, DEFAULT_LOOK.accessory);
  assert.equal(normalizeLook({ accessory: 'crown' }, { level: 6 }).accessory, 'crown');
  let look = { ...DEFAULT_LOOK, accessory: 'scarf' };
  look = stepLook(look, 'accessory', 1, { level: 1 });
  assert.equal(look.accessory, 'none', 'cape and crown are skipped below their levels');
  assert.equal(stepLook(look, 'accessory', -1, { level: 1 }).accessory, 'scarf');
  assert.deepEqual(nextUnlock(1), { field: 'top', id: 'gi', level: 2, label: 'GI' });
  assert.equal(nextUnlock(99), null);
  let seed = 3; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 50; i++) {
    const rolled = randomLook(random, { level: 1 });
    assert.deepEqual(normalizeLook(rolled, { level: 1 }), rolled, 'random looks only use unlocked options');
  }
});

test('every hero pose stands on the same feet with whole-pixel rectangles', () => {
  const looks = [DEFAULT_LOOK, ...optionIds('hair').map(hair => ({ ...DEFAULT_LOOK, hair, accessory: 'cape', build: 'strong' })),
    ...optionIds('top').map(top => ({ ...DEFAULT_LOOK, top, bottoms: 'shorts', accessory: 'gloves', build: 'slim' }))];
  for (const look of looks) for (const pose of Object.keys(HERO_POSES)) {
    const { rects, bounds } = heroRects(look, pose);
    assert.ok(rects.length > 40, `${pose} draws a full figure`);
    for (const { x, y, w, h, c } of rects) {
      assert.ok([x, y, w, h].every(Number.isInteger) && w > 0 && h > 0, `${pose} uses whole art pixels`);
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff);
    }
    assert.equal(bounds.y + bounds.height, FEET + 1, `${pose} soles (plus outline) rest on the floor line`);
    assert.ok(bounds.y >= 0 && Math.abs(bounds.x) <= 24, `${pose} stays inside its art cell`);
  }
  assert.equal(HERO_FIELDS.length, 12);
});

