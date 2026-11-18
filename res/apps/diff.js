/** Text Diff: the shortest set of lines taken out and put in that turns one text into another. */

const MAX_EDITS = 2000;
const CONTEXT = 3;

/**
 * Myers' difference algorithm over lines: [{ kind: 'same' | 'del' | 'add', a, b }],
 * where a and b are line indexes in the old and new text (absent on the side
 * a line is not in). Throws when the texts differ by more than MAX_EDITS lines.
 */
export function diffLines(before, after, { ignoreSpace = false } = {}) {
  const key = ignoreSpace ? line => line.replace(/\s+/g, ' ').trim() : line => line;
  const A = before.map(key);
  const B = after.map(key);
  // Shared first and last lines are matched outright; the search runs on what is left.
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const n = A.length - head - tail;
  const m = B.length - head - tail;
  const same = (x, y) => A[head + x] === B[head + y];

  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = n === 0 && m === 0 ? 0 : -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_EDITS) throw new Error(`These texts differ in more than ${MAX_EDITS} lines, too many to compare here.`);
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(x, y)) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }

  const middle = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const at = k => before[k + d + 1];
    const k = x - y;
    const back = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const fromX = at(back);
    const fromY = fromX - back;
    while (x > fromX && y > fromY) middle.push({ kind: 'same', a: head + --x, b: head + --y });
    if (x === fromX) middle.push({ kind: 'add', b: head + --y });
    else middle.push({ kind: 'del', a: head + --x });
  }
  while (x > 0 && y > 0) middle.push({ kind: 'same', a: head + --x, b: head + --y });

  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ kind: 'same', a: i, b: i });
  ops.push(...middle.reverse());
  for (let i = 0; i < tail; i++) ops.push({ kind: 'same', a: A.length - tail + i, b: B.length - tail + i });
  return ops;
}

/** What to show: changes with a few lines around them, and each longer unchanged run folded into one row. */
export function displayRows(ops, context = CONTEXT) {
  const changed = ops.map(op => op.kind !== 'same');
  const near = ops.map((_, i) => {
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) if (changed[j]) return true;
    return false;
  });
  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    if (near[i]) { rows.push(ops[i]); continue; }
    let j = i;
    while (j < ops.length && !near[j]) j++;
    rows.push({ kind: 'fold', count: j - i });
    i = j - 1;
  }
  return rows;
}

/** A unified diff, as `diff -u` would print it, for Notepad. */
export function unified(before, after, ops, context = CONTEXT) {
  const lines = ['--- before', '+++ after'];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === 'same') i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    // A hunk runs on while the next change is within two contexts of the last one.
    for (let j = i; j < ops.length; j++) {
      if (ops[j].kind !== 'same') end = j;
      else if (j - end > context * 2) break;
    }
    end = Math.min(ops.length, end + context + 1);
    const hunk = ops.slice(start, end);
    const firstA = hunk.find(op => op.a !== undefined)?.a ?? 0;
    const firstB = hunk.find(op => op.b !== undefined)?.b ?? 0;
    const countA = hunk.filter(op => op.kind !== 'add').length;
    const countB = hunk.filter(op => op.kind !== 'del').length;
    lines.push(`@@ -${firstA + (countA ? 1 : 0)},${countA} +${firstB + (countB ? 1 : 0)},${countB} @@`);
    for (const op of hunk) lines.push(op.kind === 'same' ? ` ${before[op.a]}` : op.kind === 'del' ? `-${before[op.a]}` : `+${after[op.b]}`);
    i = end;
  }
  return lines.join('\n');
}

const split = text => (text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n'));

export default function (app) {
  const { os, refs, gfx } = app;
  const view = refs.view;
  let before = [];
  let after = [];
  let ops = [];
  let rows = [];
  let problem = '';
  let scroll = { x: 0, y: 0 };
  let drag = null;
  let dirty = true;

  const compare = () => {
    before = split(app.scope.get('before'));
    after = split(app.scope.get('after'));
    try {
      ops = diffLines(before, after, { ignoreSpace: app.scope.get('ignore-space') });
      problem = '';
    } catch (error) {
      ops = [];
      problem = error.message;
    }
    rows = displayRows(ops);
    const added = ops.filter(op => op.kind === 'add').length;
    const removed = ops.filter(op => op.kind === 'del').length;
    app.scope.set('status', problem ? 'Too different to compare' : added || removed ? `+${added} −${removed} lines` : 'The same');
    dirty = true;
  };
  const later = app.debounce(200, compare);
  for (const name of ['before', 'after']) app.scope.subscribe(app.signal(name), later, { immediate: false });
  app.scope.subscribe(app.signal('ignore-space'), compare, { immediate: false });
  compare();

  const rowHeight = () => app.font.lineHeight + 1;
  function paint() {
    const bitmap = view.bitmap;
    if (!bitmap) return;
    dirty = false;
    const theme = app.theme.value;
    const { font } = app;
    const field = theme.color('field');
    const ink = theme.color('ink');
    const tone = hex => theme.lock(gfx.mix(gfx.parseColor(hex), field, 0.62));
    const faces = { add: tone('#46b04a'), del: tone('#e8475a'), fold: theme.color('panel') };
    const marks = { same: ' ', add: '+', del: '-', fold: '' };
    bitmap.clear(field);
    const height = rowHeight();
    const digits = String(Math.max(before.length, after.length, 1)).length;
    const number = n => (n === undefined ? '' : String(n + 1)).padStart(digits, ' ');
    const gutter = font.measure('0'.repeat(digits * 2 + 1)) + 10;
    const room = bitmap.height - 2;
    scroll.y = Math.max(0, Math.min(Math.max(0, rows.length * height - room), scroll.y));
    scroll.x = Math.max(0, scroll.x);
    if (problem || !rows.length) {
      const message = problem || 'Both texts are empty.';
      font.draw(bitmap, message, Math.max(4, (bitmap.width - font.measure(message)) >> 1), (bitmap.height >> 1) - 4, theme.color('dim'));
    }
    const first = Math.floor(scroll.y / height);
    for (let i = first; i < rows.length && (i - first) * height < bitmap.height; i++) {
      const row = rows[i];
      const y = 1 + i * height - scroll.y;
      if (faces[row.kind]) bitmap.fill(1, y, bitmap.width - 2, height, faces[row.kind]);
      if (row.kind === 'fold') {
        font.draw(bitmap, `… ${row.count} unchanged ${row.count === 1 ? 'line' : 'lines'}`, gutter + 2, y + 1, theme.color('panel-ink'));
        continue;
      }
      const text = (row.kind === 'add' ? after[row.b] : before[row.a]).replace(/\t/g, '  ');
      font.draw(bitmap, `${marks[row.kind]} ${text}`, gutter + 2 - scroll.x, y + 1, theme.color('field-ink'));
      bitmap.fill(1, y, gutter - 2, height, row.kind === 'same' ? field : faces[row.kind]);
      font.draw(bitmap, `${number(row.a)} ${number(row.b)}`, 3, y + 1, theme.color('dim'));
    }
    bitmap.fill(gutter - 1, 1, 1, bitmap.height - 2, theme.color('dim'));
    const total = rows.length * height;
    if (total > room) {
      const track = bitmap.height - 4;
      const knob = Math.max(6, Math.round(track * room / total));
      bitmap.fill(bitmap.width - 4, 2 + Math.round((track - knob) * scroll.y / (total - room)), 2, knob, theme.color('dim'));
    }
    bitmap.frame(0, 0, bitmap.width, bitmap.height, ink);
    view.commit();
  }

  app.frame(() => { if (dirty) paint(); });
  app.scope.on(view.events, 'resize', () => { dirty = true; paint(); });
  app.scope.subscribe(app.theme, () => { dirty = true; }, { immediate: false });
  app.scope.on(view.events, 'wheel', event => {
    scroll = { x: scroll.x + Math.round(event.dx), y: scroll.y + Math.round(event.dy) };
    dirty = true;
    event.handled = true;
  });
  app.scope.on(view.events, 'down', event => { drag = { x: event.x, y: event.y, from: scroll }; });
  app.scope.on(view.events, 'move', event => {
    if (!drag) return;
    scroll = { x: drag.from.x - (event.x - drag.x), y: drag.from.y - (event.y - drag.y) };
    dirty = true;
  });
  app.scope.on(view.events, 'up', () => { drag = null; });
  app.scope.on(view.events, 'cancel', () => { drag = null; });

  app.command('swap', () => {
    const old = app.scope.get('before');
    app.scope.set('before', app.scope.get('after'));
    app.scope.set('after', old);
    later.flush();
    compare();
  });
  app.command('to-notepad', async () => {
    later.flush();
    if (problem) return app.report(new Error(problem));
    try {
      os.open('notepad');
      const notepad = os.app('notepad');
      if (await notepad.files.run('new') === false) return;
      notepad.signal('content').set(unified(before, after, ops));
      notepad.files.changed();
    } catch (error) { app.report(error); }
  });
}
