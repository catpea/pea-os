/**
 * Files: the names Pea keeps files under, and the two files providers that
 * are always built in. Platforms add better ones (src/platform/files.js,
 * served.js, nativescript-media.js); see src/os/providers.js for the service.
 */

const NAME_PART = /^[^/\\\u0000-\u001f<>:"|?*]{1,120}$/;

/** A checked file name, "folder/name.ext" or "name.ext". Throws when a name could escape its store. */
export function fileName(value) {
  const name = String(value ?? '').trim();
  const parts = name.split('/');
  if (!name || parts.length > 2 || parts.some(part => !NAME_PART.test(part) || part.startsWith('.') || part.trim() !== part)) {
    throw new Error(`"${name}" is not a file name Pea can keep. Use letters, digits and spaces, and at most one folder.`);
  }
  return name;
}

/** The folder part of a file name, or "". */
export const folderOf = name => (name.includes('/') ? name.slice(0, name.indexOf('/')) : '');

export const MEDIA_TYPES = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', ogv: 'video/ogg',
  xspf: 'application/xspf+xml', xml: 'application/xml', txt: 'text/plain'
};

/** The media type a file name suggests. */
export function typeOf(name) {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/** A file's bytes, whether a provider handed back a Blob or bytes. */
export const bytesOf = async data => (data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()));

/** A file's text, read as UTF-8. */
export const textOf = async data => new TextDecoder().decode(await bytesOf(data));

const missing = name => new Error(`There is no file "${name}".`);

/** The parts every files provider shares once it can find a file's bytes by name. */
function filesOver({ entries, get, put, drop }) {
  return {
    async list(folder = '') {
      return (await entries()).filter(file => !folder || file.name.startsWith(`${folder}/`))
        .map(({ name, size, type, modified }) => ({ name, size, type, modified }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(name) {
      const bytes = await get(fileName(name));
      if (!bytes) throw missing(name);
      return bytes;
    },
    async write(name, data) {
      name = fileName(name);
      const bytes = await bytesOf(data);
      await put(name, bytes, { name, size: bytes.length, type: typeOf(name), modified: Date.now() });
      return { name, size: bytes.length };
    },
    async remove(name) {
      await drop(fileName(name));
    },
    async source(name) {
      const bytes = await get(fileName(name));
      if (!bytes) throw missing(name);
      // Where the runtime can make a playable address from bytes, it does; a player may also read `data`.
      const url = globalThis.Blob && globalThis.URL?.createObjectURL ? URL.createObjectURL(new Blob([bytes], { type: typeOf(name) })) : `memory:${name}`;
      return { url, data: bytes, release: () => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); } };
    }
  };
}

/** Files kept in memory until Pea OS closes: always there, so a files provider always exists. */
export function memoryFiles() {
  const files = new Map(); // name -> { info, bytes }
  return {
    id: 'memory',
    title: 'Memory',
    kind: 'local',
    about: 'Keeps files only until Pea OS closes. Always here, so nothing is ever without a place for files.',
    async status() { return { ok: true, reason: 'Built in. Files last until Pea OS closes.' }; },
    ...filesOver({
      entries: async () => [...files.values()].map(file => file.info),
      get: async name => files.get(name)?.bytes ?? null,
      put: async (name, bytes, info) => { files.set(name, { info, bytes }); },
      drop: async name => { files.delete(name); }
    })
  };
}

const STORAGE_INDEX = 'pea-os.files.v1';
const STORAGE_LIMIT = 2 * 1024 * 1024;

/** Bytes as base64 text and back, in pieces small enough for String.fromCharCode. */
const toBase64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

/**
 * Small files kept with Pea OS's preferences (platform.storage: localStorage
 * in a browser): what remains where no better place for files exists, such
 * as a browser that blocks IndexedDB. Up to 2 MB in all.
 */
export function storageFiles(storage) {
  const index = () => {
    const saved = JSON.parse(storage.get(STORAGE_INDEX) ?? 'null');
    return saved?.version === 1 && saved.files && typeof saved.files === 'object' ? saved.files : {};
  };
  const keep = files => storage.set(STORAGE_INDEX, JSON.stringify({ version: 1, files }));
  const key = name => `pea-os.file:${name}`;
  const used = files => Object.values(files).reduce((sum, file) => sum + file.size, 0);
  return {
    id: 'storage-files',
    title: 'Preferences storage',
    kind: 'local',
    about: "Keeps small files with Pea OS's own preferences. The last place before memory, for where nothing better is offered.",
    async status() {
      if (!storage?.get || !storage?.set) return { ok: false, reason: 'Not available here: this platform keeps no preferences.' };
      const kb = Math.ceil(used(index()) / 1024);
      return { ok: true, reason: `Small files are kept with Pea OS's preferences: ${kb} KB of ${STORAGE_LIMIT / 1024 / 1024} MB used.` };
    },
    ...filesOver({
      entries: async () => Object.values(index()),
      get: async name => {
        const text = index()[name] ? storage.get(key(name)) : null;
        return text === null ? null : fromBase64(text);
      },
      put: async (name, bytes, info) => {
        const files = index();
        if (used(files) - (files[name]?.size ?? 0) + bytes.length > STORAGE_LIMIT) {
          throw new Error(`${name} does not fit in preferences storage, which keeps at most ${STORAGE_LIMIT / 1024 / 1024} MB.`);
        }
        try { storage.set(key(name), toBase64(bytes)); }
        catch (error) { throw new Error(`${name} could not be kept: the browser refused (${error.message}).`); }
        keep({ ...files, [name]: info });
      },
      drop: async name => {
        const { [name]: gone, ...files } = index();
        if (!gone) return;
        keep(files);
        if (storage.remove) storage.remove(key(name));
        else storage.set(key(name), '');
      }
    })
  };
}
