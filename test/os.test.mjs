import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootHeadless } from '../cli/headless.mjs';
import { check } from '../cli/check.mjs';
import { ROOT } from '../cli/project.mjs';
import { parseXml } from '../src/core/xml.js';
import { App, parseApp } from '../src/os/app.js';
import { DesktopModel } from '../src/os/model.js';
import { Button } from '../src/ui/controls.js';
import { toHex } from '../src/gfx/color.js';
import { session, walk, center, frameOf } from './helpers.mjs';

test('the project validates: manifest, XML, every app under every theme', async () => {
  const { problems, summary } = await check(ROOT);
  assert.deepEqual(problems, []);
  assert.match(summary, /23 apps, 10 themes/);
});

test('tapping an icon opens its app; tapping buttons drives it', async t => {
  const live = await session(t);
  const { os } = live;
  await live.frames(2);
  const icon = [...walk(os.desktop)].find(widget => widget.app?.id === 'calc');
  await live.tap(...center(icon));
  await live.frames(20);
  assert.equal(os.model.state.value.active, 'calc');
  assert.equal(frameOf(live, 'calc').visible, true);

  const press = async label => {
    const button = [...walk(os.app('calc').view)].find(widget => widget instanceof Button && widget.text === label);
    await live.tap(...center(button));
  };
  for (const label of ['1', '2', '×', '3', '=']) await press(label);
  assert.equal(os.app('calc').signal('display').value, '36');
  for (const label of ['÷', '0', '=']) await press(label);
  assert.equal(os.app('calc').signal('display').value, 'Error');
});

test('closing hides a window and keeps what its app held', async t => {
  const live = await session(t, { options: { open: ['calc'] } });
  const { os } = live;
  os.app('calc').run('key:7');
  const app = os.app('calc');
  os.close('calc');
  await live.frames(20);
  assert.equal(frameOf(live, 'calc').visible, false);
  assert.equal(app.visible.value, false);
  os.open('calc');
  await live.frames(20);
  assert.equal(os.app('calc'), app, 'the same instance is shown again');
  assert.equal(app.signal('display').value, '7');
});

test('small screens maximize windows; large ones float them', async t => {
  const phone = await session(t, { width: 270, height: 480, options: { open: ['settings'] } });
  await phone.frames(2);
  const full = frameOf(phone, 'settings');
  assert.deepEqual([full.look.flat, full.look.max, full.x, full.w], [true, false, 0, 270], 'full width, and no zoom box to undo it');

  const desk = await session(t, { width: 480, height: 270, options: { open: ['settings'] } });
  await desk.frames(2);
  assert.equal(frameOf(desk, 'settings').look.flat, false);
});

test('settings are plain signals: a menu pick re-themes the whole screen', async t => {
  const live = await session(t, { width: 320, height: 200 });
  const { os } = live;
  await live.frames(2);
  const before = toHex(live.render().get(160, 100));
  os.run('set:os.theme=pocket');
  await live.frames(2);
  const screen = live.render();
  const colors = new Set();
  for (let i = 0; i < screen.px.length; i += 7) colors.add(toHex(screen.px[i]));
  assert.notEqual(toHex(screen.get(160, 100)), before);
  assert.ok([...colors].every(color => ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'].includes(color)), `palette leak: ${[...colors]}`);
  assert.throws(() => os.run('set:os.nope=1'), /Unknown signal "nope"/);
  assert.equal(os.check('launch:nothing'), `no app "nothing". Apps: ${[...os.apps.keys()].join(', ')}`);
  assert.match(os.check('window:fly'), /"window" needs one of: open, close, minimize/);
  assert.throws(() => os.run('desk:9'), /Cannot run "desk:9": "desk" needs 1 to 4/);
});

test('settings and layout survive a restart; launch options are not remembered', async t => {
  const stored = new Map();
  const first = await session(t, { width: 480, height: 270, stored });
  first.os.run('set:os.theme=night');
  first.os.run('toggle:os.scanlines');
  first.os.run('toggle:os.magnets');
  first.os.open('paint');
  first.os.move('paint', { x: 77, y: 55 });
  first.os.model.mode('paint', 'left');
  first.os.model.icon('calc', { x: 120, y: 90 });
  first.os.run('desk:2');

  const pinned = await session(t, { width: 480, height: 270, stored, options: { theme: 'arcade', pixel: 3 } });
  assert.equal(pinned.os.signals.get('theme'), 'arcade');
  pinned.os.run('set:os.theme=pocket');
  await assert.rejects(bootHeadless({ root: ROOT, stored, options: { theme: 'mauve' } }), /Launch option theme="mauve" is not valid\. Choose one of: garden/);

  const second = await session(t, { width: 480, height: 270, stored });
  const { os } = second;
  assert.deepEqual(
    [os.signals.get('theme'), os.signals.get('scanlines'), os.signals.get('magnets'), os.signals.get('pixel')],
    ['night', true, false, 'auto']
  );
  assert.equal(os.model.state.value.desk, 1, 'the desktop that was showing shows again');
  assert.deepEqual(os.model.state.value.icons, { calc: { x: 120, y: 90 } });
  os.run('desk:1');
  await second.frames(30);
  const paint = os.model.window('paint');
  assert.deepEqual([paint.open, paint.x, paint.y, paint.mode], [true, 77, 55, 'left']);
  assert.equal(frameOf(second, 'paint').visible, true, 'a restored window appears without being reopened');
});

test('the model keeps tools with their owners and restores layouts only when valid', () => {
  const windows = [
    { id: 'a', title: 'A', w: 100, h: 80 },
    { id: 'b', title: 'B', w: 100, h: 80, minW: 50, minH: 40 },
    { id: 'a.tool', title: 'T', owner: 'a', open: true, resizable: false, w: 30, h: 40 }
  ];
  const model = new DesktopModel(windows, { desks: 2 });
  assert.equal(model.shows('a.tool'), false, 'a tool waits for its owner');
  model.open('a', { x: 5, y: 6 });
  model.open('b', { x: 1, y: 2 });
  model.activate('a');
  assert.deepEqual(model.state.value.order, ['b', 'a', 'a.tool'], 'a tool is stacked directly above its owner');
  assert.equal(model.state.value.active, 'a', 'and the owner is the active app');
  assert.ok(Object.isFrozen(model.state.value.windows[0]));

  model.move('a.tool', { x: 200, y: 20 });
  model.move('a', { x: 15, y: 26 });
  assert.deepEqual([model.window('a.tool').x, model.window('a.tool').y], [210, 40], 'a placed tool moves with its owner');
  model.minimize('a');
  assert.deepEqual([model.shows('a.tool'), model.state.value.active], [false, 'b']);
  assert.throws(() => model.minimize('a.tool'), /cannot be minimized/);
  assert.throws(() => model.mode('a.tool', 'max'), /cannot be tiled/);
  assert.throws(() => model.resize('a.tool', { x: 0, y: 0, w: 9, h: 9 }), /fixed size/);

  model.resize('b', { x: 1, y: 2, w: 20, h: 300 });
  assert.deepEqual([model.window('b').w, model.window('b').h], [50, 300], 'a resize stops at the minimum size');
  model.mode('b', 'top-right');
  assert.deepEqual([model.window('b').mode, model.window('b').w], ['top-right', 50], 'tiling leaves the normal rectangle alone');
  model.desk(1);
  assert.equal(model.window('b').open, false, 'each desktop has its own arrangement');
  model.open('b', { x: 9, y: 9 });
  model.pan({ x: 3, y: 4 });
  model.desk(0);
  assert.deepEqual(model.state.value.pan, { x: 0, y: 0 });

  const snapshot = model.snapshot();
  const fresh = new DesktopModel(windows, { desks: 2 });
  fresh.restore(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(fresh.snapshot(), snapshot);
  assert.equal(fresh.state.value.active, 'b');
  assert.deepEqual(fresh.state.value.desks[1].pan, { x: 3, y: 4 });

  const before = fresh.state.value;
  const edit = change => {
    const copy = JSON.parse(JSON.stringify(snapshot));
    change(copy);
    return copy;
  };
  assert.throws(() => fresh.restore(edit(copy => { copy.desks[0].windows[0].id = 'gone'; })), /Unknown window "gone"/);
  assert.throws(() => fresh.restore(edit(copy => { copy.desks[0].order.pop(); })), /order does not match/);
  assert.throws(() => fresh.restore(edit(copy => { copy.desks[0].windows[1].mode = 'sideways'; })), /malformed window/);
  assert.throws(() => fresh.restore(edit(copy => { copy.desks.pop(); })), /needs 2 desktops/);
  assert.throws(() => fresh.restore(edit(copy => { copy.desk = 5; })), /desktop that does not exist/);
  assert.throws(() => fresh.restore({ version: 1, windows: [], order: [] }), /unsupported shape/);
  assert.equal(fresh.state.value, before, 'a refused snapshot changes nothing');
  assert.throws(() => fresh.activate('zzz'), /Unknown window "zzz"/);

  fresh.restore(edit(copy => { copy.desks[0].windows.find(win => win.id === 'a.tool').w = 99; }));
  assert.equal(fresh.window('a.tool').w, 30, 'a fixed-size window keeps the size it declares now');
});

test('view mistakes are reported at their XML line', async t => {
  const live = await session(t);
  const app = (view, extra = '') => () => new App(live.os, parseApp(parseXml(
    `<app version="1" id="x" title="X" sprite="calc">\n<state><signal name="n" type="number" value="1"/></state>\n<view>\n${view}\n</view>${extra}</app>`,
    'x.xml'
  ), 'x'));
  assert.throws(app('<label text="{m}"/>'), /x\.xml:4: <label> text="\{m\}": Unknown signal "m"\. Declared: n/);
  assert.throws(app('<label colour="red"/>'), /x\.xml:4: <label> has an unknown attribute "colour"/);
  assert.throws(app('<label color="mauve"/>'), /neither a #color nor a theme role/);
  assert.throws(app('<button text="Go" action="fly"/>'), /x\.xml:4: <button> action="fly": no command "fly"/);
  assert.throws(app('<button text="Go" action="launch:nowhere"/>'), /no app "nowhere"/);
  assert.throws(app('<button text="Go" action="magnify:moon=2"/>'), /"magnify" needs "target=N"; targets: menubar, taskbar, icons, start, minimap, overview, paint/);
  assert.throws(app('<image sprite="ghost"/>'), /Unknown sprite "ghost"/);
  assert.throws(app('<choice><option value="a" sprite="ghost"/></choice>'), /x\.xml:4: <option> sprite="ghost" is not a known sprite/);
  assert.throws(app('<blink/>'), /<blink> is not allowed inside <view>/);
  assert.throws(app('<label><label/></label>'), /cannot be nested inside <label>/);
  assert.throws(app('<column><label id="a"/><label id="a"/></column>'), /id="a" is already used/);
  assert.throws(app('<label/>', '<tool id="Bad Id"><view><label/></view></tool>'), /<tool> id="Bad Id" must be lowercase/);
  assert.throws(app('<label/>', '<tool id="t"/>'), /<tool> needs exactly one <view>/);

  const good = app('<column><label text="n is {n}"/><slider value="{n}" min="0" max="9"/></column>', '<tool id="t"><view><label text="{n}"/></view></tool>')();
  t.after(() => good.dispose());
  const [label, slider] = good.view.children;
  good.signal('n').set(4);
  assert.equal(label.text, 'n is 4');
  assert.equal(good.tools.get('t').text, '4', 'a tool view shares the app\'s state');
  slider.place(0, 0, 97, 11);
  slider.pointer('down', { x: 93, y: 5 });
  assert.equal(good.signal('n').value, 9, 'a slider writes back to the signal it is bound to');
});
