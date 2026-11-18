/**
 * A small, strict XML reader shared by every Pea OS language: manifests,
 * themes, fonts, sprite sheets, the desktop and app views.
 *
 * It needs no DOM, so the same parser runs in browsers, NativeScript and Node.
 * Supported: elements, attributes, text, comments, CDATA, the five named
 * entities and numeric character references. Doctypes are refused.
 *
 * Pea's own languages are read strictly. Documents from elsewhere, such as
 * web feeds, may be read with { foreign: true }: a doctype is skipped and an
 * entity this reader does not know is kept as written instead of failing.
 */

const NAME = /[A-Za-z_][\w.:-]*/y;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export class XmlError extends Error {
  constructor(message, source, line, column) {
    super(`${source}:${line}${column ? `:${column}` : ''}: ${message}`);
    this.name = 'XmlError';
    this.source = source;
    this.line = line;
    this.column = column;
  }
}

export class XmlNode {
  attrs = {};
  children = [];
  /** All of the node's own text, in order, without its children's. */
  text = '';
  /** The text that follows this node inside its parent, before the next sibling: what mixed content needs to keep its order. */
  tail = '';
  parent = null;

  constructor(name, source, line) {
    this.name = name;
    this.source = source;
    this.line = line;
  }

  fail(message) {
    throw new XmlError(`<${this.name}> ${message}`, this.source, this.line);
  }

  has(name) {
    return Object.hasOwn(this.attrs, name);
  }

  attr(name, fallback) {
    return this.has(name) ? this.attrs[name] : fallback;
  }

  /** A required attribute. */
  need(name) {
    if (!this.has(name)) this.fail(`needs a "${name}" attribute`);
    return this.attrs[name];
  }

  num(name, fallback) {
    if (!this.has(name)) return fallback;
    const value = Number(this.attrs[name]);
    if (this.attrs[name].trim() === '' || !Number.isFinite(value)) this.fail(`${name}="${this.attrs[name]}" is not a number`);
    return value;
  }

  flag(name, fallback = false) {
    if (!this.has(name)) return fallback;
    const value = this.attrs[name];
    if (value !== 'true' && value !== 'false') this.fail(`${name}="${value}" must be "true" or "false"`);
    return value === 'true';
  }

  child(name) {
    return this.children.find(child => child.name === name);
  }

  all(name) {
    return this.children.filter(child => child.name === name);
  }

  /** Non-empty trimmed text lines: the row format of pixel art. */
  rows() {
    return this.text.split('\n').map(row => row.trim()).filter(Boolean);
  }

  /**
   * Strict shape check. Unknown attributes and child elements are errors, so a
   * typo is reported where it was written instead of being ignored.
   */
  expect({ attrs = [], children = [], text = false } = {}) {
    for (const name of Object.keys(this.attrs)) {
      if (!attrs.includes(name)) this.fail(`has an unknown attribute "${name}". Allowed: ${attrs.join(', ') || 'none'}`);
    }
    for (const child of this.children) {
      if (!children.includes(child.name)) {
        child.fail(`is not allowed inside <${this.name}>. Allowed: ${children.map(name => `<${name}>`).join(', ') || 'nothing'}`);
      }
    }
    if (!text && this.text.trim()) this.fail('must not contain text');
    return this;
  }
}

export function parseXml(text, source = 'xml', { foreign = false } = {}) {
  let i = 0;
  let root = null;
  const stack = [];

  // Lines are counted forward from the last place asked about, since parsing only moves forward; counting from the start each time made big documents quadratic.
  let counted = 0;
  let lines = 1;
  const lineOf = at => {
    if (at < counted) return text.slice(0, at).split('\n').length;
    for (let n = text.indexOf('\n', counted); n >= 0 && n < at; n = text.indexOf('\n', n + 1)) lines++;
    counted = at;
    return lines;
  };
  const fail = (message, at = i) => {
    throw new XmlError(message, source, lineOf(at), at - text.lastIndexOf('\n', at - 1));
  };
  const decode = (raw, at) => raw.replace(/&([^;\s]*);?/g, (match, name) => {
    if (!match.endsWith(';')) {
      if (foreign) return match;
      fail('unescaped "&"; write &amp;', at);
    }
    if (name in ENTITIES) return ENTITIES[name];
    const code = /^#x[0-9a-f]+$/i.test(name) ? parseInt(name.slice(2), 16) : /^#\d+$/.test(name) ? Number(name.slice(1)) : NaN;
    if (Number.isNaN(code) || code > 0x10ffff) {
      if (foreign) return match;
      fail(`unknown entity "${match}"`, at);
    }
    return String.fromCodePoint(code);
  });
  const skipTo = (end, what) => {
    const at = text.indexOf(end, i);
    if (at < 0) fail(`unterminated ${what}`);
    const body = text.slice(i, at);
    i = at + end.length;
    return body;
  };
  const name = () => {
    NAME.lastIndex = i;
    const match = NAME.exec(text);
    if (!match) fail('expected a name');
    i = NAME.lastIndex;
    return match[0];
  };
  const space = () => {
    while (i < text.length && text.charCodeAt(i) <= 32) i++;
  };
  const expect = token => {
    if (!text.startsWith(token, i)) fail(`expected "${token}"`);
    i += token.length;
  };
  const own = piece => {
    const parent = stack.at(-1);
    parent.text += piece;
    const last = parent.children.at(-1);
    if (last) last.tail += piece;
  };
  const attach = (node, open) => {
    const parent = stack.at(-1);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else if (root) {
      fail(`a second root element <${node.name}>`);
    } else {
      root = node;
    }
    if (open) stack.push(node);
  };

  while (i < text.length) {
    if (text[i] !== '<') {
      const at = i;
      const end = text.indexOf('<', i);
      i = end < 0 ? text.length : end;
      const raw = text.slice(at, i);
      if (stack.length) own(decode(raw, at));
      else if (raw.trim()) fail('text outside the root element', at);
    } else if (text.startsWith('<!--', i)) {
      i += 4;
      skipTo('-->', 'comment');
    } else if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA outside the root element');
      i += 9;
      own(skipTo(']]>', 'CDATA section'));
    } else if (text.startsWith('<?', i)) {
      i += 2;
      skipTo('?>', 'processing instruction');
    } else if (text.startsWith('<!', i)) {
      if (!foreign || !/^<!DOCTYPE/i.test(text.slice(i, i + 9))) fail('doctype declarations are not supported');
      // A foreign doctype is skipped whole, internal subset included; its entities are not expanded.
      const subset = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      i = subset >= 0 && subset < close ? text.indexOf(']', subset) : i;
      if (i < 0) fail('unterminated doctype');
      i = text.indexOf('>', i) + 1;
      if (i <= 0) fail('unterminated doctype');
    } else if (text.startsWith('</', i)) {
      const at = i;
      i += 2;
      const closing = name();
      space();
      expect('>');
      const open = stack.pop();
      if (open?.name !== closing) fail(`</${closing}> does not close <${open?.name ?? 'anything'}>`, at);
    } else {
      const at = i;
      i += 1;
      const node = new XmlNode(name(), source, lineOf(at));
      for (;;) {
        space();
        if (i >= text.length) fail(`<${node.name}> is never finished`, at);
        if (text.startsWith('/>', i)) {
          i += 2;
          attach(node, false);
          break;
        }
        if (text[i] === '>') {
          i += 1;
          attach(node, true);
          break;
        }
        const key = name();
        space();
        expect('=');
        space();
        const quote = text[i];
        if (quote !== '"' && quote !== "'") fail('attribute values must be quoted');
        const from = i + 1;
        const end = text.indexOf(quote, from);
        if (end < 0) fail('unterminated attribute value', from);
        if (node.has(key)) fail(`duplicate attribute "${key}"`, from);
        node.attrs[key] = decode(text.slice(from, end), from);
        i = end + 1;
      }
    }
  }

  if (stack.length) fail(`<${stack.at(-1).name}> is never closed`);
  if (!root) fail('no root element');
  return root;
}

export const escapeXml = value => String(value).replace(/[<>&"']/g, ch => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
})[ch]);
