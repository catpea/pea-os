import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { escapeXml } from '../src/core/xml.js';
import { fileName, typeOf } from '../src/os/files.js';

/**
 * The disk files provider's server half: a folder of ordinary files, at most
 * one folder deep, reached by Pea OS pages on this computer through pos serve.
 *
 *   GET    /__pos/files?folder=music    <files><file name size type modified/></files>
 *   GET    /__pos/files/music/a.mp3     the bytes; one Range is honoured, so players can seek
 *   PUT    /__pos/files/music/a.mp3     writes the body, all or nothing
 *   DELETE /__pos/files/music/a.mp3
 *
 * Names are checked by fileName() on both sides, so no name leaves the folder.
 * A file being written is a hidden ".part" file until it is complete.
 */

export const FILES_PATH = '/__pos/files';
export const UPLOAD_LIMIT = 8 * 1024 ** 3;

let parts = 0;

export class FileStore {
  constructor(root) {
    this.root = root;
  }

  path(name) {
    return join(this.root, ...fileName(name).split('/'));
  }

  async #entries(folder) {
    const where = folder ? join(this.root, fileName(folder)) : this.root;
    const names = await readdir(where, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names.filter(entry => !entry.name.startsWith('.'));
  }

  /** [{ name, size, type, modified }], in one folder, or everywhere when folder is "". */
  async list(folder = '') {
    const found = [];
    const add = async (prefix, entries) => {
      for (const entry of entries) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        try { fileName(name); } catch { continue; }
        if (entry.isDirectory() && !prefix) await add(name, await this.#entries(name));
        else if (entry.isFile()) {
          const info = await stat(this.path(name)).catch(() => null);
          if (info) found.push({ name, size: info.size, type: typeOf(name), modified: Math.round(info.mtimeMs) });
        }
      }
    };
    if (folder) await add(fileName(folder), await this.#entries(folder));
    else await add('', await this.#entries(''));
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async info(name) {
    const info = await stat(this.path(name)).catch(() => null);
    return info?.isFile() ? { name, size: info.size, type: typeOf(name), modified: Math.round(info.mtimeMs) } : null;
  }

  /** A name like `name` that no file has yet: "clip.mp4", then "clip-2.mp4", ... */
  async unique(name) {
    const at = name.lastIndexOf('.');
    const [stem, extension] = at > name.lastIndexOf('/') ? [name.slice(0, at), name.slice(at)] : [name, ''];
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${extension}`;
      if (!await this.info(candidate)) return candidate;
    }
  }

  /** A hidden path beside `name` for writing it before it is complete. */
  async scratch(name) {
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true });
    return join(dirname(path), `.${process.pid}-${++parts}.part`);
  }

  /** Writes a stream to `name`, all or nothing. Rejects past `limit` bytes. */
  async write(name, stream, limit = UPLOAD_LIMIT) {
    const path = this.path(name);
    const part = await this.scratch(name);
    let size = 0;
    try {
      await pipeline(stream, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > limit) throw Object.assign(new Error(`Files larger than ${Math.round(limit / 1024 ** 3)} GB cannot be kept here.`), { status: 413 });
          yield chunk;
        }
      }, createWriteStream(part));
      await rename(part, path);
      return { name, size };
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }

  async remove(name) {
    await rm(this.path(name), { force: true });
  }
}

export const filesXml = files => `<files>\n${files.map(file => `  <file name="${escapeXml(file.name)}" size="${file.size}" type="${escapeXml(file.type)}" modified="${file.modified}"/>\n`).join('')}</files>\n`;

/** "bytes=a-b" against a size: { start, end } (inclusive), null for no range, or false when it cannot be met. */
export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  }
  return start <= end && start < size ? { start, end } : false;
}

/** Answers one /__pos/files request. */
export async function serveFiles(store, request, response, path, query, send) {
  const name = path.slice(FILES_PATH.length + 1);
  if (!name) {
    if (request.method !== 'GET') return send(response, 405, 'text/plain', 'Method not allowed\n');
    return send(response, 200, 'application/xml; charset=utf-8', filesXml(await store.list(query.get('folder') ?? '')));
  }
  try { fileName(name); } catch (error) { return send(response, 400, 'text/plain; charset=utf-8', `${error.message}\n`); }

  if (request.method === 'PUT') {
    const length = Number(request.headers['content-length']);
    if (length > UPLOAD_LIMIT) return send(response, 413, 'text/plain', 'This file is too large to keep here.\n');
    try {
      const { size } = await store.write(name, request);
      return send(response, 201, 'application/xml; charset=utf-8', `<file name="${escapeXml(name)}" size="${size}"/>\n`);
    } catch (error) {
      if (error.status) return send(response, error.status, 'text/plain; charset=utf-8', `${error.message}\n`);
      throw error;
    }
  }
  if (request.method === 'DELETE') {
    await store.remove(name);
    return send(response, 204, 'text/plain', '');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'text/plain', 'Method not allowed\n');

  const info = await store.info(name);
  if (!info) return send(response, 404, 'text/plain; charset=utf-8', `There is no file "${name}".\n`);
  const range = byteRange(request.headers.range, info.size);
  if (range === false) {
    response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' });
    return response.end();
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  response.writeHead(range ? 206 : 200, {
    'Content-Type': info.type,
    'Content-Length': info.size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {})
  });
  if (request.method === 'HEAD' || !info.size) return response.end();
  await pipeline(createReadStream(store.path(name), { start, end }), response).catch(() => {}); // the listener may leave early, as players do
}
