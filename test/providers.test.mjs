import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { ProviderRegistry, ProviderSet } from '../src/core/providers.js';
import { storageFiles, textOf } from '../src/os/files.js';
import { createDocumentStore } from '../src/os/documents.js';
import { pageSchedule } from '../src/os/schedule.js';
import { directNetwork } from '../src/platform/network.js';
import { servedProviders } from '../src/platform/served.js';
import { handler } from '../cli/serve.mjs';
import { loadManifest, ROOT } from '../cli/project.mjs';
import { session } from './helpers.mjs';

const memory = () => {
  const values = new Map();
  return { values, get: key => values.get(key) ?? null, set: (key, value) => values.set(key, value), remove: key => values.delete(key) };
};
const fakeOs = (storage = memory()) => ({ platform: { storage }, report: error => { throw error; } });
const provider = (id, extra = {}) => ({ id, title: id, kind: 'test', status: async () => ({ ok: true, reason: 'Fine.' }), work: () => id, ...extra });

/** A small world: an app service whose best provider requires a helper service. */
function world() {
  const os = fakeOs();
  const registry = new ProviderRegistry();
  const helper = registry.add(new ProviderSet(os, { service: 'helper', title: 'Helper', methods: ['work'] }));
  const main = registry.add(new ProviderSet(os, { service: 'main', title: 'Main', methods: ['work'], order: ['best', 'plain'] }));
  main.register(provider('best', { requires: ['helper'] }));
  main.register(provider('plain'));
  registry.validate();
  return { registry, helper, main };
}

// ---- Resolving ---------------------------------------------------------------------

test('a provider is used only while every service it requires is given, and says which one is missing', async () => {
  const { registry, helper, main } = world();
  await registry.refresh();
  assert.equal(main.current.value, 'plain', 'the best one steps aside while nothing gives what it requires');
  const best = (await main.survey()).find(entry => entry.id === 'best');
  assert.deepEqual([best.ok, best.reason, best.requires], [false, 'Needs Helper, which nothing here gives.', [{ service: 'helper', title: 'Helper', met: false }]]);

  helper.register(provider('hand'));
  await registry.refresh();
  assert.deepEqual([helper.current.value, main.current.value], ['hand', 'best'], 'once the helper is here, the best one is used');
  helper.install('hand', false);
  await registry.refresh();
  assert.equal(main.current.value, 'plain', 'turning off what it requires sets it aside again');
});

test('requirements must name real services and must not go round in a circle', () => {
  const os = fakeOs();
  const registry = new ProviderRegistry();
  const a = registry.add(new ProviderSet(os, { service: 'a', title: 'A', methods: [] }));
  const b = registry.add(new ProviderSet(os, { service: 'b', title: 'B', methods: [] }));
  a.register(provider('x', { requires: ['b'] }));
  b.register(provider('y', { requires: ['nowhere'] }));
  assert.throws(() => registry.validate(), /y requires "nowhere", which is not a service/);
  b.providers.get('y').requires = ['a'];
  assert.throws(() => registry.validate(), /Services require each other in a circle: a → b → a/);
  assert.throws(() => a.register(provider('z', { requires: 'b' })), /requires must be a list of service names/);
  assert.throws(() => registry.add(new ProviderSet(os, { service: 'a', title: 'A again', methods: [] })), /two services called "a"/);
});

test('a service nobody gives says why in one sentence, from the providers that could have given it', async () => {
  const os = fakeOs();
  const registry = new ProviderRegistry();
  const set = registry.add(new ProviderSet(os, { service: 'net', title: 'Internet', methods: [] }));
  set.register({ id: 'far', title: 'Far away', kind: 'test', placeholder: true, status: async () => ({ ok: false, reason: 'Not available here.' }) });
  assert.equal(await set.why(), 'Far away: Not available here.', 'with nothing real here, the placeholders explain');
  set.register(provider('cable', { status: async () => ({ ok: false, reason: 'Unplugged.' }) }));
  assert.equal(await set.why(), 'cable: Unplugged.', 'a real provider explains better than one that is not here');
  await assert.rejects(set.route(), /^Error: Nothing here gives internet\. cable: Unplugged\.$/);
});

// ---- Built-in providers ------------------------------------------------------------

test('preferences storage keeps small files between runs, within its limit, and forgets removed ones', async () => {
  const storage = memory();
  const files = storageFiles(storage);
  await files.write('documents/a.xml', new TextEncoder().encode('<a/>'));
  assert.equal(await textOf(await storageFiles(storage).read('documents/a.xml')), '<a/>', 'another run reads the same file');
  assert.deepEqual((await files.list('documents')).map(file => [file.name, file.size, file.type]), [['documents/a.xml', 4, 'application/xml']]);
  await assert.rejects(files.write('music/big.wav', new Uint8Array(3 * 1024 * 1024)), /does not fit in preferences storage/);
  await files.remove('documents/a.xml');
  assert.deepEqual(await files.list(), []);
  assert.equal(storage.values.has('pea-os.file:documents/a.xml'), false, 'its bytes are gone too');
  assert.match((await storageFiles({}).status()).reason, /keeps no preferences/);
});

test('the page schedule runs work again and again, never twice at once, until it is disposed', async () => {
  const errors = [];
  const schedule = pageSchedule(error => errors.push(error));
  let runs = 0;
  let release;
  const stop = schedule.every(5, async () => {
    runs += 1;
    if (runs === 1) await new Promise(resolve => { release = resolve; });
    if (runs === 2) throw new Error('feed down');
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(runs, 1, 'a slow run is not started again while it is going');
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  stop();
  const after = runs;
  assert.ok(after >= 3, `it ran on (${after})`);
  assert.equal(errors[0].message, 'feed down', 'a failing run is reported, and the schedule goes on');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(runs, after, 'nothing runs once disposed');
  assert.throws(() => schedule.every(0, () => {}), /time between runs/);
});

// ---- Documents are files ------------------------------------------------------------

test('documents are XML files anyone can read, and keep every character of their content', async () => {
  const files = storageFiles(memory());
  const store = createDocumentStore(async () => files);
  const content = 'Tom & Jerry <say> "hi" \'there\' ]]> end\r\nline twoé \u{1F331}\n';
  const saved = await store.save({ appId: 'notepad', name: 'Café & <friends>', format: 'text/plain', content });
  assert.match(saved.id, /^notepad-[a-z0-9]+$/);
  const [file] = await files.list('documents');
  assert.equal(file.name, `documents/${saved.id}.xml`);
  const xml = await textOf(await files.read(file.name));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<document version="1" app="notepad" name="Café &amp; &lt;friends&gt;" format="text\/plain"/);
  assert.deepEqual(await store.get(saved.id), saved);
  assert.equal((await store.get(saved.id)).content, content);

  await store.writeRecovery('notepad', { documentId: saved.id, name: 'Draft', format: 'text/plain', content: 'unsaved & new', baseContent: content, baseUpdatedAt: saved.updatedAt });
  const draft = await store.readRecovery('notepad');
  assert.deepEqual([draft.documentId, draft.name, draft.content, draft.baseContent, draft.baseUpdatedAt], [saved.id, 'Draft', 'unsaved & new', content, saved.updatedAt]);
  await store.clearRecovery('notepad');
  assert.equal(await store.readRecovery('notepad'), null);

  await files.write('documents/stray.xml', new TextEncoder().encode('<not-a-document/>'));
  assert.deepEqual((await store.list()).map(doc => doc.id), [saved.id], 'a file that is not a document is not listed');
  assert.equal(await store.get('../escape'), null);
});

test('documents go wherever the files service keeps files now', async t => {
  const stored = new Map();
  const first = await session(t, { stored });
  await first.os.ready;
  const saved = await first.os.documents.save({ appId: 'notepad', name: 'Kept', content: 'peas' });
  assert.ok(stored.has(`pea-os.file:documents/${saved.id}.xml`), 'here, with the preferences');
  first.dispose();
  const again = await session(t, { stored });
  assert.equal((await again.os.documents.get(saved.id)).content, 'peas', 'and there after a restart');
});

// ---- Apps and the services they declare ---------------------------------------------

test('an app reaches only the services it declares, and hears in plain words what is missing', async t => {
  const live = await session(t, { options: { open: ['feeds'] } });
  const { os } = live;
  await os.ready;
  const feeds = os.app('feeds');
  const network = feeds.service('network');
  assert.equal(network.ready.value, false);
  assert.match(await network.why(), /^Pea Feeds can't reach the internet here\. Relay \(pos serve\): Not available here/);
  await assert.rejects(network.use(), /^Error: Pea Feeds can't reach the internet here\./);
  await assert.rejects(feeds.request({ url: 'https://example.com/feed' }), /Pea Feeds can't reach the internet here/);
  await live.frames(5);
  assert.match(feeds.signal('status').value, /^Pea Feeds can't reach the internet here/, 'the status line says so');
  assert.equal(await feeds.service('schedule').why(), '', 'the page schedule is always here');
  assert.throws(() => os.app('calc').service('network'), /Calculator uses the network service without declaring it/);
  await assert.rejects(os.app('calc').request({ url: 'https://example.com/' }), /without declaring it/);
  assert.deepEqual(os.software.needs('feeds').map(need => [need.title, need.required, need.provider]), [['Internet', false, null], ['Schedule', false, 'While Pea OS is open']]);
});

test('with the internet given, a declared request goes through it', async t => {
  const asked = [];
  const live = await session(t, { request: async options => { asked.push(options.url); return { ok: true, status: 200, type: 'text/plain', text: 'pong' }; } });
  const { os } = live;
  await os.ready;
  assert.equal(os.providers.network.current.value, 'test-network');
  const http = os.app('http');
  assert.equal((await http.request({ url: 'https://example.com/ping' })).text, 'pong');
  await assert.rejects(http.request({ url: 'file:///etc/passwd' }), /Only http and https/);
  assert.deepEqual(asked, ['https://example.com/ping']);
  assert.equal(os.software.installed('http'), true);
});

test('Software shows every service as a tree: its providers in order, and what each requires', async t => {
  const live = await session(t, { width: 640, height: 400, options: { open: ['software'] } });
  const { os } = live;
  await os.ready;
  await live.frames(5);
  const items = os.app('software').refs.providers.items;
  const row = value => items.find(item => item.value === value);
  assert.deepEqual([row('service:files').depth, row('service:files').detail], [0, 'Preferences storage']);
  assert.deepEqual([row('provider:files:storage-files').depth, row('provider:files:storage-files').detail, row('provider:files:storage-files').sprite], [1, 'In use', 'mark-on']);
  assert.equal(row('provider:files:memory').detail, 'Ready');
  assert.equal(row('provider:files:disk').sprite, 'mark-off', 'a provider this platform does not offer is quiet, not alarming');
  const server = items.findIndex(item => item.value === 'provider:thinking:server');
  assert.deepEqual([items[server].detail, items[server + 1].text, items[server + 1].depth, items[server + 1].detail], ['Needs internet', 'Requires internet', 2, 'Nothing here gives it']);
  os.app('software').signal('entry').set('service:network');
  await live.frames(5);
  assert.match(os.app('software').signal('entry-state').value, /^Nothing here gives internet\./);
  assert.equal(os.app('software').signal('entry-about').value, 'Required by Agent Chat and HTTP Probe. Used by Pea Feeds. Model server (/v1) requires it.');
});

// ---- Reaching sites ----------------------------------------------------------------

/** A tiny site on this computer. */
async function site(t, answer) {
  const http = createServer(answer);
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => { http.closeAllConnections(); http.close(); });
  return `http://127.0.0.1:${http.address().port}/`;
}

test('the relay reaches a site through pos serve, and streams its answer', async t => {
  const target = await site(t, (request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('hello '); response.end('peas'); });
  const pea = await site(t, handler(await loadManifest(ROOT), ROOT, { write() {} }));
  const relay = servedProviders(pea).find(item => item.id === 'relay');
  assert.deepEqual([relay.requires, (await relay.status()).ok], [['server'], true]);
  const pieces = [];
  const answer = await relay.request({ url: target, onText: piece => pieces.push(piece) });
  assert.deepEqual([answer.ok, answer.status, answer.text, pieces.join('')], [true, 200, 'hello peas', 'hello peas']);
});

test('a direct request that fails says the site may not let pages read it', async () => {
  const network = directNetwork(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(network.request({ url: 'https://feeds.example.org/rss' }), /feeds\.example\.org could not be reached from this page: it may be offline, or it may not let other pages read it/);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(directNetwork(async () => { throw new DOMException('Stopped', 'AbortError'); }).request({ url: 'https://a.example/', signal: stopped.signal }), /Stopped/);
});
