import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, escapeXml } from '../src/core/xml.js';
import { Widget } from '../src/ui/widget.js';
import { AgentRun, parseAgentFlow, backWires } from '../src/ai/flow.js';
import { ModelRouter } from '../src/ai/router.js';
import { ProviderRegistry, ProviderSet } from '../src/core/providers.js';
import { readForm } from '../src/ai/form.js';
import { parseGrammar, expand, rng } from '../src/ai/gofai.js';
import { parseFeed } from '../res/apps/feeds.js';
import { parseDatabase, serializeDatabase } from '../res/apps/records.js';
import { session, popupOf } from './helpers.mjs';

/** Things a whole-application review found, each kept from coming back. */

const xml = { parseXml, escapeXml };

test('big XML documents parse in linear time and still name the right lines', () => {
  const items = Array.from({ length: 40000 }, (_, i) => `<item><title>Item ${i}</title>\n<description>${'x'.repeat(100)}</description></item>`).join('\n');
  const started = performance.now();
  parseXml(`<rss>\n${items}</rss>`, 'big', { foreign: true });
  assert.ok(performance.now() - started < 2000, 'six and a half megabytes in well under two seconds');
  const root = parseXml('<a>\n <b/>\n\n <c>\n  <d x="1"/>\n </c>\n</a>');
  assert.deepEqual([root.children[0].line, root.children[1].line, root.children[1].children[0].line], [2, 4, 5]);
  assert.throws(() => parseXml('<a>\n\n<b x=1/></a>'), /xml:3:6: attribute values must be quoted/);
  const mixed = parseXml('<p>lead<b>x</b>mid<i/>end</p>');
  assert.equal(mixed.text, 'leadmidend', 'text keeps its meaning');
  assert.deepEqual(mixed.children.map(child => child.tail), ['mid', 'end'], 'and tails keep the order of mixed content');
});

test('an app stays open, and keeps its clock, while its window waits on another desktop', async t => {
  const live = await session(t, { width: 400, height: 260, options: { open: ['pea-timer'] } });
  const { os } = live;
  await live.frames(4);
  const app = os.app('pea-timer');
  assert.equal(app.open.value, true);
  os.run('desk:2');
  await live.frames(30);
  assert.equal(app.open.value, true, 'open on desktop 1 is still open');
  assert.equal(app.visible.value, false);
  os.run('desk:1');
  await live.frames(30);
  os.close('pea-timer');
  assert.equal(app.open.value, false);
});

test('a layout saved before an app existed still stacks that app\'s tools above it', async t => {
  const stored = new Map();
  let live = await session(t, { width: 640, height: 400, stored });
  live.os.open('about');
  await live.frames(2);
  const record = JSON.parse(stored.get('pea-os.layout'));
  for (const desk of record.value.desks) {
    desk.windows = desk.windows.filter(win => !win.id.startsWith('cards'));
    desk.order = desk.order.filter(id => !id.startsWith('cards'));
  }
  stored.set('pea-os.layout', JSON.stringify(record));
  live.dispose();
  live = await session(t, { width: 640, height: 400, stored });
  assert.equal(live.os.model.window('about').open, true, 'the old layout was restored');
  live.os.open('cards');
  await live.frames(2);
  // Jukebox's playlist opens with Jukebox, so until then it waits in the order unseen.
  assert.deepEqual(live.os.model.state.value.order.filter(id => id !== 'music.playlist'), ['about', 'cards', 'cards.tools']);
  assert.deepEqual(live.os.desktop.windows.children.map(frame => frame.id).filter(Boolean), ['about', 'cards', 'cards.tools']);
});

test('a press ends when its widget is disabled under the finger: no menu opens after the release', async t => {
  const live = await session(t, { width: 400, height: 260 });
  const { os } = live;
  const seen = [];
  class Probe extends Widget {
    interactive = true;
    pointer(type) { seen.push(type); }
    menu() { seen.push('menu'); return true; }
  }
  const probe = os.desktop.popups.add(new Probe(os.ui));
  probe.place(100, 100, 50, 50);
  os.stage.pointer.emit('down', { x: 120, y: 120, button: 0 });
  await live.frames(2);
  probe.disabled = true;
  os.stage.pointer.emit('up', { x: 120, y: 120, button: 0 });
  await live.frames(45);
  assert.deepEqual(seen, ['down']);
});

test('apps removed in Software leave the Apps menu too', async t => {
  const live = await session(t, { width: 640, height: 400 });
  const { os } = live;
  os.software.install('paint', false);
  await live.frames(2);
  os.stage.keys.emit('down', { key: 'F10' });
  for (let i = 0; i < os.desktop.menus.findIndex(menu => menu.title === 'Apps'); i++) os.stage.keys.emit('down', { key: 'ArrowRight' });
  await live.frames(2);
  const items = popupOf(live).items.map(item => item.text);
  assert.ok(items.includes('Calculator') && !items.includes('Pea Paint'), items.join(', '));
});

test('agent flows finish the same whatever order their nodes are listed in, and a forward retry does not stall a join', async () => {
  const store = new Map();
  const os = { platform: { name: 'headless', capabilities: {}, storage: { get: key => store.get(key) ?? null, set: (key, value) => store.set(key, value) } }, report: error => { throw error; } };
  // Offline: an internet service with no provider, so only Pea Mind can think.
  const registry = new ProviderRegistry();
  const ai = registry.add(new ModelRouter(os));
  registry.add(new ProviderSet(os, { service: 'network', title: 'Internet', methods: ['request'] }));
  const run = source => new Promise((resolve, reject) => {
    const program = parseAgentFlow(xml, source);
    const timer = setTimeout(() => reject(new Error('the run never finished')), 3000);
    const runner = new AgentRun(program, { ai, seed: 7, send: (wire, msg) => setImmediate(() => runner.deliver(wire, msg)), onFinish: task => { clearTimeout(timer); resolve({ program, task }); } });
    runner.start();
  });
  const body = `<node id="w" type="agent"/><node id="j" type="join"/><node id="c" type="check"><set name="min-words" value="1"/></node><node id="r" type="result"/>
    <wire from="ask.out" to="w.in"/><wire from="w.out" to="j.in"/><wire from="ask2.out" to="j.in"/><wire from="j.out" to="c.in"/><wire from="c.retry" to="w.in"/><wire from="c.pass" to="r.in"/>`;
  const asks = ['<node id="ask" type="ask"/>', '<node id="ask2" type="ask"><set name="text" value="Keep it short"/></node>'];
  const results = [];
  for (const order of [asks, [...asks].reverse()]) {
    const source = `<agentflow version="1">${order.join('')}${body}</agentflow>`;
    assert.deepEqual([...backWires(parseAgentFlow(xml, source))].map(wire => `${wire.from.id}.${wire.out}`), ['c.retry']);
    const { program, task } = await run(source);
    assert.equal(task.state, 'completed');
    assert.ok(program.nodes.every(node => node.state.status === 'done'), program.nodes.map(node => `${node.id}:${node.state.status}`).join(' '));
    results.push(program.nodes.find(node => node.id === 'r').state.text);
  }
  assert.equal(results[0], results[1]);
  assert.match(results[0], /^From Write:/, 'the writer\'s work reaches the result, not just the second ask');

  const forward = await run(`<agentflow version="1"><node id="ask" type="ask"/><node id="w" type="agent"/><node id="c" type="check"><set name="min-words" value="0"/></node>
    <node id="fix" type="agent"><set name="role" value="repair"/></node><node id="j" type="join"/><node id="r" type="result"/>
    <wire from="ask.out" to="w.in"/><wire from="w.out" to="c.in"/><wire from="c.pass" to="j.in"/><wire from="c.retry" to="fix.in"/><wire from="fix.out" to="j.in"/><wire from="j.out" to="r.in"/></agentflow>`);
  assert.equal(forward.program.nodes.find(node => node.id === 'r').state.status, 'done');
});

test('answers, grammars and records take any name, "constructor" too, and braces in the words around JSON', () => {
  assert.deepEqual(readForm('{"username":"bob"}\nI used {first} letters', [{ name: 'username' }]), { values: { username: 'bob' }, missing: [] });
  assert.deepEqual(readForm('Sure {not json}: {"username": "a}b"}', [{ name: 'username' }]).values, { username: 'a}b' });
  assert.deepEqual(readForm('username: bob', [{ name: 'constructor' }, { name: 'username' }]).missing, ['constructor']);
  assert.equal(expand(parseGrammar('origin: #toString#'), 'origin', rng(1)), '((toString))');
  assert.equal(expand(parseGrammar('constructor: peas\norigin: #constructor#'), 'origin', rng(1)), 'peas');
  const db = parseDatabase(xml, '<database version="1" name="x"><field name="constructor"/><field name="Name"/><record id="r1"><value field="Name">a</value></record></database>');
  assert.doesNotMatch(serializeDatabase(xml, db), /native code/);
});

test('feed titles keep their angle brackets, and Atom xhtml content is read in order', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
    <entry><id>1</id><title>2 &lt; 3 and 5 &gt; 4</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <b>bold</b> world &amp; peas</p><p>Two<br/>lines</p><ul><li>a</li><li>b</li></ul></div></content></entry>
    <entry><id>2</id><title>&lt;b&gt;Bold&lt;/b&gt; title</title><content type="html">&lt;p&gt;html &amp;amp; body&lt;/p&gt;</content></entry></feed>`;
  const [xhtml, html] = parseFeed(parseXml, atom).items;
  assert.equal(xhtml.title, '2 < 3 and 5 > 4');
  assert.equal(xhtml.text, 'Hello bold world & peas\n\nTwo\nlines\n\n• a\n• b');
  assert.equal(html.title, 'Bold title');
  assert.equal(html.text, 'html & body');
});

test('Calculator: a sign and a backspace leave 0, not a lone minus', async t => {
  const live = await session(t, { width: 480, height: 270, options: { open: ['calc'] } });
  const calc = live.os.app('calc');
  for (const key of ['5', 'sign', 'back', '+', '2', '=']) calc.run(`key:${key}`);
  assert.equal(calc.signal('display').value, '2');
});
