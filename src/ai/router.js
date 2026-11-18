import { ProviderSet } from '../core/providers.js';
import { completionReader, endpoint, headers, problemText } from './openai.js';
import { think, skillFor, fillForm } from './gofai.js';
import { withForm, formSchema } from './form.js';

/**
 * The model router: one doorway to every kind of thinking Pea OS can reach,
 * so an app asks for a reply and never needs to know where it comes from.
 *
 * A provider is { id, title, kind, about, status(), complete(request) }:
 *   kind      'local' (rule-based, always here), 'server' (any /v1 server,
 *             reached through os.request, so it requires the internet
 *             service), 'browser' (a model running in this page) or
 *             'device' (the phone's own model).
 *   status()  -> Promise<{ ok, reason }>: whether it can answer right now,
 *             and if not, why, in words the Software app shows.
 *   complete({ messages, model, temperature, onText, signal, skill, instructions, seed, form })
 *             skill, instructions (the user's own, without a role prompt) and
 *             topic (the words a prompt was filled in with) are hints for
 *             rule-based providers; models read messages.
 *             form ([{ name, example }], see form.js) asks for named answers:
 *             each provider adds the strongest answer format it can (a JSON
 *             schema it enforces, or a strict lines contract).
 *             -> Promise<{ text, provider, model }>
 *   setup(changed)  optional: makes a provider ready that status() reports
 *             with `setup: true`, such as a browser model still to download.
 *
 * route() takes the first provider in the user's order that is installed and
 * ready, unless the request names one. Pea Mind, the rule-based provider,
 * is always installed, so a flow always has something to think with.
 */

const KEY = 'pea-os.ai.v1';
const CHAT_KEY = 'pea-os.chat.v1';

const hash = text => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Pea Mind: good old-fashioned AI. Rules, word banks and story shapes; no network, no model. */
function peaMind() {
  return {
    id: 'pea-mind',
    title: 'Pea Mind',
    kind: 'local',
    about: 'Rule-based thinking that works offline: plans, ideas, reviews, poems, story shapes and family plans.',
    async status() { return { ok: true, reason: 'Built in. Works offline.' }; },
    async complete({ messages = [], skill, instructions: own, seed, onText, signal, form, topic }) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      const instructions = own ?? messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const input = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
      if (form?.length) {
        const text = fillForm({ prompt: input, topic, fields: form, seed: seed ?? hash(input) });
        onText?.(text);
        return { text, provider: 'pea-mind', model: 'pea-mind/form' };
      }
      const chosen = skill ?? skillFor(instructions);
      const angle = /angle:\s*(\w+)/i.exec(instructions)?.[1] ?? '';
      const text = think({ skill: chosen, instructions, input, angle, seed: seed ?? hash(instructions + input) });
      onText?.(text);
      return { text, provider: 'pea-mind', model: `pea-mind/${chosen}` };
    }
  };
}

/** Any server that speaks /v1/chat/completions, set up once in Agent Chat. */
function server(os) {
  const settings = () => {
    try {
      const saved = JSON.parse(os.platform.storage?.get(CHAT_KEY) ?? 'null');
      return { base: String(saved?.['base-url'] ?? '').trim(), key: String(saved?.['api-key'] ?? ''), model: String(saved?.model ?? '').trim() };
    } catch { return { base: '', key: '', model: '' }; }
  };
  return {
    id: 'server',
    title: 'Model server (/v1)',
    kind: 'server',
    requires: ['network'],
    about: 'Ollama, llama.cpp, LM Studio, vLLM or a hosted service. Set it up once in Agent Chat.',
    async status() {
      const { base, model } = settings();
      if (!base) return { ok: false, reason: 'Not set up: give Agent Chat a server address in Setup.' };
      if (!model) return { ok: false, reason: 'Not set up: choose a model in Agent Chat › Setup.' };
      return { ok: true, reason: `${model} at ${base}` };
    },
    async complete({ messages, temperature, onText, signal, model: wanted, form }) {
      const { base, key, model } = settings();
      if (!base || !(wanted || model)) throw new Error('The model server is not set up. Open Agent Chat › Setup.');
      const ask = async (asked, extra) => {
        const reader = completionReader(onText);
        const body = { model: wanted || model, messages: asked, stream: true, ...(Number.isFinite(temperature) ? { temperature } : {}), ...extra };
        const response = await os.request({ url: endpoint(base, 'chat/completions'), method: 'POST', headers: headers(key), body: JSON.stringify(body), signal, onText: chunk => reader.feed(chunk) });
        return { response, reader };
      };
      let { response, reader } = form?.length
        ? await ask(withForm(messages, form, 'json'), { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: formSchema(form) } } })
        : await ask(messages, {});
      // A server that cannot enforce a schema is asked again with the lines contract.
      if (!response.ok && form?.length && [400, 404, 422, 501].includes(response.status)) ({ response, reader } = await ask(withForm(messages, form, 'lines'), {}));
      if (!response.ok) throw new Error(problemText(response.status, response.text));
      return { text: reader.finish().content, provider: 'server', model: wanted || model };
    }
  };
}

/**
 * The browser's own model, through the Prompt API (`LanguageModel`): Gemini
 * Nano in Chrome 148 and newer on desktop computers. The platform hands it
 * over as platform.languageModel; nothing here is downloaded by Pea OS. The
 * browser fetches its model itself, once, when the user presses Install.
 */
function builtIn(os) {
  const LANGUAGES = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  let progress = null; // 0..1 while the browser downloads its model
  return {
    id: 'browser-ai',
    title: 'Built-in browser AI',
    kind: 'browser',
    about: "The browser's own small model, through the Prompt API: Gemini Nano in Chrome 148 and newer. Runs on this computer.",
    async status() {
      const model = os.platform.languageModel;
      if (!model) return { ok: false, reason: 'Incompatible: this browser has no built-in model (the Prompt API). Chrome 148 or newer on a desktop computer has one; Firefox and Safari do not.' };
      let state;
      try { state = await model.availability(LANGUAGES); } catch (error) { return { ok: false, reason: `Incompatible: ${error.message}` }; }
      if (state === 'available') return { ok: true, reason: "The browser's model is ready and works offline." };
      if (state === 'downloading') return { ok: false, reason: `Downloading: the browser is fetching its model${progress === null ? '' : ` (${Math.round(progress * 100)}%)`}.` };
      if (state === 'downloadable') return { ok: false, setup: true, reason: 'Not downloaded: the browser can fetch its model (several gigabytes) once. Install asks it to.' };
      return { ok: false, reason: 'Incompatible: the browser says its model cannot run on this computer. It needs about 22 GB of free disk and a GPU with more than 4 GB of memory, or 16 GB of memory and 4 cores.' };
    },
    async setup(changed) {
      const model = os.platform.languageModel;
      if (!model) throw new Error('This browser has no built-in model.');
      try {
        const session = await model.create({ ...LANGUAGES, monitor: monitor => monitor.addEventListener('downloadprogress', event => { progress = event.loaded; changed(); }) });
        session.destroy();
      } finally { progress = null; changed(); }
    },
    async complete({ messages, form, onText, signal }) {
      const model = os.platform.languageModel;
      if (!model) throw new Error('This browser has no built-in model.');
      const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
      const turns = messages.filter(item => item.role !== 'system');
      const asked = form?.length ? withForm(turns, form, 'json') : turns;
      const last = asked.at(-1) ?? { content: '' };
      const session = await model.create({ ...LANGUAGES, signal, initialPrompts: [...(system ? [{ role: 'system', content: system }] : []), ...asked.slice(0, -1)] });
      try {
        // The browser enforces the schema itself, so even a small model answers in JSON.
        const options = { signal, ...(form?.length ? { responseConstraint: formSchema(form) } : {}) };
        let text = '';
        if (onText && session.promptStreaming) {
          const reader = session.promptStreaming(last.content, options).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
            onText(value);
          }
        } else {
          text = await session.prompt(last.content, options);
          onText?.(text);
        }
        return { text, provider: 'browser-ai', model: 'built-in' };
      } finally { session.destroy(); }
    }
  };
}

/** WebLLM runs models in the page through WebGPU. Pea OS describes it but cannot fetch it. */
function webllm(os) {
  return {
    id: 'webllm',
    title: 'WebLLM (in this browser)',
    kind: 'browser',
    about: 'Runs open models inside the page with WebGPU, from webllm.mlc.ai.',
    async status() {
      if (!os.platform.capabilities?.webgpu) return { ok: false, reason: 'Incompatible: WebLLM requires WebGPU, which this browser or device does not offer.' };
      if (!globalThis.webllm) return { ok: false, reason: 'Not installed: WebLLM is a third-party library. Pea OS never downloads code; a copy supplied with Pea OS is needed.' };
      return { ok: false, reason: 'Found, but not connected yet.' };
    },
    async complete() { throw new Error('WebLLM is not available here.'); }
  };
}

/** The phone's own model, where the system offers one. */
function device(os) {
  return {
    id: 'device',
    title: 'On-device model',
    kind: 'device',
    about: 'Apple Foundation Models on iOS, Gemini Nano through AICore on Android.',
    async status() {
      if (os.platform.name !== 'nativescript') return { ok: false, reason: 'Incompatible: only on phones and tablets running Pea OS natively.' };
      return { ok: false, reason: 'Not built yet: needs a native bridge for this device.' };
    },
    async complete() { throw new Error('No on-device model is available.'); }
  };
}

/**
 * The thinking service: a ProviderSet (src/core/providers.js) whose providers
 * answer prompts, and whose complete() falls back to Pea Mind. `service`
 * describes the service as src/os/providers.js lists it.
 */
export class ModelRouter extends ProviderSet {
  constructor(os, service = { service: 'thinking', title: 'Thinking', methods: ['complete'] }) {
    super(os, { ...service, key: KEY, order: ['server', 'browser-ai', 'webllm', 'device', 'pea-mind'], off: ['webllm', 'device'], always: 'pea-mind' });
    for (const provider of [peaMind(), server(os), builtIn(os), webllm(os), device(os)]) this.register(provider);
  }

  /**
   * One reply: { text, provider, model }. Left to choose ("auto"), the router
   * falls back to Pea Mind when the chosen provider fails, and says why in
   * `fallback`, so a flow keeps going when a server is down.
   */
  async complete({ prefer = 'auto', ...request }) {
    const provider = await this.route(prefer);
    if (prefer !== 'auto' || provider.id === 'pea-mind') return provider.complete(request);
    try { return await provider.complete(request); }
    catch (error) {
      if (error.name === 'AbortError' || request.signal?.aborted) throw error;
      const reply = await this.providers.get('pea-mind').complete(request);
      return { ...reply, fallback: `${provider.title}: ${error.message}` };
    }
  }
}
