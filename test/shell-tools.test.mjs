import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signal } from '../src/core/reactive.js';
import { DesktopModel } from '../src/os/model.js';
import { StickyNotes, StickyNote } from '../src/os/sticky-notes.js';
import { Launcher } from '../src/os/launcher.js';
import { mapProjection } from '../src/os/minimap.js';
import { toHex } from '../src/gfx/color.js';
import { TITLE_H } from '../src/gfx/skin.js';
import { session, walk, frameOf, popupOf, slot, pick } from './helpers.mjs';

test('sticky notes import atomically, repair ID collisions, and retain work after storage failure', () => {
  const storage = new Map();
  const os = { platform: { storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) } },
    model: { state: new Signal({ desk: 0, desks: [{}, {}, {}, {}] }) }, report() {} };
  const desktop = { toWorld: point => point, work: { y: 14 }, revealNote() {} };
  const notes = new StickyNotes(os, desktop);
  const first = notes.create({ text: 'Keep this thought' });
  const exported = notes.export();
  assert.equal(notes.import(exported), 1);
  assert.equal(new Set(notes.state.value.notes.map(note => note.id)).size, 2);
  const before = notes.export();
  assert.throws(() => notes.import(JSON.stringify({ version: 1, notes: [{ ...first, desk: 99 }] })), /invalid/);
  assert.equal(notes.export(), before, 'a malformed import changes nothing');
  os.platform.storage.set = () => { throw new Error('disk full'); };
  assert.throws(() => notes.patch(first.id, { text: 'Still recoverable' }), /could not be saved/);
  assert.equal(notes.state.value.notes[0].text, 'Still recoverable');
  assert.match(notes.export(), /Still recoverable/);
  assert.match(notes.error.value, /Export a copy/);
  notes.dispose();
});

test('old layouts preserve camera and existing windows when new apps are installed', () => {
  const definitions = [{ id: 'paint', title: 'Paint', w: 160, h: 120 }];
  const original = new DesktopModel(definitions);
  original.open('paint', { x: 900, y: 400 });
  original.pan({ x: 700, y: 300 });
  const fresh = new DesktopModel([...definitions, { id: 'notes', title: 'Notes', w: 180, h: 120 }]);
  fresh.restore(original.snapshot());
  assert.deepEqual(fresh.state.value.pan, { x: 700, y: 300 });
  assert.deepEqual(fresh.window('paint'), original.window('paint'));
  assert.equal(fresh.window('notes').open, false);
});

test('minimap projection contains offscreen items and round-trips camera points', () => {
  const objects = [{ x: -500, y: -300, w: 90, h: 60 }, { x: 2000, y: 900, w: 400, h: 200 }];
  const projection = mapProjection(objects, { x: 0, y: 0, w: 480, h: 240 }, { x: 3, y: 15, w: 106, h: 58 });
  for (const object of objects) {
    const rect = projection.rect(object);
    assert.ok(rect.x >= 2 && rect.x + rect.w <= 111);
    assert.ok(rect.y >= 14 && rect.y + rect.h <= 75);
  }
  const point = projection.screen(400, 200);
  const world = projection.point(point.x, point.y);
  assert.ok(Math.abs(world.x - 400) <= 1 / projection.scale);
  assert.ok(Math.abs(world.y - 200) <= 1 / projection.scale);
});

test('Start searches apps and recent documents and is keyboard operable', async t => {
  const live = await session(t, { width: 480, height: 270 });
  const { os } = live;
  os.desktop.openStart();
  await live.frames(2);
  const start = popupOf(live);
  assert.ok(start instanceof Launcher);
  assert.equal(os.ui.focused, start.search);
  start.query.set('calc');
  assert.deepEqual(start.items.map(item => item.app?.id), ['calc']);
  os.stage.keys.emit('down', { key: 'Enter' });
  await live.frames(15);
  assert.equal(os.model.state.value.active, 'calc');
  assert.equal(popupOf(live), null);
  os.desktop.openStart();
  await live.frames(1);
  os.stage.keys.emit('down', { key: 'Escape' });
  assert.equal(popupOf(live), null);
  const document = await os.documents.save({ appId: 'notepad', name: 'Launch-note', format: 'text/plain', content: 'A recent document' });
  os.desktop.openStart();
  await live.frames(2);
  const recent = popupOf(live);
  recent.query.set('Launch-note');
  assert.equal(recent.items.length, 1);
  assert.equal(recent.items[0].doc.id, document.id);
  os.stage.keys.emit('down', { key: 'Escape' });
  const list = os.documents.list;
  os.documents.list = async () => { throw new Error('Storage is blocked'); };
  os.desktop.openStart();
  await live.frames(2);
  const offline = popupOf(live);
  offline.query.set('calc');
  assert.equal(offline.items[0].app.id, 'calc');
  assert.equal(offline.documentError, 'Storage is blocked');
  os.documents.list = list;
  assert.deepEqual(live.errors, []);
});

test('dragging the minimap viewport moves only the camera and commits once', async t => {
  const live = await session(t, { width: 480, height: 270 });
  const { os } = live;
  os.model.pan({ x: 500, y: 200 });
  await live.frames(2);
  const map = os.desktop.minimap;
  const before = os.model.snapshot();
  const projection = mapProjection(os.desktop.worldItems(), map.viewport, { x: 3, y: 15, w: map.w - 6, h: map.h - 18 });
  const rect = projection.rect(map.viewport);
  const x = map.x + rect.x + Math.floor(rect.w / 2);
  const y = map.y + rect.y + Math.floor(rect.h / 2);
  let commits = 0;
  const stop = os.model.state.subscribe(() => commits++, { immediate: false });
  await live.drag([[x, y], [x + 3, y + 2], [x + 7, y + 4]]);
  stop();
  assert.equal(commits, 1);
  assert.ok(os.model.state.value.pan.x > 500);
  assert.deepEqual(os.model.snapshot().desks[0].windows, before.desks[0].windows);
  assert.deepEqual(os.model.snapshot().icons, before.icons);
});

test('notes are editable desktop objects; compact mode and pixel changes preserve saved world geometry', async t => {
  const live = await session(t, { width: 960, height: 600, options: { pixel: 1, open: ['calc'] } });
  const { os } = live;
  const note = os.desktop.newNote();
  await live.frames(20);
  const widget = [...walk(os.desktop)].find(item => item instanceof StickyNote && item.note.id === note.id);
  assert.ok(widget && widget.visible);
  os.stage.keys.emit('down', { key: 'H' });
  os.stage.keys.emit('down', { key: 'i' });
  assert.equal(os.desktop.notes.state.value.notes[0].text, 'Hi');
  os.open('calc');
  os.model.move('calc', { x: 730, y: 440 });
  os.model.pan({ x: 590, y: 360 });
  const before = os.model.snapshot();
  const noteBefore = os.desktop.notes.export();
  os.stage.resize(320, 200, 1);
  await live.frames(2);
  assert.equal(os.desktop.compact, true);
  assert.deepEqual(os.model.snapshot(), before, 'compact presentation changes no saved rectangles or camera coordinates');
  os.signals.resolve('pixel').set(4);
  os.stage.resize(1280, 800, 1);
  await live.frames(2);
  assert.deepEqual(os.model.snapshot(), before);
  assert.equal(os.desktop.notes.export(), noteBefore);
  os.signals.resolve('pixel').set(1);
  os.stage.resize(960, 600, 1);
  await live.frames(2);
  assert.equal(frameOf(live, 'calc').x, 140);
  const map = os.desktop.minimap;
  assert.ok(map.y >= os.desktop.work.y && map.y + map.h <= os.desktop.work.y + os.desktop.work.h);
  assert.deepEqual(live.errors, []);
});

test('crowded taskbars retain reachable window switching and long menus stay inside the viewport', async t => {
  const live = await session(t, { width: 320, height: 200 });
  const { os } = live;
  for (const id of os.apps.keys()) os.open(id);
  await live.frames(20);
  const slots = os.desktop.tasks.slots();
  for (const part of slots) assert.ok(part.x >= 0 && part.w > 0 && part.x + part.w <= os.desktop.tasks.w);
  const overflow = slots.find(part => part.kind === 'overflow');
  assert.ok(overflow);
  await live.tap(...slot(live, 'overflow'));
  const popup = popupOf(live);
  assert.ok(popup.x >= 0 && popup.y >= 0 && popup.x + popup.w * popup.zoom <= os.desktop.w && popup.y + popup.h * popup.zoom <= os.desktop.h);
  const item = popup.items.find(item => item.text.startsWith('Pea Paint'));
  await pick(live, item.text);
  assert.equal(os.model.state.value.active, 'paint');
});

test('the map draws a minimized window as a dotted outline; clicking a window centers it and brings it back', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, open: ['calc', 'paint'] } });
  const { os } = live;
  os.move('calc', { x: 1400, y: 700 });
  os.model.minimize('calc');
  await live.frames(2);
  const map = os.desktop.minimap;
  assert.equal(map.visible, true);
  const zoom = map.zoom;
  const box = { x: 3, y: TITLE_H + 3, w: map.w - 6, h: map.h - TITLE_H - 6 };
  const projection = mapProjection(os.desktop.worldItems(), map.viewport, box);
  const item = os.desktop.worldItems().find(item => item.id === 'calc');
  assert.equal(item.min, true);
  const r = projection.rect(item);
  assert.ok(r.w > 6 && r.h > 6, 'big enough to show inside');
  const at = (x, y) => [map.x + x * zoom, map.y + y * zoom];
  const screen = live.render();
  const theme = os.themes.get(os.signals.get('theme'));
  assert.equal(toHex(screen.get(...at(r.x + 2, r.y + 2))), toHex(theme.color('wall-a')), 'empty inside');
  assert.notEqual(toHex(screen.get(...at(r.x, r.y))), toHex(theme.color('wall-a')), 'a dot on the corner');
  assert.equal(toHex(screen.get(...at(r.x + 1, r.y))), toHex(theme.color('wall-a')), 'every other pixel');

  const panBefore = { ...os.model.state.value.pan };
  await live.tap(...at(r.x + (r.w >> 1), r.y + (r.h >> 1)));
  await live.frames(30);
  const calc = os.model.window('calc');
  assert.equal(calc.min, false, 'restored');
  assert.equal(os.model.state.value.active, 'calc');
  const { pan } = os.model.state.value;
  const { work } = os.desktop;
  assert.notDeepEqual(pan, panBefore);
  assert.ok(Math.abs(calc.x + calc.w / 2 - (pan.x + work.w / 2)) <= 1, 'centered across');
  assert.ok(Math.abs(calc.y + calc.h / 2 - (pan.y + work.h / 2)) <= 1, 'centered down');
  assert.equal(frameOf(live, 'calc').visible, true);

  // Dragging from a window still drags the view, and picks nothing.
  os.activate('paint');
  const now = mapProjection(os.desktop.worldItems(), map.viewport, box);
  const c = now.rect(os.desktop.worldItems().find(item => item.id === 'calc'));
  const [x, y] = at(c.x + (c.w >> 1), c.y + (c.h >> 1));
  await live.drag([[x, y], [x + 4, y + 2], [x + 9, y + 5]]);
  assert.ok(os.model.state.value.pan.x > pan.x, 'the view moved');
  assert.equal(os.model.state.value.active, 'paint', 'the drag did not pick calc');
  assert.deepEqual(live.errors, []);
});
