/** JSON Lens: says whether text is JSON and where it is not, formats it, and lists every path in it. */

const OUTLINE_LIMIT = 2000;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** "$.apps[0]", "$['odd key']": the path of a child under `parent`. */
export function childPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

const kindOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

function preview(value) {
  const kind = kindOf(value);
  if (kind === 'array') return `${value.length} items`;
  if (kind === 'object') return `${Object.keys(value).length} keys`;
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * Every value with its path, depth first, at most `limit`:
 * [{ path, kind, preview, depth, line }], where `line` is the value's line
 * in JSON.stringify(value, null, indent) text.
 */
export function outline(value, limit = OUTLINE_LIMIT) {
  const rows = [];
  let deepest = 0;
  let line = 1;
  const visit = (node, path, depth) => {
    deepest = Math.max(deepest, depth);
    if (rows.length >= limit) return;
    rows.push({ path, kind: kindOf(node), preview: preview(node), depth, line: line++ });
    if (node && typeof node === 'object') {
      const entries = Array.isArray(node) ? node.map((child, index) => [index, child]) : Object.entries(node);
      for (const [key, child] of entries) visit(child, childPath(path, key), depth + 1);
      if (entries.length) line += 1; // the closing bracket's own line
    }
  };
  visit(value, '$', 0);
  return Object.assign(rows, { deepest });
}

/** The same value with every object's keys in order, all the way down. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}

/**
 * The offset of the first character that keeps `text` from being JSON, or
 * null when it is JSON. Engines word their errors differently and some give
 * no position, so the text is walked here the way JSON.parse reads it.
 */
export function errorOffset(text) {
  let i = 0;
  const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const fail = () => { throw i; };
  const space = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const literal = word => { if (!text.startsWith(word, i)) fail(); i += word.length; };
  const string = () => {
    for (i++; text[i] !== '"'; i++) {
      if (i >= text.length || text[i] < ' ') fail();
      if (text[i] !== '\\') continue;
      i++;
      if (text[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail(); i += 4; }
      else if (!'"\\/bfnrt'.includes(text[i] ?? 'x')) fail();
    }
    i++;
  };
  const value = () => {
    space();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      space();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (c === '{') {
          space();
          if (text[i] !== '"') fail();
          string();
          space();
          if (text[i] !== ':') fail();
          i++;
        }
        value();
        space();
        if (text[i] === close) { i++; return; }
        if (text[i] !== ',') fail();
        i++;
      }
    }
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    NUMBER.lastIndex = i;
    if (!NUMBER.test(text)) fail();
    i = NUMBER.lastIndex;
  };
  try {
    value();
    space();
    if (i < text.length) fail();
    return null;
  } catch (at) {
    if (typeof at === 'number') return Math.min(at, text.length);
    return null; // nested too deeply to walk; the engine's message stands alone
  }
}

/** Where `text` stops being JSON, as { line, column, offset, message }; line is null when that cannot be told. */
export function locate(text, error) {
  const message = error.message
    .replace(/^JSON\.parse: /, '')
    .replace(/, ".*" is not valid JSON$/s, '')
    .replace(/ (in JSON )?at position \d+.*$/s, '')
    .replace(/ at line \d+ column \d+ of the JSON data$/, '');
  const offset = errorOffset(text);
  if (offset === null) return { line: null, column: null, offset: null, message };
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n'), offset, message };
}

/** Text offset where a line and column start. */
const offsetOf = (text, line, column) => {
  let at = 0;
  for (let n = 1; n < line; n++) at = text.indexOf('\n', at) + 1;
  return at + column - 1;
};

export default function (app) {
  const { os, refs } = app;
  let parsed;
  let rows = [];

  const indent = () => (app.scope.get('indent') === 'tab' ? '\t' : Number(app.scope.get('indent')));
  const read = () => {
    const text = app.scope.get('source');
    if (!text.trim()) {
      parsed = undefined;
      rows = [];
      app.scope.set('valid', false);
      app.scope.set('status', 'Paste or type JSON on the left.');
      return show();
    }
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = undefined;
      rows = [];
      app.scope.set('valid', false);
      const where = locate(text, error);
      app.scope.set('status', where.line ? `Not JSON: line ${where.line}, column ${where.column}. ${where.message}` : `Not JSON. ${where.message}`);
      return show();
    }
    rows = outline(parsed);
    app.scope.set('valid', true);
    const capped = rows.length >= OUTLINE_LIMIT ? `, the first ${OUTLINE_LIMIT} listed` : '';
    app.scope.set('status', `JSON: ${rows.length} values${capped}, ${rows.deepest} levels deep, ${text.length} characters.`);
    show();
  };
  const show = () => {
    const filter = app.scope.get('filter').trim().toLowerCase();
    refs.outline.empty = parsed === undefined ? 'Nothing to show' : 'No path has that in it';
    refs.outline.items = rows
      .filter(row => !filter || row.path.toLowerCase().includes(filter) || row.preview.toLowerCase().includes(filter))
      .map(row => ({ value: row.path, text: row.path, detail: `${row.kind} · ${row.preview}` }));
  };
  const later = app.debounce(200, read);
  app.scope.subscribe(app.signal('source'), later, { immediate: false });
  app.scope.subscribe(app.signal('filter'), show, { immediate: false });
  read();

  const rewrite = value => {
    later.flush();
    if (parsed === undefined) return;
    app.scope.set('source', value(parsed));
    read();
  };
  app.command('format', () => rewrite(value => JSON.stringify(value, null, indent())));
  app.command('minify', () => rewrite(value => JSON.stringify(value)));
  app.command('sort-keys', () => rewrite(value => JSON.stringify(sortKeys(value), null, indent())));
  app.scope.subscribe(app.signal('indent'), () => { if (parsed !== undefined && app.scope.get('source').includes('\n')) rewrite(value => JSON.stringify(value, null, indent())); }, { immediate: false });

  // Picking a path selects its line in the text, when the text is formatted as Format leaves it.
  app.command('show-node', () => {
    const row = rows.find(candidate => candidate.path === app.scope.get('node'));
    const text = app.scope.get('source');
    if (!row || parsed === undefined || text !== JSON.stringify(parsed, null, indent())) return;
    const start = offsetOf(text, row.line, 1);
    refs.editor.setSelection(start, start + text.split('\n')[row.line - 1].length);
  });

  app.command('to-notepad', async () => {
    try {
      os.open('notepad');
      const notepad = os.app('notepad');
      if (await notepad.files.run('new') === false) return;
      notepad.signal('content').set(app.scope.get('source'));
      notepad.files.changed();
    } catch (error) { app.report(error); }
  });
}
