import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, escapeXml } from '../src/core/xml.js';
import { parseDatabase, serializeDatabase, matches } from '../res/apps/records.js';
import { parseFlow, serializeFlow, nodeSize, show, PULSE } from '../res/apps/flow.js';
import { StickyNote } from '../src/os/sticky-notes.js';
import { session, walk, popupOf, pick } from './helpers.mjs';

const xml = { parseXml, escapeXml };
const DB = `<database version="1" name="Pets">
  <field name="Name" type="text"/>
  <field name="Kind" type="choice" options="Cat,Dog"/>
  <field name="Age" type="number"/>
  <field name="Born" type="date"/>
  <field name="Fluffy" type="check"/>
  <record id="a"><value field="Name">Miso</value><value field="Kind">Cat</value><value field="Age">4</value><value field="Born">2022-03-01</value><value field="Fluffy">true</value></record>
  <record id="b"><value field="Name">Bean</value><value field="Kind">Dog</value><value field="Age">11</value><value field="Born">2015-07-12</value></record>
  <record id="c"><value field="Name">Tofu &amp; Co</value><value field="Kind">Cat</value><value field="Age">2</value></record>
</database>`;

test('databases read strictly, write back the same, and find with comparisons', () => {
  const db = parseDatabase(xml, DB, 'pets');
  assert.equal(db.records.length, 3);
  assert.equal(db.records[2].values.Name, 'Tofu & Co');
  assert.deepEqual(parseDatabase(xml, serializeDatabase(xml, db)), db);
  assert.throws(() => parseDatabase(xml, '<database version="1"><field name="A" type="colour"/></database>', 'bad.xml'), /bad\.xml:1: <field> type="colour"/);
  assert.throws(() => parseDatabase(xml, '<database version="1"><field name="A"/><record><value field="B">x</value></record></database>'), /field="B" is not a field/);
  assert.throws(() => parseDatabase(xml, '<database version="1"><field name="A"/><field name="a"/></database>'), /used twice/);
  const age = db.fields[2];
  const born = db.fields[3];
  assert.ok(matches(age, '11', '>4') && !matches(age, '2', '>4') && matches(age, '4', '2..4') && matches(age, '4', '4'));
  assert.ok(matches(born, '2022-03-01', '>2020-01-01') && !matches(born, '', '>2020-01-01'));
  assert.ok(matches(db.fields[0], 'Miso', 'mis') && matches(db.fields[0], 'Miso', '=miso') && !matches(db.fields[0], 'Misora', '=miso'));
  assert.ok(matches(db.fields[4], 'true', 'true') && matches(db.fields[4], '', 'false'));
});

test('Pea Records turns pages, finds, sorts, edits and undoes', async t => {
  const live = await session(t, { width: 640, height: 360, options: { open: ['records'] } });
  const { os } = live;
  const app = os.app('records');
  await app.files.ready;
  await live.frames(30);
  const { book, form, table } = app.refs;
  assert.equal(app.signal('position').value, '1 / 10');
  const name = form.children[0].children[1];
  assert.equal(name.text, 'Snap pea');

  // The lower half of the book goes forward, the upper half back.
  const tapBook = async y => { const at = book.toScreen(book.w >> 1, y); await live.tap(at.x, at.y); };
  await tapBook(30);
  assert.equal(app.signal('position').value, '2 / 10');
  assert.equal(name.text, 'Sweet basil');
  await tapBook(8);
  assert.equal(name.text, 'Snap pea');
  os.stage.keys.emit('down', { key: 'PageDown' });
  assert.equal(name.text, 'Sweet basil');

  // Find: herbs that take more than 35 days.
  app.signal('mode').set('find');
  await live.frames(2);
  const finders = app.refs.findForm.children;
  finders[1].children[1].model.set('Herb');
  finders[2].children[1].model.set('>35');
  app.run('find-run');
  assert.equal(app.signal('mode').value, 'browse');
  assert.equal(app.signal('counts').value, 'Found 2 of 10');
  assert.equal(name.text, 'Chives');

  // List sorts when a heading is tapped, and a row opens its record.
  app.run('show-all');
  app.signal('mode').set('list');
  await live.frames(3);
  const heading = table.toScreen(10, 5);
  await live.tap(heading.x, heading.y);
  assert.equal(app.signal('sorted').value, 'Sorted ↑ Name');
  await live.tap(heading.x, heading.y);
  assert.equal(app.signal('sorted').value, 'Sorted ↓ Name');
  const row = table.toScreen(10, 13 + 1 + 12 + 6);
  await live.tap(row.x, row.y);
  assert.equal(app.signal('position').value, '2 / 10');

  // Editing a field changes the document; undo brings the old value back.
  app.signal('mode').set('browse');
  await live.frames(2);
  const before = name.text;
  os.ui.focus(name);
  name.selectAll();
  for (const key of 'Pumpkin') os.stage.keys.emit('down', { key });
  assert.equal(app.files.state.value.dirty, true);
  assert.match(app.files.serialize(), /Pumpkin/);
  await app.files.run('undo');
  assert.equal(name.text, before);

  app.run('record-new');
  assert.equal(app.signal('position').value, '11 / 11');
  assert.equal(name.text, '');
  assert.deepEqual(live.errors, []);
});

test('Pea Records defines fields and keeps values when a field is renamed', async t => {
  const live = await session(t, { width: 640, height: 360, options: { open: ['records'] } });
  const app = live.os.app('records');
  await app.files.ready;
  app.signal('mode').set('fields');
  app.signal('field-selected').set('Kind');
  app.signal('field-name').set('Type');
  app.run('field-change');
  assert.match(app.files.serialize(), /<value field="Type">Vegetable<\/value>/);
  app.signal('field-name').set('Rating');
  app.signal('field-type').set('number');
  app.run('field-add');
  assert.equal(app.refs.fieldList.items.at(-1).text, 'Rating');
  app.signal('field-name').set('rating');
  app.run('field-add');
  assert.equal(app.signal('status').value, 'There is already a field called rating.');
  assert.deepEqual(live.errors, []);
});

test('flows are strict XML and survive a round trip', () => {
  const text = `<flow version="1">
    <node id="a" type="number" x="1" y="2"><set name="value" value="5"/></node>
    <node id="b" type="math" x="90" y="2"><set name="op" value="+"/></node>
    <node id="c" type="display" x="180" y="2"/>
    <wire from="a.out" to="b.in"/><wire from="b.out" to="c.in"/>
  </flow>`;
  const flow = parseFlow(xml, text, 'f.xml');
  assert.equal(flow.nodes[0].params.value, 5);
  assert.equal(flow.wires[1].to.id, 'c');
  assert.deepEqual(parseFlow(xml, serializeFlow(xml, flow)).nodes.map(node => node.params), flow.nodes.map(node => node.params));
  assert.throws(() => parseFlow(xml, '<flow version="1"><node id="a" type="blender"/></flow>', 'f.xml'), /f\.xml:1: <node> type="blender" is not a node type/);
  assert.throws(() => parseFlow(xml, '<flow version="1"><node id="a" type="clock"/><node id="b" type="display"/><wire from="b.in" to="a.tick"/></flow>'), /Display has outputs none/);
  assert.throws(() => parseFlow(xml, '<flow version="1"><node id="a" type="math"><set name="op" value="^"/></node></flow>'), /must be one of/);
  assert.equal(show(PULSE), '•');
  assert.equal(show(1 / 3), '0.333');
  assert.equal(show(false), 'no');
  assert.ok(nodeSize(flow.nodes[2]).h > nodeSize(flow.nodes[1]).h);
});

test('a resized node keeps its size in the document, within limits', () => {
  const flow = parseFlow(xml, '<flow version="1"><node id="a" type="log" x="0" y="0" w="150" h="900"/><node id="b" type="clock" x="0" y="90" w="10"/><node id="c" type="display" x="0" y="0"/></flow>', 'f.xml');
  assert.deepEqual([flow.nodes[0].w, flow.nodes[0].h], [150, 480], 'too tall is capped');
  assert.deepEqual(nodeSize(flow.nodes[0]), { w: 150, h: 480 });
  assert.ok(nodeSize(flow.nodes[1]).w >= 40, 'too narrow still has room for its ports');
  assert.equal(flow.nodes[2].w, undefined, 'a node never resized has no size in its XML');
  const again = serializeFlow(xml, flow);
  assert.match(again, /<node id="a" type="log" x="0" y="0" w="150" h="480"\/>/);
  assert.doesNotMatch(again, /id="c"[^>]* w=/);
  assert.throws(() => parseFlow(xml, '<flow version="1"><node id="a" type="log" x="0" y="0" w="2"/></flow>'), /w/);
});

test('Pea Flow nodes resize from their corner; a Log then shows more lines', async t => {
  const live = await session(t, { width: 720, height: 400, options: { open: ['flow'] } });
  const app = live.os.app('flow');
  await app.files.ready;
  await app.files.run('new');
  await live.frames(30);
  app.signal('node-type').set('log');
  app.run('add-node');
  const [log] = parseFlow(xml, app.files.serialize()).nodes;
  const natural = nodeSize(log);
  const { board } = app.refs;
  await live.frames(2);
  const toScreen = (wx, wy) => {
    const local = board.fromWorld(wx, wy);
    const at = board.toScreen(local.x, local.y);
    return [at.x, at.y];
  };
  const corner = toScreen(log.x + natural.w - 2, log.y + natural.h - 2);
  const zoom = board.magnifier();
  await live.drag([corner, [corner[0] + 10, corner[1] + 10], [corner[0] + 60 * zoom, corner[1] + 40 * zoom]]);
  const [sized] = parseFlow(xml, app.files.serialize()).nodes;
  const even = n => Math.round(n / 2) * 2;
  assert.deepEqual(nodeSize(sized), { w: even(natural.w + 60), h: even(natural.h + 40) }, 'the corner drags the size, in steps of 2');
  assert.equal(sized.x, log.x, 'resizing does not move the node');
  await app.files.run('undo');
  assert.equal(parseFlow(xml, app.files.serialize()).nodes[0].w, undefined, 'undo puts the size back');
  assert.deepEqual(live.errors, []);
});

test('Pea Flow runs: objects travel along wires and arrive at their nodes', async t => {
  const live = await session(t, { width: 720, height: 400, options: { open: ['flow'] } });
  const app = live.os.app('flow');
  await app.files.ready;
  await live.frames(5);
  app.run('run');
  assert.equal(app.signal('run-label').value, 'Pause');
  await live.frames(240);
  const doc = parseFlow(xml, app.files.serialize());
  assert.equal(doc.nodes.length, 9, 'running changes nothing in the document');
  assert.equal(app.files.state.value.dirty, false);
  app.run('run');
  assert.equal(app.signal('run-label').value, 'Run');
  assert.deepEqual(live.errors, []);
});

test('Pea Flow wires ports by dragging and deletes with the keyboard', async t => {
  const live = await session(t, { width: 720, height: 400, options: { open: ['flow'] } });
  const { os } = live;
  const app = os.app('flow');
  await app.files.ready;
  await os.app('flow').files.run('new');
  await live.frames(30);
  app.signal('node-type').set('number');
  app.run('add-node');
  app.signal('node-type').set('display');
  app.run('add-node');
  let doc = parseFlow(xml, app.files.serialize());
  assert.equal(doc.nodes.length, 2);
  const [number, display] = doc.nodes;
  const { board } = app.refs;
  await live.frames(2);
  const toScreen = (wx, wy) => {
    const local = board.fromWorld(wx, wy);
    const at = board.toScreen(local.x, local.y);
    return [at.x, at.y];
  };
  const numberHead = toScreen(number.x + 20, number.y + 4);
  await live.drag([numberHead, [numberHead[0] - 60, numberHead[1]], [numberHead[0] - 80, numberHead[1]]]);
  doc = parseFlow(xml, app.files.serialize());
  const moved = doc.nodes.find(node => node.id === number.id);
  assert.equal(moved.x, number.x - 80, 'the header drags the node');
  const out = toScreen(moved.x + 64, moved.y + 12 + 3 + 5);
  const into = toScreen(display.x, display.y + 12 + 3 + 5);
  await live.drag([out, [out[0] + 20, out[1] + 4], into]);
  doc = parseFlow(xml, app.files.serialize());
  assert.equal(doc.wires.length, 1, 'dragging from an output to an input makes a wire');
  assert.equal(`${doc.wires[0].from.id}.${doc.wires[0].out} → ${doc.wires[0].to.id}.${doc.wires[0].in}`, `${number.id}.out → ${display.id}.in`);
  assert.equal(app.signal('has-selection').value, true, 'the new wire is selected');
  // A wire pulled off its input and let go there again, or pulled and cancelled, is left as it was.
  const before = app.files.serialize();
  await live.drag([into, [into[0] + 12, into[1] + 6], into]);
  assert.equal(app.files.serialize(), before, 'let go where it started');
  os.stage.pointer.emit('down', { x: into[0], y: into[1], button: 0 });
  os.stage.pointer.emit('move', { x: into[0] + 30, y: into[1] + 20, button: 0 });
  os.stage.pointer.emit('cancel', { x: into[0] + 30, y: into[1] + 20, button: 0 });
  await live.frames(1);
  assert.equal(app.files.serialize(), before, 'a cancelled pull puts the wire back');
  os.stage.keys.emit('down', { key: 'Delete' });
  assert.equal(parseFlow(xml, app.files.serialize()).wires.length, 0);
  await app.files.run('undo');
  assert.equal(parseFlow(xml, app.files.serialize()).wires.length, 1, 'undo restores the wire');
  assert.deepEqual(live.errors, []);
});

test('menus show quiet icons and shortcuts; Apps are grouped; window items need a window', async t => {
  const live = await session(t, { width: 640, height: 360 });
  const { os } = live;
  const titles = os.desktop.menus.map(menu => menu.title);
  const open = async title => {
    const at = os.desktop.bar.toScreen(os.desktop.bar.slot(titles.indexOf(title)).x + 4, 5);
    await live.tap(at.x, at.y);
    return popupOf(live);
  };
  let popup = await open('File');
  const save = popup.items.find(item => item.text === 'Save');
  assert.equal(save.icon, 'glyph-save');
  assert.equal(save.shortcut, 'Ctrl+S');
  assert.ok(popup.measure().w > 100);
  os.stage.keys.emit('down', { key: 'Escape' });
  popup = await open('Apps');
  const apps = popup.items.filter(item => item.action?.startsWith('launch:'));
  const absent = [...os.apps.values()].filter(app => !apps.some(item => item.action === `launch:${app.id}`)).map(app => app.title).sort();
  assert.deepEqual(absent, ['Agent Chat', 'HTTP Probe', 'Pea Cut'], 'every app but those that require what this test host does not give: the internet, and video tools');
  assert.ok(!apps.some(item => item.action === 'launch:video'));
  assert.ok(apps.every(item => item.icon), 'every app has a little icon');
  assert.equal(popup.items.filter(item => item.separator).length, 7, 'one rule after search, six between seven groups');
  os.stage.keys.emit('down', { key: 'Escape' });
  popup = await open('Window');
  assert.ok(popup.items.filter(item => item.action?.startsWith('window:')).every(item => item.disabled), 'no window, nothing to act on');
  os.stage.keys.emit('down', { key: 'Escape' });
  os.open('calc');
  await live.frames(3);
  popup = await open('Window');
  assert.ok(popup.items.some(item => item.text === 'Size 2×'));
  await pick(live, 'Maximize');
  assert.equal(os.model.window('calc').mode, 'max');
  const rendered = live.render();
  assert.ok(rendered.width > 0);
  assert.deepEqual(live.errors, []);
});

test('sticky notes resize by their corner, roll up on a double tap, duplicate and take turns with colors', async t => {
  const stored = new Map();
  const live = await session(t, { width: 640, height: 360, stored });
  const { os } = live;
  const notes = os.desktop.notes;
  const first = notes.create({ text: 'Plant peas\nthen beans', x: 100, y: 60 });
  const second = notes.create({ text: 'Second' });
  assert.notEqual(second.color, first.color);
  await live.frames(3);
  const widget = [...walk(os.desktop)].find(item => item instanceof StickyNote && item.note.id === first.id);
  const corner = widget.toScreen(widget.w - 4, widget.h - 4);
  await live.drag([[corner.x, corner.y], [corner.x + 20, corner.y + 10], [corner.x + 40, corner.y + 30]]);
  const resized = notes.state.value.notes.find(note => note.id === first.id);
  assert.deepEqual([resized.w, resized.h], [188, 142]);
  assert.equal(resized.text, 'Plant peas\nthen beans', 'resizing never edits the text');
  const header = widget.toScreen(30, 5);
  await live.tap(header.x, header.y);
  await live.tap(header.x, header.y);
  assert.equal(notes.state.value.notes.find(note => note.id === first.id).rolled, true);
  await live.frames(2);
  assert.equal(widget.h, 17, "a rolled note is its window-height caption");
  assert.equal(widget.editor.visible, false);
  const copy = notes.duplicate(first.id);
  assert.equal(copy.text, first.text);
  assert.equal(copy.x, first.x + 14);
  // Files from before rolled notes and timestamps still import.
  const old = JSON.stringify({ version: 1, notes: [{ id: 'old', text: 'Old', color: '#ffe59a', desk: 0, x: 0, y: 0, w: 148, h: 112, hidden: false, deleted: false }] });
  assert.equal(notes.import(old), 1);
  assert.equal(notes.state.value.notes.at(-1).rolled, false);
  assert.deepEqual(live.errors, []);
});

test('a new note appears where the user is looking: the view stays put and windows stay open', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1 } });
  const { os } = live;
  const { desktop } = os;
  desktop.setPan({ x: 400, y: 300 });
  os.open('notepad');
  await live.frames(30);
  const note = desktop.newNote();
  await live.frames(3);
  assert.deepEqual(desktop.pan, { x: 400, y: 300 }, 'the desk does not jump');
  assert.equal(os.model.window('notepad').min, false, 'nothing is put away to make room');
  const at = desktop.fromWorld(note);
  const frame = [...walk(desktop)].find(widget => widget.id === 'notepad' && widget.bounds);
  const win = frame.bounds;
  assert.ok(at.x >= 0 && at.y >= desktop.work.y && at.x + note.w <= desktop.w && at.y + note.h <= desktop.work.y + desktop.work.h, 'in view');
  assert.ok(at.x + note.w <= win.x || at.x >= win.x + win.w || at.y + note.h <= win.y || at.y >= win.y + win.h, 'beside the window, not under it');
  // From the desk's context menu, the note lands where the menu was opened.
  desktop.openContext('desktop', null, { gx: 700, gy: 380 });
  await pick(live, 'New sticky note');
  const placed = desktop.notes.state.value.notes.at(-1);
  assert.deepEqual(desktop.fromWorld(placed), { x: 700, y: Math.min(380, desktop.work.y + desktop.work.h - 112 - 4) });
  assert.deepEqual(desktop.pan, { x: 400, y: 300 });
  // Revealing a note far away moves the view only as far as it must.
  const far = desktop.notes.create({ text: "Far", x: 2000, y: 360 });
  desktop.revealNote(far.id);
  await live.frames(2);
  const shown = desktop.fromWorld(far);
  assert.equal(shown.x + far.w, desktop.w - 4);
  assert.equal(desktop.pan.y, 300);
  assert.deepEqual(live.errors, []);
});

test('Start, the map, the overview and notes wear the window caption and have a Size menu', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, theme: 'garden' } });
  const { os } = live;
  const { desktop } = os;
  const theme = os.ui.theme.value;
  // The theme's stripes run through the map's caption, as through a window's.
  const map = desktop.minimap;
  assert.ok(map.visible);
  const screen = live.render();
  const stripe = map.toScreen(map.w - 8, 3);
  const between = map.toScreen(map.w - 8, 4);
  assert.equal(screen.get(stripe.x, stripe.y), theme.color('title-ink'));
  assert.equal(screen.get(between.x, between.y), theme.color('title'));

  // The Start button's label fits inside it.
  const start = desktop.tasks.slots().find(slot => slot.kind === 'launcher');
  assert.ok(start.w >= os.ui.font.measure('Start', { bold: true }) + 21);
  // Right-clicking it, or the open Start menu, offers its size; the menu comes back at that size.
  desktop.tasks.menu({ x: start.x + 4, y: 8, gx: 4, gy: 530 });
  assert.ok(popupOf(live).items.some(item => item.text === 'Start menu 2×'));
  os.stage.keys.emit('down', { key: 'Escape' });
  desktop.openStart();
  await live.frames(2);
  const launcher = popupOf(live);
  launcher.menu({ x: 20, y: 40, gx: 30, gy: 200 });
  await pick(live, 'Start menu 2×');
  await live.frames(2);
  assert.equal(os.zoomOf('start'), 2);
  assert.equal(popupOf(live).zoom, 2, 'Start reopened, magnified');
  os.stage.keys.emit('down', { key: 'Escape' });

  map.menu({ x: 20, y: 20, gx: 900, gy: 450 });
  await pick(live, 'Map 2×');
  await live.frames(2);
  assert.equal(map.zoom, 2);

  desktop.openOverview();
  await live.frames(2);
  const overview = desktop.popups.children.at(-1);
  overview.menu({ x: 30, y: 30, gx: 300, gy: 200 });
  await pick(live, 'Overview 2×');
  await live.frames(2);
  assert.equal(desktop.popups.children.at(-1).constructor.name, 'Overview');
  assert.equal(desktop.popups.children.at(-1).zoom, 2, 'the overview came back magnified');
  os.stage.keys.emit('down', { key: 'Escape' });

  // Each note has its own size, so the important ones can stand out.
  const note = desktop.notes.create({ text: 'Big', x: 40, y: 60 });
  const other = desktop.notes.create({ text: 'Small', x: 300, y: 60 });
  await live.frames(2);
  const widgetOf = id => [...walk(desktop)].find(item => item instanceof StickyNote && item.note.id === id);
  desktop.noteMenu(note.id, { gx: 100, gy: 100 });
  await pick(live, 'Size 3×');
  await live.frames(2);
  assert.equal(widgetOf(note.id).zoom, 3);
  assert.equal(widgetOf(other.id).zoom, 1, 'the other note keeps its size');
  assert.equal(desktop.worldItems().find(item => item.id === note.id).w, note.w * 3);
  assert.deepEqual(desktop.notes.state.value.notes.find(item => item.id === note.id).zooms, { 1: 3 }, 'remembered for this pixel size');
  os.run('set:os.pixel=2');
  await live.frames(2);
  assert.equal(widgetOf(note.id).zoom, 1, 'another pixel size has its own choice');
  assert.deepEqual(live.errors, []);
});

test('Pea Flow takes nodes dragged in from its list, and the wheel zooms about the pointer', async t => {
  const live = await session(t, { width: 720, height: 400, options: { open: ['flow'] } });
  const { os } = live;
  const app = os.app('flow');
  await app.files.ready;
  await app.files.run('new');
  await live.frames(30);
  const { board, palette } = app.refs;
  const row = palette.locate('random');
  const from = palette.toScreen(row.x, row.y);
  const drop = { x: board.w >> 1, y: board.h >> 1 };
  const to = board.toScreen(drop.x, drop.y);
  await live.drag([[from.x, from.y], [from.x + 4, from.y], [from.x + 30, from.y + 4], [to.x, to.y]]);
  let doc = parseFlow(xml, app.files.serialize());
  assert.deepEqual(doc.nodes.map(node => node.type), ['random'], 'the dropped type was added');
  const local = board.fromWorld(doc.nodes[0].x, doc.nodes[0].y);
  assert.ok(Math.abs(local.x - (drop.x - 32)) <= 2 && Math.abs(local.y - (drop.y - 6)) <= 2, 'where it was let go');
  assert.equal(os.ui.dragging, false);

  // A drop anywhere else does nothing.
  await live.drag([[from.x, from.y], [from.x + 30, from.y], [from.x + 30, from.y - 300]]);
  assert.equal(parseFlow(xml, app.files.serialize()).nodes.length, 1);

  const at = board.toScreen(40, 30);
  os.ui.wheel({ x: at.x, y: at.y, dy: -40 });
  assert.equal(board.magnifier(), 2);
  assert.equal(app.signal('zoom-label').value, '200%');
  const node = parseFlow(xml, app.files.serialize()).nodes[0];
  const after = board.fromWorld(node.x, node.y);
  assert.equal(after.x, (local.x - 40) * 2 + 40, 'the point under the pointer stays put');
  os.ui.wheel({ x: at.x, y: at.y, dy: 40 });
  os.ui.wheel({ x: at.x, y: at.y, dy: 40 });
  assert.equal(board.magnifier(), 0.5);
  app.run('zoom-reset');
  assert.equal(board.magnifier(), 1);
  await live.frames(2);
  assert.ok(live.render().width > 0);
  doc = parseFlow(xml, app.files.serialize());
  assert.equal(doc.nodes.length, 1);
  assert.deepEqual(live.errors, []);
});
