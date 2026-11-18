/** Codec Bench: the small conversions a developer reaches for, each one way, nothing sent anywhere. */

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

function base64Encode(text) {
  let binary = '';
  for (const byte of utf8.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(text) {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('That is not Base64: only letters, digits, + / (or - _) and = padding.');
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
  try { return fromUtf8.decode(bytes); } catch { throw new Error('The decoded bytes are not UTF-8 text.'); }
}

function hexDecode(text) {
  const clean = text.replace(/0x/gi, '').replace(/[\s:,-]/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new Error('Hex needs pairs of 0-9 and a-f.');
  const bytes = Uint8Array.from(clean.match(/../g) ?? [], pair => parseInt(pair, 16));
  try { return fromUtf8.decode(bytes); } catch { throw new Error('The decoded bytes are not UTF-8 text.'); }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlUnescape(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

async function digest(algorithm, text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Hashing needs a secure page (https or localhost).');
  const hash = new Uint8Array(await subtle.digest(algorithm, utf8.encode(text)));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A JSON Web Token's header and claims, with dates spelled out. The signature is not checked. */
function readJwt(text) {
  const parts = text.trim().split('.');
  if (parts.length !== 3) throw new Error('A JWT has three parts separated by dots.');
  const part = (index, name) => {
    try { return JSON.parse(base64Decode(parts[index])); } catch { throw new Error(`The ${name} is not Base64url JSON.`); }
  };
  const header = part(0, 'header');
  const claims = part(1, 'claims');
  const when = {};
  for (const key of ['iat', 'nbf', 'exp']) if (Number.isFinite(claims[key])) when[key] = new Date(claims[key] * 1000).toISOString();
  const expired = Number.isFinite(claims.exp) && claims.exp * 1000 < Date.now() ? '\n\nThis token has expired.' : '';
  return `${JSON.stringify({ header, claims, dates: when }, null, 2)}\n\nThe signature is not checked here.${expired}`;
}

/** Unix seconds or milliseconds to ISO time, or a date to Unix seconds. Empty input means now. */
function convertTime(text) {
  const value = text.trim();
  if (!value) {
    const now = new Date();
    return `${Math.floor(now.getTime() / 1000)}\n${now.toISOString()}`;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    const ms = Math.abs(number) >= 1e11 ? number : number * 1000; // 13 digits are milliseconds
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) throw new Error('That number is outside the range of dates.');
    return `${date.toISOString()}\n${date.toString()}\n(read as ${ms === number ? 'milliseconds' : 'seconds'})`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Give a Unix time (seconds or milliseconds) or a date such as 2026-11-14T12:00:00Z.');
  return `${Math.floor(date.getTime() / 1000)}\n${date.getTime()} ms`;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every operation: name -> async (text) -> text. */
export const OPERATIONS = {
  'base64-encode': base64Encode,
  'base64-decode': base64Decode,
  'url-encode': text => encodeURIComponent(text),
  'url-decode': text => {
    try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { throw new Error('A % in the text is not followed by a valid escape.'); }
  },
  'hex-encode': text => [...utf8.encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
  'hex-decode': hexDecode,
  'html-escape': text => text.replace(/[&<>"']/g, ch => ESCAPES[ch]),
  'html-unescape': htmlUnescape,
  'sha-256': text => digest('SHA-256', text),
  'sha-1': text => digest('SHA-1', text),
  jwt: readJwt,
  time: convertTime,
  uuid: () => uuid()
};

export async function transform(operation, text) {
  const run = OPERATIONS[operation];
  if (!run) throw new Error(`Unknown operation "${operation}".`);
  return run(text);
}

export default function (app) {
  let turn = 0;
  const run = async () => {
    const mine = ++turn;
    const operation = app.scope.get('operation');
    try {
      const output = await transform(operation, app.scope.get('input'));
      if (mine !== turn || app.scope.disposed) return; // a newer input already answered, or the app is gone
      app.scope.set('output', output);
      app.scope.set('status', `${output.length} characters out.`);
    } catch (error) {
      if (mine !== turn || app.scope.disposed) return;
      app.scope.set('output', '');
      app.scope.set('status', error.message);
    }
  };
  const later = app.debounce(120, run);
  app.scope.subscribe(app.signal('input'), later, { immediate: false });
  app.scope.subscribe(app.signal('operation'), run, { immediate: false });
  run();

  app.command('use-output', () => {
    later.flush();
    const output = app.scope.get('output');
    if (output) app.scope.set('input', output);
  });
}
