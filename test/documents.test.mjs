import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentStore } from '../src/os/documents.js';
import { storageFiles } from '../src/os/files.js';
import { createDocumentController } from '../src/os/document-controller.js';
import { DisposableScope, EventEmitter, Signal } from '../src/core/reactive.js';
import { Bitmap } from '../src/gfx/bitmap.js';
import { parseColor } from '../src/gfx/color.js';
import { parseXml } from '../src/core/xml.js';
import { readPainting, writePainting } from '../res/apps/paint.js';

const memory = () => {
  const values = new Map();
  return { values, get: key => values.get(key) ?? null, set: (key, value) => values.set(key, value), remove: key => values.delete(key) };
};

/** A document store over files kept with the platform's preferences, as where nothing better is offered. */
const storeOf = (platform, files = storageFiles(platform.storage)) => createDocumentStore(async () => files);

async function editor(t, { platform = { storage: memory() }, store, replies = [], files = [], initial = '', legacyText } = {}) {
  store ??= storeOf(platform);
  const scope = new DisposableScope();
  const errors = [], alerts = [], downloads = [];
  let text = initial;
  const app = {
    id: 'notepad', scope, keys: new EventEmitter(), visible: new Signal(true), commands: new Map(),
    command(name, fn) { this.commands.set(name, fn); },
    report(error) { errors.push(error); },
    pick: async () => files.shift() ?? null,
    os: { documents: store, platform,
      dialogs: { prompt: async () => replies.shift() ?? null, choose: async () => replies.shift() ?? null,
        confirm: async () => replies.shift() ?? null, alert: async value => alerts.push(value) },
      download: (name, content, type) => downloads.push({ name, content, type }) }
  };
  const controller = createDocumentController(app, {
    format: 'text/plain', extension: '.txt', initialName: 'Untitled', legacyText,
    create: () => '', parse: value => { if (value === '!invalid') throw new Error('Invalid document'); return value; },
    serialize: () => text, install: value => { text = value; }
  });
  await controller.ready;
  t.after(() => scope.dispose());
  return { app, controller, store, platform, replies, errors, alerts, downloads,
    get text() { return text; }, edit(value, options) { text = value; controller.changed(options); } };
}

test('document store keeps Save As independent, lists only documents and reopens its persisted data', async () => {
  const platform = { storage: memory() };
  const store = storeOf(platform);
  const original = await store.save({ appId: 'notepad', name: 'First', format: 'text/plain', content: 'first' });
  const copy = await store.save({ appId: 'notepad', name: 'Second', format: 'text/plain', content: 'second' });
  await store.writeRecovery('notepad', { name: 'Draft', content: 'unsaved' });
  assert.notEqual(copy.id, original.id);
  assert.equal((await store.get(original.id)).content, 'first');
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.list())[0].content, undefined, 'a list is metadata only');
  const reopened = storeOf(platform);
  assert.equal((await reopened.get(copy.id)).content, 'second');
  assert.equal((await reopened.readRecovery('notepad')).content, 'unsaved');
});

test('Save and Save As commit named copies; cancellation does not replace work', async t => {
  const e = await editor(t, { replies: ['Original', 'Alternative'] });
  e.edit('first draft');
  assert.equal(await e.controller.run('save'), true);
  const original = e.controller.state.value.id;
  assert.equal(e.controller.dirty, false);
  e.edit('different ending');
  assert.equal(await e.controller.run('save-as'), true);
  const alternative = e.controller.state.value.id;
  assert.notEqual(original, alternative);
  assert.equal((await e.store.get(original)).content, 'first draft');
  assert.equal((await e.store.get(alternative)).content, 'different ending');
  e.edit('still editing');
  e.replies.push('cancel');
  assert.equal(await e.controller.run('new'), false);
  assert.equal(e.text, 'still editing');
  assert.equal(e.controller.state.value.id, alternative);
  e.replies.push(null);
  assert.equal(await e.controller.run('save-as'), false);
  assert.equal(e.controller.state.value.id, alternative);
  assert.equal(e.controller.dirty, true);
});

test('failed saves preserve the previous saved data, active identity and dirty content', async t => {
  const storage = memory();
  const originalSet = storage.set;
  let blocked = false;
  storage.set = (key, value) => { if (blocked && key.startsWith('pea-os.file:documents/')) throw new Error('Storage is full'); originalSet(key, value); };
  const e = await editor(t, { platform: { storage }, replies: ['Notes'] });
  e.edit('saved');
  await e.controller.run('save');
  const id = e.controller.state.value.id;
  e.edit('must survive'); blocked = true;
  assert.equal(await e.controller.run('save'), false);
  assert.equal(e.text, 'must survive');
  assert.equal(e.controller.dirty, true);
  assert.equal(e.controller.state.value.id, id);
  assert.equal((await e.store.get(id)).content, 'saved');
  assert.match(e.controller.state.value.error, /Storage is full/);
  assert.equal(e.alerts.length, 1);
  blocked = false;
});

test('a document changed elsewhere cannot be silently overwritten; reopening the same id can reload it', async t => {
  const e = await editor(t, { replies: ['Shared'] });
  e.edit('initial'); await e.controller.run('save');
  const id = e.controller.state.value.id;
  const prior = await e.store.get(id);
  e.edit('local edits');
  await e.store.save({ ...prior, content: 'other edits', expectedUpdatedAt: prior.updatedAt });
  assert.equal(await e.controller.run('save'), false);
  assert.match(e.controller.state.value.error, /another window/);
  assert.equal((await e.store.get(id)).content, 'other edits');
  e.replies.push('discard');
  assert.equal(await e.controller.open(id), true);
  assert.equal(e.text, 'other edits');
  assert.equal(e.controller.dirty, false);
});

test('renaming an open saved file updates metadata without discarding unsaved text', async t => {
  const e = await editor(t, { replies: ['Old name'] });
  e.edit('saved'); await e.controller.run('save');
  const id = e.controller.state.value.id;
  e.edit('unsaved text');
  await e.store.rename(id, 'New name');
  assert.equal(await e.controller.run('save'), true);
  assert.equal(e.controller.state.value.name, 'New name');
  assert.equal((await e.store.get(id)).content, 'unsaved text');
  assert.equal((await e.store.get(id)).name, 'New name');
});

test('edits during an asynchronous Save stay dirty and are written to recovery', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let blocked = true;
  const platform = { storage: memory() };
  const files = storageFiles(platform.storage);
  const slow = { ...files, async write(name, data) { if (blocked && name.startsWith('documents/')) { started(); await gate; } return files.write(name, data); } };
  const e = await editor(t, { platform, store: storeOf(platform, slow), replies: ['Slow save'] });
  e.edit('snapshot being saved');
  const saving = e.controller.run('save');
  await entered;
  e.edit('typed while saving');
  blocked = false; release();
  assert.equal(await saving, true);
  const saved = await e.store.get(e.controller.state.value.id);
  assert.equal(saved.content, 'snapshot being saved');
  assert.equal(e.text, 'typed while saving');
  assert.equal(e.controller.dirty, true);
  assert.equal((await e.store.readRecovery('notepad')).content, 'typed while saving');
});

test('undo returns to saved content, redo restores the edit, and imports validate before replacing', async t => {
  const e = await editor(t, { replies: ['Note'], files: [{ name: 'broken.txt', text: '!invalid' }, null] });
  e.edit('saved'); await e.controller.run('save');
  e.edit('added');
  await e.controller.flushRecovery();
  assert.equal((await e.store.readRecovery('notepad')).content, 'added');
  await e.controller.run('undo');
  assert.equal(e.text, 'saved'); assert.equal(e.controller.dirty, false);
  await e.controller.flushRecovery();
  assert.equal(await e.store.readRecovery('notepad'), null, 'undoing to saved content removes the superseded draft');
  await e.controller.run('redo');
  assert.equal(e.text, 'added'); assert.equal(e.controller.dirty, true);
  assert.equal(await e.controller.run('import'), false);
  assert.equal(e.text, 'added');
  assert.equal(await e.controller.run('import'), false);
  assert.equal(e.text, 'added');
});

test('recovery restores an unsaved draft without overwriting the saved record', async t => {
  const platform = { storage: memory() };
  const first = await editor(t, { platform, replies: ['Keep me'] });
  first.edit('saved version'); await first.controller.run('save');
  const id = first.controller.state.value.id;
  first.edit('recovered draft'); await first.controller.flushRecovery();
  const restored = await editor(t, { platform, replies: ['restore'] });
  assert.equal(restored.text, 'recovered draft');
  assert.equal(restored.controller.dirty, true);
  assert.equal(restored.controller.state.value.id, id);
  assert.equal((await restored.store.get(id)).content, 'saved version');
});

test('legacy content is copied into the named document store and remains readable', async t => {
  const e = await editor(t, { legacyText: 'old saved work' });
  assert.equal(e.text, 'old saved work');
  assert.equal(e.controller.dirty, false);
  assert.equal((await e.store.get(e.controller.state.value.id)).content, 'old saved work');
});

test('painting XML preserves the palette and transparency, and rejects malformed dimensions', () => {
  const kit = { Bitmap, parseColor };
  const bitmap = new Bitmap(5, 3).clear(parseColor('#ffffff'));
  bitmap.set(1, 1, parseColor('#e8475a'));
  bitmap.erase(3, 1, 1, 1);
  const xml = writePainting(bitmap, kit);
  const result = readPainting(parseXml(xml, 'picture.xml'), kit);
  assert.deepEqual([...result.px], [...bitmap.px]);
  assert.equal(writePainting(result, kit), xml);
  assert.throws(() => readPainting(parseXml(xml.replace('width="5"', 'width="9999"')), kit), /width and height/);
  assert.throws(() => readPainting(parseXml(xml.replace('44444', '4444')), kit), /pixel rows/);
});
