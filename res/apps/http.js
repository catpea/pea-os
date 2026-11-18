/** HTTP Probe: one request at a time, its status, its timing, and its answer made readable. */

const HISTORY = 30;

/** "Name: value" lines into headers; blank lines and # comments are skipped. Throws on a line it cannot read. */
export function parseHeaders(text) {
  const headers = {};
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`Header line ${index + 1} needs to look like "Name: value".`);
    headers[name] = line.slice(colon + 1).trim();
  });
  return headers;
}

/** The answer as text to read: JSON indented, anything else as it came. */
export function readable(type, text) {
  if (/\bjson\b/i.test(type) || /^\s*[[{]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all: show it as it is */ }
  }
  return text;
}

const size = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export default function (app) {
  const { refs } = app;
  const history = [];
  let controller = null;

  const showHistory = () => {
    refs.history.items = history.map((entry, index) => ({
      value: String(index),
      text: `${entry.method} ${entry.url}`,
      detail: entry.result
    }));
  };

  app.command('send-request', async () => {
    if (controller) { controller.abort(); return; }
    const method = app.scope.get('method');
    const url = app.scope.get('url').trim();
    let headers;
    try { headers = parseHeaders(app.scope.get('headers')); } catch (error) {
      app.scope.set('status', error.message);
      app.scope.set('page', 'request');
      return;
    }
    const body = method === 'POST' ? app.scope.get('body') : undefined;
    const entry = { method, url, headers: app.scope.get('headers'), body: app.scope.get('body'), result: 'sending…' };
    history.unshift(entry);
    history.length = Math.min(history.length, HISTORY);
    showHistory();
    controller = new AbortController();
    const mine = controller;
    app.scope.set('send-label', 'Stop');
    app.scope.set('status', `Sending ${method} ${url}…`);
    const started = performance.now();
    try {
      const answer = await app.request({ url, method, headers, body, signal: mine.signal });
      if (app.scope.disposed) return;
      const ms = Math.round(performance.now() - started);
      const bytes = new TextEncoder().encode(answer.text).length;
      entry.result = `${answer.status} · ${ms} ms · ${size(bytes)}`;
      app.scope.set('answer', readable(answer.type, answer.text));
      app.scope.set('page', 'answer');
      app.scope.set('status', `${answer.status} ${answer.ok ? 'OK' : 'not OK'} · ${answer.type || 'no type'} · ${size(bytes)} · ${ms} ms`);
    } catch (error) {
      if (app.scope.disposed) return;
      entry.result = mine.signal.aborted ? 'stopped' : 'failed';
      app.scope.set('status', mine.signal.aborted ? 'Stopped.' : error.message);
    } finally {
      if (controller === mine) controller = null;
    }
    if (!app.scope.disposed) {
      app.scope.set('send-label', 'Send');
      showHistory();
    }
  });

  app.command('recall', () => {
    const entry = history[Number(app.scope.get('entry'))];
    if (!entry) return;
    for (const name of ['method', 'url', 'headers', 'body']) app.scope.set(name, entry[name]);
    app.scope.set('page', 'request');
  });

  app.scope.add(() => controller?.abort());
}
