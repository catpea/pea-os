import { parseXml } from '../core/xml.js';
import { fileName } from '../os/files.js';
import { answer } from './network.js';

/**
 * Providers for a page served by pos serve (cli/serve.mjs is the other
 * half): the Pea server itself, files on this computer's disk, the ffmpeg
 * installed on it, and a relay that reaches any site for the page. They
 * speak plain HTTP to the server that served the page, so they work in any
 * browser and, for tests, in Node.
 *
 * The last three require the server service, so on a static web host,
 * where nobody answers /__pos/services, they all step aside with one reason,
 * and Pea OS keeps files in the browser, asks sites directly, and has no
 * video editor.
 */

const path = name => fileName(name).split('/').map(encodeURIComponent).join('/');

async function problem(response) {
  const text = (await response.text().catch(() => '')).trim();
  return new Error(text || `The server answered HTTP ${response.status}.`);
}

/** What the server gives, looked up once and again after a failure: the <services> element, { refused }, or null. */
function services(base) {
  let known = null;
  return () => {
    known ??= fetch(new URL('__pos/services', base)).then(async response => {
      if (response.status === 403) return { refused: (await response.text()).trim() };
      if (!response.ok || !/xml/.test(response.headers.get('Content-Type') ?? '')) return null;
      return parseXml(await response.text(), 'services');
    }).catch(() => null);
    known.then(value => { if (!value || value.refused) known = null; });
    return known;
  };
}

export function servedProviders(base) {
  const look = services(base);
  const origin = new URL(base).origin;

  const server = {
    service: 'server',
    id: 'pos-serve',
    title: 'pos serve',
    kind: 'server',
    about: 'The Pea OS server on this computer. Through it, Pea keeps files on disk, uses ffmpeg, and reaches any site.',
    async status() {
      const found = await look();
      if (found?.refused) return { ok: false, reason: `Refused: ${found.refused}` };
      if (!found) return { ok: false, reason: 'Not available here: this page was not opened from pos serve.' };
      return { ok: true, reason: `Pea OS was opened from pos serve at ${origin}.` };
    },
    async describe() {
      const found = await look();
      if (!found || found.refused) throw new Error('pos serve is not answering.');
      return found;
    }
  };

  const files = {
    service: 'files',
    id: 'disk',
    title: 'Disk (pos serve)',
    kind: 'server',
    about: 'Keeps files in a folder on this computer, through pos serve: documents, music, videos and renders, as ordinary files you can find and back up.',
    requires: ['server'],
    async status() {
      const root = (await look())?.child?.('files')?.attr('root');
      if (!root) return { ok: false, reason: 'Not offered: this pos serve keeps no files on disk.' };
      return { ok: true, reason: `Files are kept in ${root}.` };
    },
    async list(folder = '') {
      const response = await fetch(new URL(`__pos/files${folder ? `?folder=${encodeURIComponent(fileName(folder))}` : ''}`, base));
      if (!response.ok) throw await problem(response);
      return parseXml(await response.text(), 'files').all('file').map(file => ({
        name: file.need('name'), size: file.num('size', 0), type: file.attr('type', ''), modified: file.num('modified', 0)
      }));
    },
    async read(name) {
      const response = await fetch(new URL(`__pos/files/${path(name)}`, base));
      if (!response.ok) throw await problem(response);
      return response.blob();
    },
    async write(name, data, { signal } = {}) {
      const response = await fetch(new URL(`__pos/files/${path(name)}`, base), { method: 'PUT', body: data, signal });
      if (!response.ok) throw await problem(response);
      const file = parseXml(await response.text(), 'file');
      return { name: file.need('name'), size: file.num('size', 0) };
    },
    async remove(name) {
      const response = await fetch(new URL(`__pos/files/${path(name)}`, base), { method: 'DELETE' });
      if (!response.ok) throw await problem(response);
    },
    // The server answers ranges, so a player can seek without loading the whole file.
    async source(name) {
      return { url: new URL(`__pos/files/${path(name)}`, base).href, release() {} };
    }
  };

  const ask = async (verb, params) => {
    const response = await fetch(new URL(`__pos/media/${verb}?${new URLSearchParams(params)}`, base));
    if (!response.ok) throw await problem(response);
    return response;
  };
  const media = {
    service: 'media',
    id: 'ffmpeg-server',
    title: 'ffmpeg (pos serve)',
    kind: 'server',
    about: 'Probes, previews and renders video with the ffmpeg already installed on this computer. Shotcut works the same way: a front end to ffmpeg.',
    requires: ['server'],
    files,
    async status() {
      const tools = (await look())?.child?.('media');
      if (!tools) return { ok: false, reason: 'Not offered: this pos serve has no video tools.' };
      if (tools.has('missing')) return { ok: false, reason: `Not installed: ${tools.attr('missing')}` };
      return { ok: true, reason: `ffmpeg ${tools.attr('ffmpeg')} renders ${tools.attr('format').toUpperCase()} with ${tools.attr('video')}.` };
    },
    async probe(name) {
      const node = parseXml(await (await ask('probe', { name: fileName(name) })).text(), 'probe');
      const video = node.child('video');
      const audio = node.child('audio');
      return {
        duration: node.num('duration', 0),
        video: video ? { width: video.num('width', 0), height: video.num('height', 0), fps: video.num('fps', 0) } : null,
        audio: audio ? { rate: audio.num('rate', 0), channels: audio.num('channels', 0) } : null
      };
    },
    async frame(name, seconds, width) {
      const response = await ask('frame', { name: fileName(name), t: String(seconds), w: String(width) });
      return { width: Number(response.headers.get('X-Pea-Width')), height: Number(response.headers.get('X-Pea-Height')), data: new Uint8Array(await response.arrayBuffer()) };
    },
    async peaks(name, count) {
      return new Uint8Array(await (await ask('peaks', { name: fileName(name), n: String(count) })).arrayBuffer());
    },
    /** Renders a <videoproject>; onProgress(0..1) follows ffmpeg; aborting `signal` stops it. */
    async render(project, { onProgress, signal } = {}) {
      const response = await fetch(new URL('__pos/media/render', base), { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: project, signal });
      if (!response.ok) throw await problem(response);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = done ? '' : lines.pop();
        for (const line of lines) {
          const [word, ...rest] = line.split(' ');
          const text = rest.join(' ');
          if (word === 'progress') onProgress?.(Number(text));
          else if (word === 'done') return { name: text };
          else if (word === 'error') throw new Error(text);
        }
        if (done) throw new Error('The render stopped without saying why.');
      }
    }
  };

  // Most sites do not let a page read them; pos serve asks on the page's behalf.
  const relay = {
    service: 'network',
    id: 'relay',
    title: 'Relay (pos serve)',
    kind: 'server',
    about: 'pos serve fetches each site for the page, so feeds and model servers that do not let pages read them still work.',
    requires: ['server'],
    async status() {
      if (!(await look())?.child?.('relay')) return { ok: false, reason: 'Not offered: this pos serve has no relay.' };
      return { ok: true, reason: 'Reaches any site, through pos serve on this computer.' };
    },
    async request({ url, method = 'GET', headers = {}, body, signal, onText }) {
      const response = await fetch(new URL('__pos/relay', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, method, headers, body }), signal
      });
      if (response.headers.get('X-Pea-Relay') !== 'ok') throw await problem(response);
      return answer(response, onText);
    }
  };

  return [server, files, media, relay];
}
