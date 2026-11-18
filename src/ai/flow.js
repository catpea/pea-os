import { parseGraph, serializeGraph } from '../ui/graph.js';
import { message, textOf, dataOf, createTask, setState, asChat } from './protocol.js';
import { placeholders, fill, parseFields, readForm } from './form.js';
import { SKILLS, SHAPES, poem, story, song, novel, familyIdeas, parseGrammar, expand, keywords, rng } from './gofai.js';

/**
 * Agent flows: a team of agents wired together. Each node is an agent with a
 * card (who it is, what it can do, whether it is a language model, rule-based
 * or input/output). Wires carry protocol messages from an output to an input.
 *
 * A node acts when every wire coming into it has brought something since it
 * last acted, so a join waits for all of its helpers. A wire that loops back
 * to an earlier node (a "back wire", like Check's retry) wakes that node at
 * once, with the feedback added. A router answers its unchosen branches with
 * a skip message; a node whose inputs were all skipped passes the skip on and
 * does nothing, so every branch of a flow finishes.
 *
 *   <agentflow version="1">
 *     <node id="ask" type="ask" x="8" y="8"><set name="text" value="A poem about rain"/></node>
 *     <node id="poet" type="poet" x="100" y="8"/>
 *     <wire from="ask.out" to="poet.in"/>
 *   </agentflow>
 */

const number = (label, value, min = 0, max = 1e6) => ({ type: 'number', label, value, min, max });
const text = (label, value) => ({ type: 'text', label, value });
const long = (label, value) => ({ type: 'long', label, value });
const choice = (label, value, options) => ({ type: 'choice', label, value, options });

const PROVIDERS = ['auto', 'pea-mind', 'server', 'browser-ai'];
const FORMS = ['couplets', 'haiku', 'limerick', 'acrostic'];

/** What a language model is asked to be, for each role; Pea Mind has a rule for each. */
export const ROLES = {
  plan: 'Break the request into a short numbered plan.',
  ideate: 'Suggest a few fresh ideas for the request.',
  solve: 'Work out a solution, using the plan and ideas you are given.',
  test: 'Test the solution: list what works and what does not.',
  review: 'Review the work: name what is good and the most important things to fix.',
  repair: 'Fix the problems that were found and give the improved version in full.',
  verify: 'Check the final answer carefully and say plainly whether it holds.',
  summarize: 'Summarize what you are given in a few sentences.',
  write: 'Write the piece asked for.',
  classify: 'Answer with one label only.',
  chat: 'Reply helpfully and kindly.'
};

const skipped = msg => dataOf(msg)?.skip === true;
const words = value => (String(value).match(/[\p{L}\p{N}']+/gu) ?? []);
/** A Prompt's ports: its {{names}} in, its answer form's names out. A form with a mistake has one plain output until it is fixed. */
const promptInputs = params => { const names = placeholders(params.prompt); return names.length ? names : ['in']; };
const promptOutputs = params => {
  try { const fields = parseFields(params.answer); return fields.length ? fields.map(field => field.name) : ['out']; } catch { return ['out']; }
};
const shorten = (value, n = 120) => { const flat = String(value).replace(/\s+/g, ' ').trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };

/** The request the creative nodes work from: what came in, or a default. */
const topic = (inputs, fallback) => inputs.map(textOf).filter(Boolean).join('\n') || fallback;

/**
 * Every node type. `card` is its A2A-style agent card; `act(context)` does
 * its work and returns emissions: [{ port, text, data, skip }].
 *   context = { node, inputs: [Message], byPort: { port: [Message] }, ai, seed, signal, run }
 * `inputs` and `outputs` are port names, or a function of the node's
 * settings for a node whose ports its settings name (see Prompt).
 */
export const TYPES = {
  ask: {
    title: 'Ask', group: 'start', inputs: [], outputs: ['out'],
    card: { kind: 'io', about: 'What you want: a question, a wish, a few words' },
    params: { name: text('Name', ''), text: long('Your request', 'A short poem about a pea who wants to fly') },
    act: ({ node }) => [{ port: 'out', text: node.params.text }]
  },
  agent: {
    title: 'Agent', group: 'think', inputs: ['in'], outputs: ['out'],
    card: { kind: 'llm', about: 'Thinks in a role: plan, ideas, solve, test, review, repair, verify, write' },
    params: {
      name: text('Name', ''),
      role: choice('Role', 'write', SKILLS),
      provider: choice('Thinks with', 'auto', PROVIDERS),
      instructions: long('Instructions', '')
    },
    async act({ node, inputs, ai, seed, signal }) {
      const { role, instructions, provider } = node.params;
      const system = [ROLES[role], instructions].filter(Boolean).join('\n');
      // A model reads the role and the instructions; Pea Mind has a rule per role and reads only the instructions.
      const reply = await ai.complete({ prefer: provider, messages: asChat(system, inputs), skill: role, instructions, seed, signal });
      node.state.by = reply.provider;
      return [{ port: 'out', text: reply.text, data: { provider: reply.provider, model: reply.model } }];
    }
  },
  prompt: {
    title: 'Prompt', group: 'think', inputs: promptInputs, outputs: promptOutputs,
    card: { kind: 'llm', about: 'Fills in a prompt from its inputs, at each {{name}}, and reads named answers back' },
    params: {
      name: text('Name', ''),
      prompt: long('Prompt: write {{name}} where an input goes', 'Make up a short, friendly username for someone called {{firstName}} {{lastName}}. Use only small letters and digits.'),
      answer: long('Answer like this: one "name: example" per line', 'username: alice123'),
      provider: choice('Thinks with', 'auto', PROVIDERS)
    },
    async act({ node, inputs, byPort, ai, seed, signal }) {
      const fields = parseFields(node.params.answer);
      const named = placeholders(node.params.prompt);
      let content = fill(node.params.prompt, name => (byPort[name] ?? []).map(textOf).join('\n'));
      if (!named.length && inputs.length) content = `${content}\n\n${inputs.map(textOf).join('\n\n')}`;
      const messages = [{ role: 'user', content }];
      const topic = named.map(name => (byPort[name] ?? []).map(textOf).join(' ')).filter(Boolean).join(' ');
      const ask = list => ai.complete({ prefer: node.params.provider, messages: list, form: fields.length ? fields : undefined, skill: 'chat', instructions: '', topic, seed, signal });
      let reply = await ask(messages);
      node.state.by = reply.provider;
      if (!fields.length) return [{ port: 'out', text: reply.text, data: { provider: reply.provider, model: reply.model } }];
      let { values, missing } = readForm(reply.text, fields);
      if (missing.length && reply.provider !== 'pea-mind') {
        // One more chance, with the answer format spelled out again.
        const some = missing.length < fields.length ? `: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing` : '';
        reply = await ask([...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: `Your reply did not follow the answer format${some}. Answer again.` }]);
        const again = readForm(reply.text, fields);
        values = { ...again.values, ...values };
        missing = missing.filter(name => !Object.hasOwn(values, name));
      }
      if (missing.length === fields.length) throw new Error(`The answer did not follow the form. It said: “${shorten(reply.text)}”`);
      node.state.missing = missing;
      return fields.map(field => (Object.hasOwn(values, field.name) ? { port: field.name, text: values[field.name], data: { field: field.name } } : { port: field.name, skip: true }));
    }
  },
  router: {
    title: 'Router', group: 'steer', inputs: ['in'], outputs: ['a', 'b', 'c'],
    card: { kind: 'gofai', about: 'Sends the message down one of three roads, by its words' },
    params: { a: text('Road a: words', 'poem, rhyme, verse'), b: text('Road b: words', 'story, tale, once'), c: text('Road c: words', 'anything else') },
    act({ node, inputs }) {
      const said = topic(inputs, '');
      const heard = new Set(words(said.toLowerCase()));
      const score = road => words(node.params[road].toLowerCase()).filter(word => heard.has(word)).length;
      const roads = ['a', 'b', 'c'];
      const scores = roads.map(score);
      const best = Math.max(...scores);
      const chosen = best > 0 ? roads[scores.indexOf(best)] : 'c';
      node.state.chosen = chosen;
      return roads.map(road => road === chosen ? { port: road, text: said } : { port: road, skip: true });
    }
  },
  join: {
    title: 'Join', group: 'steer', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Waits for every helper, then puts their answers together' },
    params: {},
    act: ({ inputs }) => [{ port: 'out', text: inputs.map(msg => `From ${msg.from}:\n${textOf(msg)}`).join('\n\n'), data: { parts: inputs.length } }]
  },
  check: {
    title: 'Check', group: 'steer', inputs: ['in'], outputs: ['pass', 'retry'],
    card: { kind: 'gofai', about: 'Checks the work against simple rules; sends it back to improve it' },
    params: { 'min-words': number('At least (words)', 30, 0, 5000), 'max-words': number('At most (0: any)', 0, 0, 20000), must: text('Must mention', ''), rounds: number('Tries', 3, 1, 9) },
    act({ node, inputs }) {
      const work = topic(inputs, '');
      const count = words(work).length;
      const lower = work.toLowerCase();
      const problems = [];
      if (count < node.params['min-words']) problems.push(`It has ${count} words; it needs at least ${node.params['min-words']}.`);
      if (node.params['max-words'] && count > node.params['max-words']) problems.push(`It has ${count} words; keep it to ${node.params['max-words']}.`);
      const missing = node.params.must.split(',').map(word => word.trim()).filter(word => word && !lower.includes(word.toLowerCase()));
      if (missing.length) problems.push(`Mention ${missing.join(', ')}.`);
      node.state.round = (node.state.round ?? 0) + 1;
      if (!problems.length) return [{ port: 'pass', text: work, data: { rounds: node.state.round } }];
      if (node.state.round >= node.params.rounds) {
        node.state.gaveUp = true;
        return [{ port: 'pass', text: work, data: { rounds: node.state.round, unmet: problems } }];
      }
      return [{ port: 'retry', text: `Please improve this. ${problems.join(' ')}\n\n${work}`, data: { feedback: problems, round: node.state.round } }];
    }
  },
  poet: {
    title: 'Poet', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Writes a little poem from a few words, offline' },
    params: { form: choice('Form', 'couplets', FORMS) },
    act({ node, inputs, seed }) {
      const made = poem({ theme: topic(inputs, 'the garden'), form: node.params.form, seed });
      return [{ port: 'out', text: `${made.title}\n\n${made.text}`, data: { form: node.params.form } }];
    }
  },
  story: {
    title: 'Story shape', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: "Tells a story along one of Vonnegut's shapes of stories, offline" },
    params: { shape: choice('Shape', 'man-in-hole', Object.keys(SHAPES)) },
    act({ node, inputs, seed }) {
      const made = story({ prompt: topic(inputs, 'a small pea'), shape: node.params.shape, seed });
      node.state.points = made.points;
      return [{ port: 'out', text: `${made.title}\n\n${made.text}`, data: { shape: node.params.shape } }];
    }
  },
  song: {
    title: 'Song', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Writes lyrics: verses and a chorus that comes back, offline' },
    params: {},
    act({ inputs, seed }) {
      const made = song({ theme: topic(inputs, 'the sunny day'), seed });
      return [{ port: 'out', text: `${made.title}\n\n${made.text}` }];
    }
  },
  novel: {
    title: 'Novel plan', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Plans a book chapter by chapter along a story shape, offline' },
    params: { shape: choice('Shape', 'cinderella', Object.keys(SHAPES)), chapters: number('Chapters', 8, 3, 24) },
    act({ node, inputs, seed }) {
      const made = novel({ prompt: topic(inputs, 'a lighthouse keeper'), shape: node.params.shape, chapters: node.params.chapters, seed });
      node.state.points = made.points;
      return [{ port: 'out', text: `${made.title}\n\n${made.text}`, data: { shape: node.params.shape } }];
    }
  },
  family: {
    title: 'Family ideas', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Things to do together: indoors, outdoors, cheap or free, offline' },
    params: {},
    act({ inputs, seed }) {
      const made = familyIdeas({ prompt: topic(inputs, 'a free afternoon'), seed });
      return [{ port: 'out', text: `${made.title}\n\n${made.text}` }];
    }
  },
  grammar: {
    title: 'Word game', group: 'make', inputs: ['in'], outputs: ['out'],
    card: { kind: 'gofai', about: 'Fills in sentence patterns with random words; #input# is what came in' },
    params: { rules: long('Rules', 'origin: #hero# #did# #place#.\nhero: A brave pea | A sleepy cat | Grandma | The tiniest dragon\ndid: danced across | tiptoed through | sang to | sneezed on\nplace: the moon | the kitchen | a puddle | the library') },
    act({ node, inputs, seed }) {
      const grammar = parseGrammar(node.params.rules);
      const said = topic(inputs, '');
      if (said) grammar.input = [said];
      grammar.topic ??= keywords(said || 'garden', 3);
      return [{ port: 'out', text: expand(grammar, 'origin', rng(seed)) }];
    }
  },
  result: {
    title: 'Result', group: 'start', inputs: ['in'], outputs: [],
    card: { kind: 'io', about: 'Shows what the team made' },
    params: { name: text('Name', '') },
    act({ node, inputs }) {
      node.state.text = inputs.length > 1 ? inputs.map(msg => `${msg.from}:\n${textOf(msg)}`).join('\n\n') : textOf(inputs[0]);
      return [];
    }
  }
};

export const MAX_NODES = 80;
export const MAX_WIRES = 200;

export function parseAgentFlow(xml, source, name = 'agent flow') {
  return parseGraph(xml, source, { root: 'agentflow', name, types: TYPES, maxNodes: MAX_NODES, maxWires: MAX_WIRES });
}

export function serializeAgentFlow(xml, program) {
  return serializeGraph(xml, program, { root: 'agentflow', types: TYPES });
}

const GROUPS = ['make', 'team', 'family'];

/** Reads the template list: [{ id, group, title, about, flow }], each flow already checked. */
export function parseTemplates(xml, text, source = 'agent-flows') {
  const root = xml.parseXml(text, source);
  if (root.name !== 'templates') root.fail('must be <templates>');
  root.expect({ attrs: ['version'], children: ['template'] });
  return root.all('template').map(item => {
    item.expect({ attrs: ['id', 'group', 'title', 'about'], children: ['agentflow'] });
    const group = item.need('group');
    if (!GROUPS.includes(group)) item.fail(`group="${group}" must be one of ${GROUPS.join(', ')}`);
    const [flow] = item.all('agentflow');
    if (!flow) item.fail('needs an <agentflow>');
    const template = { id: item.need('id'), group, title: item.need('title'), about: item.need('about'), element: flow };
    parseAgentFlow(xml, flow, source);
    return template;
  });
}

/** A node's input or output port names: fixed for most types, named by its settings for a Prompt. */
export function portsOf(node, side) {
  const ports = TYPES[node.type][side];
  return typeof ports === 'function' ? ports(node.params) : ports;
}

/** The agent card a node presents to the others, as A2A has it. */
export function cardOf(node) {
  const type = TYPES[node.type];
  const kind = (node.type === 'agent' || node.type === 'prompt') && node.params.provider === 'pea-mind' ? 'gofai' : type.card.kind;
  return { name: nameOf(node), description: type.card.about, kind, skills: [{ id: node.type === 'agent' ? node.params.role : node.type, name: type.title }] };
}

export function nameOf(node) {
  if (node.params.name) return node.params.name;
  if (node.type === 'agent') return node.params.role[0].toUpperCase() + node.params.role.slice(1);
  return TYPES[node.type].title;
}

const hash = value => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Wires that loop back to an earlier node. A Check's retry wire always does:
 * it sends work back to be done again. The rest are found by walking forward
 * from where the flow starts, so the order nodes are listed in does not matter.
 */
export function backWires({ nodes, wires }) {
  const back = new Set(wires.filter(wire => wire.from.type === 'check' && wire.out === 'retry'));
  const forward = wires.filter(wire => !back.has(wire));
  const state = new Map(); // node -> 1 on the path, 2 finished
  const visit = node => {
    state.set(node, 1);
    for (const wire of forward.filter(item => item.from === node)) {
      const seen = state.get(wire.to);
      if (seen === 1) back.add(wire);
      else if (!seen) visit(wire.to);
    }
    state.set(node, 2);
  };
  const starts = nodes.filter(node => !forward.some(wire => wire.to === node));
  for (const node of [...starts, ...nodes]) if (!state.has(node)) visit(node);
  return back;
}

/**
 * One run of a flow. The transport is the caller's: send(wire, msg) must
 * later call run.deliver(wire, msg), at once or after an envelope has
 * travelled the wire. Node progress is kept in node.state:
 *   status  'waiting' | 'working' | 'done' | 'skipped' | 'failed'
 *   text    the last thing it said;  error  why it failed
 */
export class AgentRun {
  #inbox = new Map();
  #busy = 0;
  #flying = 0;
  #acts = 0;
  #controller = new AbortController();
  done = false;

  constructor(program, { ai, send, onMessage = () => {}, onChange = () => {}, onFinish = () => {}, seed = Date.now(), limit = 200, title = 'Agent flow' }) {
    this.program = program;
    this.ai = ai;
    this.send = send;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.onFinish = onFinish;
    this.seed = seed >>> 0;
    this.limit = limit;
    this.task = createTask(title);
    this.back = backWires(program);
  }

  #forward(node) {
    return this.program.wires.filter(wire => wire.to === node && !this.back.has(wire));
  }

  start() {
    setState(this.task, 'working');
    for (const node of this.program.nodes) node.state = { status: 'waiting' };
    const starts = this.program.nodes.filter(node => !this.#forward(node).length);
    if (!starts.length) { this.#finish('failed', 'Nothing can start: every node waits for another. Add an Ask node.'); return this; }
    for (const node of starts) this.#act(node, []);
    return this;
  }

  stop() {
    if (this.done) return;
    this.#controller.abort();
    this.#finish('canceled', 'Stopped.');
  }

  deliver(wire, msg) {
    this.#flying--;
    if (this.done) return;
    const node = wire.to;
    if (this.back.has(wire)) {
      if (!skipped(msg)) {
        const box = this.#inbox.get(node);
        const earlier = box ? [...box.latest].filter(([, item]) => !skipped(item)).map(([from, item]) => ({ port: from.in, msg: item })) : [];
        this.#act(node, [...earlier, { port: wire.in, msg }]);
      }
      this.#settle();
      return;
    }
    const box = this.#inbox.get(node) ?? { latest: new Map(), fresh: new Set() };
    this.#inbox.set(node, box);
    box.latest.set(wire, msg);
    box.fresh.add(wire);
    const forward = this.#forward(node);
    if (forward.every(item => box.fresh.has(item))) {
      box.fresh.clear();
      const real = forward.map(item => ({ port: item.in, msg: box.latest.get(item) })).filter(entry => !skipped(entry.msg));
      if (real.length) this.#act(node, real);
      else this.#skip(node);
    }
    this.#settle();
  }

  #emit(node, emissions) {
    // What a node said: its one answer, or each named answer on a line of its own.
    const answers = emissions.filter(emission => !emission.skip);
    if (answers.length === 1) node.state.text = answers[0].text ?? '';
    else if (answers.length > 1) node.state.text = answers.map(emission => `${emission.port}: ${emission.text ?? ''}`).join('\n');
    for (const { port, text: said = '', data, skip } of emissions) {
      const msg = message({ from: nameOf(node), role: 'agent', text: skip ? '' : said, data: skip ? { skip: true } : data, task: this.task.id });
      if (!skip) {
        this.task.history.push(msg);
        this.onMessage(msg, node, port);
      }
      for (const wire of this.program.wires.filter(item => item.from === node && item.out === port)) {
        this.#flying++;
        this.send(wire, msg);
      }
    }
  }

  #skip(node) {
    node.state.status = 'skipped';
    this.#emit(node, portsOf(node, 'outputs').map(port => ({ port, skip: true })));
    this.onChange(node);
  }

  /** entries: [{ port, msg }], the messages the node acts on and the inputs they came in at. */
  async #act(node, entries) {
    const inputs = entries.map(entry => entry.msg);
    const byPort = {};
    for (const { port, msg } of entries) (byPort[port] ??= []).push(msg);
    if (this.done) return;
    if (++this.#acts > this.limit) { this.#finish('failed', `The agents sent more than ${this.limit} messages, so the run was stopped. A loop may be running away.`); return; }
    const type = TYPES[node.type];
    node.state.status = 'working';
    node.state.error = '';
    this.#busy++;
    this.onChange(node);
    try {
      const emissions = await type.act({ node, inputs, byPort, ai: this.ai, seed: hash(`${this.seed}:${node.id}:${this.#acts}`), signal: this.#controller.signal, run: this });
      if (this.done) return;
      node.state.status = 'done';
      if (node.type === 'result') this.task.artifacts.push({ name: nameOf(node), parts: [{ kind: 'text', text: node.state.text }] });
      this.#emit(node, emissions);
    } catch (error) {
      if (this.done) return;
      node.state.status = 'failed';
      node.state.error = error.message;
      this.failed = this.failed ?? `${nameOf(node)}: ${error.message}`;
      this.#emit(node, portsOf(node, 'outputs').map(port => ({ port, skip: true })));
    } finally {
      this.#busy--;
      if (!this.done) { this.onChange(node); this.#settle(); }
    }
  }

  #settle() {
    if (this.done || this.#busy || this.#flying) return;
    if (this.failed) this.#finish('failed', this.failed);
    else this.#finish('completed', '');
  }

  #finish(state, reason) {
    if (this.done) return;
    this.done = true;
    setState(this.task, state);
    this.reason = reason;
    this.onFinish(this.task, reason);
  }
}
