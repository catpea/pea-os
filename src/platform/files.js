import { fileName, typeOf } from '../os/files.js';

/**
 * The browser-files provider: files kept in IndexedDB for this site. The
 * browser keeps a Blob on disk and hands back a reference, so listing files
 * does not read them, and a player gets an object URL it releases.
 */
export function browserFiles(indexedDB) {
  let opening = null;

  function open() {
    if (!indexedDB) return Promise.reject(new Error('This browser keeps no files (IndexedDB is missing or blocked).'));
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('pea-os-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'name' });
      request.onerror = () => reject(request.error ?? new Error('Browser storage could not be opened.'));
      request.onblocked = () => reject(new Error('Another Pea tab is keeping browser storage open. Close it, then try again.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    opening.catch(() => { opening = null; });
    return opening;
  }

  async function run(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', mode);
      const request = work(transaction.objectStore('files'));
      let result = null;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage refused the change; it may be full.'));
    });
  }

  const record = async name => {
    const found = await run('readonly', store => store.get(fileName(name)));
    if (!found) throw new Error(`There is no file "${name}".`);
    return found;
  };

  return {
    service: 'files',
    id: 'browser-files',
    title: 'Browser storage',
    kind: 'browser',
    about: 'Keeps files inside this browser, for this site only. They stay until the browser\'s site data is cleared.',
    async status() {
      try {
        await open();
        return { ok: true, reason: 'Files are kept in this browser for this site.' };
      } catch (error) {
        return { ok: false, reason: `Not available: ${error.message}` };
      }
    },
    async list(folder = '') {
      const all = await run('readonly', store => store.getAll());
      return all.filter(file => !folder || file.name.startsWith(`${folder}/`))
        .map(({ name, size, type, modified }) => ({ name, size, type, modified }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(name) {
      return (await record(name)).blob;
    },
    async write(name, data) {
      name = fileName(name);
      const blob = data instanceof Blob ? data : new Blob([data], { type: typeOf(name) });
      await run('readwrite', store => store.put({ name, type: blob.type || typeOf(name), size: blob.size, modified: Date.now(), blob }));
      return { name, size: blob.size };
    },
    async remove(name) {
      await run('readwrite', store => store.delete(fileName(name)));
    },
    async source(name) {
      const url = URL.createObjectURL((await record(name)).blob);
      return { url, release: () => URL.revokeObjectURL(url) };
    }
  };
}
