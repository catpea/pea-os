/**
 * Agent Chat: a conversation with a language model on any server that speaks
 * the common /v1/chat/completions protocol (Ollama, llama.cpp, LM Studio,
 * vLLM, or a hosted service). The base URL, key and model are set in Setup.
 *
 * Replies stream in as they are written. With Pea tools on, the model may
 * call a few small, harmless functions of the desktop: open an app, write a
 * sticky note, list apps, notes or documents, and read the clock. Each call
 * appears in the conversation, so nothing happens out of sight.
 */

import { completionReader, endpoint, problemText, headers as requestHeaders } from '../../src/ai/openai.js';

export { completionReader };

const SETTINGS_KEY = 'pea-os.chat.v1';
const HISTORY_KEY = 'pea-os.chat.history.v1';
const MAX_ENTRIES = 80;
const MAX_SENT = 40;
const MAX_ROUNDS = 5;
const PAD = 5;
const GAP = 5;

/** Splits text into lines no wider than `width`, breaking long words too. */
export function wrapText(font, text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.measure(candidate) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      // A word wider than the bubble (an address, say) is cut where it must be.
      let piece = word;
      while (font.measure(piece) > width) {
        let cut = 1;
        while (cut < piece.length && font.measure(piece.slice(0, cut + 1)) <= width) cut++;
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

export default function chat(app) {
  const { os } = app;
  const { transcript, input, modelsButton } = app.refs;
  const storage = os.platform.storage;
  const status = app.signal('status');
  const page = app.signal('page');
  const draft = app.signal('draft');
  const busy = app.signal('busy');
  const remembered = ['base-url', 'api-key', 'model', 'tools', 'stream', 'system-prompt'];

  let entries = [];           // { role, content, tool_calls?, tool_call_id?, note? }
  let layout = null;          // cached bubble geometry
  let scroll = 0;
  let follow = true;          // keep the newest line in view while it is written
  let controller = null;
  let drag = null;
  let dirty = true;

  // ---- Remembering ------------------------------------------------------------

  try {
    const saved = JSON.parse(storage.get(SETTINGS_KEY) ?? 'null');
    if (saved?.version === 1) {
      for (const name of remembered) {
        const value = saved[name];
        const signal = app.signal(name);
        if (typeof value === typeof signal.value) signal.set(value);
      }
    }
  } catch { /* Defaults are fine. */ }
  try {
    const saved = JSON.parse(storage.get(HISTORY_KEY) ?? 'null');
    if (saved?.version === 1 && Array.isArray(saved.entries)) entries = saved.entries.filter(entry => entry && typeof entry.role === 'string' && typeof entry.content === 'string').slice(-MAX_ENTRIES);
  } catch { /* Start a new conversation. */ }

  const saveSettings = app.debounce(300, () => {
    try { storage.set(SETTINGS_KEY, JSON.stringify({ version: 1, ...Object.fromEntries(remembered.map(name => [name, app.signal(name).value])) })); }
    catch (error) { status.set(`Settings not saved: ${error.message}`); }
  });
  for (const name of remembered) app.scope.subscribe(app.signal(name), saveSettings, { immediate: false });

  function saveHistory() {
    entries = entries.slice(-MAX_ENTRIES);
    try { storage.set(HISTORY_KEY, JSON.stringify({ version: 1, entries: entries.filter(entry => !entry.pending) })); }
    catch { /* The conversation still shows; it just will not survive a restart. */ }
  }

  function changed() {
    layout = null;
    dirty = true;
    app.signal('has-messages').set(entries.length > 0);
  }

  // ---- Tools ------------------------------------------------------------------

  const tools = {
    open_app: {
      description: 'Open one of the apps of Pea OS on the desktop.',
      parameters: { type: 'object', properties: { app: { type: 'string', enum: [...os.apps.keys()], description: 'The app id' } }, required: ['app'] },
      run: ({ app: id }) => {
        if (!os.apps.has(id)) throw new Error(`There is no app "${id}".`);
        os.open(id);
        return `Opened ${os.apps.get(id).title}.`;
      }
    },
    create_sticky_note: {
      description: 'Put a sticky note with some text on the current desktop.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'What the note says' } }, required: ['text'] },
      run: ({ text }) => {
        const note = os.desktop.notes.create({ text: String(text ?? '').slice(0, 2000) });
        return `Created a sticky note (${note.id}).`;
      }
    },
    list_apps: {
      description: 'List the apps that Pea OS has.',
      parameters: { type: 'object', properties: {} },
      run: () => JSON.stringify([...os.apps.values()].map(item => ({ id: item.id, title: item.title, about: item.summary })))
    },
    list_sticky_notes: {
      description: 'Read the sticky notes on the desktops.',
      parameters: { type: 'object', properties: {} },
      run: () => JSON.stringify(os.desktop.notes.state.value.notes.filter(note => !note.deleted).map(note => ({ desktop: note.desk + 1, text: note.text.slice(0, 500) })))
    },
    list_documents: {
      description: 'List the names of documents saved in Pea OS.',
      parameters: { type: 'object', properties: {} },
      run: async () => JSON.stringify((await os.documents.list()).slice(0, 50).map(doc => ({ name: doc.name, app: doc.appId })))
    },
    current_time: {
      description: 'The local date and time.',
      parameters: { type: 'object', properties: {} },
      run: () => new Date().toString()
    }
  };
  const toolList = () => Object.entries(tools).map(([name, tool]) => ({ type: 'function', function: { name, description: tool.description, parameters: tool.parameters } }));

  // ---- Talking ----------------------------------------------------------------

  function messages() {
    const sent = [];
    const system = app.signal('system-prompt').value.trim();
    if (system) sent.push({ role: 'system', content: system });
    let recent = entries.filter(entry => ['user', 'assistant', 'tool'].includes(entry.role) && !entry.pending).slice(-MAX_SENT);
    while (recent[0]?.role === 'tool') recent = recent.slice(1);
    for (const entry of recent) {
      const message = { role: entry.role, content: entry.content };
      if (entry.tool_calls) message.tool_calls = entry.tool_calls;
      if (entry.tool_call_id) message.tool_call_id = entry.tool_call_id;
      sent.push(message);
    }
    return sent;
  }

  const headers = () => requestHeaders(app.signal('api-key').value);

  async function complete(signal) {
    const reply = { role: 'assistant', content: '', pending: true };
    entries.push(reply);
    changed();
    const streaming = app.signal('stream').value;
    const reader = completionReader(text => { reply.content += text; layout = null; dirty = true; });
    const body = { model: app.signal('model').value.trim(), messages: messages(), stream: streaming };
    if (app.signal('tools').value) body.tools = toolList();
    try {
      const response = await app.request({ url: endpoint(app.signal('base-url').value, 'chat/completions'), method: 'POST', headers: headers(), body: JSON.stringify(body), signal, onText: response => reader.feed(response) });
      if (!response.ok) throw new Error(problemText(response.status, response.text));
      const { content, toolCalls } = reader.finish();
      reply.content = content;
      if (toolCalls.length) reply.tool_calls = toolCalls.map((call, index) => ({ id: call.id || `call_${Date.now()}_${index}`, type: 'function', function: { name: call.function.name, arguments: call.function.arguments || '{}' } }));
      delete reply.pending;
      if (!reply.content && !reply.tool_calls) entries.splice(entries.indexOf(reply), 1);
      return reply;
    } catch (error) {
      if (reply.content) delete reply.pending;
      else entries.splice(entries.indexOf(reply), 1);
      throw error;
    } finally {
      changed();
    }
  }

  async function runTools(reply) {
    for (const call of reply.tool_calls ?? []) {
      const tool = tools[call.function.name];
      let result;
      try {
        if (!tool) throw new Error(`There is no tool called ${call.function.name}.`);
        const args = JSON.parse(call.function.arguments || '{}');
        result = String(await tool.run(args));
      } catch (error) {
        result = `Error: ${error.message}`;
      }
      entries.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result.slice(0, 4000) });
      changed();
    }
  }

  async function send() {
    if (controller) { controller.abort(); return; }
    const text = draft.value.trim();
    if (!text) { os.ui.focus(input); return; }
    if (!app.signal('model').value.trim()) {
      page.set('setup');
      app.signal('setup-status').set('Choose a model first: type its name, or press Load models.');
      return;
    }
    entries.push({ role: 'user', content: text });
    draft.set('');
    follow = true;
    changed();
    controller = new AbortController();
    busy.set(true);
    app.signal('send-label').set('Stop');
    status.set('Thinking…');
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const reply = await complete(controller.signal);
        if (!reply.tool_calls?.length) break;
        status.set('Using Pea tools…');
        await runTools(reply);
        if (round === MAX_ROUNDS - 1) entries.push({ role: 'note', content: 'The agent stopped after several tool rounds.' });
      }
      status.set('');
    } catch (error) {
      if (controller?.signal.aborted) { entries.push({ role: 'note', content: 'Stopped.' }); status.set(''); }
      else { entries.push({ role: 'error', content: String(error?.message ?? error) }); status.set('Something went wrong.'); }
    } finally {
      controller = null;
      busy.set(false);
      app.signal('send-label').set('Send');
      changed();
      saveHistory();
    }
  }

  app.command('chat-send', send);
  // Enter in the message field only ever sends; stopping a reply takes the Stop button.
  app.command('chat-submit', () => {
    if (controller) { status.set('Wait for the reply, or press Stop.'); return; }
    return send();
  });

  app.command('new-chat', async () => {
    if (controller) controller.abort();
    if (entries.length) {
      const answer = await os.dialogs.confirm({ title: 'New chat', message: 'Start a new conversation? This one will be forgotten. Export it first to keep it.', buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'new', text: 'New chat' }] });
      if (answer !== 'new') return;
    }
    entries = [];
    scroll = 0;
    follow = true;
    changed();
    saveHistory();
    os.ui.focus(input);
  });

  function markdown() {
    const model = app.signal('model').value.trim();
    const lines = [`# Agent Chat${model ? ` with ${model}` : ''}`, ''];
    for (const entry of entries) {
      if (entry.role === 'user') lines.push(`**You:** ${entry.content}`, '');
      else if (entry.role === 'assistant' && entry.content) lines.push(`**Agent:** ${entry.content}`, '');
      else if (entry.role === 'tool') lines.push(`> ${entry.name}: ${entry.content}`, '');
      else if (entry.role === 'error') lines.push(`> Error: ${entry.content}`, '');
    }
    return lines.join('\n');
  }

  app.command('export', () => app.download('agent-chat.md', markdown(), 'text/markdown'));

  app.command('to-notepad', async () => {
    try {
      os.open('notepad');
      const notepad = os.app('notepad');
      const opened = await notepad.files.run('new');
      if (opened === false) return;
      notepad.signal('content').set(markdown());
      notepad.files.changed();
    } catch (error) { app.report(error); }
  });

  app.command('load-models', async () => {
    const base = app.signal('base-url').value.trim();
    app.signal('setup-status').set('Asking the server for its models…');
    try {
      const response = await app.request({ url: endpoint(base, 'models'), headers: headers(), signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined });
      if (!response.ok) throw new Error(problemText(response.status, response.text));
      const data = JSON.parse(response.text);
      const ids = (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map(model => model.id ?? model.name).filter(id => typeof id === 'string').sort();
      if (!ids.length) { app.signal('setup-status').set('The server is there but lists no models. Type the model name instead.'); return; }
      app.signal('setup-status').set(`The server has ${ids.length} model${ids.length === 1 ? '' : 's'}. Pick one.`);
      os.desktop.popupMenu(ids.slice(0, 60).map(id => ({ text: id, checked: id === app.signal('model').value, invoke: () => {
        app.signal('model').set(id);
        app.signal('setup-status').set(`Ready: ${id}. Go back to Chat and say hello.`);
      } })), modelsButton.toScreen(0, modelsButton.h));
    } catch (error) {
      app.signal('setup-status').set(`Could not load models. ${error.message}`);
    }
  });

  // ---- The conversation, drawn ------------------------------------------------

  function measure(width) {
    const { font } = app;
    const blocks = [];
    let y = GAP;
    const bubbleW = Math.max(40, Math.floor((width - 14) * 0.84));
    for (const entry of entries) {
      let lines;
      let kind = entry.role;
      if (entry.role === 'assistant' && !entry.content && entry.tool_calls) {
        // Each call shows once, as its result line below.
        continue;
      } else if (entry.role === 'tool') {
        kind = 'note';
        lines = wrapText(font, `→ ${entry.name?.replace(/_/g, ' ') ?? 'tool'}: ${entry.content.length > 120 ? `${entry.content.slice(0, 120)}…` : entry.content}`, width - 24);
      } else if (entry.role === 'note') {
        lines = wrapText(font, entry.content, width - 24);
      } else {
        lines = wrapText(font, entry.content || (entry.pending ? '' : '…'), bubbleW - PAD * 2);
      }
      const textW = Math.max(entry.pending ? 8 : 0, ...lines.map(line => font.measure(line)));
      const w = kind === 'note' ? width - 16 : Math.min(bubbleW, textW + PAD * 2 + 1);
      const h = lines.length * font.lineHeight + (kind === 'note' ? 0 : PAD * 2 - 2);
      const x = kind === 'user' ? width - w - 9 : kind === 'note' ? 8 : 5;
      blocks.push({ entry, kind, lines, x, y, w, h });
      y += h + GAP;
    }
    return { blocks, height: y, width };
  }

  function paint() {
    const bitmap = transcript.bitmap;
    if (!bitmap) return;
    dirty = false;
    const theme = app.theme.value;
    const { font, gfx } = app;
    const ink = theme.color('ink');
    if (!layout || layout.width !== bitmap.width) layout = measure(bitmap.width);
    const room = bitmap.height - 2;
    const max = Math.max(0, layout.height - room);
    if (follow) scroll = max;
    scroll = Math.max(0, Math.min(max, scroll));
    bitmap.clear(theme.color('field'));
    if (!entries.length) {
      const hello = app.signal('model').value.trim()
        ? [`Say hello to ${app.signal('model').value.trim()}.`, 'Try: “Open Pea Paint and leave me', 'a note to water the basil.”']
        : ['Agent Chat talks to a language model.', 'Open Setup to choose a server', 'and a model.'];
      hello.forEach((line, index) => font.draw(bitmap, line, (bitmap.width - font.measure(line)) >> 1, (bitmap.height >> 1) - 16 + index * font.lineHeight, theme.color('dim')));
    }
    const red = theme.lock(gfx.parseColor('#e8475a'));
    for (const block of layout.blocks) {
      const y = 1 + block.y - scroll;
      if (y + block.h < 0 || y > bitmap.height) continue;
      if (block.kind === 'note') {
        block.lines.forEach((line, index) => font.draw(bitmap, line, block.x, y + index * font.lineHeight, theme.color('dim')));
        continue;
      }
      const user = block.kind === 'user';
      const face = user ? theme.color('accent') : block.kind === 'error' ? theme.lock(gfx.mix(red, theme.color('paper'), 0.7)) : theme.color('panel');
      const text = user ? theme.color('accent-ink') : block.kind === 'error' ? theme.color('ink') : theme.color('panel-ink');
      bitmap.roundFill(block.x + 1, y + 1, block.w, block.h, 3, theme.lock(gfx.darken(theme.color('field'), 0.2)));
      bitmap.roundFill(block.x, y, block.w, block.h, 3, face);
      bitmap.roundFrame(block.x, y, block.w, block.h, 3, block.kind === 'error' ? red : ink);
      // A little tail toward the speaker's side.
      const tailX = user ? block.x + block.w - 6 : block.x + 4;
      bitmap.fill(tailX, y + block.h - 1, 3, 1, face);
      bitmap.set(user ? tailX + 3 : tailX - 1, y + block.h, ink);
      bitmap.fill(user ? tailX + 1 : tailX - 1, y + block.h - 1, 3, 1, face);
      block.lines.forEach((line, index) => font.draw(bitmap, line, block.x + PAD, y + PAD - 1 + index * font.lineHeight, text));
      if (block.entry.pending && Math.floor(os.ui.stage.time / 400) % 2 === 0) {
        const last = block.lines.at(-1) ?? '';
        bitmap.fill(block.x + PAD + font.measure(last) + 1, y + PAD - 1 + (block.lines.length - 1) * font.lineHeight, 2, font.cap, text);
      }
    }
    if (max > 0) {
      const track = bitmap.height - 4;
      const knob = Math.max(6, Math.round(track * room / layout.height));
      bitmap.fill(bitmap.width - 4, 2 + Math.round((track - knob) * scroll / max), 2, knob, theme.color('dim'));
    }
    bitmap.frame(0, 0, bitmap.width, bitmap.height, ink);
    transcript.commit();
  }

  app.frame(() => {
    if (entries.some(entry => entry.pending)) dirty = true;
    if (dirty) paint();
  });
  app.scope.on(transcript.events, 'resize', () => { layout = null; paint(); });
  app.scope.subscribe(app.theme, () => { dirty = true; }, { immediate: false });
  app.scope.on(transcript.events, 'wheel', event => {
    const max = Math.max(0, (layout?.height ?? 0) - (transcript.h - 2));
    scroll = Math.max(0, Math.min(max, scroll + Math.round(event.dy)));
    follow = scroll >= max;
    dirty = true;
    event.handled = true;
  });
  app.scope.on(transcript.events, 'down', event => { drag = { y: event.y, scroll }; });
  app.scope.on(transcript.events, 'move', event => {
    if (!drag) return;
    const max = Math.max(0, (layout?.height ?? 0) - (transcript.h - 2));
    scroll = Math.max(0, Math.min(max, drag.scroll - (event.y - drag.y)));
    follow = scroll >= max;
    dirty = true;
  });
  app.scope.on(transcript.events, 'up', () => { drag = null; });
  app.scope.on(transcript.events, 'cancel', () => { drag = null; });

  app.scope.subscribe(page, value => { if (value === 'chat') queueMicrotask(() => os.ui.focus(input)); }, { immediate: false });
  app.scope.subscribe(app.signal('model'), () => { if (!entries.length) dirty = true; });
  app.scope.add(() => controller?.abort());
  if (!app.signal('model').value.trim()) page.set('setup');
  changed();
}
