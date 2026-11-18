/**
 * The network relay of the development server. A browser page may not read
 * most web feeds or local model servers directly (they send no CORS
 * headers), so Pea OS asks its own server to make the request instead.
 *
 * The relay is deliberately narrow: it answers only this machine, only
 * same-origin pages served from a loopback name, only http and https, with a
 * size limit and a timeout. It never logs URLs, headers or bodies, because
 * those may carry API keys.
 *
 *   POST /__pos/relay   { "url": "...", "method": "GET", "headers": {}, "body": "..." }
 *
 * The response carries the upstream status, its Content-Type and its body as
 * it arrives (so streamed replies stream). `X-Pea-Relay: ok` marks an
 * upstream answer; a refusal or failure of the relay itself has
 * `X-Pea-Relay: error` and a plain-text reason.
 */

export const RELAY_PATH = '/__pos/relay';

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const TIMEOUT = 120_000;
const METHODS = ['GET', 'POST'];
const DROPPED = new Set(['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'origin', 'referer', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopback = address => Boolean(address) && (address === '::1' || /^(::ffff:)?127\./.test(address));

function refuse(response, status, reason) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Pea-Relay': 'error' });
  response.end(`${reason}\n`);
}

/** Why this request may not use the relay, or null when it may. */
export function relayRefusal(request) {
  if (!isLoopback(request.socket.remoteAddress)) return 'The network relay answers only this computer.';
  let host;
  try { host = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch { return 'Bad Host header.'; }
  // A page reached through any other name could be a rebinding attack on this port.
  if (!LOOPBACK_NAMES.has(host)) return 'Open Pea OS through 127.0.0.1 or localhost to use the network.';
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return 'The network relay serves Pea OS pages only.';
  const origin = request.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== request.headers.host) return 'The network relay serves Pea OS pages only.'; }
    catch { return 'Bad Origin header.'; }
  }
  return null;
}

/**
 * A request body as text, or null once it passes `limit` bytes. Chunks are
 * joined before decoding, so a character split between two of them survives.
 */
export async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Validates a relay order: { url, method, headers, body }. Throws a readable Error. */
export function readOrder(text) {
  let order;
  try { order = JSON.parse(text); } catch { throw new Error('The relay request is not JSON.'); }
  if (!order || typeof order !== 'object') throw new Error('The relay request must be an object.');
  let url;
  try { url = new URL(String(order.url ?? '')); } catch { throw new Error('The address is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be fetched.');
  if (url.username || url.password) throw new Error('Put credentials in a header, not in the address.');
  const method = String(order.method ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`Method ${method} is not relayed. Use ${METHODS.join(' or ')}.`);
  const headers = {};
  for (const [name, value] of Object.entries(order.headers ?? {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`Header "${name}" is not valid.`);
    if (!DROPPED.has(key)) headers[key] = value;
  }
  if (order.body !== undefined && order.body !== null && typeof order.body !== 'string') throw new Error('The request body must be text.');
  if (method === 'GET' && order.body) throw new Error('A GET request has no body.');
  return { url: url.href, method, headers, body: order.body ?? undefined };
}

export async function relay(request, response) {
  if (request.method !== 'POST') return refuse(response, 405, 'Use POST.');
  const refusal = relayRefusal(request);
  if (refusal) return refuse(response, 403, refusal);

  const text = await readBody(request, REQUEST_LIMIT);
  if (text === null) return refuse(response, 413, 'The request is too large.');
  let order;
  try { order = readOrder(text); } catch (error) { return refuse(response, 400, error.message); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timed out')), TIMEOUT);
  // A page that stops listening (Stop in a chat, a closed tab) stops the upstream request too.
  const abandon = () => { if (!response.writableFinished) controller.abort(new Error('the page went away')); };
  response.on('close', abandon);
  try {
    let upstream;
    try {
      upstream = await fetch(order.url, { method: order.method, headers: order.headers, body: order.body, redirect: 'follow', signal: controller.signal });
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'unknown error';
      return refuse(response, 502, `Could not reach ${new URL(order.url).host}: ${cause}`);
    }
    const declared = Number(upstream.headers.get('content-length'));
    if (declared > RESPONSE_LIMIT) {
      await upstream.body?.cancel();
      return refuse(response, 502, 'The answer is larger than 16 MB.');
    }
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Pea-Relay': 'ok'
    });
    if (typeof response.flushHeaders === 'function') response.flushHeaders();
    let size = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        size += chunk.length;
        // Ending normally here would pass a cut-off answer as a whole one; breaking the connection says it failed.
        if (size > RESPONSE_LIMIT) { controller.abort(); response.destroy(); return; }
        response.write(chunk);
      }
    }
    response.end();
  } catch (error) {
    if (!response.headersSent) refuse(response, 502, `The request failed: ${error?.message ?? error}`);
    else response.destroy();
  } finally {
    clearTimeout(timer);
    response.off('close', abandon);
  }
}
