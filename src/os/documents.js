import { Signal } from '../core/reactive.js';
import { parseXml, escapeXml } from '../core/xml.js';
import { textOf } from './files.js';

/**
 * Named documents, kept as files by whichever files provider works here: on
 * disk under pos serve, in browser storage on a web host, on the phone. Each
 * document is one XML file in documents/, so a folder of them can be backed
 * up or read without Pea OS:
 *
 *   <document version="1" app="notepad" name="Shopping" format="text/plain"
 *             created="1731600000000" updated="1731600000000">
 *     <content>eggs, peas</content>
 *   </document>
 *
 * An app's unsaved draft is recovery/<app>.xml, a <recovery> with the draft
 * as <content> and what it was based on as <base>. Contents are opaque text
 * that each app writes in its own format.
 */

const FOLDER = 'documents';
const RECOVERY = 'recovery';
let nextId = 0;

const documentId = appId => `${appId}-${Date.now().toString(36)}${(++nextId).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pathOf = id => `${FOLDER}/${id}.xml`;
const idOf = name => name.slice(FOLDER.length + 1, -'.xml'.length);
const encode = text => new TextEncoder().encode(text);
const copy = value => (value ? { ...value } : null);

function validName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 120) throw new Error('Use a document name from 1 to 120 characters.');
  return name;
}

function writeDocument(record) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<document version="1" app="${escapeXml(record.appId)}" name="${escapeXml(record.name)}" format="${escapeXml(record.format)}" created="${record.createdAt}" updated="${record.updatedAt}">
<content>${escapeXml(record.content)}</content>
</document>
`;
}

function readDocument(text, id) {
  const node = parseXml(text, pathOf(id));
  if (node.name !== 'document' || node.attr('version') !== '1') return null;
  return {
    id, appId: node.need('app'), name: node.need('name'), format: node.attr('format', 'text/plain'),
    content: node.child('content')?.text ?? '', createdAt: node.num('created', 0), updatedAt: node.num('updated', 0)
  };
}

function writeRecovery(appId, value) {
  const optional = (name, data) => (data === undefined || data === null ? '' : ` ${name}="${escapeXml(data)}"`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<recovery version="1" app="${escapeXml(appId)}"${optional('document', value.documentId)}${optional('name', value.name)}${optional('format', value.format)}${optional('base-updated', value.baseUpdatedAt)} updated="${Date.now()}">
<content>${escapeXml(value.content)}</content>
${typeof value.baseContent === 'string' ? `<base>${escapeXml(value.baseContent)}</base>\n` : ''}</recovery>
`;
}

function readRecovery(text, appId) {
  const node = parseXml(text, `${RECOVERY}/${appId}.xml`);
  if (node.name !== 'recovery' || node.attr('version') !== '1' || node.attr('app') !== appId) return null;
  return {
    appId,
    documentId: node.attr('document', null),
    name: node.attr('name', ''),
    format: node.attr('format', ''),
    content: node.child('content')?.text ?? '',
    baseContent: node.child('base')?.text,
    baseUpdatedAt: node.has('base-updated') ? node.num('base-updated') : null,
    updatedAt: node.num('updated', 0)
  };
}

/**
 * The document store. `files()` resolves to the files provider to use, asked
 * again for every operation, so documents go wherever files go now.
 */
export function createDocumentStore(files) {
  const changed = new Signal(0);
  /** Parsed documents by file name, reused while a file's modified time stays the same. */
  const known = new Map();
  let pending = Promise.resolve();
  const mutate = fn => {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  };
  const notify = () => changed.update(value => value + 1);

  async function load(provider, file) {
    const cached = known.get(file.name);
    if (cached && cached.modified === file.modified) return cached.record;
    let record = null;
    try { record = readDocument(await textOf(await provider.read(file.name)), idOf(file.name)); }
    catch { /* A file that is not a document is not listed. */ }
    known.set(file.name, { modified: file.modified, record });
    return record;
  }

  async function find(provider, id) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(id ?? ''))) return null;
    const file = (await provider.list(FOLDER)).find(entry => entry.name === pathOf(id));
    return file ? load(provider, file) : null;
  }

  async function put(provider, record) {
    await provider.write(pathOf(record.id), encode(writeDocument(record)));
    known.delete(pathOf(record.id));
    notify();
    return copy(record);
  }

  return {
    changed,

    /** Every document's metadata, newest first: [{ id, appId, name, format, createdAt, updatedAt }]. */
    async list({ appId } = {}) {
      await pending;
      const provider = await files();
      const listed = (await provider.list(FOLDER)).filter(file => file.name.endsWith('.xml'));
      const records = (await Promise.all(listed.map(file => load(provider, file)))).filter(Boolean);
      return records.filter(record => !appId || record.appId === appId)
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
        .map(({ content, ...record }) => record);
    },

    async get(id) {
      await pending;
      return copy(await find(await files(), id));
    },

    save(input) {
      return mutate(async () => {
        if (!input || !/^[a-z][a-z0-9-]*$/.test(input.appId ?? '')) throw new Error('A document needs a valid app.');
        if (typeof input.content !== 'string') throw new Error('A document must be saved as text.');
        const name = validName(input.name);
        const provider = await files();
        const previous = input.id ? await find(provider, input.id) : null;
        if (input.id && !previous) throw new Error('This document no longer exists. Use Save As to keep a new copy.');
        if (previous && previous.appId !== input.appId) throw new Error('This document belongs to another app.');
        if (previous && input.expectedUpdatedAt !== undefined && previous.updatedAt !== input.expectedUpdatedAt) {
          throw new Error('This document changed in another window. Use Save As to keep your changes separately.');
        }
        const now = Date.now();
        return put(provider, {
          id: previous?.id ?? documentId(input.appId), appId: input.appId, name,
          format: String(input.format ?? previous?.format ?? 'text/plain'), content: input.content,
          createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1)
        });
      });
    },

    rename(id, name) {
      return mutate(async () => {
        const provider = await files();
        const record = await find(provider, id);
        if (!record) throw new Error('This document no longer exists.');
        return put(provider, { ...record, name: validName(name), updatedAt: Math.max(Date.now(), record.updatedAt + 1) });
      });
    },

    remove(id) {
      return mutate(async () => {
        const provider = await files();
        if (!(await find(provider, id))) return false;
        await provider.remove(pathOf(id));
        known.delete(pathOf(id));
        notify();
        return true;
      });
    },

    async readRecovery(appId) {
      await pending;
      const provider = await files();
      const name = `${RECOVERY}/${appId}.xml`;
      if (!(await provider.list(RECOVERY)).some(file => file.name === name)) return null;
      try { return readRecovery(await textOf(await provider.read(name)), appId); }
      catch { return null; }
    },

    writeRecovery(appId, value) {
      return mutate(async () => {
        if (typeof value.content !== 'string') throw new Error('A recovery draft must contain text.');
        await (await files()).write(`${RECOVERY}/${appId}.xml`, encode(writeRecovery(appId, value)));
      });
    },

    clearRecovery(appId) {
      return mutate(async () => { await (await files()).remove(`${RECOVERY}/${appId}.xml`); });
    },

    dispose() { changed.dispose(); }
  };
}
