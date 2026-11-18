import assert from 'node:assert/strict';
import { test } from 'node:test';
import { session, center } from './helpers.mjs';
import { Bitmap } from '../src/gfx/bitmap.js';
import { parseColor } from '../src/gfx/color.js';
import { parseXml } from '../src/core/xml.js';
import { readPainting, writePainting } from '../res/apps/paint.js';
import { readStack } from '../res/apps/cards.js';

const DESK = { width: 640, height: 360 };
const type = (os, text) => { for (const key of text) os.stage.keys.emit('down', { key }); };
async function answerPrompt(live, text) {
  await live.frames(3);
  assert.equal(live.os.dialogs.active?.options.kind, 'prompt');
  live.os.stage.keys.emit('down', { key: 'a', ctrl: true });
  type(live.os, text);
  live.os.stage.keys.emit('down', { key: 'Enter' });
  await live.frames(3);
}

async function start(t, appId, options = {}) {
  const live = await session(t, { ...DESK, ...options, options: { open: [appId] } });
  const app = live.os.app(appId);
  if (app.files) await app.files.ready;
  await live.frames(25);
  return { live, os: live.os, app };
}

test('Notepad edits at the caret, saves through a real dialog, finds text, and undoes document edits', async t => {
  const { live, os, app } = await start(t, 'notepad');
  os.ui.focus(app.refs.editor);
  type(os, 'Hello world\nHello again');
  app.refs.editor.setSelection(6, 11);
  type(os, 'Pea');
  assert.equal(app.signal('content').value, 'Hello Pea\nHello again');
  const saving = app.files.run('save');
  await answerPrompt(live, 'My note');
  assert.equal(await saving, true);
  const id = app.files.state.value.id;
  assert.equal((await os.documents.get(id)).name, 'My note');
  assert.equal(app.files.dirty, false);

  app.run('find');
  type(os, 'hello');
  app.run('find-next');
  assert.deepEqual(app.refs.editor.selection, { start: 10, end: 15 });
  app.run('find-next');
  assert.deepEqual(app.refs.editor.selection, { start: 0, end: 5 });
  app.run('find-previous');
  assert.deepEqual(app.refs.editor.selection, { start: 10, end: 15 }, 'Previous wraps from the first match');

  app.refs.editor.setSelection(app.signal('content').value.length);
  type(os, '!');
  assert.equal(app.files.dirty, true);
  await app.files.run('undo');
  assert.equal(app.signal('content').value, 'Hello Pea\nHello again');
  assert.equal(app.files.dirty, false);
  await app.files.run('redo');
  assert.match(app.signal('content').value, /again!$/);
  assert.deepEqual(live.errors, []);
});

test('Paint preserves its document across window resizes, has stroke undo and exports a real PNG', async t => {
  const { live, os, app } = await start(t, 'paint');
  app.signal('size').set(1);
  const p = app.refs.paper;
  const points = [[10, 10], [25, 10]].map(([x, y]) => { const at = p.toScreen(x, y); return [at.x, at.y]; });
  await live.drag(points);
  const read = () => readPainting(parseXml(app.files.serialize()), { Bitmap, parseColor });
  assert.equal(read().get(15, 10), parseColor('#e8475a'));
  await app.files.run('undo');
  assert.equal(read().get(15, 10), parseColor('#ffffff'));
  await app.files.run('redo');
  assert.equal(read().get(15, 10), parseColor('#e8475a'));
  const saving = app.files.run('save');
  await answerPrompt(live, 'Red line');
  await saving;
  const before = app.files.serialize();
  const win = os.model.window('paint');
  os.model.resize('paint', { x: win.x, y: win.y, w: win.w + 60, h: win.h + 30 });
  await live.frames(3);
  assert.equal(app.files.serialize(), before);
  assert.equal(app.files.dirty, false);
  await app.run('export-png');
  const png = live.downloads.at(-1);
  assert.equal(png.name, 'Red line.png');
  assert.equal(png.type, 'image/png');
  assert.deepEqual([...png.text.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(live.errors, []);
});

test('Cards undo/redo restores structural edits and saved XML remains compatible', async t => {
  const { live, app } = await start(t, 'cards');
  const read = () => readStack(parseXml(app.files.serialize()), { Bitmap, parseColor });
  assert.equal(read().cards.length, 4);
  app.run('new');
  assert.equal(read().cards.length, 5);
  await app.files.run('undo');
  assert.equal(read().cards.length, 4);
  await app.files.run('redo');
  assert.equal(read().cards.length, 5);
  const saving = app.files.run('save');
  await answerPrompt(live, 'Tour');
  await saving;
  assert.equal(app.files.dirty, false);
  assert.equal((await live.os.documents.list({ appId: 'cards' })).length, 1);
});

test('Documents previews, renames, exports and opens saved work; compact preview remains reachable', async t => {
  const { live, os, app } = await start(t, 'documents', { width: 200, height: 160 });
  const text = await os.documents.save({ appId: 'notepad', name: 'Read me', format: 'text/plain', content: 'Hello from the shelf' });
  const painting = new Bitmap(3, 2).clear(parseColor('#46b04a'));
  await os.documents.save({ appId: 'paint', name: 'Green', format: 'application/x-pea-painting+xml', content: writePainting(painting, { parseColor }) });
  await live.frames(5);
  assert.equal(app.refs.fileList.items.length, 2);
  app.signal('selected').set(text.id);
  await live.frames(3);
  assert.equal(app.refs.previewText.text, 'Hello from the shelf');
  assert.equal(app.signal('list-open').value, true);
  assert.equal(app.signal('preview-open').value, false);
  app.run('toggle-preview');
  await live.frames(3);
  assert.equal(app.signal('list-open').value, false);
  assert.equal(app.signal('preview-open').value, true);
  assert.ok(app.refs.previewPane.w > 130);
  app.run('toggle-preview');

  const renaming = app.run('rename-document');
  await answerPrompt(live, 'Renamed');
  await renaming;
  assert.equal((await os.documents.get(text.id)).name, 'Renamed');
  await app.run('export-document');
  assert.equal(live.downloads.at(-1).name, 'Renamed.txt');
  assert.equal(live.downloads.at(-1).text, 'Hello from the shelf');

  const deleting = app.run('delete-document');
  await live.frames(3);
  const cancel = os.dialogs.active.buttons.find(button => button.text === 'Cancel');
  await live.tap(...center(cancel));
  await deleting;
  assert.ok(await os.documents.get(text.id), 'Cancel leaves the document alone');
  await app.run('open-document');
  await live.frames(3);
  assert.equal(os.app('notepad').signal('content').value, 'Hello from the shelf');
  assert.deepEqual(live.errors, []);
});
