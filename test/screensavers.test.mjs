import assert from 'node:assert/strict';
import { test } from 'node:test';
import { session } from './helpers.mjs';

const SCENES = ['reef', 'warp', 'rain', 'fireworks', 'squadron'];

const positions = wallpaper => wallpaper.view.children.filter(child => !child.peaClip && child.visible).map(child => `${child.position.x},${child.position.y},${child.scale.x}`);

test('each screen-saver theme moves, keeps moving, and stops with Animations off', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1 } });
  const { os } = live;
  const { wallpaper } = os.desktop;
  os.signals.resolve('motion').set(false);
  await live.frames(1);
  const still = wallpaper.view.children.length; // the painted scene itself
  os.signals.resolve('motion').set(true);
  for (const id of SCENES) {
    os.signals.resolve('theme').set(id);
    await live.frames(30);
    assert.equal(os.ui.theme.value.wallpaper, id);
    const movers = wallpaper.view.children.length - still;
    assert.ok(movers >= 20, `${id} has movers (${movers})`);
    const before = positions(wallpaper).join(' ');
    await live.frames(90);
    assert.notEqual(positions(wallpaper).join(' '), before, `${id} moves`);
    assert.ok(positions(wallpaper).length > 0, `${id} keeps something on screen`);
  }
  os.signals.resolve('motion').set(false);
  await live.frames(2);
  assert.equal(wallpaper.view.children.length, still, 'with Animations off only the still scene remains');
  os.signals.resolve('motion').set(true);
  os.signals.resolve('theme').set('garden');
  await live.frames(2);
  assert.equal(wallpaper.view.children.length - still, Math.max(2, Math.round(960 / 90)), 'a theme change releases the last scene\'s sprites: only the garden\'s clouds are left');
  assert.deepEqual(live.errors, []);
});

test('the screen-saver scenes paint on tiny and huge screens alike', async t => {
  for (const [width, height] of [[160, 100], [1920, 1080]]) {
    for (const theme of SCENES) {
      const live = await session(t, { width, height, options: { pixel: 1, theme } });
      await live.frames(20);
      assert.deepEqual(live.errors, [], `${theme} at ${width}x${height}`);
    }
  }
});
