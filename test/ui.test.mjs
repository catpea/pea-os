import test from 'node:test';
import assert from 'node:assert/strict';
import { session, center } from './helpers.mjs';
import { Signal, DisposableScope } from '../src/core/reactive.js';
import { parseXml } from '../src/core/xml.js';
import { Widget } from '../src/ui/widget.js';
import { Button, Canvas } from '../src/ui/controls.js';
import { Field, TextArea } from '../src/ui/fields.js';
import { List, Select } from '../src/ui/lists.js';
import { Scroll, Split, Tabs, Tab } from '../src/ui/containers.js';
import { Row } from '../src/ui/layout.js';
import { build } from '../src/ui/markup.js';
import { DialogService } from '../src/os/dialogs.js';

function mount(live, width = 240, height = 150) {
  const host = live.os.ui.root.add(new Widget(live.os.ui));
  host.place(10, 25, width, height);
  return host;
}
const key = (ui, key, extra = {}) => ui.handleKey('down', { key, ...extra });

test('fields edit selections, words, Unicode, readonly state, and composition without duplicate text', async t => {
  const live = await session(t, { width: 480, height: 320 });
  const ui = live.os.ui;
  const host = mount(live);
  const value = new Signal('one two');
  const field = host.add(new Field(ui, { value }));
  field.place(0, 0, 100, 20); field.focus();
  field.setSelection(4, 7); key(ui, 'X');
  assert.equal(value.value, 'one X');
  key(ui, 'z', { ctrl: true }); assert.equal(value.value, 'one two');
  key(ui, 'y', { ctrl: true }); assert.equal(value.value, 'one X');
  field.setSelection(value.value.length); key(ui, 'ArrowLeft', { ctrl: true });
  assert.equal(field.caret, 4);
  field.selectAll(); field.replaceSelection('a😀b');
  field.setSelection(3); key(ui, 'Backspace'); assert.equal(field.text, 'ab');
  field.selectAll(); field.replaceSelection('base');
  field.setSelection(4); field.beginComposition();
  field.applyNative('baseに', 5, 5); field.applyNative('base日本', 6, 6); field.endComposition();
  assert.equal(field.text, 'base日本');
  field.undo(); assert.equal(field.text, 'base');
  field.readonly = true; field.selectAll(); key(ui, 'x'); assert.equal(field.text, 'base');
  field.readonly = false;
  const native = { key: 'q', nativeText: true };
  assert.equal(ui.handleKey('down', native), true);
  assert.equal(native.nativeDefault, true);
  assert.equal(field.text, 'base');
  field.documentUndo = true;
  assert.equal(key(ui, 'z', { ctrl: true }), false);
  const area = host.add(new TextArea(ui, { value: 'abcdefghijklmno' }));
  area.place(0, 30, 40, 70); area.focus(); area.setSelection(0);
  const down = { key: 'ArrowDown', nativeText: true };
  assert.equal(ui.handleKey('down', down), true);
  assert.equal(down.nativeDefault, undefined);
  assert.ok(area.caret > 0 && area.caret < area.text.length);
  const home = { key: 'Home', nativeText: true };
  ui.handleKey('down', home); assert.equal(home.nativeDefault, undefined);
});

test('focus traverses visible enabled controls and stops inside a modal scope', async t => {
  const live = await session(t, { width: 480, height: 320 });
  const ui = live.os.ui;
  const host = mount(live);
  const first = host.add(new Field(ui)); first.place(0, 0, 100, 20);
  const disabled = host.add(new Button(ui, { text: 'Unavailable', disabled: true })); disabled.place(0, 25, 90, 20);
  let presses = 0;
  const last = host.add(new Button(ui, { text: 'OK', onPress: () => presses++ })); last.place(0, 50, 40, 20);
  const release = ui.focusWithin(host, { trap: true }); t.after(release);
  first.focus(); key(ui, 'Tab'); assert.equal(ui.focused, last);
  key(ui, 'Tab'); assert.equal(ui.focused, first);
  key(ui, 'Tab', { shift: true }); assert.equal(ui.focused, last);
  key(ui, 'Enter'); ui.handleKey('up', { key: 'Enter' }); assert.equal(presses, 1);
  disabled.focus(); assert.equal(ui.focused, last);
  last.disabled = true; assert.equal(ui.focused, null);
});

test('lists scroll selected rows, skip disabled items, activate, and dropdowns restore focus', async t => {
  const live = await session(t, { width: 480, height: 320 });
  const ui = live.os.ui;
  const host = mount(live);
  const items = Array.from({ length: 20 }, (_, i) => ({ value: i, text: `Document ${i}`, detail: `Card stack ${i}`, disabled: i === 1 }));
  let opened = null;
  const list = host.add(new List(ui, { items, value: 0, onActivate: value => { opened = value; } }));
  list.place(0, 0, 150, 60); list.focus();
  key(ui, 'ArrowDown'); assert.equal(list.model.value, 2);
  key(ui, 'End'); assert.equal(list.model.value, 19); assert.ok(list.scrollY > 0);
  key(ui, 'Enter'); assert.equal(opened, 19);
  list.items = []; assert.equal(list.selectedItem, null); assert.equal(list.scrollY, 0);
  const select = host.add(new Select(ui, { items: items.slice(0, 4), value: 0 })); select.place(0, 70, 120, 20); select.focus();
  key(ui, 'Enter'); assert.ok(ui.focused instanceof List);
  key(ui, 'ArrowDown'); key(ui, 'Enter');
  assert.equal(select.model.value, 2); assert.equal(ui.focused, select);
});

test('scroll masks clip pixels and hit tests at whole-number zoom', async t => {
  const live = await session(t, { width: 480, height: 320 });
  const ui = live.os.ui;
  const host = mount(live);
  const scroll = host.add(new Scroll(ui, { axis: 'both' }));
  const paper = scroll.add(new Canvas(ui, { width: 90, height: 80, fill: '#ff00ff' }));
  scroll.zoom = 2; scroll.place(10, 10, 45, 40);
  await live.frames(2);
  const screen = live.render();
  const inside = scroll.toScreen(4, 4);
  const outside = scroll.toScreen(scroll.w + 2, 4);
  assert.equal(screen.get(inside.x, inside.y), paper.bitmap.get(0, 0));
  assert.notEqual(screen.get(outside.x, outside.y), paper.bitmap.get(0, 0));
  assert.equal(scroll.hit(scroll.x + scroll.w * 2 + 1, scroll.y + 2), null);
  assert.ok(scroll.maxX > 0 && scroll.maxY > 0);
  scroll.scrollTo(20, 15); assert.equal(paper.x, -20); assert.equal(paper.y, -15);
});

test('wrapped toolbars, tab selection, and single visible split panes fit small views', async t => {
  const live = await session(t, { width: 320, height: 200 });
  const ui = live.os.ui;
  const host = mount(live, 150, 150);
  const row = host.add(new Row(ui, { wrap: true, gap: 3 }));
  for (const text of ['New', 'Open', 'Save', 'Save As', 'Export PNG']) row.add(new Button(ui, { text }));
  const size = row.measure(146, Infinity); row.place(0, 0, 146, size.h);
  assert.ok(size.h > 20);
  for (const child of row.children) assert.ok(child.x >= 0 && child.x + child.w <= row.w);
  const split = host.add(new Split(ui));
  const first = split.add(new Widget(ui)); const second = split.add(new Widget(ui));
  split.place(0, 70, 146, 70); first.visible = false; split.arrange();
  assert.equal(second.w, 146); assert.equal(split.divider, -1);
  first.visible = true; split.direction = 'vertical'; split.arrange();
  assert.equal(first.w, 146); assert.ok(second.y > first.h);
  const tabs = host.add(new Tabs(ui));
  tabs.add(new Tab(ui, { name: 'one', title: 'First' })); tabs.add(new Tab(ui, { name: 'two', title: 'Second' }));
  tabs.place(0, 0, 146, 80); tabs.focus(); key(ui, 'ArrowRight');
  assert.equal(tabs.model.value, 'two'); assert.equal(tabs.children[0].visible, false); assert.equal(tabs.children[1].visible, true);
});

test('dialogs stay inside a tiny screen, resolve in order, and restore prior text focus', async t => {
  const live = await session(t, { width: 160, height: 200 });
  const ui = live.os.ui;
  const host = mount(live, 130, 120);
  const entry = host.add(new Field(ui, { value: 'prior' })); entry.place(0, 0, 100, 20); entry.focus();
  const dialogs = new DialogService(ui); t.after(() => dialogs.dispose());
  const prompt = dialogs.prompt({ title: 'Save As', message: 'A long filename can wrap without hiding the buttons or losing its editable field.', value: 'garden' });
  const choose = dialogs.choose({ title: 'Open', items: [{ value: 'a', text: 'Garden' }, { value: 'b', text: 'Story' }] });
  await live.frames(2);
  const panel = dialogs.active.panel;
  assert.ok(panel.x >= 0 && panel.y >= 0);
  assert.ok(panel.x + panel.w * panel.zoom <= 160);
  assert.ok(panel.y + panel.h * panel.zoom <= 200);
  assert.equal(ui.focused, dialogs.active.field);
  dialogs.active.field.replaceSelection('new garden'); key(ui, 'Enter');
  assert.equal(await prompt, 'new garden');
  key(ui, 'ArrowDown'); key(ui, 'Enter'); assert.equal(await choose, 'b');
  assert.equal(ui.focused, entry);
  const cancelled = dialogs.confirm({ title: 'Close', message: 'Save your work?', buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'discard', text: 'Discard' }, { value: 'save', text: 'Save' }] });
  key(ui, 'Escape'); assert.equal(await cancelled, null);
  assert.equal(ui.focusScopes.length, 0);
});

test('XML exposes checked controls and action bindings without loose attributes', async t => {
  const live = await session(t, { width: 480, height: 320 });
  const scope = new DisposableScope(); t.after(() => scope.dispose());
  scope.signal('value', new Signal('a')); scope.signal('enabled', new Signal(true));
  const context = { refs: {}, actions: [], scope, resolve: name => scope.resolve(name), run() {} };
  const tree = build(live.os.ui, parseXml('<column><field id="name" value="{value}" enabled="{enabled}"/><list id="files" value="{value}" activate="open"><option value="a" text="A" detail="One"/><option value="b" text="B" disabled="true"/></list><row wrap="true"><button text="Open" action="open"/></row></column>'), context);
  t.after(() => tree.dispose());
  assert.equal(context.refs.name.model, scope.resolve('value'));
  assert.equal(context.refs.files.items.length, 2);
  assert.equal(context.actions.filter(item => item.action === 'open').length, 2);
});
