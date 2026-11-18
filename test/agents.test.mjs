import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, escapeXml } from '../src/core/xml.js';
import { readFileSync } from 'node:fs';
import { ModelRouter } from '../src/ai/router.js';
import { ProviderRegistry, ProviderSet } from '../src/core/providers.js';
import { message, textOf, asChat } from '../src/ai/protocol.js';
import { AgentRun, backWires, parseAgentFlow, serializeAgentFlow, parseTemplates, cardOf } from '../src/ai/flow.js';
import { session, walk } from './helpers.mjs';

const xml = { parseXml, escapeXml };
const TEMPLATES = readFileSync(new URL('../res/data/agent-flows.xml', import.meta.url), 'utf8');

/** A stand-in for the kernel: storage, a platform, and a network that answers as told. */
function fakeOs({ capabilities = {}, name = 'headless', chat = null, request } = {}) {
  const store = new Map(chat ? [['pea-os.chat.v1', JSON.stringify(chat)]] : []);
  return {
    platform: { name, capabilities, storage: { get: key => store.get(key) ?? null, set: (key, value) => store.set(key, value) } },
    request: request ?? (async () => { throw new Error('There is no network connection here.'); }),
    report: error => { throw error; },
    store
  };
}

/**
 * The thinking service as the kernel has it: inside a registry, beside an
 * internet service whose one provider sends requests through os.request.
 */
function thinking(os) {
  const registry = new ProviderRegistry();
  const router = registry.add(new ModelRouter(os));
  const network = registry.add(new ProviderSet(os, { service: 'network', title: 'Internet', methods: ['request'] }));
  network.register({ id: 'test-network', title: 'Test network', kind: 'test', status: async () => ({ ok: true }), request: options => os.request(options) });
  registry.validate();
  return router;
}

/** Runs a flow with messages delivered on the next turn, as a board delivers them when envelopes land. */
function runFlow(program, ai) {
  return new Promise(resolve => {
    const run = new AgentRun(program, {
      ai, seed: 7,
      send: (wire, msg) => setImmediate(() => run.deliver(wire, msg)),
      onFinish: task => resolve({ run, task })
    });
    run.start();
  });
}

test('messages carry text and data parts and become a chat for models', () => {
  const msg = message({ from: 'Plan', text: 'Step one', data: { steps: 1 } });
  assert.equal(textOf(msg), 'Step one');
  assert.ok(Object.isFrozen(msg) && Object.isFrozen(msg.parts));
  const chat = asChat('Be brief.', [msg, message({ from: 'Ideas', text: 'Try seeds' })]);
  assert.deepEqual(chat.map(item => item.role), ['system', 'user']);
  assert.match(chat[1].content, /From Plan:\nStep one\n\nFrom Ideas:\nTry seeds/);
});

test('the model router always has Pea Mind and says why others cannot think here', async () => {
  const router = thinking(fakeOs());
  const survey = Object.fromEntries((await router.survey()).map(entry => [entry.id, entry]));
  assert.equal(survey['pea-mind'].ok, true);
  assert.match(survey.server.reason, /^Not set up/);
  assert.match(survey.webllm.reason, /^Incompatible: WebLLM requires WebGPU/);
  assert.equal(survey.webllm.installed, false, 'WebLLM starts uninstalled');
  assert.match(survey.device.reason, /^Incompatible: only on phones and tablets/);
  assert.equal((await router.route()).id, 'pea-mind');
  assert.throws(() => router.install('pea-mind', false), /always stays/);
  const reply = await router.complete({ messages: [{ role: 'user', content: 'grow beans on a windowsill' }], skill: 'plan', seed: 1 });
  assert.equal(reply.provider, 'pea-mind');
  assert.equal(reply.text, (await router.complete({ messages: [{ role: 'user', content: 'grow beans on a windowsill' }], skill: 'plan', seed: 1 })).text, 'Pea Mind answers the same question the same way');
  // WebGPU alone is not enough: Pea OS will not download the library.
  const gpu = thinking(fakeOs({ capabilities: { webgpu: true } }));
  assert.match((await gpu.survey()).find(entry => entry.id === 'webllm').reason, /^Not installed: .*never downloads code/);
});

test('a set-up server answers through os.request; when it fails, auto falls back to Pea Mind', async () => {
  const sent = [];
  const os = fakeOs({
    chat: { 'base-url': 'http://127.0.0.1:11434/v1/', model: 'tiny' },
    request: async options => {
      sent.push(options);
      options.onText('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n');
      return { ok: true, status: 200, text: '' };
    }
  });
  const router = thinking(os);
  assert.equal((await router.route()).id, 'server');
  const reply = await router.complete({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual([reply.text, reply.provider, reply.model], ['Hello', 'server', 'tiny']);
  assert.equal(sent[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(JSON.parse(sent[0].body).model, 'tiny');

  os.request = async () => ({ ok: false, status: 404, text: '{"error":{"message":"model not found"}}' });
  const fallback = await router.complete({ messages: [{ role: 'user', content: 'Hi' }], skill: 'chat' });
  assert.equal(fallback.provider, 'pea-mind');
  assert.match(fallback.fallback, /^Model server \(\/v1\): The server answered 404: model not found\. Check the base URL/);
  await assert.rejects(router.complete({ prefer: 'server', messages: [] }), /404/, 'a named provider is not swapped for another');
  router.install('server', false);
  assert.equal((await router.route()).id, 'pea-mind');
  assert.deepEqual(JSON.parse(os.store.get('pea-os.ai.v1')).off.sort(), ['device', 'server', 'webllm']);
});

test('agent flows read strictly, write back the same, and keep multi-line instructions', () => {
  const text = `<agentflow version="1">
  <node id="ask" type="ask" x="0" y="0"><set name="text" value="line one&#10;line two"/></node>
  <node id="think" type="agent" x="96" y="0"><set name="role" value="plan"/><set name="provider" value="pea-mind"/></node>
  <wire from="ask.out" to="think.in"/>
</agentflow>`;
  const flow = parseAgentFlow(xml, text, 'mine.xml');
  assert.equal(flow.nodes[0].params.text, 'line one\nline two');
  assert.deepEqual(parseAgentFlow(xml, serializeAgentFlow(xml, flow)).nodes.map(node => node.params), flow.nodes.map(node => node.params));
  assert.equal(cardOf(flow.nodes[1]).kind, 'gofai', 'an agent held to Pea Mind presents a rule-based card');
  assert.throws(() => parseAgentFlow(xml, '<agentflow version="1"><node id="a" type="wizard"/></agentflow>', 'bad.xml'), /bad\.xml:1: .*type="wizard" is not a node type/);
  assert.throws(() => parseAgentFlow(xml, '<agentflow version="1"><node id="a" type="agent"><set name="role" value="dream"/></node></agentflow>'), /value="dream" must be one of plan/);
  assert.throws(() => parseAgentFlow(xml, '<agentflow version="1"><node id="a" type="ask"/><wire from="a.out" to="a.nope"/></agentflow>'), /Ask has inputs none/);
});

test('every template runs to a result offline, and loops come back to their writer', async () => {
  const ai = thinking(fakeOs());
  const templates = parseTemplates(xml, TEMPLATES);
  assert.ok(templates.length >= 10);
  assert.deepEqual([...new Set(templates.map(template => template.group))].sort(), ['family', 'make', 'team']);
  for (const template of templates) {
    const program = parseAgentFlow(xml, template.element, template.id);
    const { task } = await runFlow(program, ai);
    assert.equal(task.state, 'completed', template.id);
    const results = program.nodes.filter(node => node.type === 'result');
    assert.ok(results.every(node => node.state.status === 'done' && node.state.text.trim().length > 0), `${template.id} reaches its result`);
    assert.equal(task.artifacts.length, results.length);
  }

  const loop = parseAgentFlow(xml, templates.find(template => template.id === 'try-again').element);
  assert.deepEqual([...backWires(loop)].map(wire => `${wire.from.id}.${wire.out}`), ['check.retry']);
  const { task } = await runFlow(loop, ai);
  const check = loop.nodes.find(node => node.id === 'check');
  assert.ok(check.state.round >= 1 && check.state.round <= 3, 'Check gives up after its tries');
  assert.equal(task.history.filter(msg => msg.from === 'Writer').length, check.state.round);
});

test('a router takes one road and skips the others, so the result still arrives', async () => {
  const flow = parseAgentFlow(xml, parseTemplates(xml, TEMPLATES).find(template => template.id === 'which-way').element);
  const { task } = await runFlow(flow, thinking(fakeOs()));
  const status = Object.fromEntries(flow.nodes.map(node => [node.id, node.state.status]));
  assert.deepEqual(status, { ask: 'done', route: 'done', poet: 'skipped', teller: 'done', helper: 'skipped', answer: 'done' });
  assert.equal(task.state, 'completed');
});

test('a failing agent fails the run with its reason, and a stopped run is canceled', async () => {
  const flow = parseAgentFlow(xml, `<agentflow version="1"><node id="a" type="ask"/><node id="b" type="agent"><set name="provider" value="server"/></node><node id="c" type="result"/>
    <wire from="a.out" to="b.in"/><wire from="b.out" to="c.in"/></agentflow>`);
  const { task, run } = await runFlow(flow, thinking(fakeOs()));
  assert.equal(task.state, 'failed');
  assert.match(run.reason, /^Write: Model server \(\/v1\): Not set up/);
  assert.equal(flow.nodes[2].state.status, 'skipped');

  const slow = { complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')))) };
  const stopped = new AgentRun(parseAgentFlow(xml, '<agentflow version="1"><node id="a" type="ask"/><node id="b" type="agent"/><wire from="a.out" to="b.in"/></agentflow>'),
    { ai: slow, send: (wire, msg) => setImmediate(() => stopped.deliver(wire, msg)) }).start();
  await new Promise(resolve => setImmediate(resolve));
  stopped.stop();
  assert.equal(stopped.task.state, 'canceled');
});

test('Agent Flow runs on the board, takes nodes dragged from its list, and starts templates', async t => {
  const live = await session(t, { width: 960, height: 540, options: { open: ['agents'], pixel: 1 } });
  const app = live.os.app('agents');
  const { board, palette } = app.refs;
  live.os.run('set:os.minimap=false'); // the map, on top, would cover the board's corner
  await live.frames(4);
  assert.equal(app.signal('zoom-label').value, '100%', 'the starter flow is framed once the board has a size');
  const done = board.runFlow();
  let result = null;
  done.then(value => { result = value; });
  for (let i = 0; i < 100 && !result; i++) await live.frames(10);
  assert.equal(result?.task.state, 'completed');
  assert.match(app.signal('output').value, /From Poet:/);
  assert.equal(app.signal('page').value, 'output');
  assert.ok(app.refs.messages.items.length >= 3);

  palette.model.set('check');
  await live.frames(2);
  const row = palette.locate('check');
  const from = palette.toScreen(row.x, row.y);
  const to = board.toScreen(board.w - 60, board.h - 30);
  await live.drag([[from.x, from.y], [from.x + 4, from.y], [from.x + 30, from.y + 4], [to.x, to.y]]);
  assert.equal(app.signal('selection-title').value, 'Check (Check)');

  const loading = board.loadTemplate('weekend');
  await live.frames(2);
  assert.ok(live.os.dialogs.active, 'a changed flow offers to save first');
  live.os.dialogs.cancel();
  assert.equal(await loading, false);
});

test('Agent Flow nodes resize from their corner, and their ports follow the right edge', async t => {
  const live = await session(t, { width: 960, height: 540, options: { open: ['agents'], pixel: 1 } });
  const app = live.os.app('agents');
  const { board } = app.refs;
  live.os.run('set:os.minimap=false');
  await app.files.ready;
  await live.frames(30); // the window opens with a little animation; press where it lands
  const { nodeSize } = await import('../res/apps/agents.js');
  const program = parseAgentFlow(xml, app.files.serialize());
  const node = program.nodes.at(-1);
  const before = nodeSize(node);
  const zoom = board.magnifier();
  const local = board.fromWorld(node.x + before.w - 2, node.y + before.h - 2);
  const corner = board.toScreen(local.x, local.y);
  await live.drag([[corner.x, corner.y], [corner.x + 8, corner.y + 8], [corner.x + 40 * zoom, corner.y + 30 * zoom]]);
  const sized = parseAgentFlow(xml, app.files.serialize()).nodes.find(item => item.id === node.id);
  assert.deepEqual(nodeSize(sized), { w: before.w + 40, h: before.h + 30 });
  assert.equal(app.signal('selection-title').value.length > 0, true);

  // Too small is held at room for the ports and a line.
  await live.drag([[corner.x + 40 * zoom, corner.y + 30 * zoom], [corner.x, corner.y], [corner.x - 400, corner.y - 400]]);
  const small = parseAgentFlow(xml, app.files.serialize()).nodes.find(item => item.id === node.id);
  assert.equal(nodeSize(small).w, 48);
  assert.ok(nodeSize(small).h < before.h && nodeSize(small).h > 30);
  assert.deepEqual(live.errors, []);
});

test('Software hides and shows apps without touching their documents; parts of Pea OS stay', async t => {
  const live = await session(t, { width: 960, height: 540, options: { open: ['software'] } });
  const { os } = live;
  const icon = () => [...walk(os.desktop.desk)].find(widget => widget.app?.id === 'catch');
  assert.ok(icon().visible);
  os.app('software').signal('app-id').set('catch');
  await live.frames(2);
  assert.equal(os.app('software').signal('app-action').value, 'Remove');
  os.app('software').run('toggle-app');
  await live.frames(4);
  assert.equal(os.software.installed('catch'), false);
  assert.equal(icon().visible, false);
  os.desktop.openStart();
  await live.frames(2);
  const start = [...walk(os.desktop.popups)].find(widget => widget.constructor.name === 'Launcher');
  start.query.set('catch');
  assert.ok(!start.items.some(item => item.app?.id === 'catch'), 'Start no longer finds it');
  os.desktop.openStart();
  assert.throws(() => os.software.install('settings', false), /part of Pea OS/);
  os.software.install('catch', true);
  await live.frames(2);
  assert.ok(icon().visible);
});

// ---- Fill-in prompts and answer forms ---------------------------------------------

import { placeholders, fill, parseFields, formPrompt, readForm, withForm } from '../src/ai/form.js';
import { fillForm } from '../src/ai/gofai.js';

test('fill-in prompts name their inputs and answer forms name their outputs', () => {
  const prompt = 'First name {{firstName}}, last name {{ lastName }}, again {{firstName}}.';
  assert.deepEqual(placeholders(prompt), ['firstName', 'lastName']);
  assert.equal(fill(prompt, name => ({ firstName: 'Alice', lastName: 'Smith' })[name]), 'First name Alice, last name Smith, again Alice.');
  assert.deepEqual(parseFields('username: alice123\n\nmood:'), [{ name: 'username', example: 'alice123' }, { name: 'mood', example: '' }]);
  assert.throws(() => parseFields('username alice123'), /line 1: write "name: example"/);
  assert.throws(() => parseFields('a: 1\na: 2'), /line 2: "a" is used twice/);
  const fields = parseFields('username: alice123\nreason: short and easy');
  const lines = formPrompt(fields);
  assert.match(lines, /^ANSWER FORMAT\. Reply with exactly these 2 lines, in this order, and nothing else/);
  assert.match(lines, /username: <username>\nreason: <reason>/);
  assert.match(lines, /username: alice123\nreason: short and easy$/);
  assert.match(formPrompt(fields, 'json'), /only one JSON object.*\n.*"username", "reason"/);
  assert.deepEqual(withForm([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }], fields).map(item => item.content.split('\n')[0]), ['S', 'Q']);
});

test('answers are read from JSON or lines, however a small model dresses them', () => {
  const fields = [{ name: 'username', example: '' }, { name: 'firstName', example: '' }, { name: 'story', example: '' }];
  const read = text => readForm(text, fields);
  assert.deepEqual(read('{"username":"alice123","first_name":"Alice","story":"Once."}').values, { username: 'alice123', firstName: 'Alice', story: 'Once.' });
  assert.deepEqual(read('Sure! Here it is:\n```json\n{ "Username": "bob7", "firstName": 3 }\n```').values, { username: 'bob7', firstName: '3' });
  const lines = read('Here you go.\n- **Username:** `alice123`\nFirst Name: "Alice"\nstory: Once upon a time,\nthere was a pea.\n\nHope that helps!');
  assert.deepEqual(lines.values, { username: 'alice123', firstName: 'Alice', story: 'Once upon a time,\nthere was a pea.' });
  assert.deepEqual(lines.missing, []);
  assert.deepEqual(read('I cannot help with that.').missing, ['username', 'firstName', 'story']);
});

test('a Prompt node fills its inputs in and sends each answer down its own wire', async () => {
  const flow = parseAgentFlow(xml, `<agentflow version="1">
    <node id="a" type="ask"><set name="text" value="Alice"/></node><node id="b" type="ask"><set name="text" value="Smith"/></node>
    <node id="p" type="prompt"><set name="answer" value="username: alice123&#10;why: short"/></node>
    <node id="r" type="result"/><node id="w" type="result"/>
    <wire from="a.out" to="p.firstName"/><wire from="b.out" to="p.lastName"/><wire from="p.username" to="r.in"/><wire from="p.why" to="w.in"/></agentflow>`);
  assert.throws(() => parseAgentFlow(xml, '<agentflow version="1"><node id="a" type="ask"/><node id="p" type="prompt"/><wire from="a.out" to="p.nickname"/></agentflow>'),
    /to="p.nickname": Prompt has inputs firstName, lastName/);
  const asked = [];
  const replies = ['Sure thing!', 'Username: alice_smith\nWhy: it is her name'];
  const ai = { complete: async request => { asked.push(request); return { text: replies.shift(), provider: 'server', model: 'tiny' }; } };
  const { task } = await runFlow(flow, ai);
  assert.equal(task.state, 'completed');
  assert.match(asked[0].messages[0].content, /someone called Alice Smith\./);
  assert.deepEqual(asked[0].form.map(field => field.name), ['username', 'why']);
  assert.equal(asked[0].topic, 'Alice Smith');
  assert.match(asked[1].messages.at(-1).content, /did not follow the answer format.*Answer again\./, 'a reply out of form is asked for once more');
  assert.equal(flow.nodes.find(node => node.id === 'r').state.text, 'alice_smith');
  assert.equal(flow.nodes.find(node => node.id === 'w').state.text, 'it is her name');

  // Offline, Pea Mind fills the form by rules, and every template still runs.
  assert.equal(fillForm({ prompt: 'Her first name is Ada and her last name is Lovelace.', fields: [{ name: 'firstName', example: '' }, { name: 'username', example: 'ada12' }] }).split('\n')[0], 'firstName: Ada');
  const offline = parseAgentFlow(xml, parseTemplates(xml, TEMPLATES).find(template => template.id === 'fill-in').element);
  await runFlow(offline, thinking(fakeOs()));
  assert.match(offline.nodes.find(node => node.id === 'answer').state.text, /^alice\d+$/);
});

/** The browser's Prompt API, as far as Pea uses it. */
function fakeLanguageModel(state, reply) {
  const calls = [];
  return {
    calls,
    state,
    async availability(options) { calls.push(['availability', options]); return this.state; },
    async create(options) {
      calls.push(['create', options]);
      options.monitor?.({ addEventListener: (type, listen) => listen({ loaded: 0.5 }) });
      this.state = 'available';
      return { prompt: async (text, options2) => { calls.push(['prompt', text, options2]); return reply; }, destroy: () => calls.push(['destroy']) };
    }
  };
}

test("the browser's built-in model is a thinker: it reports why not, downloads on Install, and enforces answer forms", async () => {
  const none = (await thinking(fakeOs()).survey()).find(entry => entry.id === 'browser-ai');
  assert.match(none.reason, /^Incompatible: this browser has no built-in model \(the Prompt API\)/);
  const os = fakeOs();
  os.platform.languageModel = fakeLanguageModel('unavailable', '');
  const router = thinking(os);
  assert.match((await router.survey()).find(entry => entry.id === 'browser-ai').reason, /^Incompatible: the browser says its model cannot run/);
  os.platform.languageModel = fakeLanguageModel('downloadable', '{"username":"alice123"}');
  const waiting = (await router.survey()).find(entry => entry.id === 'browser-ai');
  assert.deepEqual([waiting.ok, waiting.setup], [false, true]);
  let bumps = 0;
  router.changed.subscribe(() => { bumps += 1; }, { immediate: false });
  await router.setup('browser-ai');
  assert.ok(bumps >= 2, 'download progress is pushed to the Software window');
  assert.equal((await router.route()).id, 'browser-ai');
  const reply = await router.complete({ messages: [{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Name for Alice?' }], form: [{ name: 'username', example: 'alice123' }] });
  assert.deepEqual([reply.text, reply.provider], ['{"username":"alice123"}', 'browser-ai']);
  const [, created] = os.platform.languageModel.calls.filter(call => call[0] === 'create').at(-1);
  assert.deepEqual(created.initialPrompts, [{ role: 'system', content: 'Be kind.' }]);
  const [, text, options] = os.platform.languageModel.calls.find(call => call[0] === 'prompt');
  assert.match(text, /^Name for Alice\?\n\nANSWER FORMAT\. Reply with only one JSON object/);
  assert.deepEqual(options.responseConstraint, { type: 'object', properties: { username: { type: 'string' } }, required: ['username'], additionalProperties: false });
  assert.equal(os.platform.languageModel.calls.at(-1)[0], 'destroy', 'each answer gets a fresh session, freed after');
});

test('a server is asked for JSON by schema, and with the lines format when it cannot enforce one', async () => {
  const bodies = [];
  const os = fakeOs({
    chat: { 'base-url': 'http://127.0.0.1:8080/v1', model: 'small' },
    request: async options => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) return { ok: false, status: 400, text: '{"error":{"message":"response_format is not supported"}}' };
      options.onText('data: {"choices":[{"delta":{"content":"username: alice123"}}]}\n\ndata: [DONE]\n');
      return { ok: true, status: 200, text: '' };
    }
  });
  const reply = await thinking(os).complete({ messages: [{ role: 'user', content: 'Name?' }], form: [{ name: 'username', example: 'alice123' }] });
  assert.equal(reply.text, 'username: alice123');
  assert.equal(bodies[0].response_format.type, 'json_schema');
  assert.match(bodies[0].messages[0].content, /only one JSON object/);
  assert.equal(bodies[1].response_format, undefined);
  assert.match(bodies[1].messages[0].content, /Reply with exactly this 1 line/);
});
