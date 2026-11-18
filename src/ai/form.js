/**
 * Fill-in prompts and answer forms: the plain-text way to ask a model for
 * named answers. A prompt names its inputs in double curly braces,
 *
 *   The user's first name is {{firstName}} and last name is {{lastName}}.
 *
 * and an answer form names its outputs, one per line, with an example:
 *
 *   username: alice123
 *
 * The thinker is told how to answer in the strongest way it understands: a
 * JSON schema where the provider can enforce one, and otherwise a strict
 * "reply with exactly these lines" contract. readForm() accepts either shape
 * back, so a small model that drifts from JSON to lines (or wraps its answer
 * in Markdown) still gives clean values.
 */

const NAME = /^[A-Za-z_][\w-]{0,29}$/;
const MAX_FIELDS = 8;

/** The {{names}} in a prompt, in order of first use. */
export function placeholders(prompt) {
  const names = [];
  for (const [, name] of String(prompt).matchAll(/\{\{\s*([A-Za-z_][\w-]{0,29})\s*\}\}/g)) if (!names.includes(name)) names.push(name);
  return names;
}

/** The prompt with each {{name}} replaced by value(name). */
export function fill(prompt, value) {
  return String(prompt).replace(/\{\{\s*([A-Za-z_][\w-]{0,29})\s*\}\}/g, (_, name) => value(name));
}

/**
 * Reads an answer form, "name: example" per line, into [{ name, example }].
 * Blank lines are skipped; anything else that is not a field fails, naming
 * the line, so a typo does not silently lose an output.
 */
export function parseFields(text) {
  const fields = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    const name = match?.[1].trim();
    if (!match || !NAME.test(name)) throw new Error(`Answer form, line ${index + 1}: write "name: example", such as "username: alice123". A name is letters, digits, "-" or "_".`);
    if (fields.some(field => field.name === name)) throw new Error(`Answer form, line ${index + 1}: "${name}" is used twice.`);
    fields.push({ name, example: match[2].trim() });
  });
  if (fields.length > MAX_FIELDS) throw new Error(`An answer form has at most ${MAX_FIELDS} lines.`);
  return fields;
}

/** A JSON schema for the form: an object of string fields, all required. */
export function formSchema(fields) {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map(field => [field.name, { type: 'string' }])),
    required: fields.map(field => field.name),
    additionalProperties: false
  };
}

/** The instruction that ends the prompt: 'lines' for any thinker, 'json' where JSON is enforced. */
export function formPrompt(fields, style = 'lines') {
  if (style === 'json') {
    const example = JSON.stringify(Object.fromEntries(fields.map(field => [field.name, field.example || '...'])));
    return [
      'ANSWER FORMAT. Reply with only one JSON object and nothing else: no words before or after it, no code block.',
      `It has exactly these keys, each with a string value: ${fields.map(field => `"${field.name}"`).join(', ')}.`,
      `Example of the shape (the values are only examples): ${example}`
    ].join('\n');
  }
  const count = fields.length === 1 ? 'exactly this 1 line' : `exactly these ${fields.length} lines`;
  return [
    `ANSWER FORMAT. Reply with ${count}, in this order, and nothing else: no greeting, no explanation, no Markdown, no code block.`,
    ...fields.map(field => `${field.name}: <${field.name}>`),
    'Replace each <...> with your answer, on the same line. Keep the words before each colon exactly as written.',
    'Example of a correct reply (the values are only examples):',
    ...fields.map(field => `${field.name}: ${field.example || '...'}`)
  ].join('\n');
}

/** Chat messages with the answer format added to the end of the last user message. */
export function withForm(messages, fields, style) {
  const last = messages.findLastIndex(item => item.role === 'user');
  const contract = formPrompt(fields, style);
  if (last < 0) return [...messages, { role: 'user', content: contract }];
  return messages.map((item, index) => index === last ? { ...item, content: `${item.content}\n\n${contract}` } : item);
}

const key = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
const tidy = value => String(value).trim().replace(/^(\*\*|__|`+|"|')(.*)\1$/s, '$2').trim();

/** The first balanced {...} in `text` that is a JSON object, or null; braces in the words around it do not spoil it. */
function firstObject(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '\\') i++;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { /* not JSON: try the next opening brace */ }
        break;
      }
    }
  }
  return null;
}

/**
 * Reads a reply against the form: { values: { name: text }, missing: [name] }.
 * Takes a JSON object (also inside a code block or among other words) or
 * "name: value" lines (also with bullets, bold names or values running onto
 * further lines). Names match without regard to case, spaces or dashes.
 */
export function readForm(text, fields) {
  const wanted = new Map(fields.map(field => [key(field.name), field.name]));
  const values = Object.create(null);
  const raw = String(text ?? '');
  const object = firstObject(raw.replace(/```(?:json)?/gi, ''));
  if (object) {
    for (const [name, value] of Object.entries(object)) {
      const field = wanted.get(key(name));
      if (field && value !== null && value !== undefined) values[field] = typeof value === 'string' ? value.trim() : JSON.stringify(value);
    }
  }
  if (!Object.keys(values).length) {
    let current = null;
    for (const line of raw.replace(/```\w*/g, '').split(/\r?\n/)) {
      const match = /^\s*(?:[-*•]\s+)?(?:\*\*|__)?([A-Za-z_][\w -]{0,40}?)(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__)?\s*(.*)$/.exec(line);
      const field = match ? wanted.get(key(match[1])) : null;
      if (field && !Object.hasOwn(values, field)) { current = field; values[field] = match[2]; }
      else if (current && line.trim()) values[current] += `\n${line.trim()}`;
      else if (!line.trim()) current = current && values[current] ? null : current;
    }
    for (const name of Object.keys(values)) values[name] = tidy(values[name]);
  }
  for (const name of Object.keys(values)) if (!values[name]) delete values[name];
  // Built without a prototype so a field called "constructor" is never found by accident; handed back as a plain object.
  return { values: { ...values }, missing: fields.map(field => field.name).filter(name => !Object.hasOwn(values, name)) };
}
