import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { escapeXml, parseXml } from '../src/core/xml.js';
import { loadManifest, UsageError } from './project.mjs';
import { readBody, relay, relayRefusal, RELAY_PATH } from './relay.mjs';
import { FileStore, FILES_PATH, serveFiles } from './files.mjs';
import { MediaTools, MEDIA_PATH, serveMedia, serveServices } from './media.mjs';

/**
 * The development server. It serves the project as static files, answers an
 * identity probe so a second `pos serve` can find it, prints errors that the
 * browser reports, and relays the network requests of apps (see relay.mjs).
 *
 * It also gives Pea OS two services on this computer: a disk files provider
 * (files.mjs), kept in the data folder, and the media provider (media.mjs),
 * which runs the ffmpeg already installed here. Both answer only Pea OS
 * pages on this computer, as the relay does.
 */

/** Where files are kept unless --data says otherwise: $XDG_DATA_HOME/pea-os, or ~/.local/share/pea-os. */
export const defaultData = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'pea-os');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};
const PUBLIC = ['web', 'src', 'res', 'manifest.xml'];
const LOG_LIMIT = 16 * 1024;

const stateFile = root => join(tmpdir(), `pea-os-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.xml`);
const urlFor = (host, port) => `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${port}/`;

/** What the server at `url` says it is, or null when it is not a Pea OS server. */
async function identify(url) {
  try {
    const response = await fetch(new URL('__pos/identity', url), { signal: AbortSignal.timeout(800) });
    return response.ok ? parseXml(await response.text(), 'identity') : null;
  } catch {
    return null;
  }
}

/** True when `url` is a Pea OS server for this very project and data folder. */
async function isOurs(url, id, root, data) {
  const identity = await identify(url);
  return identity?.attr('app') === id && identity.attr('root') === root && identity.attr('data') === data;
}

export function handler(manifest, root, stderr, data = defaultData(), media = new MediaTools(new FileStore(join(data, 'files')))) {
  const send = (response, status, type, body) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  };
  const store = media.store;

  return async (request, response) => {
    let path, query;
    try {
      const url = new URL(request.url, 'http://local');
      path = decodeURIComponent(url.pathname);
      query = url.searchParams;
    } catch {
      return send(response, 400, 'text/plain', 'Bad request\n');
    }

    if (path === '/__pos/identity') {
      const identity = `<pea-os app="${escapeXml(manifest.id)}" release="${escapeXml(manifest.release)}" root="${escapeXml(root)}" data="${escapeXml(data)}" pid="${process.pid}"/>\n`;
      return send(response, 200, TYPES['.xml'], identity);
    }
    const service = path === '/__pos/services' || path === FILES_PATH || path.startsWith(`${FILES_PATH}/`) || path.startsWith(`${MEDIA_PATH}/`);
    if (service) {
      // The user's files and programs answer Pea OS pages on this computer only.
      const refusal = relayRefusal(request);
      if (refusal) return send(response, 403, 'text/plain; charset=utf-8', `${refusal}\n`);
      try {
        if (path === '/__pos/services') return await serveServices(media, response, send);
        if (path.startsWith(MEDIA_PATH)) return await serveMedia(media, request, response, path, query, send, readBody);
        return await serveFiles(store, request, response, path, query, send);
      } catch (error) {
        stderr.write(`pos serve: ${error.message}\n`);
        if (!response.headersSent) return send(response, 500, 'text/plain; charset=utf-8', 'The server could not do that. Its terminal says why.\n');
        return response.end();
      }
    }
    if (path === '/__pos/log' && request.method === 'POST') {
      // Only Pea OS pages on this computer may write to the terminal, and never control sequences.
      if (relayRefusal(request)) return send(response, 403, 'text/plain', 'Forbidden\n');
      const text = await readBody(request, LOG_LIMIT) ?? '(a report too long to print)';
      stderr.write(`browser: ${text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trimEnd()}\n`);
      return send(response, 204, 'text/plain', '');
    }
    if (path === RELAY_PATH) return relay(request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'text/plain', 'Method not allowed\n');
    if (path === '/') {
      response.writeHead(302, { Location: '/web/index.html' });
      return response.end();
    }

    const parts = path.split('/').filter(Boolean);
    const file = resolve(root, ...parts);
    const allowed = PUBLIC.includes(parts[0]) && !parts.some(part => part.startsWith('.')) && file.startsWith(root + sep);
    const info = allowed ? await stat(file).catch(() => null) : null;
    if (!info?.isFile()) return send(response, 404, 'text/plain', `Not found: ${path}\n`);

    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(file).pipe(response);
  };
}

const listen = (server, port, host) => new Promise((done, fail) => {
  server.once('error', fail);
  server.listen(port, host, () => {
    server.off('error', fail);
    done(server.address().port);
  });
});

/**
 * Starts the server, or finds the one already running for this project.
 * Resolves to { url, reused, close(), closed }.
 */
export async function serve({ root, port, host, stderr, data = defaultData() }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a whole number from 0 to 65535, got "${port}"`);
  const manifest = await loadManifest(root);
  data = resolve(data);
  const state = stateFile(root);

  const known = await readFile(state, 'utf8').then(text => {
    const node = parseXml(text, state);
    return { url: node.attr('url'), host: node.attr('host', '127.0.0.1') };
  }, () => null);
  // The running server is the answer only if it is the one asked for: the same host, and the same port unless any will do.
  const matches = known?.url && known.host === host && (port === 0 || Number(new URL(known.url).port) === port);
  if (matches && await isOurs(known.url, manifest.id, root, data)) return { url: known.url, reused: true };

  const server = createServer(handler(manifest, root, stderr, data));
  let actual;
  try {
    actual = await listen(server, port, host);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      if (['EACCES', 'EADDRNOTAVAIL', 'ENOTFOUND'].includes(error.code)) {
        throw new UsageError(`Cannot listen on ${host}:${port} (${error.code}). Try another --host or --port.`);
      }
      throw error;
    }
    const occupied = urlFor(host, port);
    const identity = await identify(occupied);
    if (identity?.attr('app') === manifest.id && identity.attr('root') === root && identity.attr('data') === data) return { url: occupied, reused: true };
    if (identity?.attr('app') === manifest.id && identity.attr('root') === root) {
      throw new UsageError(`Port ${port} has a Pea OS server for this project from before, ${identity.has('data') ? `keeping files in ${identity.attr('data')}` : 'without disk files or video tools'} (process ${identity.attr('pid', '?')}). Stop it, then run pos serve again.`);
    }
    throw new UsageError(`Port ${port} is in use by another program. Pea keeps this address stable because documents belong to the browser origin. Stop the other program, or deliberately choose --port PORT (a different document workspace).`);
  }

  const url = urlFor(host, actual);
  await writeFile(state, `<server url="${escapeXml(url)}" host="${escapeXml(host)}" pid="${process.pid}"/>\n`);

  let finish;
  const closed = new Promise(done => { finish = done; });
  const close = async () => {
    await rm(state, { force: true });
    server.close(finish);
    server.closeAllConnections();
    await closed;
  };
  return { url, reused: false, close, closed };
}
