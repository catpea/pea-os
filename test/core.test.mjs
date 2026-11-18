import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signal, combineLatest, batch, EventEmitter, DisposableScope, SignalBinder, persist } from '../src/core/reactive.js';
import { parseXml, XmlError } from '../src/core/xml.js';

test('a diamond settles before anyone is told', () => {
  const source = new Signal(1);
  const double = source.map(n => n * 2);
  const triple = source.map(n => n * 3);
  const sum = combineLatest(double, triple, (a, b) => a + b);
  const seen = [];
  sum.subscribe((value, previous) => seen.push([value, previous]));
  source.set(2);
  assert.deepEqual(seen, [[5, undefined], [10, 5]]);
});

test('batch publishes once and drops writes that cancel out', () => {
  const a = new Signal(1);
  const b = new Signal(10);
  const total = combineLatest(a, b, (x, y) => x + y);
  const totals = [];
  const as = [];
  total.subscribe(value => totals.push(value), { immediate: false });
  a.subscribe(value => as.push(value), { immediate: false });
  batch(() => {
    a.set(2);
    b.set(20);
    assert.equal(total.value, 22, 'a derived read inside a batch is already settled');
  });
  batch(() => {
    a.set(99);
    a.set(2);
  });
  assert.deepEqual(totals, [22]);
  assert.deepEqual(as, [2]);
  assert.throws(() => batch(async () => {}), /synchronous/);
});

test('a write from a subscriber starts a new wave with stable envelopes', () => {
  const count = new Signal(0);
  const log = [];
  count.subscribe(value => { if (value === 1) count.set(2); }, { immediate: false });
  count.subscribe((value, previous) => log.push([value, previous]), { immediate: false });
  count.set(1);
  assert.deepEqual(log, [[1, 0], [2, 1]]);
});

test('uninitialized signals stay quiet until they hold a value', () => {
  const empty = new Signal();
  const other = new Signal(undefined);
  const calls = [];
  const pair = combineLatest(empty, other, (a, b) => [a, b]);
  empty.subscribe(value => calls.push(value));
  assert.equal(pair.initialized, false);
  empty.set('now');
  assert.deepEqual(calls, ['now']);
  assert.deepEqual(pair.value, ['now', undefined]);
  assert.throws(() => pair.set(1), /read-only/);
});

test('one failing subscriber does not starve the others', () => {
  const signal = new Signal(0);
  const seen = [];
  signal.subscribe(() => { throw new Error('boom'); }, { immediate: false });
  signal.subscribe(value => seen.push(value), { immediate: false });
  assert.throws(() => signal.set(1), /boom/);
  assert.deepEqual(seen, [1]);
});

test('scope names fail loudly and disposal is LIFO, idempotent and thorough', () => {
  const scope = new DisposableScope();
  scope.signal('theme', 'garden');
  assert.throws(() => scope.signal('theme', 'night'), /already declared/);
  assert.throws(() => scope.resolve('themee'), /Unknown signal "themee"\. Declared: theme/);

  const order = [];
  scope.add(() => order.push('first'));
  scope.add(() => { throw new Error('cleanup failed'); });
  scope.add({ dispose: () => order.push('last') });
  assert.throws(() => scope.dispose(), /cleanup failed/);
  assert.deepEqual(order, ['last', 'first']);
  scope.dispose();
  let late = false;
  scope.add(() => { late = true; });
  assert.equal(late, true, 'a resource added after disposal is released at once');
});

test('scope effects rerun with cleanup and stop on disposal', () => {
  const scope = new DisposableScope();
  const size = scope.signal('size', 1);
  const log = [];
  scope.effect(['size'], value => {
    log.push(`run ${value}`);
    return () => log.push(`clean ${value}`);
  });
  size.set(2);
  scope.dispose();
  size.set(3);
  assert.deepEqual(log, ['run 1', 'clean 1', 'run 2', 'clean 2']);
});

test('SignalBinder pushes into its target; EventEmitter listeners detach', () => {
  const title = new Signal('a');
  const target = {};
  const binder = new SignalBinder(target, title, 'text');
  title.set('b');
  binder.dispose();
  title.set('c');
  assert.equal(target.text, 'b');

  const emitter = new EventEmitter();
  const heard = [];
  const off = emitter.on('tap', value => heard.push(value));
  emitter.once('tap', value => heard.push(`once ${value}`));
  emitter.emit('tap', 1);
  off();
  emitter.emit('tap', 2);
  assert.deepEqual(heard, [1, 'once 1']);
});

test('persist hydrates valid records and ignores the rest', () => {
  const store = new Map();
  const storage = { get: key => store.get(key) ?? null, set: (key, value) => store.set(key, value) };
  const theme = new Signal('garden');
  persist(theme, { key: 'theme', storage });
  theme.set('night');
  assert.deepEqual(JSON.parse(store.get('theme')), { version: 1, value: 'night' });

  const restored = new Signal('garden');
  persist(restored, { key: 'theme', storage, accept: value => ['garden', 'night'].includes(value) });
  assert.equal(restored.value, 'night');

  store.set('theme', '{"version":1,"value":"gone"}');
  const refused = new Signal('garden');
  persist(refused, { key: 'theme', storage, accept: value => value !== 'gone' });
  assert.equal(refused.value, 'garden');

  store.set('theme', 'not json');
  const errors = [];
  const broken = new Signal('garden');
  persist(broken, { key: 'theme', storage, onError: error => errors.push(error) });
  assert.equal(broken.value, 'garden');
  assert.equal(errors.length, 1);
});

test('xml: elements, attributes, entities, CDATA and comments', () => {
  const root = parseXml(`<?xml version="1.0"?>
    <!-- a comment -->
    <app title="Tom &amp; Jerry &#x2665;" n='2'>
      <row>a &lt; b</row>
      <row><![CDATA[<raw>]]></row>
      <empty/>
    </app>`, 'app.xml');
  assert.equal(root.name, 'app');
  assert.equal(root.attr('title'), 'Tom & Jerry ♥');
  assert.equal(root.num('n'), 2);
  assert.deepEqual(root.all('row').map(row => row.text), ['a < b', '<raw>']);
  assert.equal(root.child('empty').line, 6);
  assert.equal(root.attr('missing', 'fallback'), 'fallback');
});

test('xml: mistakes are located and never ignored', () => {
  const fails = (text, pattern) => assert.throws(() => parseXml(text, 'bad.xml'), error => {
    assert.ok(error instanceof XmlError);
    assert.match(error.message, pattern);
    return true;
  });
  fails('<a><b></a>', /bad\.xml:1:\d+: <\/a> does not close <b>/);
  fails('<a>\n  <b x="1" x="2"/>\n</a>', /bad\.xml:2:\d+: duplicate attribute "x"/);
  fails('<a>', /<a> is never closed/);
  fails('<a/><b/>', /second root/);
  fails('<a>&nope;</a>', /unknown entity/);
  fails('<!DOCTYPE a><a/>', /doctype/);
  fails('<a x=1/>', /must be quoted/);

  const node = parseXml('<theme id="x" colour="red"><oops/></theme>', 'theme.xml');
  assert.throws(() => node.expect({ attrs: ['id'] }), /theme\.xml:1: <theme> has an unknown attribute "colour"/);
  assert.throws(() => node.expect({ attrs: ['id', 'colour'], children: ['color'] }), /<oops> is not allowed inside <theme>/);
  assert.throws(() => node.need('name'), /needs a "name" attribute/);
  assert.throws(() => parseXml('<a n="x1"/>').num('n'), /is not a number/);
});
