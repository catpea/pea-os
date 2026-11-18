import { Signal } from '../../src/core/reactive.js';
import { createDocumentController } from '../../src/os/document-controller.js';
import { Row } from '../../src/ui/layout.js';
import { Label, Check } from '../../src/ui/controls.js';
import { Field, TextArea } from '../../src/ui/fields.js';
import { Select } from '../../src/ui/lists.js';

/**
 * Pea Records: a small card-file database in the spirit of the classic
 * desktop databases. One document holds field definitions and records.
 * Browse shows one record as a form; the book in the status area turns to
 * the previous or next record. List shows the found set as a table, Find
 * narrows it, and Fields defines what a record holds.
 *
 *   <database version="1" name="Seed Catalogue">
 *     <field name="Name" type="text"/>
 *     <field name="Kind" type="choice" options="Vegetable,Herb"/>
 *     <record id="r1"><value field="Name">Snap pea</value></record>
 *   </database>
 */

export const FIELD_TYPES = ['text', 'number', 'date', 'check', 'choice', 'note'];
const MAX_FIELDS = 40;
const MAX_RECORDS = 5000;
const MAX_VALUE = 20000;
const ROW_H = 12;
const HEAD_H = 13;
const FLIP_MS = 170;

/** Reads a database document. Throws an XmlError that names the line. */
export function parseDatabase(xml, text, source = 'database') {
  const root = xml.parseXml(text, source);
  if (root.name !== 'database') root.fail('must be <database>');
  root.expect({ attrs: ['version', 'name'], children: ['field', 'record'] });
  if (root.need('version') !== '1') root.fail(`version="${root.attr('version')}" is not supported`);
  const fields = root.all('field').map(node => {
    node.expect({ attrs: ['name', 'type', 'options'] });
    const name = node.need('name').trim();
    if (!name || name.length > 40) node.fail('needs a name of 1 to 40 characters');
    const type = node.attr('type', 'text');
    if (!FIELD_TYPES.includes(type)) node.fail(`type="${type}" must be one of ${FIELD_TYPES.join(', ')}`);
    const options = (node.attr('options') ?? '').split(',').map(option => option.trim()).filter(Boolean);
    if (type === 'choice' && !options.length) node.fail('of type "choice" needs options="a,b,c"');
    return { name, type, options };
  });
  if (fields.length > MAX_FIELDS) root.fail(`has more than ${MAX_FIELDS} fields`);
  const names = new Set();
  for (const [index, field] of fields.entries()) {
    const key = field.name.toLowerCase();
    if (names.has(key)) root.all('field')[index].fail(`name="${field.name}" is used twice`);
    names.add(key);
  }
  const ids = new Set();
  const records = root.all('record').map((node, index) => {
    node.expect({ attrs: ['id'], children: ['value'] });
    let id = node.attr('id', `r${index + 1}`);
    if (!/^[\w-]{1,40}$/.test(id) || ids.has(id)) node.fail(`id="${id}" must be unique letters, digits, "-" or "_"`);
    ids.add(id);
    const values = Object.create(null); // a field may be called "constructor": no inherited names
    for (const value of node.all('value')) {
      value.expect({ attrs: ['field'], text: true });
      const field = value.need('field');
      if (!fields.some(candidate => candidate.name === field)) value.fail(`field="${field}" is not a field of this database`);
      if (value.text.length > MAX_VALUE) value.fail(`is longer than ${MAX_VALUE} characters`);
      values[field] = value.text;
    }
    return { id, values };
  });
  if (records.length > MAX_RECORDS) root.fail(`has more than ${MAX_RECORDS} records`);
  return { name: root.attr('name', 'Records'), fields, records };
}

export function serializeDatabase({ escapeXml }, db) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<database version="1" name="${escapeXml(db.name)}">`];
  for (const field of db.fields) {
    lines.push(`  <field name="${escapeXml(field.name)}" type="${field.type}"${field.type === 'choice' ? ` options="${escapeXml(field.options.join(','))}"` : ''}/>`);
  }
  for (const record of db.records) {
    lines.push(`  <record id="${escapeXml(record.id)}">`);
    for (const field of db.fields) {
      const value = record.values[field.name];
      if (value !== undefined && value !== '') lines.push(`    <value field="${escapeXml(field.name)}">${escapeXml(value)}</value>`);
    }
    lines.push('  </record>');
  }
  lines.push('</database>', '');
  return lines.join('\n');
}

/** "&gt;5", "1..9", "=Mint" or plain text: does `value` satisfy what was typed for this field? */
export function matches(field, value = '', wanted) {
  const query = String(wanted).trim();
  if (!query) return true;
  if (field.type === 'check') return (value === 'true') === (query === 'true');
  const ordered = field.type === 'number' || field.type === 'date';
  const read = text => (field.type === 'number' ? Number(text) : text);
  const range = /^(.+?)\.{2,3}(.+)$/.exec(query);
  if (ordered && range) {
    const [low, high] = [read(range[1].trim()), read(range[2].trim())];
    return value !== '' && read(value) >= low && read(value) <= high;
  }
  const compare = /^(>=|<=|>|<|=)\s*(.*)$/.exec(query);
  if (compare) {
    const [, op, operand] = compare;
    if (op === '=') return value.toLowerCase() === operand.toLowerCase();
    if (value === '') return false;
    const [a, b] = ordered ? [read(value), read(operand)] : [value.toLowerCase(), operand.toLowerCase()];
    return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
  }
  if (field.type === 'number') return value !== '' && Number(value) === Number(query);
  return value.toLowerCase().includes(query.toLowerCase());
}

function compareBy(field) {
  if (field.type === 'number') {
    return (a, b) => {
      const [x, y] = [Number(a || NaN), Number(b || NaN)];
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) - Number.isNaN(y);
      return x - y;
    };
  }
  if (field.type === 'check') return (a, b) => (a === 'true') - (b === 'true');
  return (a, b) => (!a || !b ? !a - !b : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function problem(field, value) {
  if (!value) return '';
  if (field.type === 'number' && !Number.isFinite(Number(value))) return `${field.name} should be a number`;
  if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) return `${field.name} should be a date like 2026-05-01`;
  return '';
}

export default function records(app) {
  const { ui } = app.os;
  const { book, table, form, findForm, fieldList } = app.refs;
  const mode = app.signal('mode');
  const status = app.signal('status');
  const fieldSelected = app.signal('field-selected');
  // Until a saved database is opened, Records shows the example catalogue.
  let db = parseDatabase(app.xml, app.os.dataText('records-sample'), 'Seed Catalogue');
  let found = db.records.slice();
  let at = 0;
  let sort = null;             // { field, dir }
  let criteria = null;         // { fieldName: query } while a find is in effect
  let loading = false;
  let flip = null;             // { dir, start } while the book turns a page
  let tableScroll = 0;
  let lastClick = { index: -1, time: -Infinity };
  let formScope = app.scope.child();
  let findScope = app.scope.child();
  let editors = new Map();     // field name -> Signal of the browse form
  let finders = new Map();     // field name -> Signal of the find form

  const current = () => found[at] ?? null;
  const field = name => db.fields.find(candidate => candidate.name === name);

  // ---- Found set ------------------------------------------------------------

  function refind(keep = current()) {
    found = criteria ? db.records.filter(record => Object.entries(criteria).every(([name, query]) => {
      const definition = field(name);
      return !definition || matches(definition, record.values[name] ?? '', query);
    })) : db.records.slice();
    if (sort) {
      const definition = field(sort.field);
      if (!definition) sort = null;
      else {
        const compare = compareBy(definition);
        found.sort((a, b) => compare(a.values[sort.field] ?? '', b.values[sort.field] ?? '') * sort.dir);
      }
    }
    const index = keep ? found.indexOf(keep) : -1;
    at = Math.max(0, Math.min(index >= 0 ? index : at, found.length - 1));
  }

  function summary() {
    const total = db.records.length;
    app.signal('db-name').set(db.name);
    app.signal('position').set(found.length ? `${at + 1} / ${found.length}` : '0 / 0');
    app.signal('counts').set(criteria ? `Found ${found.length} of ${total}` : `${total} record${total === 1 ? '' : 's'}`);
    app.signal('sorted').set(sort ? `Sorted ${sort.dir > 0 ? '↑' : '↓'} ${sort.field}` : 'Unsorted');
    app.signal('has-record').set(Boolean(current()));
  }

  function show({ turn = 0 } = {}) {
    const record = current();
    loading = true;
    try {
      for (const [name, signal] of editors) signal.set(record?.values[name] ?? '');
    } finally { loading = false; }
    form.disabled = !record;
    if (turn && app.motion.value) flip = { dir: turn, start: ui.stage.time };
    summary();
    paintBook();
    revealRow();
    paintTable();
  }

  function go(index) {
    if (!found.length) return;
    const next = Math.max(0, Math.min(found.length - 1, index));
    if (next === at) return;
    const turn = Math.sign(next - at);
    at = next;
    show({ turn });
  }

  // ---- The document -----------------------------------------------------------

  function install(value, { reset = false } = {}) {
    const keep = reset ? null : current()?.id;
    // Undo of a typed value must not rebuild the form under the caret.
    const sameFields = JSON.stringify(value.fields) === JSON.stringify(db.fields) && editors.size === value.fields.length;
    db = value;
    if (reset) { sort = null; criteria = null; at = 0; }
    refind(db.records.find(record => record.id === keep) ?? null);
    if (!sameFields) buildForms();
    refreshFields();
    show();
  }

  const files = createDocumentController(app, {
    format: 'application/xml', extension: '.xml', accept: '.xml,application/xml,text/xml',
    create: () => ({ name: 'New database', fields: [{ name: 'Name', type: 'text', options: [] }, { name: 'Notes', type: 'note', options: [] }], records: [] }),
    parse: (text, source) => parseDatabase(app.xml, text, source),
    serialize: () => serializeDatabase(app.xml, db),
    install
  });

  const edited = coalesce => files.changed(coalesce ? { coalesce } : undefined);

  // ---- Forms ------------------------------------------------------------------

  function editorFor(definition, signal, onEdit, finding = false) {
    const common = { value: signal, label: definition.name, grow: 1 };
    if (definition.type === 'check') {
      if (finding) return new Select(ui, { ...common, items: [{ value: '', text: 'Either' }, { value: 'true', text: 'Yes' }, { value: 'false', text: 'No' }] });
      const box = new Signal(signal.value === 'true');
      formScope.add(box);
      formScope.subscribe(signal, value => box.set(value === 'true'));
      formScope.subscribe(box, value => { if (!loading && signal.value !== String(value)) { signal.set(String(value)); onEdit(); } }, { immediate: false });
      return new Check(ui, { value: box, text: 'Yes', label: definition.name });
    }
    if (definition.type === 'choice') {
      const items = [{ value: '', text: finding ? 'Any' : '—' }, ...definition.options.map(option => ({ value: option, text: option }))];
      return new Select(ui, { ...common, items, onChange: () => onEdit() });
    }
    const placeholder = definition.type === 'date' ? (finding ? 'e.g. >2026-04-01' : 'YYYY-MM-DD') : definition.type === 'number' && finding ? 'e.g. >30 or 10..60' : '';
    const Type = definition.type === 'note' && !finding ? TextArea : Field;
    return new Type(ui, { ...common, placeholder, maxlength: MAX_VALUE, height: Type === TextArea ? 40 : undefined, onChange: () => onEdit() });
  }

  function buildForms() {
    formScope.dispose();
    findScope.dispose();
    formScope = app.scope.child();
    findScope = app.scope.child();
    for (const child of [...form.children, ...findForm.children]) child.dispose();
    editors = new Map();
    const keepFinders = new Map([...finders].map(([name, signal]) => [name, signal.value]));
    finders = new Map();
    const labelWidth = Math.min(72, Math.max(36, ...db.fields.map(definition => app.font.measure(definition.name) + 4)));
    if (!db.fields.length) form.add(new Label(ui, { text: 'This database has no fields yet. Choose Fields to add some.', color: 'dim', wrap: true }));
    for (const definition of db.fields) {
      const signal = formScope.add(new Signal(''));
      editors.set(definition.name, signal);
      const row = form.add(new Row(ui, { gap: 4, align: definition.type === 'note' ? 'start' : 'center' }));
      row.add(new Label(ui, { text: definition.name, width: labelWidth, align: 'end', color: 'dim' }));
      row.add(editorFor(definition, signal, () => {
        if (loading) return;
        const record = current();
        if (!record) return;
        record.values[definition.name] = signal.value;
        status.set(problem(definition, signal.value));
        edited(`edit:${record.id}:${definition.name}`);
      }));

      const query = findScope.add(new Signal(keepFinders.get(definition.name) ?? ''));
      finders.set(definition.name, query);
      const findRow = findForm.add(new Row(ui, { gap: 4, align: 'center' }));
      findRow.add(new Label(ui, { text: definition.name, width: labelWidth, align: 'end', color: 'dim' }));
      findRow.add(editorFor(definition, query, () => {}, true));
    }
    ui.requestLayout();
  }

  // ---- The book ---------------------------------------------------------------

  function paintBook() {
    const bitmap = book.bitmap;
    if (!bitmap) return;
    const theme = app.theme.value;
    bitmap.clear(0);
    const w = Math.min(44, bitmap.width - 4);
    const x = (bitmap.width - w) >> 1;
    const h = 38;
    const ink = theme.color('ink');
    const paper = theme.color('field');
    const dim = theme.color('dim');
    // Two cards behind the top one make the stack.
    bitmap.fill(x + 3, 5, w - 2, h - 3, theme.color('panel'));
    bitmap.frame(x + 3, 5, w - 2, h - 3, ink);
    bitmap.fill(x + 1, 3, w - 2, h - 3, paper);
    bitmap.frame(x + 1, 3, w - 2, h - 3, ink);
    let offset = 0;
    if (flip) {
      const t = Math.min(1, (ui.stage.time - flip.start) / FLIP_MS);
      offset = Math.round((1 - t) * 9) * -flip.dir;
      if (t >= 1) flip = null;
    }
    const top = 1 + offset;
    bitmap.fill(x - 1, top, w - 2, h - 3, paper);
    bitmap.frame(x - 1, top, w - 2, h - 3, ink);
    // Rings along the top edge.
    for (let ring = x + 4; ring < x + w - 6; ring += 7) bitmap.fill(ring, top - 1, 2, 3, ink);
    // A fold splits the card: the upper half goes back, the lower half forward.
    const mid = top + ((h - 3) >> 1);
    bitmap.fill(x, mid, w - 4, 1, dim);
    const arrow = (cx, cy, up, enabled) => {
      const color = enabled ? theme.color('accent') : dim;
      for (let row = 0; row < 4; row++) bitmap.fill(cx - row, cy + (up ? row : 3 - row), row * 2 + 1, 1, color);
    };
    const center = x - 1 + ((w - 2) >> 1);
    arrow(center, top + 6, true, at > 0);
    arrow(center, mid + 5, false, at < found.length - 1);
    // The rail: where this record sits in the found set; drag it to jump.
    const railY = h + 6;
    bitmap.fill(2, railY, bitmap.width - 4, 3, theme.color('field'));
    bitmap.frame(2, railY, bitmap.width - 4, 3, ink);
    if (found.length) {
      const knob = 2 + Math.round((found.length > 1 ? at / (found.length - 1) : 0) * (bitmap.width - 9));
      bitmap.fill(knob, railY - 2, 5, 7, theme.color('accent'));
      bitmap.frame(knob, railY - 2, 5, 7, ink);
    }
    book.commit();
  }

  let railDrag = false;
  app.scope.on(book.events, 'down', event => {
    if (!found.length) return;
    if (event.y >= 40) { railDrag = true; scrub(event); return; }
    go(at + (event.y < 20 ? -1 : 1));
  });
  app.scope.on(book.events, 'move', event => { if (railDrag) scrub(event); });
  app.scope.on(book.events, 'up', () => { railDrag = false; });
  app.scope.on(book.events, 'cancel', () => { railDrag = false; });
  app.scope.on(book.events, 'wheel', event => { if (event.dy) { go(at + Math.sign(event.dy)); event.handled = true; } });
  app.scope.on(book.events, 'resize', () => paintBook());
  book.useCursor(() => 'pointer');
  function scrub(event) {
    const t = Math.max(0, Math.min(1, (event.x - 4) / Math.max(1, book.w - 9)));
    go(Math.round(t * (found.length - 1)));
  }
  app.frame(() => { if (flip) paintBook(); });

  // ---- The table --------------------------------------------------------------

  function columns(width) {
    const { font } = app;
    const sample = found.slice(0, 60);
    const cols = [];
    let x = 0;
    for (const definition of db.fields) {
      // A long heading gives way to its values; it is shortened with "…" when it must be.
      const widest = Math.max(Math.min(font.measure(definition.name) + 10, 52), ...sample.map(record => font.measure(cell(definition, record)) + 6));
      const w = Math.min(definition.type === 'note' ? 110 : 90, Math.max(definition.type === 'check' ? 20 : 34, widest));
      if (x + w > width && cols.length) break;
      cols.push({ definition, x, w });
      x += w;
    }
    if (cols.length) cols.at(-1).w = Math.max(cols.at(-1).w, width - cols.at(-1).x);
    return cols;
  }

  function cell(definition, record) {
    const value = record.values[definition.name] ?? '';
    if (definition.type === 'check') return value === 'true' ? '✓' : '';
    return value.split('\n')[0];
  }

  const fit = (text, width) => {
    const { font } = app;
    if (font.measure(text) <= width) return text;
    let end = text;
    while (end && font.measure(`${end}…`) > width) end = end.slice(0, -1);
    return `${end}…`;
  };

  const maxScroll = () => Math.max(0, found.length * ROW_H - (table.h - HEAD_H - 2));

  function revealRow() {
    if (!table.h) return;
    const top = at * ROW_H;
    const room = table.h - HEAD_H - 2;
    if (top < tableScroll) tableScroll = top;
    if (top + ROW_H > tableScroll + room) tableScroll = top + ROW_H - room;
    tableScroll = Math.max(0, Math.min(maxScroll(), tableScroll));
  }

  function paintTable() {
    const bitmap = table.bitmap;
    if (!bitmap || !table.visible) return;
    const theme = app.theme.value;
    const { font } = app;
    const ink = theme.color('ink');
    bitmap.clear(theme.color('field'));
    const cols = columns(bitmap.width - 2);
    const first = Math.floor(tableScroll / ROW_H);
    for (let index = first; index < found.length; index++) {
      const y = HEAD_H + 1 + index * ROW_H - tableScroll;
      if (y >= bitmap.height) break;
      const record = found[index];
      const selected = index === at;
      if (selected) bitmap.fill(1, y, bitmap.width - 2, ROW_H, theme.color('accent'));
      else if (index % 2) bitmap.fill(1, y, bitmap.width - 2, ROW_H, theme.lock(app.gfx.mix(theme.color('field'), theme.color('panel'), 0.45)));
      for (const { definition, x, w } of cols) {
        font.draw(bitmap, fit(cell(definition, record), w - 6), x + 4, y + 2, theme.color(selected ? 'accent-ink' : 'field-ink'));
      }
    }
    if (!found.length) font.draw(bitmap, criteria ? 'No records were found.' : 'No records yet. Press New record.', 6, HEAD_H + 6, theme.color('dim'));
    bitmap.fill(0, 0, bitmap.width, HEAD_H, theme.color('panel'));
    bitmap.fill(0, HEAD_H, bitmap.width, 1, ink);
    for (const { definition, x, w } of cols) {
      const sorted = sort?.field === definition.name;
      const label = `${definition.name}${sorted ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}`;
      font.draw(bitmap, fit(label, w - 6), x + 4, 3, theme.color('panel-ink'), { bold: sorted });
      if (x > 0) bitmap.fill(x, 0, 1, bitmap.height, theme.color('dim'));
    }
    bitmap.frame(0, 0, bitmap.width, bitmap.height, ink);
    if (maxScroll() > 0) {
      const track = bitmap.height - HEAD_H - 4;
      const knob = Math.max(4, Math.round(track * track / (found.length * ROW_H)));
      bitmap.fill(bitmap.width - 4, HEAD_H + 2 + Math.round((track - knob) * tableScroll / maxScroll()), 2, knob, theme.color('dim'));
    }
    table.commit();
  }

  app.scope.on(table.events, 'resize', () => { revealRow(); paintTable(); });
  app.scope.on(table.events, 'down', event => {
    if (event.y < HEAD_H) {
      const column = columns(table.w - 2).find(({ x, w }) => event.x >= x && event.x < x + w);
      if (column) sortBy(column.definition.name, sort?.field === column.definition.name ? -sort.dir : 1);
      return;
    }
    const index = Math.floor((event.y - HEAD_H - 1 + tableScroll) / ROW_H);
    if (index < 0 || index >= found.length) return;
    const now = ui.stage.time;
    const twice = lastClick.index === index && now - lastClick.time < 400;
    lastClick = twice ? { index: -1, time: -Infinity } : { index, time: now };
    if (index !== at) { at = index; show(); }
    if (twice) mode.set('browse');
  });
  app.scope.on(table.events, 'wheel', event => {
    const next = Math.max(0, Math.min(maxScroll(), tableScroll + Math.round(event.dy)));
    if (next !== tableScroll) { tableScroll = next; paintTable(); event.handled = true; }
  });
  table.useCursor(event => (event.y < HEAD_H ? 'pointer' : 'default'));

  // ---- Modes ------------------------------------------------------------------

  app.scope.subscribe(mode, value => {
    app.signal('browsing').set(value === 'browse');
    app.signal('listing').set(value === 'list');
    app.signal('finding').set(value === 'find');
    app.signal('defining').set(value === 'fields');
    status.set(value === 'find' ? 'Find shows the records that match every field you fill in.' : '');
    if (value === 'list') queueMicrotask(() => { revealRow(); paintTable(); });
    if (value === 'find') queueMicrotask(() => findForm.children[0]?.children[1]?.focus());
  });

  function sortBy(name, dir) {
    sort = name ? { field: name, dir } : null;
    refind();
    show();
    status.set(sort ? `Sorted by ${name}, ${dir > 0 ? 'A to Z' : 'Z to A'}.` : 'Records are in the order they were made.');
  }

  app.command('sort', async () => {
    const items = [{ value: '', text: 'Unsorted', detail: 'The order records were made' }, ...db.fields.flatMap(definition => [
      { value: `${definition.name}\u00001`, text: `${definition.name} ↑`, detail: 'Ascending' },
      { value: `${definition.name}\u0000-1`, text: `${definition.name} ↓`, detail: 'Descending' }
    ])];
    const choice = await app.os.dialogs.choose({ title: 'Sort records', message: 'Sort the found set by:', items, value: sort ? `${sort.field}\u0000${sort.dir}` : '', acceptLabel: 'Sort' });
    if (choice === null) return;
    const [name, dir] = String(choice).split('\u0000');
    sortBy(name || null, Number(dir) || 1);
  });

  app.command('show-all', () => {
    criteria = null;
    refind();
    show();
    if (mode.value === 'find') mode.set('browse');
    status.set(`Showing all ${db.records.length} records.`);
  });

  app.command('find-run', () => {
    const wanted = Object.fromEntries([...finders].filter(([, signal]) => String(signal.value).trim()).map(([name, signal]) => [name, String(signal.value)]));
    if (!Object.keys(wanted).length) { app.run('show-all'); return; }
    const previous = criteria;
    criteria = wanted;
    refind(null);
    if (!found.length) {
      criteria = previous;
      refind();
      status.set('No records match. Change what you typed and try again.');
      return;
    }
    at = 0;
    mode.set('browse');
    show();
    status.set(`Found ${found.length} of ${db.records.length}.`);
  });
  app.command('find-clear', () => { for (const signal of finders.values()) signal.set(''); });

  // ---- Records ----------------------------------------------------------------

  const nextId = () => {
    let n = db.records.length + 1;
    const taken = new Set(db.records.map(record => record.id));
    while (taken.has(`r${n}`)) n++;
    return `r${n}`;
  };

  function add(values) {
    if (!db.fields.length) { mode.set('fields'); status.set('Add a field first: a record is made of fields.'); return; }
    if (db.records.length >= MAX_RECORDS) { status.set(`A database holds up to ${MAX_RECORDS} records.`); return; }
    const record = { id: nextId(), values: Object.assign(Object.create(null), values) };
    db.records.push(record);
    found.push(record);
    at = found.length - 1;
    edited();
    if (mode.value !== 'browse') mode.set('browse');
    show({ turn: 1 });
    queueMicrotask(() => form.children[0]?.children[1]?.focus());
  }

  app.command('record-new', () => add({}));
  app.command('record-duplicate', () => { if (current()) add({ ...current().values }); });
  app.command('record-open', () => mode.set('browse'));
  app.command('record-delete', async () => {
    const record = current();
    if (!record) return;
    const title = record.values[db.fields[0]?.name] || 'this record';
    const answer = await app.os.dialogs.confirm({ title: 'Delete record', message: `Delete “${title}”? Undo can bring it back.`,
      buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'delete', text: 'Delete' }] });
    if (answer !== 'delete' || !db.records.includes(record)) return;
    db.records.splice(db.records.indexOf(record), 1);
    found.splice(found.indexOf(record), 1);
    at = Math.min(at, found.length - 1);
    edited();
    show();
    status.set('Record deleted.');
  });

  // ---- Fields -----------------------------------------------------------------

  function refreshFields() {
    fieldList.items = db.fields.map(definition => ({ value: definition.name, text: definition.name, detail: definition.type === 'choice' ? `Choice: ${definition.options.join(', ')}` : { text: 'Text', number: 'Number', date: 'Date', check: 'Yes / no', note: 'Long text' }[definition.type] }));
    if (!field(fieldSelected.value)) fieldSelected.set(db.fields[0]?.name ?? '');
    app.signal('has-field').set(Boolean(field(fieldSelected.value)));
  }

  app.scope.subscribe(fieldSelected, name => {
    const definition = field(name);
    app.signal('has-field').set(Boolean(definition));
    if (!definition) return;
    app.signal('field-name').set(definition.name);
    app.signal('field-type').set(definition.type);
    app.signal('field-options').set(definition.options.join(', '));
  });
  app.scope.subscribe(app.signal('field-type'), type => app.signal('field-is-choice').set(type === 'choice'));

  function draft() {
    const name = app.signal('field-name').value.trim();
    const type = app.signal('field-type').value;
    const options = app.signal('field-options').value.split(',').map(option => option.trim()).filter(Boolean);
    if (!name) throw new Error('Give the field a name.');
    if (name.length > 40) throw new Error('A field name has at most 40 characters.');
    if (type === 'choice' && !options.length) throw new Error('A choice field needs choices, separated by commas.');
    return { name, type, options: type === 'choice' ? [...new Set(options)] : [] };
  }

  function changeFields(fn, message) {
    try {
      fn();
      edited();
      buildForms();
      refreshFields();
      refind();
      show();
      status.set(message);
    } catch (error) { status.set(error.message); }
  }

  app.command('field-add', () => changeFields(() => {
    const definition = draft();
    if (db.fields.length >= MAX_FIELDS) throw new Error(`A database has at most ${MAX_FIELDS} fields.`);
    if (db.fields.some(other => other.name.toLowerCase() === definition.name.toLowerCase())) throw new Error(`There is already a field called ${definition.name}.`);
    db.fields.push(definition);
    fieldSelected.set(definition.name);
  }, 'Field added.'));

  app.command('field-change', () => changeFields(() => {
    const old = field(fieldSelected.value);
    if (!old) return;
    const definition = draft();
    if (db.fields.some(other => other !== old && other.name.toLowerCase() === definition.name.toLowerCase())) throw new Error(`There is already a field called ${definition.name}.`);
    if (definition.name !== old.name) {
      for (const record of db.records) {
        if (old.name in record.values) { record.values[definition.name] = record.values[old.name]; delete record.values[old.name]; }
      }
      if (sort?.field === old.name) sort.field = definition.name;
      if (criteria && old.name in criteria) { criteria[definition.name] = criteria[old.name]; delete criteria[old.name]; }
    }
    db.fields[db.fields.indexOf(old)] = definition;
    fieldSelected.set(definition.name);
  }, 'Field changed.'));

  const move = step => changeFields(() => {
    const index = db.fields.findIndex(definition => definition.name === fieldSelected.value);
    const target = index + step;
    if (index < 0 || target < 0 || target >= db.fields.length) return;
    [db.fields[index], db.fields[target]] = [db.fields[target], db.fields[index]];
  }, 'Field moved.');
  app.command('field-up', () => move(-1));
  app.command('field-down', () => move(1));

  app.command('field-delete', async () => {
    const definition = field(fieldSelected.value);
    if (!definition) return;
    const used = db.records.filter(record => (record.values[definition.name] ?? '') !== '').length;
    const answer = await app.os.dialogs.confirm({ title: 'Delete field', message: `Delete the field “${definition.name}”${used ? ` and what ${used} record${used === 1 ? '' : 's'} hold in it` : ''}? Undo can bring it back.`,
      buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'delete', text: 'Delete' }] });
    if (answer !== 'delete' || !db.fields.includes(definition)) return;
    changeFields(() => {
      db.fields.splice(db.fields.indexOf(definition), 1);
      for (const record of db.records) delete record.values[definition.name];
      if (criteria) delete criteria[definition.name];
    }, 'Field deleted.');
  });

  // ---- Keys -------------------------------------------------------------------

  app.scope.on(app.keys, 'down', event => {
    const { key, ctrl } = event;
    if (ctrl && key.toLowerCase() === 'f') { mode.set('find'); event.handled = true; return; }
    if (key === 'Escape' && mode.value === 'find') { mode.set('browse'); return; }
    if (key === 'PageUp' || (ctrl && key === 'ArrowUp') || (mode.value === 'list' && key === 'ArrowUp')) go(at - 1);
    else if (key === 'PageDown' || (ctrl && key === 'ArrowDown') || (mode.value === 'list' && key === 'ArrowDown')) go(at + 1);
    else if (mode.value === 'list' && key === 'Home') go(0);
    else if (mode.value === 'list' && key === 'End') go(found.length - 1);
    else if (mode.value === 'list' && key === 'Enter') mode.set('browse');
  });

  app.scope.subscribe(app.theme, () => { paintBook(); paintTable(); }, { immediate: false });

  buildForms();
  refreshFields();
  show();
  files.ready.then(() => show());
}
