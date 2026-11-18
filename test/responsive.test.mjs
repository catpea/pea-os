import test from 'node:test';
import assert from 'node:assert/strict';
import { session, frameOf } from './helpers.mjs';

test('screen size, density, pixel size and keyboard changes preserve documents, camera and normal geometry', async t => {
  const live = await session(t, { width: 800, height: 600, options: { pixel: 1, open: ['notepad', 'paint'] } });
  const { os } = live;
  os.signals.set('motion', false);
  const text = os.app('notepad');
  const paint = os.app('paint');
  await Promise.all([text.files.ready, paint.files.ready]);
  text.refs.editor.replaceSelection('A stable document.\nSecond line: preserved across resize.');
  const note = os.desktop.notes.create({ text: 'World-space note', x: -200, y: 400 });
  os.move('notepad', { x: 73, y: 39 });
  os.model.resize('notepad', { x: 73, y: 39, w: 330, h: 250 });
  os.move('paint', { x: 450, y: -50 });
  os.model.pan({ x: 120, y: -90 });
  os.setZoom('notepad', 3);
  os.open('notepad');
  await live.frames(2);
  assert.match(frameOf(live, 'notepad').look.title, /^\* Untitled/);
  os.ui.focus(text.refs.editor);
  os.stage.keys.emit('down', { key: 'Meta', ctrl: true });
  assert.equal(os.ui.focused, text.refs.editor, 'Command is a modifier, so it must not open Start before a Mac shortcut');
  assert.equal(os.desktop.popups.children.length, 0);
  const geometry = os.model.snapshot();
  const notes = JSON.stringify(os.desktop.notes.state.value.notes);
  const writing = text.files.serialize();
  const painting = paint.files.serialize();
  const draft = os.dialogs.prompt({ title: 'Name this document', value: 'Unfinished name', message: 'The field and focus must survive changes.' });
  const field = os.dialogs.active.field;
  const cases = [
    [160, 200, 1, 6, false],
    [200, 160, 1, 'auto', false],
    [320, 568, 1, 2, false],
    [568, 320, 1, 3, false],
    [640, 480, 1.25, 2, false],
    [640, 480, 2.6, 6, false],
    [800, 600, 2, 'auto', false],
    [320, 240, 1, 6, true],
    [160, 200, 1, 1, true],
    [1280, 720, 1, 1, false],
    [800, 600, 1, 1, false]
  ];
  for (const [width, height, density, pixel, keyboard] of cases) {
    os.signals.set('pixel', pixel);
    os.stage.resize(width * density, height * density, density);
    os.signals.set('keys', keyboard);
    await live.frames(2);
    const scenario = `${width}x${height} dpr=${density} pixel=${pixel} keyboard=${keyboard}`;
    assert.deepEqual(os.model.snapshot(), geometry, scenario);
    assert.equal(JSON.stringify(os.desktop.notes.state.value.notes), notes, scenario);
    assert.equal(text.files.serialize(), writing, scenario);
    assert.equal(paint.files.serialize(), painting, scenario);
    assert.equal(os.ui.focused, field, scenario);
    assert.equal(field.text, 'Unfinished name', scenario);
    const { panel } = os.dialogs.active;
    const { w, h } = os.stage.size.value;
    assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.w * panel.zoom <= w && panel.y + panel.h * panel.zoom <= h, scenario);
  }
  assert.equal(frameOf(live, 'notepad').zoom, 3, 'the requested zoom returns with its pixel-size setting');
  assert.equal(os.desktop.notes.state.value.notes.find(item => item.id === note.id).x, -200);
  os.dialogs.cancel();
  assert.equal(await draft, null);
  assert.deepEqual(live.errors, []);
});
