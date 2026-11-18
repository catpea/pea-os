/**
 * Internet providers that need nothing but fetch: a browser asking a site
 * directly, and a native app, which no browser rule stops. The relay through
 * pos serve, which reaches any site from a page, is in served.js.
 */

/** Reads a response body as text, handing each decoded piece to onText as it arrives. */
export async function readBody(response, onText) {
  if (!response.body?.getReader) {
    const text = await response.text();
    onText?.(text);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    const piece = decoder.decode(value, { stream: !done });
    if (piece) { text += piece; onText?.(piece); }
    if (done) return text;
  }
}

/** What a network provider's request() answers. */
export async function answer(response, onText) {
  const text = await readBody(response, onText);
  return { status: response.status, ok: response.ok, type: response.headers.get('Content-Type') ?? '', text };
}

/**
 * The page asks the site itself. A browser lets a page read only sites that
 * allow it (CORS), which most feeds and model servers do not, so this is the
 * fallback where there is no relay, and its failures say so.
 */
export function directNetwork(fetch) {
  return {
    service: 'network',
    id: 'direct',
    title: 'Direct from this page',
    kind: 'browser',
    about: 'The page asks each site itself. Browsers allow that only for sites that let other pages read them, which many feeds and servers do not.',
    async status() {
      if (!fetch) return { ok: false, reason: 'Not available: this browser cannot make requests.' };
      return { ok: true, reason: 'Reaches only sites that let other pages read them. Open Pea OS from pos serve to reach any site.' };
    },
    async request({ url, method = 'GET', headers = {}, body, signal, onText }) {
      let response;
      try { response = await fetch(url, { method, headers, body, signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`${new URL(url).host} could not be reached from this page: it may be offline, or it may not let other pages read it. Opened from pos serve, Pea OS can reach any site.`);
      }
      return answer(response, onText);
    }
  };
}

/** A native app asks sites directly; no browser rule applies. Bodies arrive whole. */
export function nativeNetwork(fetch) {
  return {
    service: 'network',
    id: 'native-http',
    title: 'Phone network',
    kind: 'device',
    about: "The phone's own network connection. A native app is not bound by browser rules, so it reaches any site.",
    async status() { return { ok: true, reason: "Reaches any site through the phone's connection." }; },
    async request({ url, method = 'GET', headers = {}, body, signal, onText }) {
      const response = await fetch(url, { method, headers, body, signal });
      const text = await response.text();
      onText?.(text);
      return { status: response.status, ok: response.ok, type: response.headers.get('Content-Type') ?? '', text };
    }
  };
}
