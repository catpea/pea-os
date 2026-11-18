/** Regex Lab: a pattern, its matches in sample text, and what a replacement makes of it. */

const MATCH_LIMIT = 500;

/** Builds the expression, or explains in words why it cannot be built. */
export function compile(pattern, flags) {
  if (!/^[dgimsuvy]*$/.test(flags)) throw new SyntaxError(`Unknown flag "${flags.replace(/[dgimsuvy]/g, '')[0]}". Flags: d g i m s u v y`);
  if (new Set(flags).size !== flags.length) throw new SyntaxError('A flag is given twice.');
  return new RegExp(pattern, flags);
}

/**
 * Every match of `pattern` in `text`, whether or not the flags say global:
 * [{ index, text, groups: [..], named: { name: text } | null }], at most `limit`.
 */
export function findMatches(pattern, flags, text, limit = MATCH_LIMIT) {
  const expression = compile(pattern, flags.includes('g') || flags.includes('y') ? flags : `${flags}g`);
  const found = [];
  for (const match of text.matchAll(expression)) {
    if (found.length >= limit) break;
    found.push({ index: match.index, text: match[0], groups: match.slice(1), named: match.groups ? { ...match.groups } : null });
  }
  return found;
}

/** The text with the replacement applied, honoring the flags as given (without g, only the first match). */
export function replaceAll(pattern, flags, text, replacement) {
  return text.replace(compile(pattern, flags), replacement);
}

const shown = text => JSON.stringify(text).slice(1, -1);

export default function (app) {
  const { refs } = app;
  let matches = [];

  const update = () => {
    const pattern = app.scope.get('pattern');
    const flags = app.scope.get('flags').trim();
    const sample = app.scope.get('sample');
    if (!pattern) {
      matches = [];
      refs.matches.items = [];
      app.scope.set('result', sample);
      app.scope.set('status', 'Type a pattern to see what it matches.');
      return;
    }
    try {
      matches = findMatches(pattern, flags, sample);
      app.scope.set('result', replaceAll(pattern, flags, sample, app.scope.get('replacement')));
    } catch (error) {
      matches = [];
      refs.matches.items = [];
      app.scope.set('result', '');
      app.scope.set('status', error.message.replace(/^Invalid regular expression: /, ''));
      return;
    }
    refs.matches.items = matches.map((match, index) => {
      const groups = match.named
        ? Object.entries(match.named).map(([name, text]) => `${name}=${text === undefined ? '–' : shown(text)}`)
        : match.groups.map((text, n) => `$${n + 1}=${text === undefined ? '–' : shown(text)}`);
      return { value: String(index), text: `${index + 1}. “${shown(match.text)}” at ${match.index}`, detail: groups.join('  ') || 'no groups' };
    });
    const more = matches.length >= MATCH_LIMIT ? ` (the first ${MATCH_LIMIT})` : '';
    app.scope.set('status', matches.length ? `${matches.length} matches${more}. Pick one to select it in the text.` : 'No matches.');
  };
  // Typing a pattern rebuilds on a pause, so half-typed expressions do not run against long text on every key.
  const later = app.debounce(150, update);
  for (const name of ['pattern', 'flags', 'sample', 'replacement']) app.scope.subscribe(app.signal(name), later, { immediate: false });
  update();

  app.command('show-match', () => {
    const match = matches[Number(app.scope.get('match'))];
    if (!match) return;
    refs.sample.setSelection(match.index, match.index + match.text.length);
  });
}
