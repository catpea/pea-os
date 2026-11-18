import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button } from '../src/ui/controls.js';
import { session, walk, center, frameOf, popupOf, pick, caption, slot, commits } from './helpers.mjs';
import { dock } from '../src/os/desktop.js';
import { parseApp } from '../src/os/app.js';
import { parseXml } from '../src/core/xml.js';

/** Everything here runs on a 480 x 270 screen: the work area is y 14 to 254. */
const DESK = { width: 480, height: 270 };
const iconOf = (live, id) => [...walk(live.os.desktop)].find(widget => widget.app?.id === id);

test('dragging commits one move and keeps the caption reachable', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about'] } });
  const { os } = live;
  await live.frames(20); // let the opening animation finish
  const frame = frameOf(live, 'about');
  const [x, y] = caption(frame, 20);
  const count = commits(os);

  os.stage.pointer.emit('down', { x, y });
  os.stage.pointer.emit('move', { x: x + 30, y: y + 20 });
  os.stage.pointer.emit('move', { x: 470, y: 5000 });
  assert.equal(count.n, 0, 'nothing is committed while the gesture is in flight');
  os.stage.pointer.emit('up', { x: 470, y: 5000 });
  assert.equal(count.n, 1);

  const moved = os.model.window('about');
  assert.equal(moved.x, 480 - 40, 'a strip of caption stays on screen');
  const map = os.desktop.minimap;
  assert.ok(map.visible && map.parent === os.desktop.mapOver, 'the map is on top here');
  assert.equal(moved.y + 14, map.y - 13 - 2, 'and rises above the map rather than hide under it');

  // With the map under the windows, the caption only has to stay above the taskbar.
  os.run('set:os.minimap-top=false');
  await live.frames(2);
  os.stage.pointer.emit('down', { x: frame.x + 20, y: frame.y + 5 });
  os.stage.pointer.emit('move', { x: frame.x + 25, y: frame.y + 30 });
  os.stage.pointer.emit('move', { x: 470, y: 5000 });
  os.stage.pointer.emit('up', { x: 470, y: 5000 });
  assert.equal(os.model.window('about').y, 254 - 13 - 14, 'and stays above the taskbar');
  assert.equal(count.n, 2, 'one more move');
  count.n = 1;

  await live.frames(2);
  await live.tap(...caption(frame, 20));
  assert.equal(count.n, 1, 'a tap that does not move commits nothing');
});

test('dragging to the top maximizes; dragging away brings the normal size back under the pointer', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about'] } });
  const { os } = live;
  await live.frames(20);
  const frame = frameOf(live, 'about');
  const normal = frame.frame;

  await live.drag([caption(frame), [240, 60], [240, 5]]);
  assert.equal(os.model.window('about').mode, 'max');
  assert.deepEqual([frame.look.flat, frame.x, frame.w, frame.y + frame.h], [true, 0, 480, 254]);

  await live.drag([[240, 18], [240, 60], [300, 100]]);
  const win = os.model.window('about');
  assert.equal(win.mode, 'normal');
  assert.deepEqual(frame.frame, normal);
  assert.ok(frame.x < 300 && frame.x + normal.w > 300, 'the caption is still under the pointer');

  // A second tap on the caption does what the zoom box does.
  await live.tap(...caption(frame));
  await live.tap(...caption(frame));
  assert.equal(os.model.window('about').mode, 'max');
  const box = frame.toScreen(frame.frame.w - 7, 6);
  await live.tap(box.x, box.y);
  assert.equal(os.model.window('about').mode, 'normal');
});

test('screen edges tile a window, with a preview first', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about'] } });
  const { os } = live;
  await live.frames(20);
  const frame = frameOf(live, 'about');
  const { preview } = os.desktop;

  os.stage.pointer.emit('down', { x: caption(frame)[0], y: caption(frame)[1] });
  os.stage.pointer.emit('move', { x: 100, y: 120 });
  assert.equal(preview.visible, false);
  os.stage.pointer.emit('move', { x: 2, y: 120 });
  await live.frames(1);
  assert.deepEqual([preview.visible, preview.x, preview.y, preview.w, preview.h], [true, 0, 14, 240, 240]);
  os.stage.pointer.emit('up', { x: 2, y: 120 });
  await live.frames(2);
  assert.equal(preview.visible, false);
  assert.equal(os.model.window('about').mode, 'left');
  assert.deepEqual([frame.x, frame.y, frame.frame.w, frame.frame.h], [0, 14, 240, 240]);

  await live.drag([caption(frame), [300, 100], [479, 250]]);
  assert.equal(os.model.window('about').mode, 'bottom-right');
  assert.deepEqual([frame.x, frame.y, frame.frame.w, frame.frame.h], [240, 134, 240, 120]);

  os.run('toggle:os.snap');
  await live.drag([caption(frame), [300, 100], [2, 120]]);
  assert.equal(os.model.window('about').mode, 'normal', 'with snapping off an edge is just an edge');
});

test('nearby window edges attract; Alt places freely', async t => {
  const live = await session(t, { ...DESK, options: { open: ['calc', 'about'] } });
  const { os } = live;
  await live.frames(20);
  os.move('calc', { x: 300, y: 40 });
  os.move('about', { x: 50, y: 60 });
  await live.frames(2);
  const about = frameOf(live, 'about');
  const width = about.frame.w;
  const from = caption(about);
  const to = [from[0] + (300 - width + 3) - 50, from[1]];

  await live.drag([from, to]);
  assert.equal(os.model.window('about').x + width, 300, 'three pixels short of touching snaps to touching');

  os.move('about', { x: 50, y: 60 });
  await live.frames(2);
  await live.drag([from, to], { alt: true });
  assert.equal(os.model.window('about').x + width, 303);

  os.move('about', { x: 50, y: 60 });
  os.run('toggle:os.magnets');
  await live.frames(2);
  await live.drag([from, to]);
  assert.equal(os.model.window('about').x + width, 303, 'and so does everything once magnets are off');
});

test('edges and corners resize, down to the minimum and no further', async t => {
  // Leave room around the larger document toolbar while testing all four edges.
  const live = await session(t, { width: 640, height: 400, options: { open: ['cards', 'paint'] } });
  const { os } = live;
  await live.frames(20);
  os.move('cards', { x: 300, y: 40 });
  os.move('paint', { x: 20, y: 10 });
  os.run('toggle:os.magnets');
  await live.frames(2);
  const frame = frameOf(live, 'paint');
  const before = os.model.window('paint');
  const count = commits(os);
  const corner = () => [frame.x + frame.frame.w - 1, frame.y + frame.frame.h - 1];

  await live.drag([corner(), [corner()[0] + 15, corner()[1] + 5], [corner()[0] + 30, corner()[1] + 10]]);
  let after = os.model.window('paint');
  assert.deepEqual([after.w, after.h, after.x, after.y], [before.w + 30, before.h + 10, before.x, before.y]);
  assert.equal(count.n, 1, 'one resize is one command');

  await live.drag([[frame.x, frame.y + 60], [frame.x + 10, frame.y + 60]]);
  after = os.model.window('paint');
  assert.deepEqual([after.w, after.x], [before.w + 20, before.x + 10], 'the left edge moves; the right edge stays');

  await live.drag([corner(), [0, 0]]);
  after = os.model.window('paint');
  assert.deepEqual([after.w, after.h], [after.minW, after.minH]);
  assert.ok(after.minW < before.w);

  const tool = frameOf(live, 'cards.tools');
  assert.equal(tool.look.sizable, true, 'tools resize too');
  assert.equal(tool.grip.visible, false, 'by their edges: a grow corner would cover the last control');
});

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('dock places tools beside their owner, never over one another', () => {
  const area = { x: 0, y: 14, w: 480, h: 240 };
  const owner = { x: 100, y: 30, w: 150, h: 120, caption: 14 };
  // Two short tools stack in one column to the right.
  const [a, b] = dock(owner, [{ w: 60, h: 80 }, { w: 60, h: 80 }], [], area);
  assert.deepEqual(a, { x: 253, y: 30 });
  assert.deepEqual(b, { x: 253, y: 113 });
  // A third that no longer fits below starts a second column.
  const third = dock(owner, [{ w: 60, h: 100 }, { w: 60, h: 100 }, { w: 60, h: 100 }], [], area);
  assert.deepEqual(third.map(spot => spot.x), [253, 253, 316]);
  // With no room on the right, the left; with no room on either side, inside, stacked upward.
  assert.deepEqual(dock({ ...owner, x: 330 }, [{ w: 140, h: 80 }], [], area), [{ x: 187, y: 30 }]);
  const inside = dock({ x: 10, y: 20, w: 460, h: 230, caption: 14 }, [{ w: 60, h: 80 }, { w: 60, h: 80 }], [], area);
  assert.deepEqual(inside, [{ x: 406, y: 166 }, { x: 406, y: 83 }]);
  // A floating tool is kept clear of.
  const [clear] = dock(owner, [{ w: 60, h: 80 }], [{ x: 255, y: 20, w: 50, h: 50 }], area);
  assert.ok(!overlaps({ ...clear, w: 60, h: 80 }, { x: 255, y: 20, w: 50, h: 50 }));
  // The map is avoided where possible, and only then given up on.
  const map = { x: 250, y: 20, w: 100, h: 200 };
  assert.deepEqual(dock(owner, [{ w: 60, h: 80 }], [], area, [map]), [{ x: 37, y: 30 }], 'here on the left');
  assert.deepEqual(dock(owner, [{ w: 60, h: 80 }], [], area, [{ x: 0, y: 0, w: 480, h: 270 }]), [{ x: 253, y: 30 }]);
});

test('two tools of one window never cover each other, and the first stays put when a second opens', async t => {
  const live = await session(t, { width: 640, height: 400, options: { open: ['pea-timer'] } });
  const { os } = live;
  await live.frames(20);
  os.run('tool:pea-timer.hero');
  await live.frames(4);
  const hero = frameOf(live, 'pea-timer.hero');
  const owner = frameOf(live, 'pea-timer');
  assert.deepEqual([hero.x, hero.y], [owner.x + owner.bounds.w + 3, owner.y], 'the only open tool takes the first place');
  const first = [hero.x, hero.y];
  os.run('tool:pea-timer.plan');
  await live.frames(4);
  const plan = frameOf(live, 'pea-timer.plan');
  assert.deepEqual([hero.x, hero.y], first, 'opening a second tool does not move the first');
  assert.ok(!overlaps(hero.bounds, plan.bounds), 'and the second does not cover it');
  assert.ok(!overlaps(owner.bounds, plan.bounds), 'nor the window: here it goes to the left, where there is room');

  // Closing the first lets the second move up into its place.
  os.run('tool:pea-timer.hero');
  await live.frames(4);
  assert.deepEqual([plan.x, plan.y], first);
  assert.deepEqual(live.errors, []);
});

test('tool windows resize; a docked one stays docked unless pulled from its left or top', async t => {
  const live = await session(t, { width: 640, height: 400, options: { open: ['pea-timer'] } });
  const { os } = live;
  await live.frames(20);
  os.run('toggle:os.magnets');
  os.run('tool:pea-timer.hero');
  await live.frames(4);
  const tool = frameOf(live, 'pea-timer.hero');
  const before = os.model.window('pea-timer.hero');
  const bottom = () => [tool.x + 40, tool.y + tool.frame.h - 1];
  await live.drag([bottom(), [bottom()[0], bottom()[1] + 10], [bottom()[0], bottom()[1] + 20]]);
  let after = os.model.window('pea-timer.hero');
  assert.deepEqual([after.h, after.x, after.y], [before.h + 20, null, null], 'taller, and still docked');

  await live.drag([bottom(), [bottom()[0], 0]]);
  after = os.model.window('pea-timer.hero');
  assert.equal(after.h, after.minH, 'no shorter than its minimum');
  assert.ok(after.minH < before.h, 'which the app set below the declared height');

  await live.drag([[tool.x, tool.y + 40], [tool.x - 10, tool.y + 40]]);
  after = os.model.window('pea-timer.hero');
  assert.equal(after.w, before.w + 10);
  assert.notEqual(after.x, null, 'pulled from the left, it floats where it was put');

  const fixed = parseApp(parseXml(`<app version="1" id="f" title="F" sprite="calc">
    <view><column/></view>
    <tool id="t" width="40" height="40" resize="false"><view><column/></view></tool>
  </app>`, 'f.xml'), 'f');
  assert.equal(fixed.tools[0].resizable, false, 'resize="false" fixes a tool');
  assert.deepEqual(live.errors, []);
});

test('the taskbar switches, minimizes and restores windows', async t => {
  const live = await session(t, { ...DESK, options: { open: ['calc', 'about'] } });
  const { os } = live;
  await live.frames(20);
  const task = id => slot(live, 'task', candidate => candidate.id === id);
  assert.equal(os.model.state.value.active, 'about');

  await live.tap(...task('calc'));
  assert.equal(os.model.state.value.active, 'calc');

  await live.tap(...task('calc'));
  await live.frames(20);
  assert.deepEqual([os.model.window('calc').min, frameOf(live, 'calc').visible, os.app('calc').visible.value], [true, false, false]);
  assert.equal(os.model.state.value.active, 'about');

  await live.tap(...task('calc'));
  await live.frames(20);
  assert.deepEqual([os.model.window('calc').min, frameOf(live, 'calc').visible, os.model.state.value.active], [false, true, 'calc']);

  await live.tap(...slot(live, 'peek'));
  assert.deepEqual([os.model.window('calc').min, os.model.window('about').min, os.model.state.value.active], [true, true, null]);
  await live.tap(...slot(live, 'peek'));
  assert.deepEqual([os.model.window('calc').min, os.model.window('about').min], [false, false]);

  await live.tap(...slot(live, 'launcher'));
  assert.ok(popupOf(live), 'the pea opens the launcher');
  await pick(live, 'Pea Paint');
  await live.frames(20);
  assert.equal(os.model.state.value.active, 'paint');

  os.run('toggle:os.taskbar');
  await live.frames(2);
  assert.equal(os.desktop.work.h, 270 - 14, 'without the taskbar the work area reaches the bottom');
});

test('a right click magnifies one window, for this pixel size only', async t => {
  const stored = new Map();
  const live = await session(t, { ...DESK, stored, options: { open: ['about', 'calc'] } });
  const { os } = live;
  await live.frames(20);
  const calc = frameOf(live, 'calc');
  const about = frameOf(live, 'about');
  const size = calc.frame;

  await live.tap(...caption(calc), 2);
  assert.deepEqual(popupOf(live).items.slice(0, 4).map(item => [item.text, Boolean(item.checked)]), [['Size 1×', true], ['Size 2×', false], ['Size 3×', false], ['Size 4×', false]]);
  await pick(live, 'Size 2×');
  await live.frames(2);
  assert.deepEqual([os.zoomOf('calc'), calc.zoom, about.zoom], [2, 2, 1]);
  assert.deepEqual(calc.frame, size, 'the window keeps its own pixels');
  assert.deepEqual([calc.bounds.w, calc.bounds.h], [size.w * 2, size.h * 2], 'and covers twice as many of the desktop\'s');

  // Its buttons are still where they look.
  const seven = [...walk(os.app('calc').view)].find(widget => widget instanceof Button && widget.text === '7');
  assert.equal(seven.magnification, 2);
  await live.tap(...center(seven));
  assert.equal(os.app('calc').signal('display').value, '7');

  // A right click inside the content reaches the window's menu too.
  await live.tap(...center(seven), 2);
  assert.equal(popupOf(live).items[1].checked, true);
  await live.tap(470, 240);
  assert.equal(popupOf(live), null, 'a press elsewhere closes the menu');

  os.run('set:os.pixel=1');
  await live.frames(2);
  assert.equal(calc.zoom, 1, 'pixel size 1 has its own magnifications');
  os.run('magnify:menubar=2');
  os.run('magnify:calc=3');
  await live.frames(2);
  assert.deepEqual([os.desktop.bar.zoom, os.desktop.work.y, calc.zoom], [2, 28, 3]);
  os.run('set:os.pixel=auto');
  await live.frames(2);
  assert.deepEqual([os.desktop.bar.zoom, calc.zoom], [1, 2], 'going back brings back what was chosen there');
  assert.deepEqual(os.signals.get('magnify'), { auto: { calc: 2 }, 1: { menubar: 2, calc: 3 } });

  os.run('magnify:calc=1');
  assert.deepEqual(os.signals.get('magnify'), { 1: { menubar: 2, calc: 3 } }, 'size 1 stores nothing');
  assert.throws(() => os.setZoom('moon', 2), /"moon" cannot be magnified/);

  const again = await session(t, { ...DESK, stored, options: { pixel: 1 } });
  assert.deepEqual([again.os.zoomOf('menubar'), again.os.zoomOf('calc'), again.os.zoomOf('taskbar')], [2, 3, 1], 'magnifications are remembered');
});

test('the menu bar, the taskbar and the icons have context menus that magnify them', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about'] } });
  const { os } = live;
  await live.frames(20);
  const about = frameOf(live, 'about');
  const top = about.y;

  await live.tap(300, 5, 2);
  await pick(live, 'Menus 2×');
  await live.frames(2);
  assert.equal(os.desktop.bar.zoom, 2);
  assert.equal(about.y, top + 14, 'windows make room for the taller bar');

  // Menus open at the bar's size, and their items still land.
  await live.tap(20, 10);
  assert.equal(popupOf(live).zoom, 2);
  await pick(live, 'Settings');
  await live.frames(20);
  assert.equal(os.model.state.value.active, 'settings');

  await live.tap(300, 262, 2);
  await pick(live, 'Taskbar 2×');
  await live.frames(2);
  assert.deepEqual([os.desktop.tasks.zoom, os.desktop.tasks.y], [2, 270 - 32]);

  const icon = iconOf(live, 'paint');
  await live.tap(...center(icon), 2);
  assert.deepEqual(popupOf(live).items.map(item => item.text ?? '-'), ['Open', '-', 'Icons 1×', 'Icons 2×', 'Icons 3×', 'Icons 4×', 'Tidy icons']);
  await pick(live, 'Icons 2×');
  await live.frames(2);
  assert.equal(icon.zoom, 2);
  await live.tap(...center(icon), 2);
  await pick(live, 'Open');
  await live.frames(20);
  assert.equal(os.model.state.value.active, 'paint');
});

test('a long press opens a context menu on chrome, never on app content', async t => {
  const live = await session(t, { ...DESK, options: { open: ['calc'] } });
  const { os } = live;
  await live.frames(20);
  const calc = frameOf(live, 'calc');
  const [x, y] = caption(calc);

  os.stage.pointer.emit('down', { x, y });
  await live.frames(20);
  assert.equal(popupOf(live), null, 'not yet');
  await live.frames(20);
  assert.ok(popupOf(live), 'held still for over half a second');
  os.stage.pointer.emit('up', { x, y });
  await live.frames(2);
  assert.ok(popupOf(live), 'letting go leaves the menu open');
  await pick(live, 'Roll up');
  await live.frames(2);
  assert.deepEqual([calc.look.shade, calc.frame.h, calc.content.visible], [true, 14, false]);
  os.run('window:shade');
  await live.frames(2);

  const seven = [...walk(os.app('calc').view)].find(widget => widget instanceof Button && widget.text === '7');
  os.stage.pointer.emit('down', { x: center(seven)[0], y: center(seven)[1] });
  await live.frames(45);
  assert.equal(popupOf(live), null);
  os.stage.pointer.emit('up', { x: center(seven)[0], y: center(seven)[1] });
  assert.equal(os.app('calc').signal('display').value, '7', 'a slow press is still a press');

  // A press whose release never arrived is ended by the next press, not left holding the pointer.
  os.stage.pointer.emit('down', { x: center(seven)[0], y: center(seven)[1] });
  await live.tap(...center(seven));
  assert.equal(os.app('calc').signal('display').value, '77');

  // A press that wanders is a drag, not a long press.
  os.stage.pointer.emit('down', { x, y });
  os.stage.pointer.emit('move', { x: x + 10, y: y + 10 });
  await live.frames(45);
  os.stage.pointer.emit('up', { x: x + 10, y: y + 10 });
  assert.equal(popupOf(live), null);
});

test('virtual desktops keep their own windows, pan and active window', async t => {
  const stored = new Map();
  const live = await session(t, { ...DESK, stored, options: { open: ['calc'] } });
  const { os } = live;
  await live.frames(20);
  const at = os.model.window('calc').x;
  os.model.pan({ x: 5, y: 6 });

  os.run('desk:2');
  await live.frames(30);
  assert.deepEqual([os.model.state.value.desk, os.signals.get('desk'), frameOf(live, 'calc').visible], [1, 2, false]);
  assert.deepEqual(os.model.state.value.pan, { x: 0, y: 0 });
  os.open('about');
  await live.frames(20);

  await live.tap(...slot(live, 'desk', candidate => candidate.index === 0));
  await live.frames(30);
  assert.deepEqual([frameOf(live, 'calc').visible, frameOf(live, 'about').visible, os.model.state.value.active], [true, false, 'calc']);
  assert.deepEqual(os.model.state.value.pan, { x: 5, y: 6 });

  await live.tap(...caption(frameOf(live, 'calc')), 2);
  await pick(live, 'Move to desktop 3');
  await live.frames(20);
  assert.deepEqual([os.model.window('calc').open, os.model.state.value.active], [false, null]);
  os.run('desk:3');
  await live.frames(30);
  assert.deepEqual([os.model.window('calc').open, os.model.window('calc').x, os.model.state.value.active], [true, at, 'calc']);

  os.run('desk:next');
  os.run('desk:next');
  assert.equal(os.model.state.value.desk, 0, 'next wraps around');
  os.run('desk:previous');
  assert.equal(os.model.state.value.desk, 3);
  await live.frames(40);

  const again = await session(t, { ...DESK, stored });
  await again.frames(2);
  assert.equal(again.os.model.state.value.desk, 3);
  again.os.run('desk:3');
  await again.frames(30);
  assert.equal(frameOf(again, 'calc').visible, true);
});

test('panning moves windows but not icons, and commits once', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about'] } });
  const { os } = live;
  os.signals.resolve('minimap').set(false); // this test deliberately drags the empty corner of the desktop
  await live.frames(20);
  const about = frameOf(live, 'about');
  const icon = iconOf(live, 'paint');
  const start = { window: about.x, icon: icon.x };
  const count = commits(os);
  const empty = [[430, 230], [400, 220], [380, 210]];

  await live.drag(empty);
  assert.deepEqual([os.model.state.value.pan, count.n], [{ x: 0, y: 0 }, 0], 'a plain drag on the desk does nothing');

  os.stage.pointer.emit('down', { x: 430, y: 230, button: 1 });
  os.stage.pointer.emit('move', { x: 380, y: 210, button: 1 });
  await live.frames(1);
  assert.deepEqual([about.x, icon.x, count.n], [start.window - 50, start.icon, 0], 'the middle button drags the windows off the icons; nothing is stored yet');
  os.stage.pointer.emit('up', { x: 380, y: 210, button: 1 });
  assert.deepEqual([os.model.state.value.pan, count.n], [{ x: 50, y: 20 }, 1]);
  await live.frames(1);
  assert.equal(icon.x, start.icon, 'icons stay on the screen once the pan is stored');
  assert.ok(!live.os.desktop.worldItems().some(item => item.kind === 'icon'), 'and are not on the map of the world');

  await live.drag([center(about), [center(about)[0] - 10, center(about)[1]]], { button: 1 });
  assert.equal(os.model.state.value.pan.x, 60, 'the middle button pans from over a window too');

  await live.tap(...slot(live, 'pan'));
  assert.equal(os.signals.get('pan-mode'), true);
  await live.drag(empty);
  assert.deepEqual(os.model.state.value.pan, { x: 110, y: 40 }, 'in pan mode a plain drag pans');
  os.run('toggle:os.pan-mode');

  os.stage.keys.emit('down', { key: ' ' });
  await live.drag(empty);
  os.stage.keys.emit('up', { key: ' ' });
  assert.equal(os.model.state.value.pan.x, 160, 'and so does a drag with Space held');

  // A window far away: its task button scrolls the desktop to it.
  os.model.pan({ x: 2000, y: 0 });
  os.open('calc');
  await live.frames(20);
  assert.ok(about.x + about.bounds.w < 0);
  await live.tap(...slot(live, 'task', candidate => candidate.id === 'about'));
  await live.frames(30);
  assert.ok(about.x >= 0 && about.x + about.bounds.w <= 480, 'the window is back in view');
  assert.equal(os.model.state.value.active, 'about');

  // Gather brings everything home; with panning off nothing can be lost.
  os.run('arrange:gather');
  await live.frames(2);
  const calc = frameOf(live, 'calc');
  assert.deepEqual(os.model.state.value.pan, { x: 0, y: 0 });
  assert.ok(calc.x >= 0 && calc.x + calc.bounds.w <= 480 && about.x >= 0);
  os.model.pan({ x: 3000, y: 0 });
  os.run('toggle:os.panning');
  await live.frames(2);
  assert.equal(about.x, 40 - about.bounds.w, 'a strip of caption stays reachable');
  await live.drag(empty, { button: 1 });
  assert.equal(os.model.state.value.pan.x, 3000, 'and the middle button no longer pans');
});

test('tool windows float above their owner, follow it and hide with it', async t => {
  const live = await session(t, { ...DESK, options: { open: ['cards'] } });
  const { os } = live;
  await live.frames(20);
  const owner = frameOf(live, 'cards');
  const tool = frameOf(live, 'cards.tools');
  // Beside its owner, on the side the always-on-top map leaves clear (the left, on this small screen).
  const besideOwner = () => tool.x === owner.x + owner.bounds.w + 3 || tool.x + tool.bounds.w + 3 === owner.x;
  assert.deepEqual([tool.visible, tool.look.tool, besideOwner()], [true, true, true], 'docked beside its owner');
  const map = os.desktop.minimap;
  assert.ok(map.visible && !overlaps(tool.bounds, { x: map.x, y: map.y, w: map.w * map.zoom, h: map.h * map.zoom }), 'clear of the map');
  // Jukebox's playlist opens with Jukebox, so until then it waits in the order unseen.
  assert.deepEqual(os.model.state.value.order.filter(id => id !== 'music.playlist'), ['cards', 'cards.tools']);
  assert.ok(!os.desktop.tasks.slots().some(candidate => candidate.id === 'cards.tools'), 'a tool has no task button');

  const win = os.model.window('cards');
  os.move('cards', { x: win.x - 20, y: win.y + 10 });
  await live.frames(2);
  assert.ok(besideOwner(), 'a docked tool stays docked');

  await live.drag([[tool.x + 20, tool.y + 4], [tool.x + 10, tool.y + 30], [tool.x - 10, tool.y + 44]]);
  const placed = os.model.window('cards.tools');
  assert.ok(placed.x !== null, 'dragging gives it a place of its own');
  os.move('cards', { x: win.x - 10, y: win.y + 10 });
  assert.equal(os.model.window('cards.tools').x, placed.x + 10, 'which then moves with the owner');

  os.open('about');
  await live.frames(20);
  assert.deepEqual(os.model.state.value.order.filter(id => id !== 'music.playlist'), ['cards', 'cards.tools', 'about']);
  await live.tap(tool.x + tool.bounds.w - 4, tool.y + 40); // the strip of the tool that About does not cover
  assert.deepEqual(os.model.state.value.order.filter(id => id !== 'music.playlist'), ['about', 'cards', 'cards.tools'], 'pressing a tool raises its owner with it');
  assert.equal(os.model.state.value.active, 'cards');
  assert.equal(owner.active && tool.active, true);

  os.model.minimize('cards');
  await live.frames(20);
  assert.equal(tool.visible, false);
  os.activate('cards');
  await live.frames(20);
  assert.equal(tool.visible, true);

  // Closed from its own menu, brought back from its owner's.
  await live.tap(tool.x + 20, tool.y + 4, 2);
  await pick(live, 'Close');
  await live.frames(2);
  assert.deepEqual([tool.visible, owner.visible], [false, true]);
  await live.tap(...caption(owner), 2);
  assert.equal(popupOf(live).items.find(item => item.text === 'Tools').checked, false);
  await pick(live, 'Tools');
  await live.frames(2);
  assert.equal(tool.visible, true);
});

test('icons can be dragged; they land on the grid and can be tidied', async t => {
  const live = await session(t, DESK);
  const { os } = live;
  await live.frames(2);
  const icon = iconOf(live, 'paint');
  const [x, y] = center(icon);

  await live.drag([[x, y], [x + 100, y + 50], [300, 150]]);
  await live.frames(2);
  const placed = os.model.state.value.icons.paint;
  assert.ok(placed, 'the icon has a place of its own');
  assert.deepEqual([(placed.x - 4) % 58, (placed.y - 6) % 42], [0, 0], 'on the grid');
  assert.ok(Math.abs(center(icon)[0] - 300) < 40 && Math.abs(center(icon)[1] - 150) < 30);
  assert.equal(os.model.state.value.active, null, 'a drag does not open the app');

  os.run('toggle:os.grid');
  await live.drag([center(icon), [203, 111]]);
  const free = os.model.state.value.icons.paint;
  assert.ok((free.x - 4) % 58 !== 0 || (free.y - 6) % 42 !== 0, 'off the grid when the grid is off');

  os.run('toggle:os.labels');
  await live.frames(2);
  assert.equal(icon.h, 30, 'without labels an icon is just its tile');

  os.run('arrange:icons');
  await live.frames(2);
  assert.deepEqual(os.model.state.value.icons, {});
  assert.deepEqual([icon.x, icon.y], [4, 14 + 6]);
});

test('the on-screen keyboard types the same keys a real one does', async t => {
  const live = await session(t, { ...DESK, options: { open: ['calc'] } });
  const { os } = live;
  await live.frames(20);
  const typed = [];
  os.app('calc').keys.on('down', event => typed.push(event.key));
  const { keys } = os.desktop;
  const press = async value => {
    const at = keys.locate(value);
    assert.ok(at, `the keyboard shows "${value}"`);
    const { x, y } = keys.toScreen(at.x, at.y);
    await live.tap(x, y);
  };

  assert.equal(keys.visible, false);
  await live.tap(...slot(live, 'keys'));
  assert.equal(keys.visible, true);
  assert.equal(os.desktop.work.h, keys.y - 14, 'the work area ends where the keyboard begins');

  for (const value of ['a', 'Shift', 'b', 'c', ' ', 'layer:123', '7', 'layer:abc', 'Backspace', 'Enter']) await press(value);
  assert.deepEqual(typed, ['a', 'B', 'c', ' ', '7', 'Backspace', 'Enter']);
});

test('settings.xml can be saved, read back and is refused whole when wrong', async t => {
  const live = await session(t, DESK);
  const { os } = live;
  os.run('set:os.theme=arcade');
  os.run('set:os.pixel=2');
  os.run('toggle:os.snap');
  os.run('magnify:taskbar=2');
  os.run('save-settings');
  const [file] = live.downloads;
  assert.equal(file.name, 'settings.xml');
  assert.match(file.text, /<set name="theme" value="arcade"\/>/);
  assert.match(file.text, /<magnify pixel="2">\n {4}<zoom target="taskbar" value="2"\/>/);

  const other = await session(t, { ...DESK, files: [file] });
  other.os.run('load-settings');
  await other.frames(2);
  assert.deepEqual(
    [other.os.signals.get('theme'), other.os.signals.get('pixel'), other.os.signals.get('snap'), other.os.zoomOf('taskbar')],
    ['arcade', 2, false, 2]
  );
  assert.equal(other.os.settingsXml(), file.text, 'a round trip changes nothing');

  const wrong = '<settings version="1">\n<set name="theme" value="night"/>\n<set name="pixle" value="3"/>\n</settings>';
  assert.throws(() => other.os.applySettings(wrong, 'mine.xml'), /mine\.xml:3: <set> name="pixle" is not a setting\. Settings: theme, pixel/);
  assert.equal(other.os.signals.get('theme'), 'arcade', 'nothing from a wrong file is applied');
  assert.throws(() => other.os.applySettings('<settings version="1"><magnify pixel="1"><zoom target="calc" value="9"/></magnify></settings>'), /value="9" must be one of 1, 2, 3, 4/);
  assert.throws(() => other.os.applySettings('<settings version="1"><magnify pixel="7"/></settings>'), /pixel="7" must be one of auto, 1, 2/);
});

test('a window and its tools move as one during a drag, and a tool rides the edge it is near during a resize', async t => {
  const live = await session(t, { width: 640, height: 400, options: { open: ['cards'] } });
  const { os } = live;
  await live.frames(20);
  const owner = frameOf(live, 'cards');
  const tool = frameOf(live, 'cards.tools');
  const gap = tool.x - owner.x;
  const [cx, cy] = caption(owner);
  // Mid-drag, before anything is committed, the docked tool is already beside the window.
  os.stage.pointer.emit('down', { x: cx, y: cy });
  for (const step of [10, 20, 30]) {
    os.stage.pointer.emit('move', { x: cx - step, y: cy + step });
    await live.frames(1);
  }
  assert.equal(tool.x - owner.x, gap, 'the tool keeps its place while the drag is still going');
  assert.equal(tool.y, owner.y);
  os.stage.pointer.emit('up', { x: cx - 30, y: cy + 30 });
  await live.frames(2);
  assert.equal(tool.x - owner.x, gap);

  // A floating tool to the right of the window rides the right edge as the window grows.
  const win = os.model.window('cards');
  os.model.move('cards.tools', { x: win.x + 120, y: win.y + 40 });
  await live.frames(2);
  const start = { x: tool.x, y: tool.y };
  const corner = owner.toScreen(owner.frame.w - 3, owner.frame.h - 3);
  os.stage.pointer.emit('down', { x: corner.x, y: corner.y });
  os.stage.pointer.emit('move', { x: corner.x + 20, y: corner.y + 6 });
  await live.frames(1);
  os.stage.pointer.emit('move', { x: corner.x + 40, y: corner.y + 12 });
  await live.frames(1);
  const grown = owner.frame.w - win.w;
  assert.ok(grown > 0, 'the window grew');
  assert.equal(tool.x, start.x + grown * owner.zoom, 'mid-resize, the tool keeps its distance from the right edge');
  os.stage.pointer.emit('up', { x: corner.x + 40, y: corner.y + 12 });
  await live.frames(2);
  assert.equal(os.model.window('cards.tools').x, win.x + 120 + grown, 'and the resize commits it there');
  assert.equal(tool.x, start.x + grown * owner.zoom);
  assert.deepEqual(live.errors, []);
});

test('a window can be kept on top, and kept on whichever desktop is showing', async t => {
  const live = await session(t, { ...DESK, options: { open: ['about', 'calc'] } });
  const { os } = live;
  await live.frames(20);
  os.desktop.openContext('window', 'about', { gx: 100, gy: 100 });
  await pick(live, 'Always on top');
  await live.frames(2);
  assert.equal(os.model.window('about').top, true);
  os.activate('calc');
  await live.frames(2);
  const state = os.model.state.value;
  assert.equal(state.active, 'calc', 'the top window does not steal the focus');
  assert.equal(state.layers.at(-1), 'about', 'but it is drawn in front');
  assert.equal(os.desktop.windows.children.at(-1).id, 'about');

  os.run('window:all', null, { window: 'calc' });
  const before = frameOf(live, 'calc').x;
  os.run('desk:2');
  await live.frames(30);
  const there = os.model.state.value;
  assert.equal(there.desk, 1);
  assert.ok(there.windows.find(win => win.id === 'calc').open, 'it came along');
  assert.ok(!there.windows.find(win => win.id === 'about').open, 'the others stay behind');
  assert.equal(frameOf(live, 'calc').x, before, 'at the same place on screen');
  const snapshot = os.model.snapshot();
  os.model.restore(snapshot);
  assert.equal(os.model.window('calc').all, true, 'a saved layout remembers it');

  os.desktop.openContext('window', 'calc', { gx: 100, gy: 100 });
  const item = popupOf(live).items.find(entry => entry.text === 'Always on visible workspace');
  assert.equal(item.checked, true);
  assert.deepEqual(live.errors, []);
});

test('a window does not jitter against its own docked tool while it is dragged or resized', async t => {
  const live = await session(t, { width: 960, height: 540, options: { open: ['music'], pixel: 1 } });
  const { os } = live;
  await live.frames(20);
  const owner = frameOf(live, 'music');
  const tool = frameOf(live, 'music.playlist');
  const gap = () => tool.x < owner.x ? owner.x - tool.x - tool.frame.w : tool.x - owner.x - owner.frame.w;
  assert.equal(gap(), 3, 'the playlist is docked a magnet’s reach away');

  // One pixel at a time, the window keeps exactly to the pointer once the drag has begun.
  const [x, y] = caption(owner, 20);
  const start = owner.x;
  os.stage.pointer.emit('down', { x, y });
  const steps = [];
  for (let i = 1; i <= 12; i++) {
    os.stage.pointer.emit('move', { x: x + i, y });
    steps.push(owner.x - start);
  }
  os.stage.pointer.emit('up', { x: x + 12, y });
  const begun = steps.findIndex(step => step !== 0);
  assert.deepEqual(steps.slice(begun), Array.from({ length: 12 - begun }, (_, i) => begun + 1 + i), 'no step jumps back');
  assert.equal(gap(), 3, 'and the playlist came along');
  await live.frames(2);

  // Resized from the edge the playlist is docked on, that edge keeps to the pointer too.
  const left = tool.x < owner.x;
  const edge = left ? owner.x : owner.x + owner.frame.w - 1;
  const ey = owner.y + 50;
  const width = owner.frame.w;
  os.stage.pointer.emit('down', { x: edge, y: ey });
  const sizes = [];
  for (let i = 1; i <= 8; i++) {
    os.stage.pointer.emit('move', { x: edge + (left ? -i : i), y: ey });
    sizes.push(owner.frame.w - width);
  }
  os.stage.pointer.emit('up', { x: edge + (left ? -8 : 8), y: ey });
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] >= sizes[i - 1], `the width only grows: ${sizes}`);
  assert.equal(sizes.at(-1), 8);
  await live.frames(2);
  assert.equal(gap(), 3, 'the playlist is still docked beside it');
});

test('a task button’s words fit inside it, bold or not, and stay the same when it is chosen', async t => {
  const { taskLabel, TASK_MAX } = await import('../src/os/taskbar.js');
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, open: ['notes', 'http'] } });
  const { os } = live;
  const { font } = os.desktop.ui;
  const widest = TASK_MAX - 1;
  for (const app of os.apps.values()) assert.equal(taskLabel(font, app.title, widest), app.title, `${app.title} shows whole on the widest button`);
  for (const w of [20, 30, 45, 60]) {
    for (const app of os.apps.values()) {
      const label = taskLabel(font, app.title, w);
      if (label !== null) assert.ok(14 + font.measure(label, { bold: true }) <= w - 3, `${label} fits ${w}`);
    }
  }
  await live.frames(20);
  const words = () => os.desktop.tasks.slots().filter(slot => slot.kind === 'task').map(slot => taskLabel(font, slot.title, slot.w));
  const before = words();
  assert.deepEqual(before, ['Sticky Notes', 'HTTP Probe']);
  os.activate('notes');
  await live.frames(2);
  assert.deepEqual(words(), before, 'choosing a window does not change its words');
});
